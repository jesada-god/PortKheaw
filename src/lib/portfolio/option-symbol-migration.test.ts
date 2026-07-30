import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/202607310001_portfolio_option_symbol_resolution.sql',
), 'utf8');

describe('portfolio option symbol resolution migration', () => {
  it('canonicalizes unresolved ledger rows and targets without changing legacy broker data', async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        create role anon;
        create role authenticated;
        create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
        create table public.portfolio_transactions (
          id uuid primary key,
          portfolio_id uuid not null,
          underlying_symbol text,
          option_kind text,
          strike_price numeric,
          expiration_date date,
          contract_symbol text,
          broker text,
          updated_at timestamptz not null default now()
        );
        create table public.portfolio_option_targets (
          id uuid primary key,
          portfolio_id uuid not null,
          contract_symbol text not null,
          updated_at timestamptz not null default now(),
          unique (portfolio_id, contract_symbol)
        );
      `);
      await database.exec(migration);
      await database.exec(`
        insert into public.portfolio_transactions (
          id, portfolio_id, underlying_symbol, option_kind, strike_price,
          expiration_date, contract_symbol, broker
        ) values (
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'NVDA', 'put', 100, date '2026-08-21',
          'UNRESOLVED-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'Dime'
        );
        insert into public.portfolio_option_targets (
          id, portfolio_id, contract_symbol
        ) values (
          '33333333-3333-4333-8333-333333333333',
          '22222222-2222-4222-8222-222222222222',
          'UNRESOLVED-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
        );
        select public.canonicalize_portfolio_option_contract(
          '22222222-2222-4222-8222-222222222222',
          'NVDA', 'put', 100, date '2026-08-21', 'NVDA260821P00100000'
        );
      `);

      const transaction = await database.query<{
        contract_symbol: string;
        broker: string;
      }>('select contract_symbol, broker from public.portfolio_transactions');
      const target = await database.query<{ contract_symbol: string }>(
        'select contract_symbol from public.portfolio_option_targets',
      );

      expect(transaction.rows).toEqual([{
        contract_symbol: 'NVDA260821P00100000',
        broker: 'Dime',
      }]);
      expect(target.rows).toEqual([{ contract_symbol: 'NVDA260821P00100000' }]);
    } finally {
      await database.close();
    }
  }, 30_000);

  it('runs canonicalization inside both create and update ledger RPCs', () => {
    expect(migration.match(/perform public\.canonicalize_portfolio_option_contract/g)).toHaveLength(2);
    expect(migration).toContain("canonical_symbol like 'LEGACY-%'");
  });
});
