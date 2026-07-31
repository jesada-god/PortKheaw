import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationFile = '202607310002_multi_portfolios.sql';
const bangkokDateMigrationFile = '202607310003_portfolio_bangkok_transaction_date.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationFile), 'utf8');
const bangkokDateSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', bangkokDateMigrationFile), 'utf8');
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();
const BEFORE_MULTI = [
  '202607180001_phase_1_auth.sql',
  '202607180003_phase_3_watchlist.sql',
  '202607180004_phase_4_portfolio_core.sql',
  '202607180005_phase_4_portfolio_options.sql',
  '202607180006_portfolio_currency_summary.sql',
  '202607180009_phase_7_alerts_notifications.sql',
  '202607300001_portfolio_ledger_source_of_truth.sql',
  '202607310001_portfolio_option_symbol_resolution.sql',
];

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  await db.query(`select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false)`);
  for (const file of BEFORE_MULTI) {
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  // These migrations pre-date tracked production history in some environments.
  // Replaying them must be safe before the multi-portfolio migration is pushed.
  await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', BEFORE_MULTI.at(-2)!), 'utf8'));
  await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', BEFORE_MULTI.at(-1)!), 'utf8'));
  await db.exec(rawSql);
  await db.exec(bangkokDateSql);
  await db.exec(`
    grant usage on schema public, auth to authenticated;
    grant select on all tables in schema public to authenticated;
    insert into auth.users (id) values
      ('11111111-1111-4111-8111-111111111111'),
      ('22222222-2222-4222-8222-222222222222');
  `);
  return db;
}

async function setUser(db: PGlite, userId: string) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
}

async function createPortfolio(db: PGlite, name: string, type: 'STOCK' | 'OPTION') {
  const result = await db.query<{ create_portfolio: string }>(
    `select public.create_portfolio($1, $2)`,
    [name, type],
  );
  return result.rows[0].create_portfolio;
}

async function deposit(db: PGlite, portfolioId: string, amount: number, idempotencyKey: string) {
  await db.query(`
    select public.create_portfolio_ledger_transaction(
      $1, 'deposit', null, null, null, $2, null, 'USD', null,
      timestamptz '2020-07-31 12:00:00+07', null,
      null, null, null, null, null, null, null, null, $3
    )
  `, [portfolioId, amount, idempotencyKey]);
}

