import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { serverEnv } from '@/src/config/env/server';
import { createAdminClient } from '@/src/lib/supabase/admin';
import { runDailySnapshotCapture } from '@/src/lib/market-data/daily-snapshot-run';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Post-market capture of the day's closes.
 *
 * ===========================================================================
 * THE SCHEDULE, AND WHY IT IS 21:10 UTC RATHER THAN "16:10 ET"
 * ===========================================================================
 * `vercel.json` fires this at `10 21 * * 1-5`. Vercel cron expressions are
 * evaluated in UTC and there is no zone to set, so a schedule written as a New
 * York wall clock has to be chosen for BOTH halves of the year.
 *
 * The obvious reading of "16:10 ET" is 20:10 UTC, and that choice is broken for
 * roughly four months a year:
 *
 *     20:10 UTC  →  16:10 ET in EDT (after the close — fine)
 *                →  15:10 ET in EST (MARKET STILL OPEN — the guard refuses,
 *                                    and nothing is ever captured all winter)
 *
 *     21:10 UTC  →  17:10 ET in EDT (after-hours, same trading day)
 *                →  16:10 ET in EST (after the close, same trading day)
 *
 * So 21:10 UTC is the earliest single time that is past the closing bell under
 * both offsets. The hour of drift across the DST boundary is ACCEPTED, not
 * overlooked: in summer this runs at 17:10 ET instead of 16:10, which is still
 * inside the after-hours window and still the same trading date, so the row it
 * writes is identical. `lastCompletedSessionDate` was checked at both offsets
 * and resolves to the same session either way.
 *
 * MONDAY TO FRIDAY, not every day, and that is about spend rather than safety.
 * On a Saturday the session is CLOSED (not OPEN), so the guard lets the run
 * through and `lastCompletedSessionDate` answers *Friday* — a weekend run would
 * therefore re-capture Friday's closes twice for no new data. The upsert makes
 * it harmless and the provider calls make it wasteful. A market holiday still
 * costs one redundant re-capture, which is a handful of days a year and not
 * worth a holiday calendar to avoid.
 *
 * ===========================================================================
 * FIRING EARLY IS NOT A DATA HAZARD
 * ===========================================================================
 * The run refuses to write while the market is open, and refuses again for any
 * target date that is not a trading date. A refusal returns 200 with a reason,
 * because a scheduler that fires on a public holiday has not failed — there was
 * simply nothing to capture. That guard is what makes the schedule above a
 * cost decision rather than a correctness one, and it is covered by
 * `src/lib/market-data/daily-snapshot-run.test.ts`.
 *
 * ===========================================================================
 * AUTHORIZATION
 * ===========================================================================
 * Same bearer-secret shape as `/api/cron/alerts`, compared in constant time.
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations
 * whenever that variable is set on the project, so the platform's own mechanism
 * and this route's check are the same secret — no new variable is introduced.
 *
 * `CRON_SECRET` unset means every caller is rejected, including Vercel. That is
 * deliberate: an endpoint that writes market data must not be open because a
 * variable was forgotten.
 */
function authorized(request: NextRequest): boolean {
  const expected = serverEnv.CRON_SECRET;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

type SnapshotAudit =
  | 'daily_snapshot_written'
  | 'daily_snapshot_refused'
  | 'daily_snapshot_rejected'
  | 'daily_snapshot_failed';

/**
 * One line per run, structured, so a deploy can be checked without a database.
 *
 * The whole point of logging here is that this job's failures are SILENT: a run
 * that refuses and a run that never fired both leave an empty table, and until
 * now the only way to tell them apart was to query production. A line naming
 * the outcome and the counts distinguishes them from the Vercel log alone.
 *
 * Nothing personal reaches the log — symbol and contract COUNTS are product
 * facts, and no reader, holding or price is named. Same rule the billing
 * webhook's audit line follows.
 */
function record(event: SnapshotAudit, detail: Record<string, unknown>) {
  const payload = JSON.stringify({ event, ...detail });
  if (event === 'daily_snapshot_written' || event === 'daily_snapshot_refused') {
    console.info(payload);
  } else {
    console.warn(payload);
  }
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    record('daily_snapshot_rejected', { reason: 'unauthorized' });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const client = createAdminClient();
  if (!client) {
    record('daily_snapshot_failed', { reason: 'not_configured' });
    return NextResponse.json({ error: 'Daily snapshot capture is not configured' }, { status: 503 });
  }
  try {
    const data = await runDailySnapshotCapture(client);
    if (data.refused) {
      /*
        A refusal is an ordinary outcome and is logged as one. `market-open`
        means the schedule drifted or somebody triggered it by hand;
        `no-completed-session` and `not-a-trading-day` mean the calendar had
        nothing to offer. None of the three is an error.
      */
      record('daily_snapshot_refused', { refused: data.refused, date: data.date });
    } else {
      record('daily_snapshot_written', {
        date: data.date,
        written: data.written,
        skipped: data.skipped,
        symbols: data.symbols,
        contracts: data.contracts,
        unpriced: data.unpriced,
      });
    }
    return NextResponse.json({ data });
  } catch {
    record('daily_snapshot_failed', { reason: 'capture_threw' });
    return NextResponse.json({ error: 'Daily snapshot capture failed' }, { status: 503 });
  }
}
