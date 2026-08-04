import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/src/lib/supabase/admin';
import type { Database } from '@/src/types/database';
import type { BillingCollectionMethod, BillingProviderMode } from '@/src/types/database';
import type { NormalizedBillingEvent } from './billing-events';
import { isBillingPaymentMethod } from './billing-payment-method';
import { billingPlans, isBillingPlanKey } from './billing-plans';
import type { TrustedBillingProviderMode } from './billing-provider-mode';
import type { PendingPromptPayRecord } from './promptpay-pending';

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
  /**
   * Which rail the subscription is billed on. Read from the reader's own row
   * rather than added to the snapshot routine, so no function already serving
   * production has its signature changed — the same reason the provider mode is
   * read this way.
   */
  billing_collection_method: BillingCollectionMethod | null;
};

/**
 * A relation or column this build knows about that the database does not have
 * yet.
 *
 * Deploys are not atomic: for a few minutes after a release, code that knows
 * about Phase 4.4 can be answering requests against a database that has not been
 * migrated. Only *these* two conditions are tolerated, and only by falling back
 * to what the previous phase would have returned — anything else still throws,
 * because a billing read that fails for a real reason must not be quietly
 * treated as "no subscription".
 */
function isMissingSchemaError(error: { code?: string } | null): boolean {
  // 42P01 undefined_table, 42703 undefined_column; PGRST20x is PostgREST's own
  // schema cache reporting the same thing.
  return error?.code === '42P01'
    || error?.code === '42703'
    || error?.code === 'PGRST204'
    || error?.code === 'PGRST205';
}

export async function readBillingSnapshot(
  client: SupabaseClient<Database>,
): Promise<BillingSnapshot | null> {
  const [snapshotResult, railResult] = await Promise.all([
    client.rpc('get_my_billing_snapshot'),
    client
      .from('user_subscriptions')
      .select('billing_provider_mode, billing_collection_method')
      .maybeSingle(),
  ]);
  if (snapshotResult.error) throw snapshotResult.error;

  let rail = railResult.data ?? null;
  if (railResult.error) {
    if (!isMissingSchemaError(railResult.error)) throw railResult.error;
    // Pre-4.4 database: the provider mode still exists, and an unknown rail is
    // exactly what a record from before the column meant anyway.
    const legacy = await client
      .from('user_subscriptions')
      .select('billing_provider_mode')
      .maybeSingle();
    if (legacy.error) throw legacy.error;
    rail = legacy.data ? { ...legacy.data, billing_collection_method: null } : null;
  }

  const snapshot = snapshotResult.data?.[0];
  return snapshot
    ? {
      ...snapshot,
      billing_provider_mode: rail?.billing_provider_mode ?? null,
      billing_collection_method: rail?.billing_collection_method ?? null,
    }
    : null;
}

/**
 * The reader's own unpaid invoice, if one exists.
 *
 * Read through their session, so row-level security decides what is visible and
 * this can never return somebody else's. The provider's subscription and invoice
 * identifiers are deliberately not selected: the page needs to show a plan, an
 * amount, a deadline and a link to the reader's own QR, and none of those
 * answers requires an identifier to reach the browser.
 *
 * Returns `null` for a row that does not describe a rail and plan this build
 * knows, rather than casting a database string into a union.
 */
