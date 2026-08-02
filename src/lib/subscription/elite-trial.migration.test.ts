import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The trial and the read-only downgrade are both decided inside PostgreSQL, so
 * they are tested inside PostgreSQL. Every case below runs the real migration
 * chain against an in-process database rather than asserting on SQL text.
 */
const migrationFile = '202608030001_elite_trial_and_read_only.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationFile), 'utf8');
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();

const MIGRATION_CHAIN = [
  '202607180001_phase_1_auth.sql',
  '202607180003_phase_3_watchlist.sql',
  '202607180004_phase_4_portfolio_core.sql',
  '202607180005_phase_4_portfolio_options.sql',
  '202607180006_portfolio_currency_summary.sql',
  '202607180009_phase_7_alerts_notifications.sql',
  '202607300001_portfolio_ledger_source_of_truth.sql',
  '202607310001_portfolio_option_symbol_resolution.sql',
  '202607310002_multi_portfolios.sql',
  '202607310003_portfolio_bangkok_transaction_date.sql',
  '202608020002_transfer_cash_lint.sql',
  '202608020008_subscription_entitlements.sql',
  migrationFile,
];

const USERS = {
  verified: '11111111-1111-4111-8111-111111111111',
  unverified: '22222222-2222-4222-8222-222222222222',
  paid: '33333333-3333-4333-8333-333333333333',
  concurrent: '44444444-4444-4444-8444-444444444444',
  downgraded: '55555555-5555-4555-8555-555555555555',
  missing: '66666666-6666-4666-8666-666666666666',
} as const;

const VERIFIED_USERS = [USERS.verified, USERS.paid, USERS.concurrent, USERS.downgraded, USERS.missing];

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email_confirmed_at timestamptz,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  for (const file of MIGRATION_CHAIN.slice(0, -2)) {
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.query(
    `insert into auth.users (id, email_confirmed_at)
     select value, case when value = $1 then null else timestamptz '2026-01-01 00:00:00+00' end
     from unnest($2::uuid[]) as value`,
    [USERS.unverified, [USERS.unverified, ...VERIFIED_USERS]],
  );
  for (const file of MIGRATION_CHAIN.slice(-2)) {
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec(`grant usage on schema public, auth to anon, authenticated`);
  return db;
}

async function setUser(db: PGlite, userId: string | null) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
}

/** PGlite decodes `timestamptz` into a JavaScript `Date`, not an ISO string. */
interface TrialRow {
  user_id: string;
  tier: string;
  status: string;
  trial_started_at: Date;
  trial_ends_at: Date;
  trial_used_at: Date;
  database_now: Date;
}

const isoLiteral = (value: Date) => `timestamptz '${value.toISOString()}'`;

async function startTrial(db: PGlite) {
  const result = await db.query<TrialRow>(`select * from public.start_elite_trial()`);
  return result.rows[0];
}

async function effectiveTier(db: PGlite, userId: string, asOf = 'statement_timestamp()') {
  const result = await db.query<{ tier: string }>(
    `select public.resolve_effective_subscription_tier($1, ${asOf}) as tier`,
    [userId],
  );
  return result.rows[0].tier;
}

async function createPortfolio(db: PGlite, name: string, type: 'STOCK' | 'OPTION') {
  const result = await db.query<{ create_portfolio: string }>(
    `select public.create_portfolio($1, $2)`,
    [name, type],
  );
  return result.rows[0].create_portfolio;
}

async function addDeposit(db: PGlite, portfolioId: string, amount = 100) {
  const result = await db.query<{ id: string }>(
    `select public.create_portfolio_ledger_transaction(
       $1, 'deposit', null, null, null, $2, null, 'USD', null,
       timestamptz '2026-02-01 10:00:00+00', null, null, null, null, null, null, null, null, null,
       gen_random_uuid()
     ) as id`,
    [portfolioId, amount],
  );
  return result.rows[0].id;
}

