import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/202607300001_portfolio_ledger_source_of_truth.sql',
);
const rawSql = readFileSync(migrationPath, 'utf8');
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();
const PRE_LEDGER_MIGRATIONS = [
  '202607180001_phase_1_auth.sql',
  '202607180003_phase_3_watchlist.sql',
  '202607180004_phase_4_portfolio_core.sql',
  '202607180005_phase_4_portfolio_options.sql',
  '202607180006_portfolio_currency_summary.sql',
  '202607180009_phase_7_alerts_notifications.sql',
];

describe('portfolio ledger source-of-truth migration', () => {
  it('stores stock, cash and every option lifecycle event in one ledger', () => {
    for (const event of [
      'initial_position', 'buy_to_open', 'sell_to_close', 'sell_to_open',
      'buy_to_close', 'exercise', 'assignment', 'expired',
    ]) expect(sql).toContain(`'${event}'`);
    expect(sql).toContain('create or replace function public.assert_portfolio_ledger_valid');
    expect(sql).toContain('option close exceeds available long contracts');
    expect(sql).toContain('option close exceeds available short contracts');
  });

  it('normalizes money once while preserving original currency and transaction time', () => {
    expect(sql).toContain('normalized_price_usd');
    expect(sql).toContain('normalized_fee_usd');
    expect(sql).toContain('occurred_at_time timestamptz');
    expect(sql).toContain("input_original_currency = 'usd'");
    expect(sql).toContain("input_occurred_at at time zone 'asia/bangkok'");
  });

  it('migrates only open legacy option positions without inventing a closing price', () => {
    expect(sql).toContain("from public.portfolio_option_positions as legacy where legacy.status = 'open'");
    expect(sql).toContain("upper('legacy-' || legacy.id::text)");
    expect(sql).not.toContain("where legacy.status = 'closed'");
  });

  it('migrates the legacy NVTS put from the actual pre-ledger schema without losing NVDA', async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        create role anon;
        create role authenticated;
        create schema auth;
        create table auth.users (
          id uuid primary key,
          raw_user_meta_data jsonb not null default '{}'::jsonb
        );
        create function auth.uid() returns uuid language sql stable
        as $$ select null::uuid $$;
      `);
      for (const file of PRE_LEDGER_MIGRATIONS) {
        await database.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
      }

      await database.exec(`
        insert into auth.users (id)
        values ('11111111-1111-4111-8111-111111111111');

        insert into public.portfolio_transactions (
          portfolio_id, transaction_type, symbol, quantity, price, amount,
          occurred_at, note, idempotency_key, original_amount,
          original_currency, fx_rate_at_transaction, normalized_amount_usd
        )
        select
          id, 'acquisition', 'NVDA', 1, 100, null, date '2026-07-27',
          null, '22222222-2222-4222-8222-222222222222', null, 'USD', null, null
        from public.portfolios
        where user_id = '11111111-1111-4111-8111-111111111111';

        insert into public.portfolio_option_positions (
          id, portfolio_id, underlying_symbol, option_kind, contracts,
          premium_per_share, strike_price, opened_at, expiration_date,
          status, idempotency_key
        )
        select
          'c307f481-b34c-4fe3-97f4-0d2326282bf8', id, 'NVTS', 'put', 1,
          2, 12, date '2026-07-27', date '2026-08-21', 'open',
          '33333333-3333-4333-8333-333333333333'
        from public.portfolios
        where user_id = '11111111-1111-4111-8111-111111111111';
      `);

      await database.exec(rawSql);
      const migrated = await database.query<{
        contract_symbol: string;
        underlying_symbol: string;
        option_kind: string;
        option_side: string;
        strike_price: string;
        expiration_date: string;
        multiplier: string;
      }>(`
        select
          contract_symbol, underlying_symbol, option_kind, option_side,
          strike_price::text, expiration_date::text, multiplier::text
        from public.portfolio_transactions
        where transaction_type = 'buy_to_open' and underlying_symbol = 'NVTS'
      `);
      expect(migrated.rows).toEqual([{
        contract_symbol: 'LEGACY-C307F481-B34C-4FE3-97F4-0D2326282BF8',
        underlying_symbol: 'NVTS',
        option_kind: 'put',
        option_side: 'long',
        strike_price: '12.00000000',
        expiration_date: '2026-08-21',
        multiplier: '100.00000000',
      }]);

      const backfillStart = rawSql.indexOf('insert into public.portfolio_transactions (');
      const backfillEnd = rawSql.indexOf('create or replace function public.assert_portfolio_ledger_valid');
      await database.exec(rawSql.slice(backfillStart, backfillEnd));

      const preserved = await database.query<{
        nvda_count: number;
        legacy_nvts_count: number;
        migrated_nvts_count: number;
        targets_table_exists: boolean;
      }>(`
        select
          (select count(*)::int from public.portfolio_transactions where symbol = 'NVDA') as nvda_count,
          (select count(*)::int from public.portfolio_option_positions where underlying_symbol = 'NVTS') as legacy_nvts_count,
          (select count(*)::int from public.portfolio_transactions where transaction_type = 'buy_to_open' and underlying_symbol = 'NVTS') as migrated_nvts_count,
          to_regclass('public.portfolio_option_targets') is not null as targets_table_exists
      `);
      expect(preserved.rows).toEqual([{
        nvda_count: 1,
        legacy_nvts_count: 1,
        migrated_nvts_count: 1,
        targets_table_exists: true,
      }]);
    } finally {
      await database.close();
    }
  }, 30_000);

  it('keeps target mutations owner-scoped and reuses in-app notifications', () => {
    expect(sql).toContain('create table if not exists public.portfolio_option_targets');
    expect(sql).toContain('alter table public.portfolio_option_targets enable row level security');
    expect(sql).toContain("jsonb_build_object( 'kind', 'option_target'");
    expect(sql).toContain("values ( requesting_user, 'system', notification_title");
    expect(sql).toContain('revoke insert, update, delete on public.portfolio_option_targets from authenticated');
  });
});
