import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/src/lib/supabase/admin';
import type { Database } from '@/src/types/database';
import { BillingAdminUnavailableError } from './billing-repository';
import type { NormalizedInvoiceRecord } from './billing-events';
import type { BillingRefundAction, NormalizedRefundEvent } from './billing-refunds';
import { refundIsFull } from './billing-refunds';
import type { TrustedBillingProviderMode } from './billing-provider-mode';
import type { BillingPlanKey } from './billing-plans';
import { billingRetryBackoffSeconds, BILLING_WEBHOOK_MAX_ATTEMPTS } from './webhook-retry';

/**
 * The database side of billing *operations*: the invoice ledger, refunds and
 * disputes, and the retry ledger behind the webhook.
 *
 * Every function here runs with the service role and is reachable only from the
 * webhook route or the scheduler. None of them decides anything — the routines
 * they call own idempotency, locking, identity matching and the entitlement
 * policy, so a bug in this file cannot skip a check. It is a translation layer,
 * on purpose.
 *
 * Kept beside `billing-repository.ts` rather than inside it so the module that
 * serves the reader's own manage page does not grow a second, privileged half.
 */

type AdminClient = SupabaseClient<Database>;

function admin(client?: AdminClient): AdminClient {
  const resolved = client ?? createAdminClient();
  if (!resolved) throw new BillingAdminUnavailableError();
  return resolved;
}

/**
 * Record what the provider billed.
 *
 * Called for every invoice event, including a failed payment: an invoice that
 * exists and was not paid is exactly what reconciliation needs to see. The
 * routine cannot reach a tier, a status or a period, which is what keeps "an
 * invoice was paid" and "a plan is open" two separate facts to compare.
 */
export async function recordBillingInvoice(input: {
  userId: string;
  providerMode: TrustedBillingProviderMode;
  invoice: NormalizedInvoiceRecord;
  subscriptionId: string | null;
  planKey: BillingPlanKey | null;
}, client?: AdminClient): Promise<'recorded' | 'ignored' | 'unknown_user'> {
  const { data, error } = await admin(client).rpc('record_billing_invoice', {
    input_user_id: input.userId,
    input_provider: 'stripe',
    input_provider_mode: input.providerMode,
    input_invoice_id: input.invoice.invoiceId,
    input_subscription_id: input.subscriptionId,
    input_plan_key: input.planKey,
    input_status: input.invoice.status,
    input_amount_due_minor: input.invoice.amountDueMinor,
    input_amount_paid_minor: input.invoice.amountPaidMinor,
    input_currency: input.invoice.currency,
    input_period_start: input.invoice.periodStart,
    input_period_end: input.invoice.periodEnd,
    input_issued_at: input.invoice.issuedAt,
    input_paid_at: input.invoice.paidAt,
  });
  if (error) throw error;
  return data ?? 'ignored';
}

export interface RefundApplyResult {
  outcome: string;
  entitlementChanged: boolean;
  refundEventId: string | null;
}

/**
 * Apply a provider-confirmed refund, dispute or dispute resolution.
 *
 * `action` is computed by the pure classifier and passed in rather than derived
 * here, so the one decision that takes away paid access is made in a function
 * with no dependencies and a test for every branch.
 */
export async function applyBillingRefundEvent(input: {
  providerMode: TrustedBillingProviderMode;
  eventId: string;
  eventType: string;
  refund: NormalizedRefundEvent;
  action: BillingRefundAction;
  userId: string | null;
  subscriptionId: string | null;
}, client?: AdminClient): Promise<RefundApplyResult> {
  const { data, error } = await admin(client).rpc('apply_billing_refund_event', {
    input_provider: 'stripe',
    input_provider_mode: input.providerMode,
    input_event_id: input.eventId,
    input_event_type: input.eventType,
    input_kind: input.refund.kind,
    input_action: input.action,
    input_occurred_at: input.refund.occurredAt,
    input_user_id: input.userId,
    input_subscription_id: input.subscriptionId ?? input.refund.subscriptionId,
    input_invoice_id: input.refund.invoiceId,
    input_charge_id: input.refund.chargeId,
    input_amount_minor: input.refund.amountMinor,
    input_charge_amount_minor: input.refund.chargeAmountMinor,
    input_currency: input.refund.currency,
    input_is_full: refundIsFull(input.refund.amountMinor, input.refund.chargeAmountMinor),
    input_dispute_outcome: input.refund.disputeOutcome,
  });
  if (error) throw error;
  const row = data?.[0];
  return {
    outcome: row?.outcome ?? 'recorded',
    entitlementChanged: Boolean(row?.entitlement_changed),
    refundEventId: row?.refund_event_id ?? null,
  };
}