/** Moves a granted trial into the past without touching any other column. */
async function expireTrial(db: PGlite, userId: string) {
  await db.query(
    `update public.user_subscriptions
     set trial_started_at = timestamptz '2026-01-01 00:00:00+00',
         trial_ends_at = timestamptz '2026-01-08 00:00:00+00'
     where user_id = $1`,
    [userId],
  );
}

describe('elite trial migration', () => {
  it('accepts no client input and never projects billing identifiers', () => {
    expect(sql).toContain('create or replace function public.start_elite_trial()');
    expect(sql).toContain('requesting_user uuid := (select auth.uid())');
    expect(sql).toContain('for update');
    expect(sql).toContain("interval '7 days'");
    expect(sql).toContain('revoke all on function public.start_elite_trial() from public, anon');
    expect(sql).toContain('grant execute on function public.start_elite_trial() to authenticated');
    expect(sql).not.toContain('billing_customer_id');
    expect(sql).not.toContain('billing_subscription_id');
    expect(sql).not.toContain('billing_price_id');
    // No argument list means no user_id, tier, status or timestamp can be passed.
    expect(rawSql).not.toMatch(/function public\.start_elite_trial\([^)]/);
  });

  it('contains no destructive statement against user data', () => {
    expect(sql).not.toMatch(/drop table|truncate|drop column|delete from public\.portfolios(?! where id = owned_portfolio)/);
    expect(sql).not.toContain('drop function');
    expect(sql).not.toContain('alter table public.user_subscriptions');
  });

  it('grants Elite for exactly seven days to a verified Basic account', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.verified);
      expect(await effectiveTier(db, USERS.verified)).toBe('basic');

      const granted = await startTrial(db);
      expect(granted.user_id).toBe(USERS.verified);
      expect(granted.tier).toBe('elite');
      expect(granted.status).toBe('trialing');
      expect(granted).not.toHaveProperty('billing_customer_id');
      expect(granted.trial_ends_at.getTime() - granted.trial_started_at.getTime())
        .toBe(7 * 24 * 60 * 60 * 1000);
      expect(granted.trial_used_at.getTime()).toBe(granted.trial_started_at.getTime());
      expect(await effectiveTier(db, USERS.verified)).toBe('elite');
    } finally {
      await db.close();
    }
  }, 60_000);

  it('refuses an unverified mailbox and leaves the subscription untouched', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.unverified);
      await expect(startTrial(db)).rejects.toThrow(/EMAIL_NOT_VERIFIED/);
      const row = await db.query<{ tier: string; status: string; trial_used_at: string | null }>(
        `select tier, status, trial_used_at from public.user_subscriptions where user_id = $1`,
        [USERS.unverified],
      );
      expect(row.rows[0]).toEqual({ tier: 'basic', status: 'basic', trial_used_at: null });
    } finally {
      await db.close();
    }
  }, 60_000);

  it('allows the trial exactly once, before and after it expires', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.verified);
      await startTrial(db);
      await expect(startTrial(db)).rejects.toThrow(/TRIAL_ALREADY_ACTIVE/);
      await expireTrial(db, USERS.verified);
      await expect(startTrial(db)).rejects.toThrow(/TRIAL_ALREADY_USED/);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('refuses to start while a paid plan is active', async () => {
    const db = await database();
    try {
      await db.query(
        `update public.user_subscriptions
         set tier = 'pro', status = 'active',
             current_period_start = timestamptz '2026-01-01 00:00:00+00',
             current_period_end = timestamptz '2099-01-01 00:00:00+00'
         where user_id = $1`,
        [USERS.paid],
      );
      await setUser(db, USERS.paid);
      await expect(startTrial(db)).rejects.toThrow(/PAID_SUBSCRIPTION_ACTIVE/);
      expect(await effectiveTier(db, USERS.paid)).toBe('pro');
    } finally {
      await db.close();
    }
  }, 60_000);

  it('reports a missing subscription row instead of creating one', async () => {
    const db = await database();
    try {
      await db.query(`delete from public.user_subscriptions where user_id = $1`, [USERS.missing]);
      await setUser(db, USERS.missing);
      await expect(startTrial(db)).rejects.toThrow(/SUBSCRIPTION_NOT_FOUND/);
      const rows = await db.query<{ count: number }>(
        `select count(*)::int as count from public.user_subscriptions where user_id = $1`,
        [USERS.missing],
      );
      expect(rows.rows[0].count).toBe(0);
      // A row that cannot be resolved still fails closed to Basic.
      expect(await effectiveTier(db, USERS.missing)).toBe('basic');
    } finally {
      await db.close();
    }
  }, 60_000);

  it('grants the trial once under concurrent calls', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.concurrent);
      const attempts = await Promise.allSettled([startTrial(db), startTrial(db), startTrial(db)]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      for (const attempt of attempts.filter((item) => item.status === 'rejected')) {
        expect(String((attempt as PromiseRejectedResult).reason))
          .toMatch(/TRIAL_ALREADY_ACTIVE|TRIAL_ALREADY_USED/);
      }
      const rows = await db.query<{ status: string; trial_used_at: string | null }>(
        `select status, trial_used_at from public.user_subscriptions where user_id = $1`,
        [USERS.concurrent],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].status).toBe('trialing');
      expect(rows.rows[0].trial_used_at).toBeTruthy();
    } finally {
      await db.close();
    }
  }, 60_000);

  it('denies anon and public execution of the trial', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.verified);
      await db.exec(`set role anon`);
      await expect(db.query(`select * from public.start_elite_trial()`)).rejects.toThrow(/permission denied/);
      await db.exec(`reset role`);

      await db.exec(`set role authenticated`);
      const allowed = await db.query<TrialRow>(`select * from public.start_elite_trial()`);
      expect(allowed.rows[0].status).toBe('trialing');
      // The trusted helpers stay private even to a signed-in role.
      await expect(db.query(`select public.assert_portfolio_writable(gen_random_uuid())`))
        .rejects.toThrow(/permission denied/);
      await expect(db.query(`select public.basic_writable_stock_portfolio($1)`, [USERS.verified]))
        .rejects.toThrow(/permission denied/);
      await db.exec(`reset role`);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('resolves the trial tier strictly before, at, and after expiry', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.verified);
      const granted = await startTrial(db);
      const ends = isoLiteral(granted.trial_ends_at);
      expect(await effectiveTier(db, USERS.verified, `${ends} - interval '1 millisecond'`)).toBe('elite');
      expect(await effectiveTier(db, USERS.verified, ends)).toBe('basic');
      expect(await effectiveTier(db, USERS.verified, `${ends} + interval '1 millisecond'`)).toBe('basic');
    } finally {
      await db.close();
    }
  }, 60_000);
});

