import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { serverEnv } from '@/src/config/env/server';
import { createAdminClient } from '@/src/lib/supabase/admin';
import { runBackgroundAlerts } from '@/src/lib/alerts/background';
import { deliverPendingPushes } from '@/src/lib/push/service';
import { phase2AlertsEnabled } from '@/src/config/features';
import { createOvAlertServiceStore } from '@/src/lib/market-overview/alerts/service-store';
import { runOvAlertSweep } from '@/src/lib/market-overview/alerts/run';
import { ovAlertSweepQuotes } from '@/src/lib/market-overview/alerts/sweep-quotes';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(request: NextRequest): boolean {
  const expected = serverEnv.CRON_SECRET;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The Overview alert sweep, riding this tick.
 *
 * ===========================================================================
 * IT CANNOT TAKE THE NOTIFICATION PASS WITH IT
 * ===========================================================================
 * Every failure resolves to a summary rather than a throw. The pass above it
 * writes Inbox items somebody is watching a market for; this writes rows on a
 * card. A sweep that could fail the request would let the second cost the
 * first, and the two have nothing to do with each other.
 *
 * ===========================================================================
 * IT RUNS ONCE PER WINDOW, NOT ONCE PER INVOCATION
 * ===========================================================================
 * `runBackgroundAlerts` already owns the duplicate guard: it inserts into
 * `alert_evaluation_runs` keyed by a fifteen-minute window and reports
 * `duplicateRun` when a second invocation lands in the same one. The sweep
 * honours that answer instead of inventing a second guard — two mechanisms for
 * "has this window already run" is how they come to disagree.
 *
 * So a duplicate tick sweeps nothing. The cooldown would have absorbed most of
 * it anyway, but "most" is not the property worth relying on.
 */
async function runOverviewAlertSweep(
  client: SupabaseClient<Database>,
  skip: boolean,
) {
  if (!phase2AlertsEnabled()) return { ran: false, reason: 'disabled' as const };
  if (skip) return { ran: false, reason: 'duplicate-window' as const };
  try {
    const summary = await runOvAlertSweep({
      store: createOvAlertServiceStore(client),
      loadQuotes: ovAlertSweepQuotes(),
    });
    return {
      ran: true,
      owners: summary.owners,
      evaluated: summary.evaluated,
      recorded: summary.recorded,
      failed: summary.failed,
      errors: summary.errors.length,
    };
  } catch {
    /*
      The sweep itself died — the rules could not be read at all. This comment
      used to name unapplied migrations as the likely cause; `202608300001` and
      `202608310001` are applied, so that is no longer it, and the remaining
      causes are the ordinary ones: the provider quote load failing, or the
      database being unreachable.

      Reported, never thrown, either way: the notification pass above has
      already succeeded by this point and must not be turned into a failed run
      by a section of the Overview.
    */
    return { ran: false, reason: 'failed' as const };
  }
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const client = createAdminClient();
  if (!client) return NextResponse.json({ error: 'Background alerts are not configured' }, { status: 503 });
  try {
    const notifications = await runBackgroundAlerts(client);
    /*
      After the pass, never beside it. The sweep reads prices through the same
      cache the pass just warmed, and running them concurrently would race two
      writers onto the same rows for no gain — this tick has fifteen minutes.
    */
    const overviewAlerts = await runOverviewAlertSweep(client, notifications.duplicateRun);
    try {
      const push = await deliverPendingPushes(client);
      return NextResponse.json({
        data: { ...notifications, overviewAlerts, push, pushUnavailable: false },
      });
    } catch {
      // Inbox creation is the source of truth. A delivery-provider or outbox
      // failure must not turn a successfully created Inbox item into a failed
      // notification run.
      return NextResponse.json({
        data: {
          ...notifications,
          overviewAlerts,
          push: null,
          pushUnavailable: true,
        },
      });
    }
  } catch {
    return NextResponse.json({ error: 'Background alert run failed' }, { status: 503 });
  }
}