describe('multi-portfolio migration and RPC integration', () => {
  it('validates ledger dates against the same Bangkok calendar used by the RPC', async () => {
    expect(bangkokDateSql).toContain('drop constraint if exists portfolio_transactions_occurred_at_check');
    expect(bangkokDateSql).toContain("(current_timestamp at time zone 'Asia/Bangkok')::date");

    const db = await database();
    try {
      const constraint = await db.query<{ definition: string }>(`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname = 'portfolio_transactions_occurred_at_check'
      `);
      expect(constraint.rows[0].definition).toContain("AT TIME ZONE 'Asia/Bangkok'");
    } finally {
      await db.close();
    }
  });

  it('extends the existing model with atomic limits, owner RLS and restrict-only ledger ownership', () => {
    expect(sql).toContain("portfolio_type in ('stock', 'option', 'legacy')");
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('create trigger portfolios_enforce_limit');
    expect(sql).toContain('on delete restrict');
    expect(sql).toContain("transaction_type in ('transfer_out', 'transfer_in')");
    expect(sql).toContain('create or replace function public.transfer_portfolio_cash');
    expect(sql).not.toContain('update public.portfolio_transactions set portfolio_id');
  });

  it('creates 10 portfolios per type, rejects the 11th and stays bounded under concurrent requests', async () => {
    const db = await database();
    try {
      await setUser(db, '11111111-1111-4111-8111-111111111111');
      for (const type of ['STOCK', 'OPTION'] as const) {
        for (let index = 1; index <= 10; index += 1) await createPortfolio(db, `${type}-${index}`, type);
        await expect(createPortfolio(db, `${type}-11`, type)).rejects.toThrow(/Portfolio limit reached/);
      }

      await setUser(db, '22222222-2222-4222-8222-222222222222');
      const attempts = await Promise.allSettled(
        Array.from({ length: 11 }, (_, index) => createPortfolio(db, `Concurrent-${index}`, 'STOCK')),
      );
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(10);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('normalizes names, scopes owners, persists goals and never deletes ledger history on archive', async () => {
    const db = await database();
    try {
      await setUser(db, '11111111-1111-4111-8111-111111111111');
      const portfolioId = await createPortfolio(db, 'Growth', 'STOCK');
      const emptyId = await createPortfolio(db, 'Temporary', 'OPTION');
      await db.query(`select public.delete_empty_portfolio($1)`, [emptyId]);
      const deleted = await db.query<{ count: number }>(`select count(*)::int as count from public.portfolios where id = $1`, [emptyId]);
      expect(deleted.rows[0].count).toBe(0);
      await expect(createPortfolio(db, ' growth ', 'STOCK')).rejects.toThrow();
      await deposit(db, portfolioId, 500, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      await db.query(`select public.update_portfolio_details($1, 'Growth Prime', 'STOCK')`, [portfolioId]);
      await expect(
        db.query(`select public.update_portfolio_details($1, 'Growth Prime', 'OPTION')`, [portfolioId]),
      ).rejects.toThrow(/type cannot change/);
      await db.query(`select public.set_portfolio_goal($1, 1000, date '2027-12-31')`, [portfolioId]);
      await db.query(`select public.archive_portfolio($1)`, [portfolioId]);
      await expect(db.query(`select public.delete_empty_portfolio($1)`, [portfolioId])).rejects.toThrow(/cleared before deletion|archived, not deleted/);

      const persisted = await db.query<{
        transaction_count: number;
        name: string;
        target_value_usd: string;
        target_date: string;
        archived: boolean;
      }>(`
        select
          (select count(*)::int from public.portfolio_transactions where portfolio_id = portfolio.id) as transaction_count,
          name,
          target_value_usd::text,
          target_date::text,
          archived_at is not null as archived
        from public.portfolios as portfolio where id = $1
      `, [portfolioId]);
      expect(persisted.rows[0]).toMatchObject({
        transaction_count: 1,
        name: 'Growth Prime',
        target_value_usd: '1000.00000000',
        target_date: '2027-12-31',
        archived: true,
      });

      await setUser(db, '22222222-2222-4222-8222-222222222222');
      await expect(
        db.query(`select public.update_portfolio_details($1, 'stolen', 'STOCK')`, [portfolioId]),
      ).rejects.toThrow(/Portfolio not found/);

      await db.exec(`set role authenticated`);
      const visible = await db.query<{ count: number }>(`select count(*)::int as count from public.portfolios`);
      await db.exec(`reset role`);
      expect(visible.rows[0].count).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('links transactions to the selected portfolio, enforces type and records paired transfers', async () => {
    const db = await database();
    try {
      await setUser(db, '11111111-1111-4111-8111-111111111111');
      const stockId = await createPortfolio(db, 'Stock cash', 'STOCK');
      const optionId = await createPortfolio(db, 'Option cash', 'OPTION');
      await deposit(db, stockId, 500, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      await expect(db.query(`
        select public.create_portfolio_ledger_transaction(
          $1, 'buy_to_open', null, 1, 2, null, 0, 'USD', null,
          timestamptz '2020-07-31 12:00:00+07', null,
          'NVTS', 'NVTS260821P00012000', 'put', 'long', 12, date '2026-08-21', 100, null,
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        )
      `, [stockId])).rejects.toThrow(/does not accept option/);

      await db.query(`
        select public.transfer_portfolio_cash(
          $1, $2, 125, timestamptz '2020-07-31 13:00:00+07', 'rebalance',
          'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        )
      `, [stockId, optionId]);
      const transfer = await db.query<{
        portfolio_id: string;
        transaction_type: string;
        amount: string;
        transfer_id: string;
        counterparty_portfolio_id: string;
      }>(`
        select portfolio_id, transaction_type, amount::text, transfer_id::text, counterparty_portfolio_id
        from public.portfolio_transactions
        where transfer_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        order by transaction_type
      `);
      expect(transfer.rows).toHaveLength(2);
      expect(new Set(transfer.rows.map((row) => row.portfolio_id))).toEqual(new Set([stockId, optionId]));
      expect(new Set(transfer.rows.map((row) => row.transaction_type))).toEqual(new Set(['transfer_in', 'transfer_out']));
      expect(transfer.rows.every((row) => row.amount === '125.00000000')).toBe(true);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('keeps pre-existing NVDA/NVTS ledger rows and targets in one legacy portfolio', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role anon;
        create role authenticated;
        create schema auth;
        create table auth.users (id uuid primary key, raw_user_meta_data jsonb not null default '{}'::jsonb);
        create function auth.uid() returns uuid language sql stable
        as $$ select '11111111-1111-4111-8111-111111111111'::uuid $$;
      `);
      for (const file of BEFORE_MULTI) {
        await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
      }
      await db.exec(`
        insert into auth.users (id) values ('11111111-1111-4111-8111-111111111111');
        insert into public.portfolio_transactions (
          portfolio_id, transaction_type, symbol, quantity, price, normalized_price_usd,
          amount, fee, normalized_fee_usd, original_currency, occurred_at, occurred_at_time,
          note, idempotency_key
        )
        select id, 'acquisition', 'NVDA', 1, 100, 100, null, 0, 0, 'USD',
          date '2020-07-30', timestamptz '2020-07-30 12:00:00+07', null,
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
        from public.portfolios where user_id = '11111111-1111-4111-8111-111111111111';
        insert into public.portfolio_option_targets (
          portfolio_id, contract_symbol, side, mode, target_value,
          target_premium, estimated_fee
        )
        select id, 'NVTS260821P00012000', 'long', 'premium', 3, 3, 0
        from public.portfolios where user_id = '11111111-1111-4111-8111-111111111111';
      `);
      await db.exec(rawSql);
      await db.exec(rawSql);
      const preserved = await db.query<{ portfolios: number; nvda: number; legacy: number; nvts_targets: number }>(`
        select
          (select count(*)::int from public.portfolios where user_id = '11111111-1111-4111-8111-111111111111') as portfolios,
          (select count(*)::int from public.portfolio_transactions where symbol = 'NVDA') as nvda,
          (select count(*)::int from public.portfolios where is_legacy) as legacy,
          (select count(*)::int from public.portfolio_option_targets where contract_symbol = 'NVTS260821P00012000') as nvts_targets
      `);
      expect(preserved.rows[0]).toEqual({ portfolios: 1, nvda: 1, legacy: 1, nvts_targets: 1 });
    } finally {
      await db.close();
    }
  }, 30_000);
});