describe('read-only downgrade after a trial expires', () => {
  let db: PGlite;
  let legacyId: string;
  let firstStockId: string;
  let secondStockId: string;
  let optionId: string;
  let optionTargetId: string;
  let firstStockTransactionId: string;
  let secondStockTransactionId: string;
  let optionTransactionId: string;

  beforeAll(async () => {
    db = await database();
    await setUser(db, USERS.downgraded);
    // Everything below is built while Elite, exactly as a real trial user would.
    await startTrial(db);
    const legacy = await db.query<{ id: string }>(`select public.get_or_create_default_portfolio() as id`);
    legacyId = legacy.rows[0].id;
    firstStockId = await createPortfolio(db, 'Stock A', 'STOCK');
    secondStockId = await createPortfolio(db, 'Stock B', 'STOCK');
    optionId = await createPortfolio(db, 'Options A', 'OPTION');
    firstStockTransactionId = await addDeposit(db, firstStockId, 500);
    secondStockTransactionId = await addDeposit(db, secondStockId, 300);
    await addDeposit(db, optionId, 400);
    optionTransactionId = (await db.query<{ id: string }>(
      `select public.create_portfolio_ledger_transaction(
         $1, 'buy_to_open', null, 1, 2.5, null, 0, 'USD', null,
         timestamptz '2026-02-02 10:00:00+00', null, 'AAPL', 'AAPL260220C00200000',
         'call', 'long', 200, date '2026-02-20', 100, null, gen_random_uuid()
       ) as id`,
      [optionId],
    )).rows[0].id;
    optionTargetId = (await db.query<{ id: string }>(
      `select public.upsert_portfolio_option_target(
         $1, null, 'AAPL260220C00200000', 'long', 'premium', 5, 5, 0
       ) as id`,
      [optionId],
    )).rows[0].id;
    await expireTrial(db, USERS.downgraded);
  }, 90_000);

  it('drops the account back to Basic the moment the trial ends', async () => {
    expect(await effectiveTier(db, USERS.downgraded)).toBe('basic');
  });

  it('keeps every portfolio, transaction and target readable', async () => {
    const counts = await db.query<{ portfolios: number; transactions: number; targets: number }>(`
      select
        (select count(*)::int from public.portfolios where user_id = $1) as portfolios,
        (select count(*)::int from public.portfolio_transactions as t
           join public.portfolios as p on p.id = t.portfolio_id where p.user_id = $1) as transactions,
        (select count(*)::int from public.portfolio_option_targets as g
           join public.portfolios as p on p.id = g.portfolio_id where p.user_id = $1) as targets
    `, [USERS.downgraded]);
    // Three deposits, one option purchase, one sell target, four portfolios.
    expect(counts.rows[0]).toEqual({ portfolios: 4, transactions: 4, targets: 1 });
  });

  it('keeps the deterministic Basic stock portfolio and the legacy portfolio writable', async () => {
    const writable = await db.query<{ id: string }>(
      `select public.basic_writable_stock_portfolio($1) as id`,
      [USERS.downgraded],
    );
    expect(writable.rows[0].id).toBe(firstStockId);
    await expect(addDeposit(db, firstStockId, 25)).resolves.toBeTruthy();
    await expect(addDeposit(db, legacyId, 25)).resolves.toBeTruthy();
  });

  it('rejects every mutation path on an over-limit stock portfolio', async () => {
    const readOnly = /READ_ONLY_SUBSCRIPTION/;
    await expect(addDeposit(db, secondStockId, 10)).rejects.toThrow(readOnly);
    await expect(db.query(
      `select public.update_portfolio_ledger_transaction(
         $1, 'deposit', null, null, null, 999, null, 'USD', 1,
         timestamptz '2026-02-01 10:00:00+00', null, null, null, null, null, null, null, null, null
       )`,
      [secondStockTransactionId],
    )).rejects.toThrow(readOnly);
    await expect(db.query(`select public.delete_portfolio_ledger_transaction($1)`, [secondStockTransactionId]))
      .rejects.toThrow(readOnly);
    await expect(db.query(`select public.update_portfolio_details($1, 'Renamed', 'STOCK')`, [secondStockId]))
      .rejects.toThrow(readOnly);
    await expect(db.query(`select public.set_portfolio_goal($1, 1000, null)`, [secondStockId]))
      .rejects.toThrow(readOnly);
    await expect(db.query(`select public.delete_empty_portfolio($1)`, [secondStockId]))
      .rejects.toThrow(readOnly);
    await expect(db.query(
      `select public.transfer_portfolio_cash($1, $2, 10, timestamptz '2026-02-03 10:00:00+00', null, gen_random_uuid())`,
      [firstStockId, secondStockId],
    )).rejects.toThrow(readOnly);
    await expect(db.query(
      `select public.transfer_portfolio_cash($1, $2, 10, timestamptz '2026-02-03 10:00:00+00', null, gen_random_uuid())`,
      [secondStockId, firstStockId],
    )).rejects.toThrow(readOnly);
  });

  it('rejects every mutation path on an options portfolio as an upgrade', async () => {
    const upgrade = /UPGRADE_REQUIRED/;
    await expect(addDeposit(db, optionId, 10)).rejects.toThrow(upgrade);
    await expect(db.query(
      `select public.update_portfolio_ledger_transaction(
         $1, 'buy_to_open', null, 2, 2.5, null, 0, 'USD', 1,
         timestamptz '2026-02-02 10:00:00+00', null, 'AAPL', 'AAPL260220C00200000',
         'call', 'long', 200, date '2026-02-20', 100, null
       )`,
      [optionTransactionId],
    )).rejects.toThrow(upgrade);
    await expect(db.query(`select public.delete_portfolio_ledger_transaction($1)`, [optionTransactionId]))
      .rejects.toThrow(upgrade);
    await expect(db.query(
      `select public.upsert_portfolio_option_target($1, null, 'AAPL260220C00200000', 'long', 'premium', 9, 9, 0)`,
      [optionId],
    )).rejects.toThrow(upgrade);
    await expect(db.query(`select public.delete_portfolio_option_target($1)`, [optionTargetId]))
      .rejects.toThrow(upgrade);
    await expect(db.query(`select public.update_portfolio_details($1, 'Renamed Options', 'OPTION')`, [optionId]))
      .rejects.toThrow(upgrade);
    await expect(db.query(
      `select public.transfer_portfolio_cash($1, $2, 10, timestamptz '2026-02-03 10:00:00+00', null, gen_random_uuid())`,
      [optionId, firstStockId],
    )).rejects.toThrow(upgrade);
  });

  it('rejects creating a new portfolio of either type', async () => {
    await expect(createPortfolio(db, 'Stock C', 'STOCK')).rejects.toThrow(/LIMIT_REACHED:STOCK:1/);
    await expect(createPortfolio(db, 'Options B', 'OPTION')).rejects.toThrow(/UPGRADE_REQUIRED/);
  });

  it('leaves archiving available so a reader can step back under the Basic limit', async () => {
    await expect(db.query(`select public.archive_portfolio($1)`, [secondStockId])).resolves.toBeTruthy();
    // Archiving the extra does not move the writable choice off the oldest one.
    const writable = await db.query<{ id: string }>(
      `select public.basic_writable_stock_portfolio($1) as id`,
      [USERS.downgraded],
    );
    expect(writable.rows[0].id).toBe(firstStockId);
    await expect(db.query(`select public.restore_portfolio($1)`, [secondStockId]))
      .rejects.toThrow(/LIMIT_REACHED/);
  });

  it('has not lost or altered any stored row through the rejected attempts', async () => {
    const counts = await db.query<{ portfolios: number; transactions: number; targets: number }>(`
      select
        (select count(*)::int from public.portfolios where user_id = $1) as portfolios,
        (select count(*)::int from public.portfolio_transactions as t
           join public.portfolios as p on p.id = t.portfolio_id where p.user_id = $1) as transactions,
        (select count(*)::int from public.portfolio_option_targets as g
           join public.portfolios as p on p.id = g.portfolio_id where p.user_id = $1) as targets
    `, [USERS.downgraded]);
    // Four original transactions plus the two writes the Basic tier still allows.
    expect(counts.rows[0]).toEqual({ portfolios: 4, transactions: 6, targets: 1 });
    const untouched = await db.query<{ amount: string }>(
      `select amount::text from public.portfolio_transactions where id = $1`,
      [secondStockTransactionId],
    );
    expect(Number(untouched.rows[0].amount)).toBe(300);
    const firstStill = await db.query<{ count: number }>(
      `select count(*)::int as count from public.portfolio_transactions where id = $1`,
      [firstStockTransactionId],
    );
    expect(firstStill.rows[0].count).toBe(1);
  });

  it('restores full write access when the account becomes paid again', async () => {
    await db.query(
      `update public.user_subscriptions
       set tier = 'elite', status = 'active',
           current_period_start = timestamptz '2026-01-01 00:00:00+00',
           current_period_end = timestamptz '2099-01-01 00:00:00+00'
       where user_id = $1`,
      [USERS.downgraded],
    );
    expect(await effectiveTier(db, USERS.downgraded)).toBe('elite');
    // The restore the Basic limit refused a moment ago now succeeds, and both
    // previously read-only portfolios accept writes again.
    await expect(db.query(`select public.restore_portfolio($1)`, [secondStockId])).resolves.toBeTruthy();
    await expect(addDeposit(db, secondStockId, 10)).resolves.toBeTruthy();
    await expect(addDeposit(db, optionId, 10)).resolves.toBeTruthy();
  });
});
