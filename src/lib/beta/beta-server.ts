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
  if (!client) return UNKNOWN_BETA_ACCESS;

  try {
    const { data, error } = await client.rpc('resolve_my_beta_access');
    if (error) throw error;
    const row = data?.[0];
    if (!row) return UNKNOWN_BETA_ACCESS;
    return {
      stage: normalizeBetaStage(row.stage),
      admitted: row.admitted,
      reason: row.reason as BetaAccessReason,
      isAdmin: row.is_admin,
      participantCap: row.participant_cap,
      activeInvites: row.active_invites,
    };
  } catch (cause) {
    /*
     * Fails open, and says so out loud. See `UNKNOWN_BETA_ACCESS`: a rollout flag
     * that cannot be read must not close checkout for a product that is already
     * selling, and the authorization that matters is re-applied in the database
     * on the way to the provider.
     */
    captureServerError({ scope: 'beta.access', cause, level: 'warning' });
    return UNKNOWN_BETA_ACCESS;
  }
});

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
