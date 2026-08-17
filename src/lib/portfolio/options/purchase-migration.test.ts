import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const migrationFile = '202608050008_option_chain_portfolio_purchase.sql';
const feeMigrationFile = '202608170002_option_purchase_fee.sql';
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const BASIC = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const FUTURE = '2027-08-01 00:00:00+00';
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
  '202608030001_elite_trial_and_read_only.sql',
  '202608030002_admin_role_and_access_preview.sql',
  '202608030003_billing_subscriptions.sql',
  '202608040001_effective_access_tier.sql',
  migrationFile,
  feeMigrationFile,
];

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      email_confirmed_at timestamptz,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  for (const file of MIGRATION_CHAIN) {
    if (file === '202608030002_admin_role_and_access_preview.sql') {
      await db.query(
        `insert into auth.users (id, email_confirmed_at)
         select value, timestamptz '2026-01-01 00:00:00+00'
         from unnest($1::uuid[]) as value`,
        [[OWNER, BASIC, PRO]],
      );
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec(`
    update public.user_subscriptions
    set tier = 'pro', status = 'active', current_period_end = timestamptz '${FUTURE}'
    where user_id = '${PRO}';
    grant usage on schema public, auth to authenticated;
  `);
  return db;
}

async function setUser(db: PGlite, userId: string) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
}

async function createOptionPortfolio(db: PGlite, name = 'Options') {
  const result = await db.query<{ id: string }>(`select public.create_portfolio($1, 'OPTION') as id`, [name]);
  return result.rows[0].id;
}

async function deposit(db: PGlite, portfolioId: string, amount: number) {
  await db.query(`
    select public.create_portfolio_ledger_transaction(
      $1, 'deposit', null, null, null, $2, null, 'USD', null,
      timestamptz '2026-08-05 09:00:00+07', null,
      null, null, null, null, null, null, null, null,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  `, [portfolioId, amount]);
}

/**
 * Calls the routine the way the application does. A caller that names no fee
 * omits the two trailing arguments entirely — which is exactly what a client
 * built before the fee box sends, and is therefore the back-compatibility check
 * as much as it is a convenience.
 */
async function purchase(db: PGlite, portfolioId: string, overrides: {
  symbol?: string; kind?: 'call' | 'put'; strike?: number; contracts?: number;
  price?: number; idempotencyKey?: string; fee?: number; feeMode?: string;
} = {}) {
  const symbol = overrides.symbol ?? (overrides.kind === 'put' ? 'AAPL260821P00200000' : 'AAPL260821C00200000');
  const withFee = overrides.fee !== undefined || overrides.feeMode !== undefined;
  const result = await db.query<{ id: string }>(`
    select public.create_portfolio_option_purchase(
      $1, 'AAPL', $2, $3, $4, date '2026-08-21', $5, $6,
      timestamptz '2026-08-05 10:00:00+07', timestamptz '2026-08-05 09:59:30+07', $7
      ${withFee ? ', $8, $9' : ''}
    ) as id
  `, [
    portfolioId,
    symbol,
    overrides.kind ?? 'call',
    overrides.strike ?? 200,
    overrides.contracts ?? 1,
    overrides.price ?? 2.5,
    overrides.idempotencyKey ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ...withFee ? [overrides.fee ?? 0, overrides.feeMode ?? 'total'] : [],
  ]);
  return result.rows[0].id;
}

