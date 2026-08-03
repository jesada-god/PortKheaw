/**
 * Stripe's vocabulary → ours. Pure, and deliberately so.
 *
 * Every function here takes an already-parsed Stripe object and returns plain
 * data. No network, no clock, no secret. That is what lets the whole webhook
 * mapping — which is the part of billing that decides who has paid for what — be
 * tested exhaustively without a Stripe account.
 *
 * Two details of the pinned API version (`2026-07-29.dahlia`) are load-bearing
 * and were verified against the installed typings rather than assumed, because
 * both moved in recent versions and both fail silently if guessed:
 *
 *   * the billing period lives on the **subscription item**
 *     (`items.data[].current_period_end`), not on the subscription;
 *   * an invoice names its subscription through
 *     `parent.subscription_details.subscription`, not `invoice.subscription`,
 *     which no longer exists.
 */

import type Stripe from 'stripe';
import {
  BILLING_METADATA_PLAN_KEY,
  BILLING_METADATA_USER_ID,
  mapProviderSubscriptionStatus,
  type BillingEventKind,
  type BillingPaymentStatus,
  type NormalizedBillingEvent,
  type NormalizedSubscriptionState,
} from '../../billing-events';
import { billingPlans, isBillingPlanKey, type BillingInterval, type BillingPlanKey, type PaidTier } from '../../billing-plans';

/** Seconds since the epoch → ISO, or null for an absent timestamp. */
function isoFromUnix(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

/** Stripe returns either an id or an expanded object; we only ever want the id. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id ?? null;
}

function readMetadata(metadata: Stripe.Metadata | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function planKeyFrom(metadata: Stripe.Metadata | null | undefined): BillingPlanKey | null {
  const value = readMetadata(metadata, BILLING_METADATA_PLAN_KEY);
  return isBillingPlanKey(value) ? value : null;
}

/**
 * Stripe's interval union stays open to values this product does not sell
 * (`day`, `week`, and anything added later), so an unrecognised cadence becomes
 * `null` and the caller falls back to the cadence the plan key already implies.
 */
function intervalFrom(price: Stripe.Price | null | undefined): BillingInterval | null {
  const interval = price?.recurring?.interval;
  if (interval === 'month') return 'month';
  if (interval === 'year') return 'year';
  return null;
}

/**
 * The tier a subscription grants.
 *
 * Read from the plan key we wrote into the subscription's own metadata at
 * checkout — our value, on our object, never inferred from an amount. A
 * subscription whose metadata is missing or unrecognised yields `null`, and the
 * caller refuses the event rather than picking a tier for it.
 */
export function tierFromSubscription(subscription: Stripe.Subscription): PaidTier | null {
  const key = planKeyFrom(subscription.metadata);
  return key ? billingPlans[key].tier : null;
}

/**
 * The full subscription state, in our vocabulary.
 *
 * Returns `null` when the object does not carry a recognised plan key, which is
 * the fail-closed path: an unrecognised subscription is logged and left alone
 * rather than being mapped onto a tier by guesswork.
 */
export function normalizeStripeSubscription(subscription: Stripe.Subscription): {
  state: NormalizedSubscriptionState;
  planKey: BillingPlanKey;
  priceId: string | null;
  userId: string | null;
  customerId: string | null;
  subscriptionId: string;
} | null {
  const planKey = planKeyFrom(subscription.metadata);
  if (!planKey) return null;

  // A subscription in this product has exactly one item. Reading the first is
  // therefore reading the only one; the period lives here, not on the parent.
  const item = subscription.items?.data?.[0];

  return {
    planKey,
    priceId: idOf(item?.price ?? null),
    userId: readMetadata(subscription.metadata, BILLING_METADATA_USER_ID),
    customerId: idOf(subscription.customer),
    subscriptionId: subscription.id,
    state: {
      tier: billingPlans[planKey].tier,
      status: mapProviderSubscriptionStatus(subscription.status),
      interval: intervalFrom(item?.price) ?? billingPlans[planKey].interval,
      currentPeriodStart: isoFromUnix(item?.current_period_start),
      currentPeriodEnd: isoFromUnix(item?.current_period_end),
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    },
  };
}

/**
 * Which Stripe events we act on.
 *
 * Anything not listed is `ignored`: recorded in the audit table so the endpoint
 * is never silently dropping traffic, but with no effect on entitlement.
 * Refunds and disputes sit here deliberately — neither ends a subscription by
 * itself in Stripe, and when one does lead to a cancellation that cancellation
 * arrives as its own `customer.subscription.deleted`.
 */
export function classifyStripeEvent(type: string): BillingEventKind {
  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return 'checkout_completed';
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return 'subscription_changed';
    case 'customer.subscription.deleted':
      return 'subscription_canceled';
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return 'payment_succeeded';
    case 'invoice.payment_failed':
    case 'checkout.session.async_payment_failed':
      return 'payment_failed';
    default:
      return 'ignored';
  }
}

