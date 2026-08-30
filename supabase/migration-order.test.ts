import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MIGRATIONS MUST REPLAY FROM ZERO, IN FILENAME ORDER.
 *
 * ===========================================================================
 * WHY THIS IS NOT COVERED BY ANYTHING ELSE
 * ===========================================================================
 * `supabase db push` and `scripts/apply-migrations.ts` both apply
 * `supabase/migrations/*.sql` in FILENAME ORDER and neither can be told to skip
 * one. Production does not test that property: it was built by applying
 * migrations as they were written, sometimes by hand in an order the filenames
 * do not record. So a history can be un-replayable for weeks while every
 * deployed database is perfectly healthy — and the moment it is discovered is a
 * restore drill, which is the worst moment to discover it.
 *
 * These tests read the SQL and check the orderings that a from-scratch replay
 * depends on. They do not need a database.
 */

const root = fileURLToPath(new URL('./migrations/', import.meta.url));
const FILES = readdirSync(root).filter((file) => file.endsWith('.sql')).sort();
const sql = (file: string) => readFileSync(join(root, file), 'utf8');

/** Strip SQL line comments so prose about a statement is not read as one. */
const code = (file: string) => sql(file).replace(/^\s*--.*$/gm, '');

describe('the migration history replays from zero', () => {
  it('has migrations to check, so a pass is never vacuous', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  /*
   * A constraint must EXIST before anything validates it.
   *
   * `alter table ... validate constraint X` on a constraint that has not been
   * added yet is error 42704, and it aborts the whole replay — not a
   * data-dependent failure that a lightly-populated restore might survive, but
   * a certain one on an empty database.
   */
  it('adds every constraint before the migration that validates it', () => {
    const addedIn = new Map<string, number>();
    FILES.forEach((file, index) => {
      for (const match of code(file).matchAll(/add\s+constraint\s+([a-z0-9_]+)/gi)) {
        const name = match[1].toLowerCase();
        if (!addedIn.has(name)) addedIn.set(name, index);
      }
    });

    const problems: string[] = [];
    FILES.forEach((file, index) => {
      for (const match of code(file).matchAll(/validate\s+constraint\s+([a-z0-9_]+)/gi)) {
        const name = match[1].toLowerCase();
        const added = addedIn.get(name);
        if (added === undefined) {
          problems.push(`${file} validates ${name}, which no migration adds`);
        } else if (added > index) {
          problems.push(
            `${file} validates ${name}, but it is only added in ${FILES[added]} — `
            + 'a replay from zero fails here with 42704',
          );
        }
      }
    });

    /*
     * ONE KNOWN DEFECT, PINNED RATHER THAN LEFT RED.
     *
     * `202608240001` validates a constraint that `202608240003` adds, so a
     * replay from zero aborts with 42704 on an empty database. It is real, it
     * is open, and PLAN.md §9.1 records why it is not fixed in this branch:
     * all three files are already applied to production, so renumbering means
     * editing the `supabase_migrations.schema_migrations` ledger to match, and
     * that belongs with the next restore drill rather than beside it.
     *
     * The file's own header claims the renumber from `202608230002` fixed the
     * ordering. It did not — that move fixed the relationship to
     * `202608230003`, while the real dependency is `202608240003`, which still
     * sorts later.
     *
     * Pinned as an exact list rather than skipped, so:
     *   * a NEW ordering defect fails this test immediately, and
     *   * FIXING this one also fails it, which sends whoever did it here and to
     *     PLAN.md §9.1 to retire the entry rather than leaving a stale note.
     */
    const KNOWN = [
      '202608240001_billing_period_status_validate.sql validates '
      + 'user_subscriptions_granting_status_period_check, but it is only added in '
      + '202608240003_billing_period_status_atomicity.sql — a replay from zero fails here with 42704',
    ];
    expect(problems).toEqual(KNOWN);
  });

  /*
   * A table must exist before anything alters, indexes, or writes a policy for
   * it. Currently clean; here so it stays that way, since this is the same
   * class of defect as the constraint ordering above and is just as invisible
   * on a database that was built incrementally.
   */
  it('creates every table before the migration that uses it', () => {
    const createdIn = new Map<string, number>();
    FILES.forEach((file, index) => {
      const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi;
      for (const match of code(file).matchAll(pattern)) {
        const name = match[1].toLowerCase();
        if (!createdIn.has(name)) createdIn.set(name, index);
      }
    });

    const problems: string[] = [];
    FILES.forEach((file, index) => {
      const patterns = [
        /references\s+public\.([a-z0-9_]+)/gi,
        /alter\s+table\s+(?:if\s+exists\s+)?public\.([a-z0-9_]+)/gi,
        /create\s+policy[^;]*?\bon\s+public\.([a-z0-9_]+)/gi,
      ];
      for (const pattern of patterns) {
        for (const match of code(file).matchAll(pattern)) {
          const name = match[1].toLowerCase();
          const created = createdIn.get(name);
          if (created !== undefined && created > index) {
            problems.push(`${file} uses public.${name}, created later in ${FILES[created]}`);
          }
        }
      }
    });
    expect(problems).toEqual([]);
  });
});
