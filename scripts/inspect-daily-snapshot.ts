/**
 * What is actually IN `daily_snapshot` — row count, latest date, symbols, and
 * the trading days that have no rows at all.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * The capture endpoint has been deployed for days and nothing has ever checked
 * that it ran. A cron that is not wired up fails in the quietest way there is:
 * the route returns 200 to anybody who calls it, the table stays valid and
 * empty, and every page that reads it degrades to the live-only path it had
 * before — so the product looks correct and the history it is supposed to be
 * accumulating simply does not exist.
 *
 * The only way to tell is to count rows and look at the dates. That is all this
 * does.
 *
 * ===========================================================================
 * IT IS READ-ONLY, AND IT CANNOT REACH PRODUCTION
 * ===========================================================================
 * Every statement is a select. Beyond that it resolves its target through
 * `src/lib/dev/db-target.ts`, which reads `.env.test` and THROWS on a
 * production project ref — there is no override flag, because the situation
 * where somebody reaches for one is the situation where they are wrong.
 *
 * For production, this script deliberately does not offer a path. Use the SQL
 * in `docs/operations/daily-snapshot-verification.md` on the Supabase
 * dashboard, where the queries run under a human's eyes and leave an audit
 * trail that a script run from a laptop does not.
 *
 *   npm run inspect:daily-snapshot
 */
import { createClient } from '@supabase/supabase-js';
import {
  ProductionTargetError,
  resolveDevSupabaseTarget,
  type DevSupabaseTarget,
} from '../src/lib/dev/db-target';

/*
  Resolved and CHECKED before a client is constructed — the same shape every
  other guarded script in this repo uses, and the shape `db-target.test.ts`
  reads these files to enforce. A guarded script that also keeps an unguarded
  connection is an unguarded script.
*/
let target: DevSupabaseTarget;
try {
  target = resolveDevSupabaseTarget('npm run inspect:daily-snapshot');
} catch (error) {
  if (error instanceof ProductionTargetError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const client = createClient(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** US market holidays are not modelled here — see the note in `report`. */
function weekdaysBetween(first: string, last: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${first}T00:00:00.000Z`);
  const end = new Date(`${last}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

async function main() {
  console.log(`\ndaily_snapshot — ${target.url}\n${'='.repeat(60)}`);

  const { count, error: countError } = await client
    .from('daily_snapshot')
    .select('*', { count: 'exact', head: true });

  if (countError) {
    console.error(`\nCould not read daily_snapshot: ${countError.message}`);
    console.error('If this is "relation does not exist", the migration has not been applied here.');
    process.exit(1);
  }

  console.log(`rows: ${count ?? 0}`);

  if (!count) {
    /*
      The headline result, stated as a conclusion rather than left for the
      reader to infer from a zero. An empty table after a deploy means the
      capture has never completed once.
    */
    console.log('\nTHE TABLE IS EMPTY.');
    console.log('The capture has never written a row against this project.');
    console.log('Expected when the cron is not scheduled — see');
    console.log('docs/operations/daily-snapshot-verification.md.\n');
    return;
  }

  const { data: dates } = await client
    .from('daily_snapshot')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);
  const { data: earliest } = await client
    .from('daily_snapshot')
    .select('date')
    .order('date', { ascending: true })
    .limit(1);

  const maxDate = dates?.[0]?.date as string | undefined;
  const minDate = earliest?.[0]?.date as string | undefined;
  console.log(`date range: ${minDate} .. ${maxDate}`);

  /*
    Paged, because a select without a range caps at Supabase's default and a
    truncated read here would under-report both the symbol set and the gaps —
    the two things this script exists to report.
  */
  const rows: Array<{ date: string; symbol: string }> = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('daily_snapshot')
      .select('date, symbol')
      .order('date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data as Array<{ date: string; symbol: string }>));
    if (!data || data.length < PAGE) break;
  }

  const symbols = [...new Set(rows.map((row) => row.symbol))].sort();
  console.log(`distinct symbols: ${symbols.length}`);
  console.log(`symbols: ${symbols.join(', ')}`);

  const byDate = new Map<string, number>();
  for (const row of rows) byDate.set(row.date, (byDate.get(row.date) ?? 0) + 1);
  console.log('\nrows per captured date:');
  for (const [date, n] of [...byDate].sort()) console.log(`  ${date}  ${n}`);

  /*
    GAPS ARE REPORTED AS WEEKDAYS WITHOUT ROWS, NOT AS MISSED RUNS.

    This deliberately does not model the US market holiday calendar. A weekday
    with no rows is a fact; calling it a missed capture would be a claim, and on
    Thanksgiving or Christmas it would be a false one. The reader knows which
    holidays fall in the range — the script does not, and guessing would make
    the honest half of the output less trustworthy.
  */
  if (minDate && maxDate) {
    const missing = weekdaysBetween(minDate, maxDate).filter((day) => !byDate.has(day));
    console.log(`\nweekdays in range with no rows: ${missing.length}`);
    if (missing.length) {
      console.log(`  ${missing.join(', ')}`);
      console.log('  (US market holidays are NOT excluded — check these against the calendar.)');
    }
  }
  console.log();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
