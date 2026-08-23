import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OPTIONS_SIGNAL_CONFIG } from './config';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

/**
 * The Options Signal history migration, applied to a real Postgres before it is
 * applied to ours.
 *
 * This table is what turns the IV and Put/Call percentiles from dead code into a
 * feature, so every claim its prose makes is one somebody would otherwise have
 * to take on trust:
 *
 *   * it applies standalone and touches nothing that already exists;
 *   * one row per symbol per captured date is enforced by the SCHEMA, so six
 *     page views in an afternoon cannot put six copies of one day into a
 *     sixty-day percentile;
 *   * RLS is on with NO policy, which is what keeps the archived inputs — the
 *     product's entire paid output — unreachable from a browser;
 *   * the retention sweep reports before it deletes, and refuses a window short
 *     enough to silently disable the percentile;
 *   * it is reversible, and the reversal in the file actually runs.
 */

const MIGRATION_FILE = '202608190001_options_signal_history.sql';
/* The sweep's second window — the access canary — arrived in its own file, and
 * the two are applied here in the order production applies them. */
const SWEEP_MIGRATION_FILE = '202608190003_options_signal_history_canary_sweep.sql';

const readMigration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8');

/* The reversal lives in a trailing comment block, so the file cannot be fed to
 * Postgres whole — everything after the migration's own `commit;` is prose. */
const splitReversal = (sql: string) => sql.split(/^-- =+\s*\n-- Reversal/m);

const [migrationSql, reversalBlock] = splitReversal(readMigration(MIGRATION_FILE));
const [sweepMigrationSql] = splitReversal(readMigration(SWEEP_MIGRATION_FILE));

let database: PGlite;

/* Supabase's roles are platform-level rather than part of any migration here, so
 * a bare Postgres has to be given them before a file that revokes from them will
 * apply. Same approach the Market Signal history migration test takes. */
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
  await database.exec(sweepMigrationSql);
});

const rows = async <T>(sql: string): Promise<T[]> => (await database.query<T>(sql)).rows;

