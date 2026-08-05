import { createHash } from 'node:crypto';
import { getBillingConfig } from '@/src/lib/billing/billing-server';
import {
  applyBillingEvent,
  applyBillingPaymentRail,
  BillingAdminUnavailableError,
} from '@/src/lib/billing/billing-repository';
import {
  applyBillingRefundEvent,
  markWebhookAlerted,
  readWebhookAttemptCount,
  recordBillingInvoice,
  recordWebhookAttempt,
  resolveWebhookRetry,
} from '@/src/lib/billing/billing-operations';
import {
  billingEventNotifications,
  refundEventNotifications,
} from '@/src/lib/billing/billing-notifications';
import { refundEntitlementAction } from '@/src/lib/billing/billing-refunds';
import { webhookFailureDisposition } from '@/src/lib/billing/webhook-retry';
import { adminDeadLetterNotification } from '@/src/lib/notifications/account-events';
import { notifyAccount, notifyAdmins } from '@/src/lib/notifications/dispatch';
import { captureServerError } from '@/src/lib/monitoring/report';
import type { NormalizedBillingEvent } from '@/src/lib/billing/billing-events';
import {
  BillingModeMismatchError,
  BillingSignatureError,
  verifyStripeWebhook,
} from '@/src/lib/billing/providers/stripe/stripe-provider';
import { revalidateEveryEntitlementSurface } from '@/src/lib/subscription/revalidate-entitlements';

/**
 * The billing webhook: the only path in this product that may change what
 * somebody has paid for.
 *
 * Nothing else grants a paid tier. Not the checkout action, which returns a URL
 * and stops; not the success redirect, which is a page a reader can type into
 * their own address bar and therefore proves nothing. A tier changes here, after
 * a signature has been verified against a secret only this server holds.
 *
 * The trust chain, in order:
 *
 *   1. No configuration → 503, and nothing is read or written. Fail closed.
 *   2. The **raw** body is verified against the provider's signature. Anything
 *      that fails is answered 400 with no detail.
 *   3. The verified event is normalized, and the subscription is re-fetched from
 *      the provider rather than trusted from the payload, which may be a stale
 *      snapshot on a redelivery.
 *   4. The database routine applies it under a row lock, refusing duplicates,
 *      identity mismatches and out-of-order deliveries, and marks the delivery
 *      processed in the same transaction as the change itself.
 *
 * Deliberately absent: any card data, any raw secret, and any log line carrying
 * an account identifier or a provider identifier.
 */

// `node:crypto` and raw-body access both require the Node runtime, and the
// signature check is worthless without the exact bytes that were signed.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WebhookAudit =
  | 'billing_webhook_applied'
  | 'billing_webhook_skipped'
  | 'billing_webhook_rejected'
  | 'billing_webhook_failed'
  /** The delivery ran out of attempts and was escalated instead of retried. */
  | 'billing_webhook_dead_lettered';

/**
 * Structured, and sanitized by construction: an event *type* and an outcome are
 * product facts, not personal ones. The event id, the customer, the account and
 * the payload never reach a log line.
 */
function record(event: WebhookAudit, eventType: string, outcome?: string) {
  const payload = JSON.stringify({ event, eventType, ...(outcome ? { outcome } : {}) });
  if (event === 'billing_webhook_applied' || event === 'billing_webhook_skipped') console.info(payload);
  else console.warn(payload);
}