export async function readPendingPromptPayPayment(
  client: SupabaseClient<Database>,
  providerMode: TrustedBillingProviderMode,
): Promise<PendingPromptPayRecord | null> {
  const { data, error } = await client
    .from('billing_pending_payments')
    .select('plan_key, payment_method, status, amount_baht, hosted_invoice_url, due_at, created_at, provider_mode')
    .maybeSingle();
  // A database that has not been migrated yet has no pending invoices in it, so
  // "no table" and "no row" are the same answer. Any other failure still throws.
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
  if (!data || data.provider_mode !== providerMode) return null;
  if (!isBillingPlanKey(data.plan_key) || !isBillingPaymentMethod(data.payment_method)) return null;

  return {
    planKey: data.plan_key,
    paymentMethod: data.payment_method,
    status: data.status,
    amountBaht: data.amount_baht,
    hostedInvoiceUrl: data.hosted_invoice_url,
    dueAt: data.due_at,
    createdAt: data.created_at,
  };
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

export type PendingPaymentOutcome =
  Database['public']['Functions']['record_pending_billing_payment']['Returns'];

/**
 * Record a PromptPay invoice that is awaiting payment.
 *
 * Called after the provider has created the invoice — never before, so a row
 * here always names something a reader can actually pay. It writes no
 * entitlement column: the routine it calls cannot reach tier, status, period or
 * the Founder flag, which is what keeps "an invoice exists" and "a plan was
 * bought" two different facts in the database as well as in the code.
 */
export async function recordPendingPromptPayPayment(input: {
  userId: string;
  providerMode: TrustedBillingProviderMode;
  planKey: keyof typeof billingPlans;
  subscriptionId: string;
  invoiceId: string | null;
  hostedInvoiceUrl: string | null;
  amountBaht: number;
  dueAt: string | null;
}): Promise<PendingPaymentOutcome> {
  const admin = createAdminClient();
  if (!admin) throw new BillingAdminUnavailableError();

  const { data, error } = await admin.rpc('record_pending_billing_payment', {
    input_user_id: input.userId,
    input_provider: 'stripe',
    input_provider_mode: input.providerMode,
    input_payment_method: 'promptpay',
    input_plan_key: input.planKey,
    input_subscription_id: input.subscriptionId,
    input_invoice_id: input.invoiceId,
    input_hosted_invoice_url: input.hostedInvoiceUrl,
    input_amount_baht: input.amountBaht,
    input_due_at: input.dueAt,
  });
  if (error) throw error;
  return data ?? 'unknown_user';
}

/**
 * The provider identifiers behind a pending invoice, for the two callers that
 * genuinely need them: the webhook, matching an event to a row, and the abandon
 * action, which has to tell the provider *which* subscription to cancel.
 *
 * Service-role, because the reader's own projection deliberately omits them.
 */
export async function readPendingPromptPayIdentity(
  userId: string,
  providerMode: TrustedBillingProviderMode,
): Promise<{ subscriptionId: string; status: string } | null> {
  const admin = createAdminClient();
  if (!admin) throw new BillingAdminUnavailableError();

  const { data, error } = await admin
    .from('billing_pending_payments')
    .select('subscription_id, status')
    .eq('user_id', userId)
    .eq('provider', 'stripe')
    .eq('provider_mode', providerMode)
    .maybeSingle();
  if (error) throw error;
  return data ? { subscriptionId: data.subscription_id, status: data.status } : null;
}

/** Private provider identity for re-opening the next invoice on the same rail. */
export async function readPromptPaySubscriptionIdentity(
  userId: string,
  providerMode: TrustedBillingProviderMode,
): Promise<{ subscriptionId: string; planKey: keyof typeof billingPlans } | null> {
  const admin = createAdminClient();
  if (!admin) throw new BillingAdminUnavailableError();

  const { data, error } = await admin
    .from('user_subscriptions')
    .select('billing_subscription_id, billing_plan_key, status, billing_collection_method')
    .eq('user_id', userId)
    .eq('billing_provider', 'stripe')
    .eq('billing_provider_mode', providerMode)
    .maybeSingle();
  if (error) throw error;
  if (
    !data?.billing_subscription_id
    || !isBillingPlanKey(data.billing_plan_key)
    || data.billing_collection_method !== 'send_invoice'
    || (data.status !== 'active' && data.status !== 'past_due')
  ) return null;
  return {
    subscriptionId: data.billing_subscription_id,
    planKey: data.billing_plan_key,
  };
}

/**
 * Mark an unpaid invoice abandoned, after the provider has been told to cancel
 * it. The row survives, marked — see the migration for why the next attempt
 * depends on it existing.
 */
export async function cancelPendingPromptPayPayment(input: {
  userId: string;
  providerMode: TrustedBillingProviderMode;
  subscriptionId: string;
}): Promise<boolean> {
  const admin = createAdminClient();
  if (!admin) throw new BillingAdminUnavailableError();

  const { data, error } = await admin.rpc('cancel_pending_billing_payment', {
    input_user_id: input.userId,
    input_provider_mode: input.providerMode,
    input_subscription_id: input.subscriptionId,
  });
  if (error) throw error;
  return Boolean(data);
}

/**
 * Record which rail a subscription is billed on, and clear a pending invoice
 * that has been settled.
 *
 * Deliberately separate from `applyBillingEvent`, and deliberately unable to
 * grant: it writes one descriptive column and deletes one non-entitlement row.
 * Keeping it apart is what let the invoice rail be added without changing the
 * signature of the one routine that decides who has paid for what.
 */
export async function applyBillingPaymentRail(input: {
  userId: string;
  providerMode: TrustedBillingProviderMode;
  subscriptionId: string;
  collectionMethod: BillingCollectionMethod | null;
  pendingSettled: boolean;
}): Promise<{ railUpdated: boolean; pendingCleared: boolean }> {
  const admin = createAdminClient();
  if (!admin) throw new BillingAdminUnavailableError();

  const { data, error } = await admin.rpc('apply_billing_payment_rail', {
    input_user_id: input.userId,
    input_provider: 'stripe',
    input_provider_mode: input.providerMode,
    input_subscription_id: input.subscriptionId,
    input_collection_method: input.collectionMethod,
    input_pending_settled: input.pendingSettled,
  });
  if (error) throw error;
  const row = data?.[0];
  return {
    railUpdated: Boolean(row?.rail_updated),
    pendingCleared: Boolean(row?.pending_cleared),
  };
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
