import 'server-only';

import { cache } from 'react';
import { createClient } from '@/src/lib/supabase/server';
import { captureServerError } from '@/src/lib/monitoring/report';
import {
  normalizeBetaStage,
  UNKNOWN_BETA_ACCESS,
  type BetaAccess,
  type BetaAccessReason,
} from './beta-stages';
import {
  bangkokLocalDate,
  normalizeBetaFunnelEvent,
  type BetaFunnelEventInput,
} from './funnel-events';

/**
 * The rollout gate and the funnel recorder, as the server sees them.
 *
 * Both go through the database's own routines rather than reading tables: the
 * stage, the allowlist and the funnel are all behind row-level security with no
 * grant to any client role, so `security definer` routines are the only path —
 * and they re-check the caller from `auth.uid()`, which is what makes this module
 * a convenience rather than the boundary.
 */

/**
 * Whether this reader may start a new purchase.
 *
 * Wrapped in React's per-request cache: the subscription page, the plan cards and
 * the checkout action may all ask within one render, and they must observe one
 * answer and issue one round trip.
 */
export const resolveBetaAccessForRequest = cache(async (): Promise<BetaAccess> => {
  const client = await createClient();
  if (!client) return unresolved('no_session_client');

  try {
    const { data, error } = await client.rpc('resolve_my_beta_access');
    if (error) throw error;
    const row = data?.[0];
    if (!row) return unresolved('empty_result');
    return {
      stage: normalizeBetaStage(row.stage),
      admitted: row.admitted,
      reason: row.reason as BetaAccessReason,
      isAdmin: row.is_admin,
      participantCap: row.participant_cap,
      activeInvites: row.active_invites,
      resolution: 'resolved',
    };
  } catch (cause) {
    return unresolved('rpc_failed', cause);
  }
});

/**
 * How often one process may report the same outage.
 *
 * Every page view and every refused button press runs this resolver, so an
 * unreported gap and an alert per request are both wrong: the first hides an
 * outage that is silently refusing purchases, the second buries it. One line per
 * window per instance is enough to notice and to measure the duration from.
 */
const UNRESOLVED_ALERT_INTERVAL_MS = 5 * 60_000;
let lastUnresolvedAlertAt = 0;

/**
 * The stand-in answer, reported once per window.
 *
 * `detail` names which of the three ways the read failed and carries nothing
 * else — no account, no mailbox, no row. The reporter sanitizes the cause on top
 * of that, so a database error string cannot smuggle an identifier into the log.
 */
function unresolved(detail: 'no_session_client' | 'empty_result' | 'rpc_failed', cause?: unknown): BetaAccess {
  const now = Date.now();
  if (now - lastUnresolvedAlertAt >= UNRESOLVED_ALERT_INTERVAL_MS) {
    lastUnresolvedAlertAt = now;
    captureServerError({
      scope: 'beta.access',
      message: 'beta access unresolved; new trials and checkouts are refused',
      cause,
      level: 'warning',
      // `code` because the reporter's context allowlist is the thing that keeps
      // an identifier out of a report; a key it does not know is dropped.
      context: { code: detail },
    });
  }
  return UNKNOWN_BETA_ACCESS;
}

/**
 * Record one funnel event.
 *
 * Never throws and never returns a failure the caller has to handle: a funnel
 * event is telemetry, and telemetry that can fail a checkout is a liability. The
 * account, the timestamp, the calendar date and the beta stage are all stamped by
 * the database — this function cannot forge any of them, which is the whole
 * reason the routine takes so few arguments.
 */
export async function recordBetaFunnelEvent(
  input: Omit<BetaFunnelEventInput, 'localDate'> & { localDate?: string },
): Promise<'recorded' | 'duplicate' | 'skipped'> {
  const normalized = normalizeBetaFunnelEvent({
    ...input,
    localDate: input.localDate ?? bangkokLocalDate(),
  });
  if (!normalized) return 'skipped';

  try {
    const client = await createClient();
    if (!client) return 'skipped';
    const { data, error } = await client.rpc('record_beta_funnel_event', {
      input_event_key: normalized.event,
      input_plan_key: normalized.planKey,
      input_payment_rail: normalized.paymentRail,
      input_feature_key: normalized.featureKey,
      input_dedupe_scope: normalized.dedupeScope,
    });
    if (error) throw error;
    return data === 'recorded' ? 'recorded' : data === 'duplicate' ? 'duplicate' : 'skipped';
  } catch {
    // Deliberately silent. A funnel row is worth nothing next to the request it
    // rode in on, and reporting every miss would be its own noise problem.
    return 'skipped';
  }
}

/**
 * Fire-and-forget telemetry, for callers on a path that must not fail.
 *
 * `recordBetaFunnelEvent` promises never to reject, but a promise-level promise
 * is not enough for code inside a `try` that turns any throw into a refusal the
 * reader sees: a synchronous fault — a module that did not load, a stubbed
 * dependency that is not there — would arrive before there is a promise to
 * attach a handler to. This swallows both, so recording that somebody started a
 * trial can never be the reason they are told they could not.
 */
export function recordBetaFunnelEventSafely(
  input: Omit<BetaFunnelEventInput, 'localDate'> & { localDate?: string },
): void {
  try {
    void recordBetaFunnelEvent(input).catch(() => {});
  } catch {
    // Telemetry is never worth the request it rode in on.
  }
}
