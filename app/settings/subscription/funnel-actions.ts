'use server';

import { createClient } from '@/src/lib/supabase/server';
import { recordBetaFunnelEvent } from '@/src/lib/beta/beta-server';
import { isClientRecordableEventKey } from '@/src/lib/beta/funnel-events';
import {
  consumeRateLimit, resolveClientAddress,
} from '@/src/lib/security/rate-limit';

/**
 * The one thing a browser may add to the rollout funnel.
 *
 * It exists for exactly one class of fact: something that happened in the
 * browser and nowhere else — most importantly the provider's checkout return,
 * which arrives as a query parameter on a page that is contractually forbidden
 * from reading query parameters.
 *
 * Four things bound what this can do, and together they are why accepting an
 * event name from a client is safe here:
 *
 *   1. **The key is allowlisted to intent.** `isClientRecordableEventKey`
 *      refuses `payment_succeeded`, `checkout_started`, `promptpay_renewal_paid`
 *      and `signup_completed`. A browser cannot claim money moved.
 *   2. **It grants nothing.** The routine behind it inserts one row into
 *      `beta_funnel_events` and touches no subscription, tier, period or status.
 *      There is no argument that could make it do anything else.
 *   3. **The account, clock and stage are stamped by the database**, from
 *      `auth.uid()` and its own clock — so an event cannot be backdated,
 *      attributed to somebody else, or claimed for a different stage.
 *   4. **It is bounded and deduplicated.** A rate limit caps the call, and a
 *      unique index collapses repeats to one row per account per scope.
 *
 * It returns nothing. A caller learns whether its own telemetry landed only by
 * not being told, which removes any incentive to retry.
 */
export async function recordClientFunnelEventAction(
  event: string,
  planKey?: string | null,
  featureKey?: string | null,
): Promise<void> {
  if (!isClientRecordableEventKey(event)) return;

  try {
    const client = await createClient();
    if (!client) return;

    const { data: { user } } = await client.auth.getUser();
    const bound = await consumeRateLimit(client, {
      scope: 'funnel.record',
      userId: user?.id ?? null,
      clientAddress: await resolveClientAddress(),
    });
    if (!bound.allowed) return;

    await recordBetaFunnelEvent({ event, planKey, featureKey });
  } catch {
    // Telemetry never reports its own failure to a browser.
  }
}
