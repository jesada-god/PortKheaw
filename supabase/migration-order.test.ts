import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * A STATUS HEADER MUST BE A CLAIM SOMEBODY CAN BE HELD TO.
 *
 * ===========================================================================
 * WHAT WENT WRONG, AND WHY PROSE DID NOT CATCH IT
 * ===========================================================================
 * Five migrations carried the sentence "NOT YET APPLIED" at the top while their
 * tables were live in production — `202608180001`, `202608210001`,
 * `202608290001`, `202608290002` and `202608290003`. Two more enumerated those
 * five as a queue still ahead of them. Nothing was wrong when any of it was
 * written; it simply was never revisited, and there was no form to revisit,
 * because a status written as a paragraph is a status nothing can read.
 *
 * So the status is a two-line block with a fixed grammar, and these tests read
 * it. See `docs/operations/migration-state.md`.
 *
 * ===========================================================================
 * WHAT THIS CAN AND CANNOT ASSERT
 * ===========================================================================
 * It CANNOT check a claim against production, and nothing offline can: there is
 * no `schema_migration_log` there and no checksum of any file. A header saying
 * APPLIED of a table that does not exist passes every test below.
 *
 * What it does enforce is that the claim is WELL FORMED, DATED, and CONSISTENT
 * WITH ITSELF ACROSS FILES — which is exactly the class the five files failed.
 * A stale APPLIED is a fact nobody re-checked; a stale queue is a file
 * contradicting its neighbours, and that is machine-readable.
 */
