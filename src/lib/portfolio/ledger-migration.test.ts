import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/202607300001_portfolio_ledger_source_of_truth.sql'),
  'utf8',
).replace(/\s+/g, ' ').toLowerCase();

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
    expect(sql).not.toContain("where legacy.status = 'closed'");
  });

  it('keeps target mutations owner-scoped and reuses in-app notifications', () => {
    expect(sql).toContain('create table if not exists public.portfolio_option_targets');
    expect(sql).toContain('alter table public.portfolio_option_targets enable row level security');
    expect(sql).toContain("jsonb_build_object( 'kind', 'option_target'");
    expect(sql).toContain("values ( requesting_user, 'system', notification_title");
    expect(sql).toContain('revoke insert, update, delete on public.portfolio_option_targets from authenticated');
  });
});
