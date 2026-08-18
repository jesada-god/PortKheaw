import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

/**
 * The collection table, applied to a real Postgres before it is applied to ours.
 *
 * This one carries a risk the other migrations do not: nothing reads the table,
 * so nothing will notice if it is subtly wrong. A constraint that admits a zero
 * volatility, or a key that lets two readings share a day, produces a series
 * that looks fine for a year and is worthless when somebody finally opens it —
 * and the chains it came from are long gone by then.
 */

const MIGRATION_FILE = '202608180002_expected_move_collection.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8');
const [migrationSql] = rawSql.split(/^-- =+\s*\n-- Reversal/m);

const PLATFORM_ROLES = `
  do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
`;

let database: PGlite;

const insert = (over: Record<string, string | number> = {}) => {
  const row = {
    symbol: "'AAPL'",
    as_of: "'2026-08-18'",
    spot: 230.5,
    expiration: "'2026-09-18'",
    days_to_expiry: 31,
    atm_iv: 0.284,
    atm_strike: 230,
    implied_move: 19.07,
    implied_move_pct: 0.0827,
    provider: "'alpaca'",
    ...over,
  };
  return `insert into public.expected_move_observations (${Object.keys(row).join(', ')})
          values (${Object.values(row).join(', ')});`;
};

beforeAll(async () => {
  database = new PGlite();
  await database.exec(PLATFORM_ROLES);
  await database.exec(migrationSql);
});

const rows = async <T>(sql: string): Promise<T[]> => (await database.query<T>(sql)).rows;

describe('the table', () => {
  it('applies on its own, depending on no earlier migration', async () => {
    const found = await rows<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_name = 'expected_move_observations'",
    );
    expect(found[0].count).toBe(1);
  });

  it('accepts a well-formed day', async () => {
    await database.exec(insert());
    const stored = await rows<{ atm_iv: string; days_to_expiry: number }>(
      "select atm_iv, days_to_expiry from public.expected_move_observations where symbol = 'AAPL'",
    );
    expect(Number(stored[0].atm_iv)).toBeCloseTo(0.284, 6);
    expect(stored[0].days_to_expiry).toBe(31);
  });

  it('keys one reading per symbol per day, so a retry overwrites', async () => {
    await database.exec(insert({ symbol: "'MSFT'", atm_iv: 0.2 }));
    await database.exec(`${insert({ symbol: "'MSFT'", atm_iv: 0.31 }).replace(/;$/, '')}
      on conflict (symbol, as_of) do update set atm_iv = excluded.atm_iv;`);
    const stored = await rows<{ atm_iv: string }>(
      "select atm_iv from public.expected_move_observations where symbol = 'MSFT'",
    );
    expect(stored).toHaveLength(1);
    expect(Number(stored[0].atm_iv)).toBeCloseTo(0.31, 6);
  });

  /*
   * The failure this table is most exposed to. A zero here reads, a year later,
   * as a day the market expected no movement at all — and nothing in the product
   * would have flagged it, because nothing reads the table.
   */
  it('refuses a zero or negative volatility', async () => {
    await expect(database.exec(insert({ symbol: "'ZERO'", atm_iv: 0 }))).rejects.toThrow();
    await expect(database.exec(insert({ symbol: "'NEG'", atm_iv: -0.2 }))).rejects.toThrow();
  });

  it('refuses a zero move, a zero spot and a same-day expiry', async () => {
    await expect(database.exec(insert({ symbol: "'A1'", implied_move: 0 }))).rejects.toThrow();
    await expect(database.exec(insert({ symbol: "'A2'", spot: 0 }))).rejects.toThrow();
    await expect(database.exec(insert({ symbol: "'A3'", days_to_expiry: 0 }))).rejects.toThrow();
  });

  it('requires the provider, so a break in the series is attributable', async () => {
    await expect(database.exec(
      `insert into public.expected_move_observations
       (symbol, as_of, spot, expiration, days_to_expiry, atm_iv, atm_strike, implied_move, implied_move_pct)
       values ('NOPROV', '2026-08-18', 100, '2026-09-18', 31, 0.2, 100, 5, 0.05);`,
    )).rejects.toThrow();
  });

  it('indexes the date on its own, which the primary key cannot serve', async () => {
    const indexes = await rows<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'expected_move_observations'",
    );
    expect(indexes.map((index) => index.indexname)).toContain('expected_move_observations_as_of_idx');
  });
});

describe('nothing reaches a client', () => {
  it('has row level security on and no policy', async () => {
    const table = await rows<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'expected_move_observations'",
    );
    expect(table[0].relrowsecurity).toBe(true);
    const policies = await rows<{ policyname: string }>(
      "select policyname from pg_policies where tablename = 'expected_move_observations'",
    );
    expect(policies).toEqual([]);
  });

  it('grants neither role anything', async () => {
    const granted = await rows<{ role: string; can: boolean }>(`
      select role, has_table_privilege(role, 'public.expected_move_observations', 'select') as can
      from (values ('anon'), ('authenticated')) as roles(role)
    `);
    expect(granted.every((row) => row.can === false)).toBe(true);
  });
});

describe('it collects and does not delete', () => {
  /*
   * The value of this table is its length, and a retention job's only possible
   * effect here is to destroy the thing being collected.
   */
  it('creates no retention sweep and schedules nothing', () => {
    const statements = rawSql.replace(/^\s*--.*$/gm, '');
    expect(statements).not.toMatch(/cron\.schedule/);
    expect(statements).not.toMatch(/delete\s+from/i);
    expect(statements).not.toMatch(/create\s+or\s+replace\s+function/i);
  });

  it('alters nothing that already exists', () => {
    const statements = rawSql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
    const alters = statements.match(/alter table [a-z_.]+/g) ?? [];
    expect(new Set(alters)).toEqual(new Set(['alter table public.expected_move_observations']));
    expect(statements).not.toContain('drop table');
  });

  it('reverses with the statement the file documents', async () => {
    const reversal = new PGlite();
    await reversal.exec(PLATFORM_ROLES);
    await reversal.exec(migrationSql);
    await reversal.exec('drop table if exists public.expected_move_observations;');
    const left = await reversal.query<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_name = 'expected_move_observations'",
    );
    expect(left.rows[0].count).toBe(0);
  });
});

describe('the file explains itself to whoever finds it', () => {
  /*
   * A table nobody reads for a year will be found by somebody who does not know
   * why it is there. If the file does not answer that, the safest-looking action
   * is to drop it — which destroys the only copy of something unrecoverable.
   */
  it('says why it exists and when it is worth reading', () => {
    expect(rawSql).toContain('NOT YET APPLIED');
    expect(rawSql).toMatch(/12 months|twelve months/i);
    expect(rawSql).toContain('docs/market-signal/expected-move-collection.md');
  });

  it('warns in the table comment itself, where a schema browser will show it', async () => {
    const comment = await rows<{ description: string }>(
      "select obj_description('public.expected_move_observations'::regclass) as description",
    );
    expect(comment[0].description).toContain('Nothing reads this table');
    expect(comment[0].description).toMatch(/twelve months/i);
  });
});
