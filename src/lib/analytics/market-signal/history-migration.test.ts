import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

/**
 * The P6 migration, applied to a real Postgres before it is applied to ours.
 *
 * The brief made this migration a stop-and-report, which is only worth anything
 * if the thing being reported on has been shown to do what the prose says. Every
 * claim below is one somebody would otherwise have to take on trust from a
 * comment:
 *
 *   * it applies standalone and touches nothing that already exists;
 *   * one row per symbol per day is enforced by the schema, not by the caller;
 *   * RLS is on with NO policy, which is what makes the table unreachable from a
 *     browser — the entitlement boundary this feature depends on;
 *   * the retention sweep reports before it deletes, and refuses a window short
 *     enough to be a typo;
 *   * it is reversible, and the reversal in the file actually runs.
 */

const MIGRATION_FILE = '202608180001_market_signal_history.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8');

/*
 * The reversal lives in a trailing comment block, so the file cannot be fed to
 * Postgres whole — everything after the migration's own `commit;` is prose.
 */
const [migrationSql] = rawSql.split(/^-- =+\s*\n-- Reversal/m);

let database: PGlite;

/*
 * Supabase's roles are part of the platform rather than of any migration in this
 * repository, so a bare Postgres has to be given them before a file that revokes
 * from them will apply. Same approach the account-deletion migration tests take.
 */
const PLATFORM_ROLES = `
  do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
`;

beforeAll(async () => {
  database = new PGlite();
  await database.exec(PLATFORM_ROLES);
  await database.exec(migrationSql);
});

const rows = async <T>(sql: string): Promise<T[]> => (await database.query<T>(sql)).rows;

describe('the table', () => {
  it('applies on its own, with no dependency on any earlier migration', async () => {
    const found = await rows<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_name = 'market_signal_history'",
    );
    expect(found[0].count).toBe(1);
  });

  it('keys one row per symbol per day, so a second read of a day updates it', async () => {
    await database.exec(`
      insert into public.market_signal_history (symbol, as_of, state, bias, score)
      values ('AAPL', '2026-08-12', 'SIDEWAYS', 'neutral', 3)
      on conflict (symbol, as_of) do update set state = excluded.state, score = excluded.score;
      insert into public.market_signal_history (symbol, as_of, state, bias, score)
      values ('AAPL', '2026-08-12', 'BULLISH', 'bullish', 42)
      on conflict (symbol, as_of) do update set state = excluded.state, score = excluded.score;
    `);
    const stored = await rows<{ state: string; score: number; count: number }>(
      "select state, score, count(*) over ()::int as count from public.market_signal_history where symbol = 'AAPL'",
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].state).toBe('BULLISH');
  });

  it('refuses a state the card cannot render', async () => {
    await expect(database.exec(`
      insert into public.market_signal_history (symbol, as_of, state, bias)
      values ('AAPL', '2026-08-13', 'MOON', 'bullish');
    `)).rejects.toThrow();
  });

  it('refuses a symbol that is not the shape every other table uses', async () => {
    await expect(database.exec(`
      insert into public.market_signal_history (symbol, as_of, state, bias)
      values ('aapl', '2026-08-14', 'SIDEWAYS', 'neutral');
    `)).rejects.toThrow();
  });

  it('accepts the futures and crypto tickers the card already covers', async () => {
    await database.exec(`
      insert into public.market_signal_history (symbol, as_of, state, bias)
      values ('GC-F', '2026-08-12', 'SIDEWAYS', 'neutral'), ('BTC-USD', '2026-08-12', 'BULLISH', 'bullish');
    `);
    const stored = await rows<{ count: number }>(
      "select count(*)::int as count from public.market_signal_history where symbol in ('GC-F', 'BTC-USD')",
    );
    expect(stored[0].count).toBe(2);
  });

  it('allows a null zone, because a day with SIGNAL_ZONES off is a real day', async () => {
    await database.exec(`
      insert into public.market_signal_history (symbol, as_of, state, bias, zone)
      values ('MSFT', '2026-08-12', 'SQUEEZE', 'neutral', null);
    `);
    const stored = await rows<{ zone: string | null }>(
      "select zone from public.market_signal_history where symbol = 'MSFT'",
    );
    expect(stored[0].zone).toBeNull();
  });

  it('indexes the date on its own, which the primary key cannot serve', async () => {
    const indexes = await rows<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'market_signal_history'",
    );
    expect(indexes.map((index) => index.indexname)).toContain('market_signal_history_as_of_idx');
  });
});

/*
 * The entitlement boundary, expressed as an absence.
 *
 * RLS on with no policy means `anon` and `authenticated` select nothing, which
 * is the whole reason a table of the product's paid output can exist without a
 * Basic session being able to read every label it ever published. A policy
 * added here later would move that decision out of `loadEntitledMarketSignal`,
 * where it is tested, and into a place nobody looks.
 */
