import { createHash } from 'node:crypto';
import { getBillingConfig } from '@/src/lib/billing/billing-server';
import {
  applyBillingEvent,
  applyBillingPaymentRail,
  BillingAdminUnavailableError,
} from '@/src/lib/billing/billing-repository';
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
  | 'billing_webhook_failed';

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

    if (outcome === 'applied') {
      // Access has genuinely changed, so every cached render that depended on it
      // has to go. Same invalidation the admin preview performs, on purpose.
      revalidateEveryEntitlementSurface();
      record('billing_webhook_applied', event.eventType, outcome);
    } else {
      // `duplicate`, `stale`, `ignored` and the mismatch outcomes are all
      // successful *handling* — the provider must not retry them.
      record('billing_webhook_skipped', event.eventType, outcome);
    }

    return Response.json({ received: true, outcome }, { status: 200 });
  } catch (error) {
    /*
     * A 500 here is deliberate: it asks the provider to redeliver. The event id
     * was either never claimed, or claimed inside a transaction that rolled
     * back, so a redelivery is safe — it will be processed exactly once.
     */
    const detail = error instanceof BillingAdminUnavailableError ? 'admin_unavailable' : 'apply_failed';
    record('billing_webhook_failed', event.eventType, detail);
    return Response.json({ error: 'processing_failed' }, { status: 500 });
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