describe('Option Chain to Portfolio database gate', () => {
  it('writes Call and Put through the canonical ledger with multiplier 100 and exact cash', async () => {
    const db = await database();
    try {
      await setUser(db, PRO);
      const portfolioId = await createOptionPortfolio(db);
      await deposit(db, portfolioId, 1_000);
      await purchase(db, portfolioId);
      await purchase(db, portfolioId, {
        kind: 'put', contracts: 2, price: 1.25,
        idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      });

      const rows = await db.query<{
        option_kind: string; multiplier: string; quantity: string; price: string; option_side: string;
      }>(`
        select option_kind, multiplier::text, quantity::text, normalized_price_usd::text as price, option_side
        from public.portfolio_transactions
        where portfolio_id = $1 and transaction_type = 'buy_to_open'
        order by option_kind
      `, [portfolioId]);
      expect(rows.rows).toEqual([
        { option_kind: 'call', multiplier: '100.00000000', quantity: '1.00000000', price: '2.50000000', option_side: 'long' },
        { option_kind: 'put', multiplier: '100.00000000', quantity: '2.00000000', price: '1.25000000', option_side: 'long' },
      ]);
      const cash = await db.query<{ cash: string }>(`select public.portfolio_cash_balance_usd($1)::text as cash`, [portfolioId]);
      expect(Number(cash.rows[0].cash)).toBe(500);
    } finally {
      await db.close();
    }
  });

  it('rejects insufficient cash without a partial row', async () => {
    const db = await database();
    try {
      await setUser(db, PRO);
      const portfolioId = await createOptionPortfolio(db);
      await deposit(db, portfolioId, 100);
      await expect(purchase(db, portfolioId)).rejects.toThrow(/INSUFFICIENT_CASH/);
      const count = await db.query<{ count: number }>(`
        select count(*)::int as count from public.portfolio_transactions
        where portfolio_id = $1 and transaction_type = 'buy_to_open'
      `, [portfolioId]);
      expect(count.rows[0].count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('returns the same transaction for a replay and refuses a changed payload with the same key', async () => {
    const db = await database();
    try {
      await setUser(db, PRO);
      const portfolioId = await createOptionPortfolio(db);
      await deposit(db, portfolioId, 1_000);
      const first = await purchase(db, portfolioId);
      expect(await purchase(db, portfolioId)).toBe(first);
      await expect(purchase(db, portfolioId, { price: 2.6 })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
      const count = await db.query<{ count: number }>(`
        select count(*)::int as count from public.portfolio_transactions
        where portfolio_id = $1 and transaction_type = 'buy_to_open'
      `, [portfolioId]);
      expect(count.rows[0].count).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('stores the order fee on the row and takes it out of the cash balance', async () => {
    const db = await database();
    try {
      await setUser(db, PRO);
      const portfolioId = await createOptionPortfolio(db);
      await deposit(db, portfolioId, 1_000);
      await purchase(db, portfolioId, { fee: 7.5, feeMode: 'per_contract' });

      const row = await db.query<{ fee: string; normalized_fee: string; fee_mode: string | null }>(`
        select fee::text, normalized_fee_usd::text as normalized_fee, fee_mode
        from public.portfolio_transactions
        where portfolio_id = $1 and transaction_type = 'buy_to_open'
      `, [portfolioId]);
      expect(row.rows[0]).toEqual({
        fee: '7.50000000', normalized_fee: '7.50000000', fee_mode: 'per_contract',
      });
      // 1,000 deposited, 250 of premium, 7.50 of commission.
      const cash = await db.query<{ cash: string }>(`select public.portfolio_cash_balance_usd($1)::text as cash`, [portfolioId]);
      expect(Number(cash.rows[0].cash)).toBe(742.5);
    } finally {
      await db.close();
    }
  });

  /*
   * The routine keeps its old arity, so a deploy that lands the migration before
   * the new client — or rolls the client back after — writes exactly what it
   * wrote yesterday rather than failing to resolve a function.
   */
  it('writes a zero fee at the total mode when the caller names neither', async () => {
    const db = await database();
    try {
      await setUser(db, PRO);
      const portfolioId = await createOptionPortfolio(db);
      await deposit(db, portfolioId, 1_000);
      await purchase(db, portfolioId);
      const row = await db.query<{ fee: string; fee_mode: string | null }>(`
        select fee::text, fee_mode from public.portfolio_transactions
        where portfolio_id = $1 and transaction_type = 'buy_to_open'
      `, [portfolioId]);
      expect(row.rows[0]).toEqual({ fee: '0.00000000', fee_mode: 'total' });
      const cash = await db.query<{ cash: string }>(`select public.portfolio_cash_balance_usd($1)::text as cash`, [portfolioId]);
      expect(Number(cash.rows[0].cash)).toBe(750);
    } finally {
      await db.close();
    }
  });

  it('refuses a negative fee and an unknown fee mode without writing a row', async () => {
    const db = await database();
    try {
      await setUser(db, PRO);
      const portfolioId = await createOptionPortfolio(db);
      await deposit(db, portfolioId, 1_000);
      await expect(purchase(db, portfolioId, { fee: -1 })).rejects.toThrow(/Invalid option purchase fee/);
      await expect(purchase(db, portfolioId, { fee: 1, feeMode: 'monthly' })).rejects.toThrow(/fee mode/);
      const count = await db.query<{ count: number }>(`
        select count(*)::int as count from public.portfolio_transactions
        where portfolio_id = $1 and transaction_type = 'buy_to_open'
      `, [portfolioId]);
      expect(count.rows[0].count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('counts the fee in the atomic cash check and treats a changed fee as a different order', async () => {
    const db = await database();
    try {
      await setUser(db, PRO);
      const portfolioId = await createOptionPortfolio(db);
      await deposit(db, portfolioId, 255);
      // 250 of premium fits in 255; 250 plus 10 of commission does not.
      await expect(purchase(db, portfolioId, { fee: 10 })).rejects.toThrow(/INSUFFICIENT_CASH/);
      const first = await purchase(db, portfolioId, { fee: 5 });
      expect(await purchase(db, portfolioId, { fee: 5 })).toBe(first);
      await expect(purchase(db, portfolioId, { fee: 4 })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    } finally {
      await db.close();
    }
  });

  it('enforces effective access again in the database after a Pro account becomes Basic', async () => {
    const db = await database();
    try {
      await setUser(db, PRO);
      const portfolioId = await createOptionPortfolio(db);
      await deposit(db, portfolioId, 1_000);
      await db.query(`
        update public.user_subscriptions
        set tier = 'basic', status = 'basic', current_period_end = null
        where user_id = $1
      `, [PRO]);
      await expect(purchase(db, portfolioId)).rejects.toThrow(/UPGRADE_REQUIRED:portfolio.options.write/);
    } finally {
      await db.close();
    }
  });
});