describe('the migration status headers', () => {
  const HEADER_LINES = 40;
  const STATUSES = ['APPLIED', 'NOT YET APPLIED'] as const;
  const lines = (file: string) => sql(file).split(/\r?\n/);

  /** The status a file claims, or null when it carries no status block. */
  const statusOf = (file: string): string | null => {
    const found = lines(file)
      .map((line) => /^-- STATUS: (.+)$/.exec(line.trimEnd())?.[1])
      .filter((value): value is string => value !== undefined);
    return found.length === 1 ? found[0] : null;
  };

  const MARKED = FILES.filter((file) => statusOf(file) !== null);
  const UNAPPLIED = MARKED.filter((file) => statusOf(file) === 'NOT YET APPLIED');

  /*
   * AN EMPTY QUEUE IS A LEGITIMATE STATE, AND THE FIRST VERSION OF THIS DENIED
   * IT.
   *
   * This asserted `UNAPPLIED.length > 0`, which held while three migrations were
   * pending and went red the moment they were applied and their headers told the
   * truth about it. A test that fails when the repository becomes correct is a
   * test that pushes back towards the lie.
   *
   * What is actually needed is that there are statuses to read at all. Every
   * assertion below is over `MARKED`, so that is the only floor that keeps them
   * from passing on an empty set.
   */
  it('has statuses to check, so a pass is never vacuous', () => {
    expect(MARKED.length).toBeGreaterThanOrEqual(5);
    expect(UNAPPLIED.length).toBeLessThanOrEqual(MARKED.length);
  });

  /*
   * One status line, one of two spellings, inside the header.
   *
   * "One" matters as much as the spelling: a second one added lower down while
   * the first is left alone is the same drift in a new shape.
   */
  it('states a status exactly once, in a form with only two spellings', () => {
    const problems: string[] = [];
    for (const file of FILES) {
      const all = lines(file);
      const at = all
        .map((line, index) => ({ line: line.trimEnd(), index }))
        .filter(({ line }) => line.startsWith('-- STATUS:'));
      if (at.length === 0) continue;
      if (at.length > 1) {
        problems.push(`${file} carries ${at.length} STATUS lines; there may be one`);
        continue;
      }
      const [only] = at;
      const claim = /^-- STATUS: (.+)$/.exec(only.line)?.[1];
      if (claim === undefined || !STATUSES.includes(claim as (typeof STATUSES)[number])) {
        problems.push(`${file} says "${only.line}"; expected one of ${STATUSES.join(' | ')}`);
      }
      if (only.index >= HEADER_LINES) {
        problems.push(`${file} states its status at line ${only.index + 1}, below the header`);
      }
    }
    expect(problems).toEqual([]);
  });

  /*
   * "NOT YET APPLIED" as prose is banned outright.
   *
   * The old headers were prose, and prose is what nothing could read. Allowing
   * both forms would let a file drift back to the unreadable one while still
   * passing everything above.
   */
  it('never states a status as prose, only as a STATUS line', () => {
    const problems: string[] = [];
    for (const file of FILES) {
      lines(file).forEach((line, index) => {
        if (!line.includes('NOT YET APPLIED')) return;
        if (line.trimEnd() === '-- STATUS: NOT YET APPLIED') return;
        problems.push(`${file}:${index + 1} states a status in prose: ${line.trim()}`);
      });
    }
    expect(problems).toEqual([]);
  });

  /*
   * Every status is dated, and the date is real and not in the future.
   *
   * An undated APPLIED is the exact failure this whole block exists for: true
   * when written, unfalsifiable afterwards, and nothing says when to look again.
   */
  it('dates every status, on the line directly below it', () => {
    const problems: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const file of MARKED) {
      const all = lines(file);
      const index = all.findIndex((line) => line.trimEnd().startsWith('-- STATUS:'));
      const next = (all[index + 1] ?? '').trimEnd();
      const match = /^-- VERIFIED: (\d{4}-\d{2}-\d{2}), by (.+)\.$/.exec(next);
      if (!match) {
        problems.push(
          `${file} follows its STATUS with "${next}"; expected `
          + '"-- VERIFIED: YYYY-MM-DD, by <how>."',
        );
        continue;
      }
      const [, date, how] = match;
      if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        problems.push(`${file} is verified on ${date}, which is not a real date`);
      } else if (date > today) {
        problems.push(`${file} is verified on ${date}, which is in the future`);
      }
      if (how.trim().length < 4) {
        problems.push(`${file} does not say how it was verified`);
      }
    }
    expect(problems).toEqual([]);
  });

  /*
   * The unapplied files are the TAIL of filename order.
   *
   * Migrations are applied in filename order and none of the runners can skip
   * one, so an applied file sorting after an unapplied one describes a database
   * that cannot be rebuilt. A file with no status block counts as applied — the
   * convention is newer than most of this directory.
   */
  it('leaves the unapplied files at the end of filename order', () => {
    const first = FILES.findIndex((file) => statusOf(file) === 'NOT YET APPLIED');
    if (first === -1) return;
    const after = FILES.slice(first).filter((file) => statusOf(file) !== 'NOT YET APPLIED');
    expect(after).toEqual([]);
  });

  /*
   * A QUEUE line names the unapplied set, and agrees with every other one.
   *
   * This is the assertion that catches the failure directly. `202608300001`
   * called itself sixth of eight and listed five files that were already in
   * production; the moment one of the three remaining files is applied and its
   * own status changes, every QUEUE line that still names it goes red.
   */
  it('lists the same unapplied queue everywhere a queue is written', () => {
    const expected = UNAPPLIED.map((file) => file.slice(0, 12));
    const problems: string[] = [];
    for (const file of FILES) {
      for (const line of lines(file)) {
        const match = /^-- QUEUE: (.+)$/.exec(line.trimEnd());
        if (!match) continue;
        if (statusOf(file) !== 'NOT YET APPLIED') {
          problems.push(`${file} writes a QUEUE line but is not itself unapplied`);
        }
        const listed = match[1].split(',').map((id) => id.trim());
        if (listed.join(' ') !== expected.join(' ')) {
          problems.push(
            `${file} queues [${listed.join(', ')}]; the unapplied files are `
            + `[${expected.join(', ')}]`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

/**
 * THE PROSE COPY OF THE QUEUE, HELD TO THE HEADERS.
 *
 * ===========================================================================
 * THE DRIFT THIS CLOSES
 * ===========================================================================
 * `docs/operations/migration-state.md` carried a "Not yet applied" section
 * naming `202608300001`, `202608310001` and `202608310002` for three days after
 * all three were applied and their own headers said `STATUS: APPLIED`. Four
 * other places said the same thing in different words: `PHASE2_CONTRACT.md`
 * listed the same three as pending, `alert-sweep-schedule.md` said the sweep's
 * tables were unapplied migrations, and two source comments — in `app/page.tsx`
 * and `WatchlistTable.tsx` — told a reader the alert count is unreadable "in
 * every deployment today".
 *
 * The block above already pins the SQL headers against each other, and it
 * passed the whole time. Nothing read the documents, so the documents drifted,
 * and it was invisible because the rendered result is identical either way: an
 * unreadable count and a count of zero both draw nothing.
 *
 * ===========================================================================
 * ONE CURATED LIST, NOT A SCAN OF THE PROSE
 * ===========================================================================
 * The first attempt was a repository-wide scan: every twelve-digit migration id
 * sitting on a line with "not applied" / "unapplied" / "ยังไม่ได้ apply" must be
 * a file that is actually unapplied. It was written and run before this was, and
 * it is NOT shipped, because it found three lines and all three were correct:
 *
 *   PLAN.md             "~~ยังไม่ได้ apply~~ — แก้แล้ว: `202608300001` apply แล้ว"
 *   cron/alerts/route   "used to name unapplied migrations as the likely cause;
 *                        `202608300001` and `202608310001` are applied"
 *   PHASE2_CONTRACT.md  "ห้าไฟล์ที่เคยเขียนว่า NOT YET APPLIED … apply ไปแล้วทั้งหมด"
 *
 * That is the shape a correction takes in this repository — the fixed sentence
 * keeps the wrong one beside it and says what changed — so a proximity scan
 * fires on exactly the writing it exists to reward. Telling "X is not applied"
 * from "X used to be described as not applied" needs the meaning of the
 * sentence, and a heuristic that guessed would teach people to write worse prose
 * to keep a test green. Same reason `no-banned-copy` skips comments.
 *
 * So there is ONE machine-readable list, in the file whose job is to hold it,
 * and everything else is prose pointing at it. That list is what is checked.
 */
describe('the documented migration state', () => {
  const DOC = fileURLToPath(new URL('../docs/operations/migration-state.md', import.meta.url));
  const doc = readFileSync(DOC, 'utf8');
  const docLines = doc.split(/\r?\n/);

  const statusLines = (file: string) => readFileSync(join(root, file), 'utf8').split(/\r?\n/);
  const statusOf = (file: string): string | null => {
    const found = statusLines(file)
      .map((line) => /^-- STATUS: (.+)$/.exec(line.trimEnd())?.[1])
      .filter((value): value is string => value !== undefined);
    return found.length === 1 ? found[0] : null;
  };
  const UNAPPLIED = FILES.filter((file) => statusOf(file) === 'NOT YET APPLIED');

  /**
   * The numbered list under `## Not yet applied`, and nothing else in it.
   *
   * Read from the numbered items alone rather than from every backticked span in
   * the section, so the paragraphs around the list can discuss a file — which
   * ones stopped being pending, what follows from one still being unapplied —
   * without a mention turning into a claim.
   */
  const listed = (): string[] => {
    const start = docLines.findIndex((line) => line.trim() === '## Not yet applied');
    if (start === -1) return [];
    const rest = docLines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith('## '));
    return (end === -1 ? rest : rest.slice(0, end))
      .map((line) => /^\d+\.\s+`([^`]+)`$/.exec(line.trim())?.[1])
      .filter((value): value is string => value !== undefined);
  };

  it('has a section to read, so a pass is never vacuous', () => {
    expect(docLines).toContain('## Not yet applied');
    expect(doc.length).toBeGreaterThan(1_000);
  });

  /*
   * THE ASSERTION: the document's list and the files' own headers are the same
   * set, in the same order.
   *
   * Order as well as membership. The runners apply in filename order and cannot
   * skip one, so a list naming them out of order describes a sequence nobody can
   * perform.
   */
  it('lists exactly the files whose headers say they are unapplied', () => {
    expect(listed()).toEqual(UNAPPLIED);
  });

  /*
   * Every listed name is a file that exists. Otherwise a rename leaves the
   * document naming a migration nobody can run, and the comparison above would
   * still pass on the day of the rename if the header moved with the file.
   */
  it('names only files that are on disk', () => {
    for (const file of listed()) {
      expect(existsSync(join(root, file)), `${file} is listed but not in supabase/migrations/`)
        .toBe(true);
    }
  });

  /*
   * The document's confirmation date is the date the headers cite.
   *
   * `migration-state.md` is where the method is written down — what a PostgREST
   * probe can and cannot establish — and every `VERIFIED:` line names that probe
   * on one day. If a later probe moves the headers and the document keeps its
   * old date, the document is summarising an observation older than the one it
   * describes, which is how "last confirmed" becomes decoration.
   */
  it('is dated the day the headers were verified', () => {
    const dates = new Set(
      FILES.flatMap((file) => statusLines(file)
        .map((line) => /^-- VERIFIED: (\d{4}-\d{2}-\d{2}),/.exec(line.trimEnd())?.[1])
        .filter((value): value is string => value !== undefined)),
    );
    expect(dates.size, `headers cite ${dates.size} different verification dates`).toBe(1);
    const [verified] = [...dates];
    const confirmed = /^Last confirmed \*\*(\d{4}-\d{2}-\d{2})\*\*/m.exec(doc)?.[1];
    expect(confirmed, 'migration-state.md states no "Last confirmed" date').toBe(verified);
  });
});