export async function POST(request: Request): Promise<Response> {
  const config = getBillingConfig();
  if (!config) {
    // No secret means no way to tell a real delivery from a forged one, so the
    // endpoint refuses everything rather than accepting anything.
    record('billing_webhook_rejected', 'unknown', 'not_configured');
    return Response.json({ error: 'billing_not_configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  let event;
  try {
    event = await verifyStripeWebhook(config, rawBody, signature);
  } catch (error) {
    if (error instanceof BillingModeMismatchError) {
      record('billing_webhook_rejected', 'unknown', 'mode_mismatch');
      return Response.json({ error: 'mode_mismatch' }, { status: 400 });
    }
    if (error instanceof BillingSignatureError) {
      record('billing_webhook_rejected', 'unknown', 'invalid_signature');
      return Response.json({ error: 'invalid_signature' }, { status: 400 });
    }
    record('billing_webhook_failed', 'unknown', 'verification_error');
    return Response.json({ error: 'verification_failed' }, { status: 400 });
  }

  // A digest, never the body. Enough to prove two deliveries carried the same
  // bytes, and useless to anybody who reads the row.
  const payloadDigest = createHash('sha256').update(rawBody).digest('hex');

  try {
    const outcome = await applyBillingEvent(event, payloadDigest);

    /*
     * Runs on every delivery, including one the routine above answered as a
     * duplicate. It grants nothing — it records which rail the subscription is
     * billed on and closes a settled pending invoice — and both writes are
     * idempotent, so a redelivery that follows a failure here finishes the job.
     */
    await settlePaymentRail(event);

    /*
     * The invoice ledger, and then money going back. Both are idempotent, both
     * are recorded whatever the subscription routine decided above, and both are
     * kept out of that routine on purpose: it is the only thing that may change
     * a tier, and neither an invoice row nor a refund row is allowed to be a
     * second way in.
     */
    await recordInvoiceLedger(event);
    const refundOutcome = await applyRefund(event);

    if (outcome === 'applied' || refundOutcome?.entitlementChanged) {
      // Access has genuinely changed, so every cached render that depended on it
      // has to go. Same invalidation the admin preview performs, on purpose.
      revalidateEveryEntitlementSurface();
      record('billing_webhook_applied', event.eventType, outcome);
    } else {
      // `duplicate`, `stale`, `ignored`, `revoked_hold` and the mismatch
      // outcomes are all successful *handling* — the provider must not retry.
      record('billing_webhook_skipped', event.eventType, outcome);
    }

    await announce(event, outcome);

    /*
     * This delivery succeeded, so any earlier failure of the same event is no
     * longer an open problem. Recorded rather than deleted: the failure is
     * evidence too, and reconciliation stops reporting a resolved row.
     */
    await settleRetryLedger(event);

    return Response.json({ received: true, outcome }, { status: 200 });
  } catch (error) {
    const detail = error instanceof BillingAdminUnavailableError ? 'admin_unavailable' : 'apply_failed';
    return failDelivery(event, detail);
  }
}

/**
 * What to answer after a failure, and how loudly.
 *
 * A 500 asks the provider to redeliver, which is right while the failure might
 * be transient: the event id was either never claimed, or claimed inside a
 * transaction that rolled back, so a redelivery is processed exactly once.
 *
 * After the bound, a 500 stops being useful and starts being harmful — the
 * provider keeps hammering an endpoint that cannot succeed, and eventually
 * disables it, taking every *future* delivery down with the broken one. So the
 * delivery is dead-lettered, operators are told once, reconciliation keeps
 * reporting it, and the provider is answered 200 and released.
 *
 * If the retry ledger itself is unreachable we fall back to 500. Asking for one
 * more redelivery is the safer failure: it cannot lose an event.
 */
async function failDelivery(
  event: NormalizedBillingEvent,
  detail: string,
): Promise<Response> {
  let attempt;
  try {
    const previousAttempts = await readWebhookAttemptCount({
      providerMode: event.providerMode,
      eventId: event.eventId,
    });
    attempt = await recordWebhookAttempt({
      providerMode: event.providerMode,
      eventId: event.eventId,
      eventType: event.eventType,
      userId: event.userId,
      errorCode: detail,
      previousAttempts,
    });
  } catch {
    record('billing_webhook_failed', event.eventType, `${detail}:retry_ledger_unavailable`);
    return Response.json({ error: 'processing_failed' }, { status: 500 });
  }

  if (webhookFailureDisposition(attempt) === 'retry') {
    record('billing_webhook_failed', event.eventType, detail);
    return Response.json({ error: 'processing_failed' }, { status: 500 });
  }

  // `mark_billing_webhook_alerted` claims the alert, so operators hear about a
  // dead letter once however many redeliveries follow it.
  try {
    const claimed = await markWebhookAlerted({
      providerMode: event.providerMode,
      eventId: event.eventId,
    });
    if (claimed) {
      await notifyAdmins(adminDeadLetterNotification({
        eventId: event.eventId,
        eventType: event.eventType,
        attemptCount: attempt.attemptCount,
        observedAt: event.occurredAt,
      }));
    }
  } catch {
    // An alert we could not send must not turn a bounded failure back into an
    // unbounded retry. The dead letter row stands, and reconciliation reports it.
  }

  record('billing_webhook_dead_lettered', event.eventType, detail);
  /*
   * The one webhook outcome that needs a human. Reported to monitoring as well
   * as to the operator Inbox, because a dead letter is a paid invoice that may
   * never have opened a plan — and the Inbox is read when somebody looks, while
   * monitoring is what pages.
   *
   * The context is the event *type* and a code, never the provider's event id or
   * payload; the reporter's redactor would strip them anyway.
   */
  captureServerError({
    scope: 'billing.webhook.dead-letter',
    message: 'billing webhook dead-lettered',
    context: {
      eventType: event.eventType,
      providerMode: event.providerMode,
      attempt: attempt.attemptCount,
      code: detail,
    },
  });
  return Response.json({ received: true, outcome: 'dead_letter' }, { status: 200 });
}

/** Write the invoice this event carried, when it carried one. */
async function recordInvoiceLedger(event: NormalizedBillingEvent): Promise<void> {
  if (!event.invoice || !event.userId) return;
  await recordBillingInvoice({
    userId: event.userId,
    providerMode: event.providerMode,
    invoice: event.invoice,
    subscriptionId: event.subscriptionId,
    planKey: event.planKey,
  });
}

/**
 * Apply a refund or a dispute.
 *
 * The entitlement consequence is decided by the pure classifier and handed to
 * the database, which owns idempotency and the row lock. A refund on a charge
 * we could not link to a subscription still lands in the ledger with no
 * consequence, which is the honest record of what we know.
 */
async function applyRefund(event: NormalizedBillingEvent) {
  if (!event.refund) return null;
  return applyBillingRefundEvent({
    providerMode: event.providerMode,
    eventId: event.eventId,
    eventType: event.eventType,
    refund: event.refund,
    action: refundEntitlementAction(event.refund),
    userId: event.userId,
    subscriptionId: event.subscriptionId,
  });
}

/**
 * Tell the reader, and where it matters the operators.
 *
 * Deliberately after everything that changes state and deliberately unable to
 * fail the request: a webhook that granted a plan and could not write an Inbox
 * row has still granted the plan, and answering 500 would ask the provider to
 * redeliver an event that was already applied.
 */
async function announce(event: NormalizedBillingEvent, outcome: string): Promise<void> {
  try {
    const lifecycle = billingEventNotifications(event, outcome);
    const refunds = refundEventNotifications(event);
    for (const item of [...lifecycle.account, ...refunds.account]) {
      await notifyAccount(event.userId, item);
    }
    for (const item of [...lifecycle.admin, ...refunds.admin]) {
      await notifyAdmins(item);
    }
  } catch {
    record('billing_webhook_skipped', event.eventType, 'notification_failed');
  }
}

async function settleRetryLedger(event: NormalizedBillingEvent): Promise<void> {
  try {
    await resolveWebhookRetry({ providerMode: event.providerMode, eventId: event.eventId });
  } catch {
    // Nothing to do: a stale `retrying` row is reported by reconciliation and
    // resolved by the next successful delivery.
  }
}

/**
 * Which events end a purchase that was in flight.
 *
 * A paid invoice ends it because the plan is now bought; a voided or written-off
 * invoice and a cancelled subscription end it because it can never be paid. A
 * failed payment does **not**: on the PromptPay rail the reader can still scan
 * again before the due date, and clearing the row would take their QR away
 * while the invoice is still live.
 */
function settlesPendingPayment(event: NormalizedBillingEvent): boolean {
  return event.kind === 'payment_succeeded'
    || event.kind === 'invoice_closed'
    || event.kind === 'subscription_canceled';
}

async function settlePaymentRail(event: NormalizedBillingEvent): Promise<void> {
  if (!event.userId || !event.subscriptionId) return;
  const settled = settlesPendingPayment(event);
  if (!settled && !event.collectionMethod) return;

  await applyBillingPaymentRail({
    userId: event.userId,
    providerMode: event.providerMode,
    subscriptionId: event.subscriptionId,
    collectionMethod: event.collectionMethod,
    pendingSettled: settled,
  });
}

/**
 * Providers probe endpoints with a GET during setup. Answering with a plain
 * "this is here, POST to it" avoids a confusing 405 in their dashboard without
 * disclosing whether a secret is configured.
 */
export async function GET(): Promise<Response> {
  return Response.json({ endpoint: 'billing-webhook', method: 'POST' }, { status: 200 });
}