describe('nothing reaches a client directly', () => {
  it('has row level security enabled', async () => {
    const table = await rows<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'market_signal_history'",
    );
    expect(table[0].relrowsecurity).toBe(true);
  });

  it('has no policy at all, which is what makes it unreadable', async () => {
    const policies = await rows<{ policyname: string }>(
      "select policyname from pg_policies where tablename = 'market_signal_history'",
    );
    expect(policies).toEqual([]);
  });

  it('grants neither role any privilege on the table', async () => {
    const granted = await rows<{ role: string; can: boolean }>(`
      select role, has_table_privilege(role, 'public.market_signal_history', 'select') as can
      from (values ('anon'), ('authenticated')) as roles(role)
    `);
    expect(granted.map((row) => `${row.role}:${row.can}`)).toEqual(['anon:false', 'authenticated:false']);
  });

  it('keeps the retention sweep off both roles too', async () => {
    const granted = await rows<{ role: string; can: boolean }>(`
      select role, has_function_privilege(
        role, 'public.sweep_market_signal_history(integer, boolean)', 'execute'
      ) as can
      from (values ('anon'), ('authenticated')) as roles(role)
    `);
    expect(granted.every((row) => row.can === false)).toBe(true);
  });
});

describe('retention', () => {
  const seed = `
    insert into public.market_signal_history (symbol, as_of, state, bias) values
      ('NVDA', (now() at time zone 'utc')::date - 500, 'SIDEWAYS', 'neutral'),
      ('NVDA', (now() at time zone 'utc')::date - 401, 'SIDEWAYS', 'neutral'),
      ('NVDA', (now() at time zone 'utc')::date - 399, 'BULLISH', 'bullish'),
      ('NVDA', (now() at time zone 'utc')::date - 1, 'BULLISH', 'bullish')
    on conflict do nothing;
  `;

  it('counts what is due and deletes nothing by default', async () => {
    await database.exec(seed);
    const before = await rows<{ count: number }>(
      "select count(*)::int as count from public.market_signal_history where symbol = 'NVDA'",
    );
    const report = await rows<{ due: number; deleted: number }>(
      'select * from public.sweep_market_signal_history(400)',
    );
    expect(Number(report[0].due)).toBe(2);
    expect(Number(report[0].deleted)).toBe(0);

    const after = await rows<{ count: number }>(
      "select count(*)::int as count from public.market_signal_history where symbol = 'NVDA'",
    );
    expect(after[0].count).toBe(before[0].count);
  });

  it('deletes only what it reported, and only when told to', async () => {
    await database.exec(seed);
    const report = await rows<{ due: number; deleted: number }>(
      'select * from public.sweep_market_signal_history(400, true)',
    );
    expect(Number(report[0].deleted)).toBe(2);

    const left = await rows<{ count: number }>(
      "select count(*)::int as count from public.market_signal_history where symbol = 'NVDA'",
    );
    expect(left[0].count).toBe(2);
  });

  /*
   * A retention window is a delete, and a delete is one typo away from being a
   * truncate. Refusing anything under a month is not a policy — it is a guard
   * against `sweep(4)` when `sweep(400)` was meant.
   */
  it('refuses a window short enough to be a mistake', async () => {
    await expect(database.query('select * from public.sweep_market_signal_history(4, true)'))
      .rejects.toThrow(/MARKET_SIGNAL_HISTORY_RETENTION_TOO_SHORT/);
  });

  it('is not scheduled by this migration', () => {
    // The first thing a new feature does unattended must not be a delete.
    // Comments stripped, because the file explains at length that it is
    // deliberately NOT scheduling anything, and an assertion about the DDL must
    // not be able to trip over the prose saying so.
    const statements = rawSql.replace(/^\s*--.*$/gm, '');
    expect(statements).not.toMatch(/cron\.schedule/);
  });
});

describe('reversibility', () => {
  it('alters nothing that already exists', () => {
    const statements = rawSql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
    expect(statements).not.toContain('alter table public.stock_plans');
    expect(statements).not.toContain('drop table');
    // The only `alter table` in the file is the one enabling RLS on its own table.
    const alters = statements.match(/alter table [a-z_.]+/g) ?? [];
    expect(new Set(alters)).toEqual(new Set(['alter table public.market_signal_history']));
  });

  it('reverses with the statements the file documents', async () => {
    const reversal = new PGlite();
    await reversal.exec(PLATFORM_ROLES);
    await reversal.exec(migrationSql);
    await reversal.exec(`
      drop function if exists public.sweep_market_signal_history(integer, boolean);
      drop table if exists public.market_signal_history;
    `);
    const left = await reversal.query<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_name = 'market_signal_history'",
    );
    expect(left.rows[0].count).toBe(0);
  });
});