/** The subscription id an event points at, wherever this event type keeps it. */
export function subscriptionIdFromEvent(event: Stripe.Event): string | null {
  // `data.object` is a union of every Stripe resource, so each branch below
  // narrows it by the event type that produced it rather than by a type guard.
  const object: unknown = event.data.object;

  switch (classifyStripeEvent(event.type)) {
    case 'checkout_completed':
      return idOf((object as Stripe.Checkout.Session).subscription);
    case 'subscription_changed':
    case 'subscription_canceled':
      return (object as Stripe.Subscription).id ?? null;
    case 'payment_succeeded':
    case 'payment_failed': {
      // `invoice.subscription` was removed; the link is under `parent`.
      const invoice = object as Stripe.Invoice;
      return idOf(invoice.parent?.subscription_details?.subscription ?? null);
    }
    default:
      return null;
  }
}

function paymentStatusFor(kind: BillingEventKind): BillingPaymentStatus | null {
  if (kind === 'payment_succeeded') return 'succeeded';
  if (kind === 'payment_failed') return 'failed';
  return null;
}

function invoiceIdFromEvent(event: Stripe.Event): string | null {
  const kind = classifyStripeEvent(event.type);
  if (kind !== 'payment_succeeded' && kind !== 'payment_failed') return null;
  const invoice = event.data.object as Stripe.Invoice;
  return invoice.id ?? null;
}

/**
 * Statuses a failed payment must not overwrite.
 *
 * `payment_failed` asserts `past_due`, because that is what a failed renewal
 * means to a reader and what the grace policy is written against. But a failure
 * arriving after the subscription has already ended must not resurrect it into a
 * state that grants access — so a terminal stored status wins.
 */
const TERMINAL_STATUSES = new Set(['canceled', 'expired']);

/**
 * The event, fully normalized.
 *
 * `subscription` is the authoritative object fetched by the adapter — Stripe's
 * own current view — rather than whatever was embedded in the event payload,
 * which may be a stale snapshot by the time a retry is delivered.
 */
export function normalizeStripeEvent(
  event: Stripe.Event,
  subscription: Stripe.Subscription | null,
): NormalizedBillingEvent {
  const kind = classifyStripeEvent(event.type);
  const normalized = subscription ? normalizeStripeSubscription(subscription) : null;

  let state: NormalizedSubscriptionState | null = normalized?.state ?? null;

  if (state && kind === 'payment_failed' && !TERMINAL_STATUSES.has(state.status)) {
    state = { ...state, status: 'past_due' };
  }

  return {
    provider: 'stripe',
    eventId: event.id,
    eventType: event.type,
    kind,
    occurredAt: isoFromUnix(event.created) ?? new Date(0).toISOString(),
    userId: normalized?.userId ?? checkoutUserId(event),
    customerId: normalized?.customerId ?? checkoutCustomerId(event),
    subscriptionId: normalized?.subscriptionId ?? subscriptionIdFromEvent(event),
    planKey: normalized?.planKey ?? null,
    priceId: normalized?.priceId ?? null,
    invoiceId: invoiceIdFromEvent(event),
    paymentStatus: paymentStatusFor(kind),
    state: kind === 'ignored' ? null : state,
  };
}

/**
 * The identity carried by a checkout session itself.
 *
 * Used only as a fallback for logging when the subscription could not be read;
 * entitlement is never granted from it, because a session is a request to buy
 * and the subscription is the record of having bought.
 */
function checkoutUserId(event: Stripe.Event): string | null {
  if (classifyStripeEvent(event.type) !== 'checkout_completed') return null;
  const session = event.data.object as Stripe.Checkout.Session;
  return readMetadata(session.metadata, BILLING_METADATA_USER_ID) ?? session.client_reference_id ?? null;
}

function checkoutCustomerId(event: Stripe.Event): string | null {
  if (classifyStripeEvent(event.type) !== 'checkout_completed') return null;
  const session = event.data.object as Stripe.Checkout.Session;
  return idOf(session.customer);
}
