/**
 * Which Inbox items a verified billing event produces.
 *
 * Pure, and separate from the route on purpose: "did the reader get told the
 * right thing?" is a question worth answering in a test rather than by sending
 * a real payment through Stripe. The route's job is to call this and hand the
 * result to the dispatcher.
 *
 * Two things this file is careful about.
 *
 * **It describes what happened, not what was delivered.** A cancellation
 * scheduled for the end of a paid period and one that took effect immediately
 * are different sentences, and getting them the wrong way round is how a reader
 * concludes they lost a month they had already paid for.
 *
 * **It never invents a notification for an event that changed nothing.** An
 * event held by the revocation rule, a duplicate redelivery and a stale
 * out-of-order event all produce an empty list — the idempotency key would have
 * collapsed them anyway, but not producing them is cheaper and clearer.
 */

import {
  adminDisputeNotification,
  adminReconciliationNotification,
  cardPaymentFailedNotification,
  disputeOpenedNotification,
  entitlementExpiredNotification,
  packageActivatedNotification,
  paymentSucceededNotification,
  refundRecordedNotification,
  subscriptionCanceledNotification,
  type AccountNotification,
} from '@/src/lib/notifications/account-events';
import type { NormalizedBillingEvent } from './billing-events';
import { billingPlans } from './billing-plans';
import { bahtFromMinor, refundEntitlementAction, refundIsFull } from './billing-refunds';

/** The generic name, for an event whose plan key we could not read. */
const FALLBACK_PLAN_NAME = 'PortKheaw';

export function planNameFor(planKey: string | null): string {
  if (!planKey) return FALLBACK_PLAN_NAME;
  return planKey in billingPlans
    ? billingPlans[planKey as keyof typeof billingPlans].name
    : FALLBACK_PLAN_NAME;
}

export interface BillingNotificationPlan {
  /** For the account the event concerns. Empty when nothing needs saying. */
  account: AccountNotification[];
  /** For every operator. Disputes and lost chargebacks, and nothing routine. */
  admin: AccountNotification[];
}

const EMPTY: BillingNotificationPlan = { account: [], admin: [] };

/**
 * The subscription-lifecycle notices.
 *
 * `outcome` is what the database actually did. Only `applied` is allowed to
 * produce an activation or a cancellation notice, because only `applied` means
 * the stored state moved.
 */
export function billingEventNotifications(
  event: NormalizedBillingEvent,
  outcome: string,
): BillingNotificationPlan {
  if (!event.userId) return EMPTY;

  const account: AccountNotification[] = [];
  const planName = planNameFor(event.planKey);

  // A payment is a payment whatever the subscription routine decided about it:
  // the money moved, and the invoice says so.
  if (event.kind === 'payment_succeeded' && event.invoice?.status === 'paid') {
    account.push(paymentSucceededNotification({
      invoiceId: event.invoice.invoiceId,
      planName,
      amountBaht: bahtFromMinor(event.invoice.amountPaidMinor, event.invoice.currency),
      occurredAt: event.occurredAt,
    }));
  }

  /*
   * A failed *card* renewal. The PromptPay rail is excluded deliberately: there
   * is no stored credential to fail there, the reader is already being reminded
   * to scan, and telling them their card was declined when they have never given
   * us one would be nonsense.
   */
  if (
    event.kind === 'payment_failed'
    && event.collectionMethod === 'charge_automatically'
    && event.invoiceId
  ) {
    account.push(cardPaymentFailedNotification({
      invoiceId: event.invoiceId,
      planName,
      periodEnd: event.state?.currentPeriodEnd ?? null,
      occurredAt: event.occurredAt,
    }));
  }

  if (outcome === 'applied' && event.state && event.subscriptionId) {
    if (event.state.status === 'active') {
      account.push(packageActivatedNotification({
        subscriptionId: event.subscriptionId,
        periodStart: event.state.currentPeriodStart,
        periodEnd: event.state.currentPeriodEnd,
        planName,
        occurredAt: event.occurredAt,
      }));
    }

    if (event.kind === 'subscription_canceled') {
      account.push(subscriptionCanceledNotification({
        subscriptionId: event.subscriptionId,
        planName,
        accessEndsAt: event.state.currentPeriodEnd,
        // The subscription is over at the provider. Whether any access remains
        // is decided by the stored period, which the notice states either way.
        immediate: !event.state.currentPeriodEnd,
        occurredAt: event.occurredAt,
      }));
    } else if (event.state.cancelAtPeriodEnd) {
      account.push(subscriptionCanceledNotification({
        subscriptionId: event.subscriptionId,
        planName,
        accessEndsAt: event.state.currentPeriodEnd,
        immediate: false,
        occurredAt: event.occurredAt,
      }));
    }
  }

  return { account, admin: [] };
}

/**
 * The refund and dispute notices.
 *
 * A partial refund still tells the reader — money left their account and they
 * should hear it from us before they see it on a statement — but says plainly
 * that the plan continues.
 */
export function refundEventNotifications(
  event: NormalizedBillingEvent,
): BillingNotificationPlan {
  const refund = event.refund;
  if (!refund) return EMPTY;

  const account: AccountNotification[] = [];
  const admin: AccountNotification[] = [];
  const planName = planNameFor(event.planKey);
  const action = refundEntitlementAction(refund);
  const amountBaht = bahtFromMinor(refund.amountMinor, refund.currency);

  if (refund.kind === 'refund' && event.userId) {
    account.push(refundRecordedNotification({
      eventId: event.eventId,
      amountBaht,
      full: refundIsFull(refund.amountMinor, refund.chargeAmountMinor),
      occurredAt: refund.occurredAt,
    }));
  }

  if (refund.kind === 'dispute_opened') {
    if (event.userId) {
      account.push(disputeOpenedNotification({
        eventId: event.eventId,
        planName,
        occurredAt: refund.occurredAt,
      }));
    }
    admin.push(adminDisputeNotification({
      eventId: event.eventId,
      amountBaht,
      observedAt: refund.occurredAt,
    }));
  }

  // A lost dispute turns a suspension into a revocation, which operators need to
  // see even though the reader was already told when it opened.
  if (refund.kind === 'dispute_closed' && action === 'revoke') {
    admin.push(adminDisputeNotification({
      eventId: event.eventId,
      amountBaht,
      observedAt: refund.occurredAt,
    }));
  }

  return { account, admin };
}

/* Re-exported so the scheduler imports its two notices from one place. */
export { adminReconciliationNotification, entitlementExpiredNotification };