describe('the table', () => {
  it('applies on its own, with no dependency on any earlier migration', async () => {
    const found = await rows<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_name = 'options_signal_history'",
    );
    expect(found[0].count).toBe(1);
  });

  it('holds every column the percentile bases and the archive need', async () => {
    const columns = await rows<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'options_signal_history' order by column_name`,
    );
    // Sorted in JS rather than trusting the server collation.
    const names = [...columns.map((column) => column.column_name)].sort();
    expect(names).toEqual([
      'captured_at', 'confidence', 'config_version', 'inputs', 'iv',
      'put_call_oi', 'put_call_volume', 'recorded_at', 'score', 'signal_type',
      'symbol', 'underlying_bias',
    ]);
    // A row that cannot say which model wrote it is one nothing may compare.
    const required = new Set(columns.filter((column) => column.is_nullable === 'NO').map((column) => column.column_name));
    expect(required.has('symbol')).toBe(true);
    expect(required.has('captured_at')).toBe(true);
    expect(required.has('config_version')).toBe(true);
    expect(required.has('inputs')).toBe(true);
  });

  it('enforces one row per symbol per captured date in the schema, not in the caller', async () => {
    await database.exec(`
      insert into public.options_signal_history (symbol, captured_at, config_version, iv, put_call_oi)
      values ('AAPL', '2026-08-18', '2026.08.19', 0.31, 1.1);
    `);
    // The second read of the same day REPLACES the first: a reading taken after
    // the close is the more complete statement about that day.
    await database.exec(`
      insert into public.options_signal_history (symbol, captured_at, config_version, iv, put_call_oi)
      values ('AAPL', '2026-08-18', '2026.08.19', 0.34, 1.2)
      on conflict (symbol, captured_at) do update set iv = excluded.iv, put_call_oi = excluded.put_call_oi;
    `);
    const stored = await rows<{ count: number; iv: number }>(
      "select count(*)::int as count, max(iv) as iv from public.options_signal_history where symbol = 'AAPL'",
    );
    expect(stored[0].count).toBe(1);
    expect(Number(stored[0].iv)).toBeCloseTo(0.34, 6);

    await expect(database.exec(`
      insert into public.options_signal_history (symbol, captured_at, config_version)
      values ('AAPL', '2026-08-18', '2026.08.19');
    `)).rejects.toThrow();
  });

  it('refuses a symbol shape the rest of the schema could not join on', async () => {
    await expect(database.exec(`
      insert into public.options_signal_history (symbol, captured_at, config_version)
      values ('aapl', '2026-08-17', '2026.08.19');
    `)).rejects.toThrow();
    // The futures and crypto tickers the product already covers must still fit.
    await database.exec(`
      insert into public.options_signal_history (symbol, captured_at, config_version)
      values ('BTC-USD', '2026-08-17', '2026.08.19'), ('GC-F', '2026-08-17', '2026.08.19');
    `);
  });

  it('rejects readings that are out of range rather than storing a broken percentile', async () => {
    for (const bad of [
      "insert into public.options_signal_history (symbol, captured_at, config_version, score) values ('MSFT', '2026-08-01', 'v', 140)",
      "insert into public.options_signal_history (symbol, captured_at, config_version, confidence) values ('MSFT', '2026-08-02', 'v', -3)",
      "insert into public.options_signal_history (symbol, captured_at, config_version, iv) values ('MSFT', '2026-08-03', 'v', 0)",
      "insert into public.options_signal_history (symbol, captured_at, config_version, put_call_oi) values ('MSFT', '2026-08-04', 'v', -1)",
      "insert into public.options_signal_history (symbol, captured_at, config_version, signal_type) values ('MSFT', '2026-08-05', 'v', 'PRIME_MAYBE')",
    ]) {
      await expect(database.exec(`${bad};`)).rejects.toThrow();
    }
  });

  it('takes the health canary row, which is the row with no inputs in it', async () => {
    /*
     * The bug that made this test exist.
     *
     * `inputs` is `not null default '{}'`, and a DEFAULT only fills a column
     * that is OMITTED — an explicit null is a constraint violation, 23502. The
     * canary writes a probe record with no engine input at all, the store sent
     * that as a literal null, the write was rejected, and the health check read
     * one rejected write as "the history store is unreachable". The card then
     * told every reader the percentiles were down while the table sat there
     * answering reads perfectly.
     *
     * Both halves are pinned: an explicit null is still refused (the constraint
     * is real and stays), and the payload the store now sends still lands.
     */
    await expect(database.exec(`
      insert into public.options_signal_history (symbol, captured_at, config_version, inputs)
      values ('ZZ-NULLIN', '2026-08-10', '2026.08.19', null);
    `)).rejects.toThrow();

    await database.exec(`
      insert into public.options_signal_history
        (symbol, captured_at, config_version, signal_type, underlying_bias, score, confidence,
         iv, put_call_oi, put_call_volume, inputs, recorded_at)
      values ('${OPTIONS_SIGNAL_CONFIG.history.canarySymbol}', '2026-08-10', '2026.08.19',
              null, null, null, 0, null, null, null, '{}'::jsonb, now())
      on conflict (symbol, captured_at) do update set recorded_at = excluded.recorded_at;
    `);
    const stored = await rows<{ count: number }>(
      `select count(*)::int as count from public.options_signal_history
       where symbol = '${OPTIONS_SIGNAL_CONFIG.history.canarySymbol}'`,
    );
    expect(stored[0].count).toBe(1);
  });

  it('serves the read path off its primary key, with no duplicate index beside it', async () => {
    const indexes = await rows<{ indexdef: string }>(
      "select indexdef from pg_indexes where tablename = 'options_signal_history' order by indexname",
    );
    const definitions = indexes.map((index) => index.indexdef);
    // (symbol, captured_at) as the primary key IS the index the range scan uses.
    expect(definitions.some((definition) => /PRIMARY|pkey/i.test(definition)
      && definition.includes('symbol') && definition.includes('captured_at'))).toBe(true);
    // Retention sweeps by date across all symbols, which the PK cannot serve.
    expect(definitions.some((definition) => /captured_at_idx/.test(definition))).toBe(true);
    expect(definitions).toHaveLength(2);
  });
});

describe('row level security', () => {
  it('is enabled with NO policy, which is the entitlement boundary', async () => {
    const enabled = await rows<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'options_signal_history'",
    );
    expect(enabled[0].relrowsecurity).toBe(true);

    const policies = await rows<{ count: number }>(
      "select count(*)::int as count from pg_policies where tablename = 'options_signal_history'",
    );
    expect(policies[0].count).toBe(0);
  });

  it('grants nothing to anon or authenticated', async () => {
    const grants = await rows<{ count: number }>(
      `select count(*)::int as count from information_schema.role_table_grants
       where table_name = 'options_signal_history' and grantee in ('anon', 'authenticated')`,
    );
    expect(grants[0].count).toBe(0);
  });
});

describe('retention', () => {
  it('reports what is due and deletes nothing by default', async () => {
    await database.exec(`
      insert into public.options_signal_history (symbol, captured_at, config_version)
      values ('NVDA', '2019-01-02', '2026.08.19');
    `);
    const reported = await rows<{ due: number; deleted: number }>(
      'select * from public.sweep_options_signal_history(400)',
    );
    expect(Number(reported[0].due)).toBeGreaterThan(0);
    expect(Number(reported[0].deleted)).toBe(0);

    const still = await rows<{ count: number }>(
      "select count(*)::int as count from public.options_signal_history where symbol = 'NVDA'",
    );
    expect(still[0].count).toBe(1);
  });

  it('deletes only past the window when told to apply', async () => {
    const applied = await rows<{ due: number; deleted: number }>(
      'select * from public.sweep_options_signal_history(400, true)',
    );
    expect(Number(applied[0].deleted)).toBe(Number(applied[0].due));
    const remaining = await rows<{ count: number }>(
      "select count(*)::int as count from public.options_signal_history where symbol = 'NVDA'",
    );
    expect(remaining[0].count).toBe(0);
    // Rows inside the window are untouched.
    const kept = await rows<{ count: number }>(
      "select count(*)::int as count from public.options_signal_history where symbol = 'AAPL'",
    );
    expect(kept[0].count).toBe(1);
  });

  it('refuses a window short enough to quietly switch the percentile off', async () => {
    // The percentile needs sixty readings; a 30-day retention would look like a
    // tidy-up and behave like a feature removal.
    await expect(rows('select * from public.sweep_options_signal_history(30, true)')).rejects.toThrow();
    await expect(rows('select * from public.sweep_options_signal_history(null, true)')).rejects.toThrow();
  });

  it('is driven by the same retention number the engine config declares', () => {
    expect(OPTIONS_SIGNAL_CONFIG.history.retentionDays).toBe(400);
    // The floor in the migration has to leave room for the percentile window.
    expect(OPTIONS_SIGNAL_CONFIG.history.retentionDays)
      .toBeGreaterThan(OPTIONS_SIGNAL_CONFIG.iv.minimumPercentileObservations);
    expect(sweepMigrationSql).toContain('retention_days < 90');
  });
});

/*
 * The access canary writes one row per day and nothing ever reads a row older
 * than the one it just wrote. Under the single 400-day window those rows simply
 * accumulated — more than a year of daily writes under a reserved symbol that no
 * percentile, no card and no query reads. It gets its own, much shorter window,
 * and its own counters, so clearing it can never be mistaken for real history
 * being deleted.
 */
describe('retention · the access canary', () => {
  const canary = OPTIONS_SIGNAL_CONFIG.history.canarySymbol;

  const sweep = (sql: string) =>
    rows<{ due: number; deleted: number; canary_due: number; canary_deleted: number }>(sql);

  it('clears canary rows on their own window while real history is untouched', async () => {
    // Start from a known canary state rather than from whatever the earlier
    // retention tests happened to leave, so the counts below mean one thing.
    await database.exec(
      `delete from public.options_signal_history where symbol = '${canary}';`,
    );
    await database.exec(`
      insert into public.options_signal_history (symbol, captured_at, config_version) values
        ('${canary}', (now() at time zone 'utc')::date - 400, '2026.08.19'),
        ('${canary}', (now() at time zone 'utc')::date - 60,  '2026.08.19'),
        ('${canary}', (now() at time zone 'utc')::date - 8,   '2026.08.19'),
        ('${canary}', (now() at time zone 'utc')::date - 1,   '2026.08.19'),
        ('MSFT',      (now() at time zone 'utc')::date - 100, '2026.08.19')
      on conflict (symbol, captured_at) do nothing;
    `);

    const reported = await sweep(
      `select * from public.sweep_options_signal_history(400, false, '${canary}', 7)`,
    );
    // Three canary rows are older than seven days; nothing has been deleted yet.
    expect(Number(reported[0].canary_due)).toBe(3);
    expect(Number(reported[0].canary_deleted)).toBe(0);
    // And the real MSFT reading at 100 days is nowhere near its own window.
    expect(Number(reported[0].due)).toBe(0);

    const applied = await sweep(
      `select * from public.sweep_options_signal_history(400, true, '${canary}', 7)`,
    );
    expect(Number(applied[0].canary_deleted)).toBe(3);
    expect(Number(applied[0].deleted)).toBe(0);

    const left = await rows<{ count: number }>(
      `select count(*)::int as count from public.options_signal_history where symbol = '${canary}'`,
    );
    // The row inside the window survives — a week of them is the record of when
    // the store was last reachable, which is all these rows can ever answer.
    expect(left[0].count).toBe(1);
    const history = await rows<{ count: number }>(
      "select count(*)::int as count from public.options_signal_history where symbol = 'MSFT'",
    );
    expect(history[0].count).toBe(1);
  });

  it('never counts canary rows as history, in either direction', async () => {
    await database.exec(`
      insert into public.options_signal_history (symbol, captured_at, config_version) values
        ('${canary}', (now() at time zone 'utc')::date - 500, '2026.08.19'),
        ('TSLA',      (now() at time zone 'utc')::date - 500, '2026.08.19')
      on conflict (symbol, captured_at) do nothing;
    `);
    const reported = await sweep(
      `select * from public.sweep_options_signal_history(400, false, '${canary}', 7)`,
    );
    // One of each, and they are reported as one of each — never as two of either.
    expect(Number(reported[0].due)).toBe(1);
    expect(Number(reported[0].canary_due)).toBe(1);
    await sweep(`select * from public.sweep_options_signal_history(400, true, '${canary}', 7)`);
  });

  it('refuses a canary window that would delete the row just written', async () => {
    // The probe is "is the row I just wrote there". A zero-day window would
    // delete it in the same breath, turning the health check into a liar.
    await expect(rows(`select * from public.sweep_options_signal_history(400, true, '${canary}', 0)`))
      .rejects.toThrow();
    await expect(rows(`select * from public.sweep_options_signal_history(400, true, '${canary}', null)`))
      .rejects.toThrow();
    // And an empty symbol would match nothing on either side, silently restoring
    // the accumulation this window exists to stop.
    await expect(rows("select * from public.sweep_options_signal_history(400, true, '   ', 7)"))
      .rejects.toThrow();
  });

  it('takes both canary numbers from the engine config, not from a literal', () => {
    expect(OPTIONS_SIGNAL_CONFIG.history.canaryRetentionDays).toBe(7);
    expect(OPTIONS_SIGNAL_CONFIG.history.canaryRetentionDays)
      .toBeLessThan(OPTIONS_SIGNAL_CONFIG.history.retentionDays);
    // The reserved symbol still satisfies the table's own symbol check.
    expect(OPTIONS_SIGNAL_CONFIG.history.canarySymbol).toMatch(/^[A-Z0-9][A-Z0-9.-]{0,19}$/);
  });
});

/**
 * THE DEPLOY-ORDER RISK, DEMONSTRATED RATHER THAN DESCRIBED.
 *
 * `2026.08.23` publishes a label the shipped schema does not admit. The
 * changelog and the runbook both say the migration must land first; this is the
 * part that shows what happens if it does not, on a real Postgres, so the
 * warning is a reproduction rather than a claim.
 *
 * On its OWN database, because it applies a migration the tests above are
 * written against the absence of.
 */
describe('the CONFLICTED label migration', () => {
  const CONFLICTED_MIGRATION_FILE = '202608230001_options_signal_history_conflicted_label.sql';
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(PLATFORM_ROLES);
    await db.exec(migrationSql);
    await db.exec(sweepMigrationSql);
  });

  const insertLabelled = (label: string, day: string) => db.exec(`
    insert into public.options_signal_history (symbol, captured_at, config_version, signal_type)
    values ('CONF', '${day}', '2026.08.23', '${label}');
  `);

  it('rejects CONFLICTED before it runs, with the SQLSTATE the boot guard keys on', async () => {
    /*
     * 23514 is not incidental. `checkOptionsSignalSchema` distinguishes "the
     * migration has not run" from "the database did not answer" by exactly this
     * code, and a guard that keyed on the wrong one would either refuse to boot
     * on a network blip or fail to refuse on the real thing.
     */
    await expect(insertLabelled('CONFLICTED', '2026-08-23')).rejects.toMatchObject({ code: '23514' });

    // …and SIDEWAYS still writes, which is what makes the failure SELECTIVE.
    // Every symbol whose evidence agrees keeps accumulating history while the
    // ones whose evidence disagrees stop, and nothing anywhere says so.
    await expect(insertLabelled('SIDEWAYS', '2026-08-23')).resolves.toBeDefined();
  });

  it('admits CONFLICTED once it runs, and leaves the other labels alone', async () => {
    await db.exec(readMigration(CONFLICTED_MIGRATION_FILE));

    await expect(insertLabelled('CONFLICTED', '2026-08-24')).resolves.toBeDefined();
    await expect(insertLabelled('PRIME_CALL', '2026-08-25')).resolves.toBeDefined();
    // The set is still closed: a typo is still a rejected write, not a new label.
    await expect(insertLabelled('CONFLICTING', '2026-08-26')).rejects.toMatchObject({ code: '23514' });
  });

  it('does not touch the rows already written, which is the deliberate part', async () => {
    // A pre-existing SIDEWAYS row was produced by an engine that could not tell
    // the two states apart. Reinterpreting it would be a guess about what a
    // retired model meant, and the `config_version` on the row already says so.
    const kept = await (await db.query<{ signal_type: string; config_version: string }>(
      "select signal_type, config_version from public.options_signal_history where captured_at = '2026-08-23'",
    )).rows;
    expect(kept).toEqual([{ signal_type: 'SIDEWAYS', config_version: '2026.08.23' }]);
  });

  it('ROLLBACK: an older app reads a CONFLICTED row without erroring', async () => {
    /*
     * The question a rollback plan has to answer. The CHECK constraint is
     * enforced on WRITE only, so rolling the app back while the migration stays
     * applied is safe for reads: the previous build selects the row and gets the
     * string 'CONFLICTED' in a column it types as a union that does not include
     * it. It does not throw at the database layer — which is precisely why the
     * label has to be handled defensively one layer up rather than trusted.
     *
     * What is NOT safe is reverting the migration under a new app, so the
     * runbook does not offer that as a step.
     */
    const readBack = await (await db.query<{ signal_type: string }>(
      "select signal_type from public.options_signal_history where captured_at = '2026-08-24'",
    )).rows;
    expect(readBack).toEqual([{ signal_type: 'CONFLICTED' }]);

    // And the old engine's own writes keep working beside it, unchanged.
    await expect(insertLabelled('CALL_WATCH', '2026-08-27')).resolves.toBeDefined();
  });
});

describe('reversal', () => {
  it('is written in the file, and actually runs', async () => {
    expect(reversalBlock).toContain('drop table if exists public.options_signal_history');
    const [, statements] = reversalBlock.split('--   begin;');
    const sql = (statements ?? '')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('--   '))
      .map((line) => line.trim().replace(/^--\s+/, ''))
      .join('\n');
    expect(sql).toContain('drop function');
    await database.exec(sql);

    const found = await rows<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_name = 'options_signal_history'",
    );
    expect(found[0].count).toBe(0);
  });
});