export interface WebhookAttemptResult {
  attemptCount: number;
  status: 'retrying' | 'dead_letter' | 'resolved';
  nextAttemptAt: string | null;
  newlyDeadLettered: boolean;
}

/**
 * Record one failed delivery.
 *
 * The backoff is computed here — from the attempt number the database is about
 * to reach — and handed down, so the schedule is arithmetic in a tested pure
 * function rather than an interval expression buried in SQL. The bound is passed
 * for the same reason: one constant, one place.
 */
export async function recordWebhookAttempt(input: {
  providerMode: TrustedBillingProviderMode;
  eventId: string;
  eventType: string;
  userId: string | null;
  errorCode: string;
  /** Attempts already recorded, so the delay reflects the one being written. */
  previousAttempts: number;
}, client?: AdminClient): Promise<WebhookAttemptResult> {
  const { data, error } = await admin(client).rpc('record_billing_webhook_attempt', {
    input_provider: 'stripe',
    input_provider_mode: input.providerMode,
    input_event_id: input.eventId,
    input_event_type: input.eventType,
    input_user_id: input.userId,
    input_error_code: input.errorCode,
    input_backoff_seconds: billingRetryBackoffSeconds(input.previousAttempts + 1),
    input_max_attempts: BILLING_WEBHOOK_MAX_ATTEMPTS,
  });
  if (error) throw error;
  const row = data?.[0];
  return {
    attemptCount: row?.attempt_count ?? 1,
    status: row?.status ?? 'retrying',
    nextAttemptAt: row?.next_attempt_at ?? null,
    newlyDeadLettered: Boolean(row?.newly_dead_lettered),
  };
}

/** A later delivery succeeded, so the open failure is closed. */
export async function resolveWebhookRetry(input: {
  providerMode: TrustedBillingProviderMode;
  eventId: string;
}, client?: AdminClient): Promise<boolean> {
  const { data, error } = await admin(client).rpc('resolve_billing_webhook_retry', {
    input_provider: 'stripe',
    input_provider_mode: input.providerMode,
    input_event_id: input.eventId,
  });
  if (error) throw error;
  return Boolean(data);
}

/** Claim the one alert a dead letter is allowed to send. */
export async function markWebhookAlerted(input: {
  providerMode: TrustedBillingProviderMode;
  eventId: string;
}, client?: AdminClient): Promise<boolean> {
  const { data, error } = await admin(client).rpc('mark_billing_webhook_alerted', {
    input_provider: 'stripe',
    input_provider_mode: input.providerMode,
    input_event_id: input.eventId,
  });
  if (error) throw error;
  return Boolean(data);
}

/**
 * How many times this delivery has already failed.
 *
 * Read before recording a new failure so the backoff can be computed from the
 * attempt about to be written. A row that does not exist yet is zero attempts,
 * and an unreadable one is treated the same way — the cost of guessing low is a
 * shorter delay, never a missed dead letter, because the bound is enforced by
 * the routine itself.
 */
export async function readWebhookAttemptCount(input: {
  providerMode: TrustedBillingProviderMode;
  eventId: string;
}, client?: AdminClient): Promise<number> {
  try {
    const { data, error } = await admin(client)
      .from('billing_webhook_retries')
      .select('attempt_count')
      .eq('provider', 'stripe')
      .eq('provider_mode', input.providerMode)
      .eq('provider_event_id', input.eventId)
      .maybeSingle();
    if (error) throw error;
    return data?.attempt_count ?? 0;
  } catch {
    return 0;
  }
}
