import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { serverEnv } from '@/src/config/env/server';
import { createAdminClient } from '@/src/lib/supabase/admin';
import { runBackgroundAlerts } from '@/src/lib/alerts/background';
import { deliverPendingPushes } from '@/src/lib/push/service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * THE ALERT TICK. ONE PASS OVER ONE TABLE.
 *
 * ===========================================================================
 * WHERE THE SCHEDULE COMES FROM, AND WHY IT IS NOT IN vercel.json
 * ===========================================================================
 * This route is scheduled from Supabase pg_cron: the job
 * `portkheaw-background-notifications` in
 * `202608020003_supabase_notification_cron.sql` calls it every fifteen minutes.
 * `vercel.json` deliberately does not list it, and
 * `src/lib/market-data/daily-snapshot-run.test.ts` pins that — two schedulers on
 * one endpoint double-fire the pass, each invisible from the other's dashboard.
 *
 * See `docs/operations/alert-sweep-schedule.md` for the UTC-versus-ET arithmetic
 * and why a fifteen-minute cadence is immune to the DST mistake a daily one is
 * not.
 *
 * ===========================================================================
 * THERE USED TO BE A SECOND SWEEP HERE
 * ===========================================================================
 * `runOverviewAlertSweep` rode this same tick, behind `PHASE2_ALERTS`, reading
 * `overview_alert_rules` and writing `overview_alert_hits` — a parallel alert
 * system over the same four comparisons, with its own cooldown, its own
 * evaluator and no interface to create a rule with. `202609200001` merged its
 * one real capability (`earnings`) into `price_alerts` and dropped it.
 *
 * What it needed — a try/catch so a section of the Overview could not fail a run
 * that had already written Inbox items, and a `duplicateRun` check so a
 * double-invoked cron swept once — is gone with it. Both properties still hold,
 * and now they hold because there is one pass rather than because a second one
 * was carefully fenced off from the first.
 */

function authorized(request: NextRequest): boolean {
  const expected = serverEnv.CRON_SECRET;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const client = createAdminClient();
  if (!client) return NextResponse.json({ error: 'Background alerts are not configured' }, { status: 503 });
  try {
    const notifications = await runBackgroundAlerts(client);
    try {
      const push = await deliverPendingPushes(client);
      return NextResponse.json({
        data: { ...notifications, push, pushUnavailable: false },
      });
    } catch {
      // Inbox creation is the source of truth. A delivery-provider or outbox
      // failure must not turn a successfully created Inbox item into a failed
      // notification run.
      return NextResponse.json({
        data: {
          ...notifications,
          push: null,
          pushUnavailable: true,
        },
      });
    }
  } catch {
    return NextResponse.json({ error: 'Background alert run failed' }, { status: 503 });
  }
}
