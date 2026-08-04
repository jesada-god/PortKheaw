import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/src/lib/supabase/admin';
import type { Database } from '@/src/types/database';
import type { BillingProviderMode } from '@/src/types/database';
import type { NormalizedBillingEvent } from './billing-events';
import { billingPlans } from './billing-plans';
import type { TrustedBillingProviderMode } from './billing-provider-mode';

/**
 * The database side of billing.
 *
 * Two very different privileges live here, and the split is the point:
 *
 *   `readBillingSnapshot` runs as the **reader**, through their own session, and
 *   returns the sanitized projection the database chose. It cannot see another
 *   account, and it never receives a provider identifier.
 *
 *   `applyBillingEvent` runs as the **service role**, and is reachable only from
 *   the webhook route after a signature has been verified. It does not decide
 *   anything: idempotency, locking, identity matching and staleness are all
 *   enforced inside the database routine, so a bug in this file cannot skip them.
 */

type BillingSnapshotRow = Database['public']['Functions']['get_my_billing_snapshot']['Returns'][number];

export type BillingSnapshot = BillingSnapshotRow & {
  billing_provider_mode: BillingProviderMode | null;
};

export async function readBillingSnapshot(
  client: SupabaseClient<Database>,
): Promise<BillingSnapshot | null> {
  const [snapshotResult, modeResult] = await Promise.all([
    client.rpc('get_my_billing_snapshot'),
    client.from('user_subscriptions').select('billing_provider_mode').maybeSingle(),
  ]);
  if (snapshotResult.error) throw snapshotResult.error;
  if (modeResult.error) throw modeResult.error;
  const snapshot = snapshotResult.data?.[0];
  return snapshot
    ? { ...snapshot, billing_provider_mode: modeResult.data?.billing_provider_mode ?? null }
    : null;
}

export type BillingApplyOutcome =
  Database['public']['Functions']['apply_billing_subscription_event']['Returns'][number]['outcome'];

/** Raised when the service-role key is absent, so the route can answer 503. */
export class BillingAdminUnavailableError extends Error {
  constructor() {
    super('BILLING_ADMIN_UNAVAILABLE');
    this.name = 'BillingAdminUnavailableError';
  }
}

/**
 * Hand a verified event to the database and report what it did with it.
 *
 * `founder` is asserted only when the subscription actually became active: the
 * discounted first invoice has been paid at that point, so the one-per-account
 * promotion is genuinely spent. A checkout that never completed leaves the flag
 * alone, so the reader keeps the offer.
 */
export async function applyBillingEvent(
  event: NormalizedBillingEvent,
  payloadDigest: string,
): Promise<BillingApplyOutcome> {
  const admin = createAdminClient();
  if (!admin) throw new BillingAdminUnavailableError();

  const plan = event.planKey ? billingPlans[event.planKey] : null;
  const founderSpent = Boolean(plan?.founder) && event.state?.status === 'active';

  const { data, error } = await admin.rpc('apply_billing_subscription_event', {
    input_provider: event.provider,
    input_provider_mode: event.providerMode,
    input_event_id: event.eventId,
    input_event_type: event.eventType,
    input_occurred_at: event.occurredAt,
    input_payload_digest: payloadDigest,
    input_user_id: event.userId,
    input_customer_id: event.customerId,
    input_subscription_id: event.subscriptionId,
    input_plan_key: event.planKey,
    input_price_id: event.priceId,
    input_tier: event.state?.tier ?? null,
    input_status: event.state?.status ?? null,
    input_interval: event.state?.interval ?? null,
    input_period_start: event.state?.currentPeriodStart ?? null,
    input_period_end: event.state?.currentPeriodEnd ?? null,
    input_cancel_at_period_end: event.state?.cancelAtPeriodEnd ?? null,
    input_invoice_id: event.invoiceId,
    input_payment_status: event.paymentStatus,
    input_founder: founderSpent,
  });
  if (error) throw error;

  const outcome = data?.[0]?.outcome;
  if (!outcome) throw new Error('BILLING_EVENT_NO_OUTCOME');
  return outcome;
}

/**
 * The provider customer identifier for one account, read with service-role
 * privilege because the reader's own sanitized snapshot deliberately omits it.
 *
 * Used for exactly one thing: opening the provider's billing portal for the
 * account that asked. The identifier is passed straight to the provider and is
 * never returned to the browser.
 */
export async function readBillingCustomerId(
  userId: string,
  providerMode: TrustedBillingProviderMode,
): Promise<string | null> {
  const admin = createAdminClient();
  if (!admin) throw new BillingAdminUnavailableError();

  const { data, error } = await admin
    .from('user_subscriptions')
    .select('billing_customer_id')
    .eq('user_id', userId)
    .eq('billing_provider', 'stripe')
    .eq('billing_provider_mode', providerMode)
    .maybeSingle();
  if (error) throw error;
  return data?.billing_customer_id ?? null;
}
