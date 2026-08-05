import { NextResponse } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';
import { billingConfigResult } from '@/src/lib/billing/billing-server';
import type { SchedulerStatus } from '@/src/types/database';

/**
 * Liveness and readiness, for an uptime monitor.
 *
 * Public, unauthenticated, and deliberately incurious. It answers four questions
 * with words:
 *
 *   app        did this process serve the request at all;
 *   database   did the database answer;
 *   billing    is the payment configuration complete enough to take money;
 *   scheduler  did the background run complete recently.
 *
 * What it will not do is explain itself. There is no error message, no missing
 * variable name, no provider name, no timestamp, no row count and no version of
 * anything. A readiness endpoint is the most-scanned URL a product has, and every
 * detail it volunteers is reconnaissance — "billing: incomplete" is all an
 * operator needs to go and look, and all an attacker learns is that a page said a
 * word.
 *
 * The status code is the part a monitor actually reads: 200 while the product can
 * serve readers, 503 once the database is unreachable. Billing and scheduler
 * degradations are reported but do not fail the check — a stale scheduler is an
 * operator's problem, not a reason for an uptime provider to page at 03:00 and
 * declare the site down while it is serving every reader perfectly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CheckState = 'ok' | 'degraded' | 'unavailable';

/**
 * Distinguishes "the database is unreachable" from "the schema is behind".
 *
 * PostgREST answers a request for a routine it does not have with a `PGRST…`
 * code — which means the database and its API both replied, and what is missing
 * is a migration. Those are very different incidents: one is an outage, the
 * other is a deploy that landed ahead of its migration and is harmless because
 * every new path in this release fails open.
 *
 * Collapsing them would make this endpoint report a total outage during an
 * ordinary rollout, and page somebody for a product that is serving every reader.
 */
function isSchemaError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('PGRST') || code === '42883');
}

async function databaseCheck(): Promise<{ database: CheckState; scheduler: SchedulerStatus }> {
  try {
    const client = await createClient();
    if (!client) return { database: 'unavailable', scheduler: 'unknown' };
    const { data, error } = await client.rpc('platform_readiness');
    if (error) {
      return isSchemaError(error)
        ? { database: 'degraded', scheduler: 'unknown' }
        : { database: 'unavailable', scheduler: 'unknown' };
    }
    const row = data?.[0];
    if (!row?.database_ready) return { database: 'unavailable', scheduler: 'unknown' };
    return { database: 'ok', scheduler: row.scheduler_status };
  } catch {
    return { database: 'unavailable', scheduler: 'unknown' };
  }
}

/**
 * Whether money can be taken, without saying what is missing.
 *
 * `billingConfigResult()` knows exactly which variables are absent and names them
 * for the server log. None of that crosses this boundary — the endpoint reduces
 * it to one of three words.
 */
function billingCheck(): CheckState {
  try {
    const result = billingConfigResult();
    if (!result.enabled) return 'unavailable';
    return result.availablePlanKeys.length > 0 ? 'ok' : 'degraded';
  } catch {
    return 'unavailable';
  }
}

export async function GET(): Promise<NextResponse> {
  const { database, scheduler } = await databaseCheck();
  const billing = billingCheck();

  const schedulerState: CheckState = scheduler === 'ok'
    ? 'ok'
    : scheduler === 'lagging' ? 'degraded' : 'unavailable';

  // Only an unreachable database fails the check. See the note above on why a
  // stale scheduler — or a schema one migration behind — must not read as "the
  // site is down".
  const healthy = database !== 'unavailable';
  const degraded = database !== 'ok' || billing !== 'ok' || schedulerState !== 'ok';

  return NextResponse.json(
    {
      status: healthy ? (degraded ? 'degraded' : 'ok') : 'unavailable',
      checks: { app: 'ok' satisfies CheckState, database, billing, scheduler: schedulerState },
    },
    {
      status: healthy ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        // A monitor should never be handed a cached "ok" by an intermediary.
        'CDN-Cache-Control': 'no-store',
      },
    },
  );
}
