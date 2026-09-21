import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE SWEEP AND THE FUNCTION IT CALLS, HELD TO THE SAME SHAPE.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * The five conditions are written down in three places:
 *
 *   1. `price_alerts_condition_check`         — the column
 *   2. `trigger_price_alert_service`          — the evaluator
 *   3. `AlertCondition` / `AlertConditionValue` — the domain and schema types
 *
 * (3) is pinned against itself at COMPILE time, by the two mutually exclusive
 * assignments in `./types.ts`. Nothing pins (1) and (2), and nothing pins the
 * argument list the sweep sends against the parameters the function declares —
 * both of those live in SQL that TypeScript never reads.
 *
 * That gap has already cost this product a whole kind. The dropped overview
 * alert table had its column CHECK widened to admit `earnings` while the
 * function that inserted rows was left on four values, so a kind could be
 * stored, evaluated, cooled down and recorded — and created by nobody, for a
 * month, with nothing detecting it. `202608310003` was written to repair it and
 * was never applied.
 *
 * So the pairs SQL cannot check for itself are checked here, by reading the
 * migration's text.
 *
 * ===========================================================================
 * WHAT THIS DOES NOT PROVE
 * ===========================================================================
 * That the migration has been APPLIED. It reads a file, and a file is a claim
 * about a database rather than the database. `npm run db:validate` answers
 * whether it runs; `docs/operations/migration-state.md` records where.
 *
 * The argument-name check in particular is the one that matters on a deploy:
 * PostgREST resolves a function by its argument NAMES, so a sweep sending a key
 * the deployed function does not declare gets `PGRST202` and every alert stops
 * firing until the migration lands. That failure is loud by design — see
 * `migration-state.md` — and this is what keeps it from being introduced by a
 * rename rather than by a deploy order.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const MIGRATION = read('../../../supabase/migrations/202609200001_unify_alert_rules.sql');
const BACKGROUND = read('./background.ts');
const TYPES = read('./types.ts');
const DATABASE = read('../../types/database.ts');

const CONDITIONS = ['above', 'below', 'percent_change_up', 'percent_change_down', 'earnings'];

/** The values a `condition in (...)` list admits, in the order written. */
function conditionsIn(sql: string): string[] {
  const match = /condition in \(([^)]*)\)/.exec(sql);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((found) => found[1]);
}

describe('the condition list, everywhere it is written', () => {
  it('the column CHECK admits exactly the five conditions', () => {
    /*
      Read from the `add constraint`, not from the first `condition in (` in the
      file — the reversal footer at the bottom carries the OLD four-value list on
      purpose, and a looser read would find it and pass on the wrong text.
    */
    const added = /add constraint price_alerts_condition_check\s*\n?\s*check \(([\s\S]*?)\);/
      .exec(MIGRATION);
    expect(added, 'the migration no longer adds price_alerts_condition_check').not.toBeNull();
    expect(conditionsIn(added![1])).toEqual(CONDITIONS);
  });

  it('the evaluator compares every condition the column admits', () => {
    const body = /matches_now :=([\s\S]*?);\s*\n\s*update public\.price_alerts/.exec(MIGRATION);
    expect(body, 'matches_now is not assigned the way this test reads it').not.toBeNull();
    const compared = [...body![1].matchAll(/owned_alert\.condition = '([^']+)'/g)]
      .map((found) => found[1]);
    expect([...compared].sort()).toEqual([...CONDITIONS].sort());
  });

  it('the domain and the schema types carry the same five', () => {
    for (const condition of CONDITIONS) {
      expect(TYPES, `AlertCondition is missing '${condition}'`).toContain(`'${condition}'`);
      expect(DATABASE, `AlertConditionValue is missing '${condition}'`).toContain(`'${condition}'`);
    }
  });

  it('nothing still describes the four-condition world as current', () => {
    /*
      The reversal footer is allowed to, and is the only thing that may: reverting
      IS the four-condition world. It is commented out, so the check is that every
      four-value list left in the file is on a commented line.
    */
    for (const line of MIGRATION.split('\n')) {
      if (!line.includes("'percent_change_down')")) continue;
      if (line.includes('earnings')) continue;
      expect(line.trimStart().startsWith('--'), `live four-condition list: ${line.trim()}`)
        .toBe(true);
    }
  });
});

describe('the sweep and the function it calls', () => {
  /** The parameter names the migration declares, in order. */
  const declared = (() => {
    const match = /create function public\.trigger_price_alert_service\(([\s\S]*?)\)\s*\nreturns/
      .exec(MIGRATION);
    expect(match, 'the migration does not create trigger_price_alert_service').not.toBeNull();
    return match![1]
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  })();

  /** The keys the sweep actually sends. */
  const sent = (() => {
    const match = /'trigger_price_alert_service',\s*\{([\s\S]*?)\n {8}\},/.exec(BACKGROUND);
    expect(match, 'background.ts does not call the RPC the way this test reads it').not.toBeNull();
    return [...match![1].matchAll(/^\s{10}([a-z_]+):/gm)].map((found) => found[1]);
  })();

  it('reads a real argument list out of each, so a pass is never vacuous', () => {
    expect(declared.length).toBe(10);
    expect(sent.length).toBe(10);
  });

  it('sends exactly the arguments the function declares', () => {
    /*
      PostgREST matches on the SET of names, not the order, so this compares
      sorted. A missing or misspelled name is PGRST202 at run time — for every
      alert, on every tick.
    */
    expect([...sent].sort()).toEqual([...declared].sort());
  });

  it('carries the reading the earnings condition needs', () => {
    expect(declared).toContain('observed_earnings_days');
    expect(sent).toContain('observed_earnings_days');
  });

  it('declares the same argument list it grants and revokes', () => {
    const grants = [...MIGRATION.matchAll(
      /(?:revoke all on|grant execute on) function public\.trigger_price_alert_service\(\s*([^)]*?)\s*\)/g,
    )].map((found) => found[1].replace(/\s+/g, ' ').trim());
    /*
      Two statements, and both must name the NEW signature. A grant left on the
      old one succeeds against the old function if it still exists and errors if
      it does not — neither outcome grants the function this migration created,
      and the sweep would then be refused at run time by a permission check
      nobody changed on purpose.
    */
    expect(grants.length).toBe(2);
    for (const list of grants) {
      expect(list).toBe('uuid, numeric, numeric, integer, timestamptz, text, text, text, text, text');
    }
  });
});
