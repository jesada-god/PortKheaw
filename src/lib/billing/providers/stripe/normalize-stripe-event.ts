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
import type {
  BillingDisputeOutcome,
  BillingRefundKind,
  NormalizedRefundEvent,
} from '../../billing-refunds';
import {
  BILLING_METADATA_PLAN_KEY,
  BILLING_METADATA_PROVIDER_MODE,
  BILLING_METADATA_SCHEMA_VERSION,
  BILLING_METADATA_SCHEMA_VERSION_VALUE,
  BILLING_METADATA_USER_ID,
  gateEntitlementByCollectionMethod,
  mapProviderSubscriptionStatus,
  type BillingEventKind,
  type BillingPaymentStatus,
  type NormalizedBillingEvent,
  type NormalizedInvoiceRecord,
  type NormalizedSubscriptionState,
} from '../../billing-events';
import {
  isBillingCollectionMethod,
  type BillingCollectionMethod,
} from '../../billing-payment-method';
import { billingPlans, isBillingPlanKey, type BillingInterval, type BillingPlanKey, type PaidTier } from '../../billing-plans';
import { isTrustedBillingProviderMode, stripeProviderMode } from '../../billing-provider-mode';

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
  collectionMethod: BillingCollectionMethod | null;
} | null {
  const planKey = planKeyFrom(subscription.metadata);
  const metadataMode = readMetadata(subscription.metadata, BILLING_METADATA_PROVIDER_MODE);
  const schemaVersion = readMetadata(subscription.metadata, BILLING_METADATA_SCHEMA_VERSION);
  const objectMode = stripeProviderMode(subscription.livemode);
  if (
    !planKey
    || !isTrustedBillingProviderMode(metadataMode)
    || metadataMode !== objectMode
    || schemaVersion !== BILLING_METADATA_SCHEMA_VERSION_VALUE
  ) return null;

  // A subscription in this product has exactly one item. Reading the first is
  // therefore reading the only one; the period lives here, not on the parent.
  const item = subscription.items?.data?.[0];

  return {
    planKey,
    priceId: idOf(item?.price ?? null),
    userId: readMetadata(subscription.metadata, BILLING_METADATA_USER_ID),
    customerId: idOf(subscription.customer),
    subscriptionId: subscription.id,
    /*
     * Read from the provider's own field rather than from metadata we wrote.
     * Which rail a subscription is billed on is the provider's fact, and it is
     * what gates whether an event may open a period at all — so it must not be
     * something a bug in our checkout could mislabel. An unrecognised value
     * stays `null`, and the gate then treats the subscription as a card one only
     * if Stripe actually said so.
     */
    collectionMethod: isBillingCollectionMethod(subscription.collection_method)
      ? subscription.collection_method
      : null,
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
    /*
     * An invoice that will never be paid. Neither event grants or withdraws
     * anything — an unpaid PromptPay invoice never granted anything to withdraw
     * — but both settle the question of whether a purchase is still in flight,
     * which is what releases the account's one open-purchase slot.
     */
    case 'invoice.voided':
    case 'invoice.marked_uncollectible':
      return 'invoice_closed';
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
    case 'payment_failed':
    case 'invoice_closed': {
      // `invoice.subscription` was removed; the link is under `parent`.
      const invoice = object as Stripe.Invoice;
      return idOf(invoice.parent?.subscription_details?.subscription ?? null);
    }
    default:
      return null;
  }
}

/**
 * Which Stripe events describe money going back.
 *
 * Kept apart from `classifyStripeEvent` on purpose. Those events are `ignored`
 * for the *subscription* path and must stay that way: neither a refund nor a
 * dispute ends a Stripe subscription, so letting them reach the routine that
 * writes tier and period would be asserting a state the provider never asserted.
 * They travel their own path, into their own ledger, with their own idempotency.
 */
export function classifyStripeRefundEvent(type: string): BillingRefundKind | null {
  switch (type) {
    // Fires for a partial refund as well as a full one, which is exactly why
    // "full" is decided by comparing amounts rather than by reading this name.
    case 'charge.refunded':
      return 'refund';
    case 'charge.dispute.created':
      return 'dispute_opened';
    case 'charge.dispute.closed':
      return 'dispute_closed';
    default:
      return null;
  }
}

/**
 * How a dispute ended.
 *
 * The warning states — `warning_needs_response`, `warning_under_review`,
 * `warning_closed` — are notifications about a charge the bank is asking about,
 * not a dispute that has been decided, so they map to `other` and change
 * nothing. `needs_response` and `under_review` on a *closed* event are likewise
 * not outcomes.
 */
export function mapStripeDisputeOutcome(status: string | null | undefined): BillingDisputeOutcome | null {
  if (!status) return null;
  if (status === 'won') return 'won';
  if (status === 'lost') return 'lost';
  return 'other';
}

/** The invoice this ledger row is about, as the provider currently states it. */
export function normalizeStripeInvoice(invoice: Stripe.Invoice): NormalizedInvoiceRecord | null {
  if (!invoice.id) return null;
  // Stripe's status union stays open to values added later, so the allowlist is
  // an explicit membership test: `draft` and anything unrecognised describe an
  // invoice that has not been issued, and there is nothing to reconcile there.
  const recordable = ['open', 'paid', 'void', 'uncollectible'] as const;
  const status = recordable.find((candidate) => candidate === invoice.status);
  if (!status) return null;

  /*
   * The period a subscription invoice *covers* lives on its line item; the
   * invoice's own `period_start`/`period_end` describe when the invoice was
   * assembled and can be a single instant on a renewal. Reconciliation compares
   * this period against the stored one, so reading the wrong pair would
   * manufacture a mismatch on every account.
   */
  const line = invoice.lines?.data?.[0];
  const linePeriod = line?.period ?? null;

  return {
    invoiceId: invoice.id,
    status,
    amountDueMinor: typeof invoice.amount_due === 'number' ? invoice.amount_due : 0,
    amountPaidMinor: typeof invoice.amount_paid === 'number' ? invoice.amount_paid : 0,
    currency: (invoice.currency ?? 'thb').toLowerCase(),
    periodStart: isoFromUnix(linePeriod?.start) ?? isoFromUnix(invoice.period_start),
    periodEnd: isoFromUnix(linePeriod?.end) ?? isoFromUnix(invoice.period_end),
    issuedAt: isoFromUnix(invoice.created),
    paidAt: isoFromUnix(invoice.status_transitions?.paid_at),
  };
}

function invoiceRecordFromEvent(event: Stripe.Event): NormalizedInvoiceRecord | null {
  if (!INVOICE_KINDS.has(classifyStripeEvent(event.type))) return null;
  return normalizeStripeInvoice(event.data.object as Stripe.Invoice);
}

function paymentStatusFor(kind: BillingEventKind): BillingPaymentStatus | null {
  if (kind === 'payment_succeeded') return 'succeeded';
  if (kind === 'payment_failed') return 'failed';
  return null;
}

const INVOICE_KINDS = new Set<BillingEventKind>([
  'payment_succeeded',
  'payment_failed',
  'invoice_closed',
]);

function invoiceIdFromEvent(event: Stripe.Event): string | null {
  if (!INVOICE_KINDS.has(classifyStripeEvent(event.type))) return null;
  const invoice = event.data.object as Stripe.Invoice;
  return invoice.id ?? null;
}

/**
 * Whether the invoice this event carries is genuinely settled.
 *
 * The event *name* says a payment succeeded; this reads the invoice's own status
 * and requires it to agree. It costs nothing on the card rail, where the two
 * always match, and it is the last line of defence on the invoice rail, where
 * "an invoice exists" and "the invoice was paid" are days apart and only the
 * second one may open a period.
 */
function invoiceIsPaid(event: Stripe.Event): boolean {
  const invoice = event.data.object as Stripe.Invoice;
  return invoice.status === 'paid';
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
/**
 * The parts of a refund or dispute that only a provider lookup can supply.
 *
 * A dispute names a charge, a charge names an invoice, and an invoice names a
 * subscription — three hops, none of which is in the event body. The adapter
 * walks them and hands the result here so this file stays pure.
 */
export interface StripeRefundLinkage {
  chargeId: string | null;
  invoiceId: string | null;
  subscriptionId: string | null;
  /** What the charge was for, so a partial refund can be told from a full one. */
  chargeAmountMinor: number | null;
}

/**
 * A refund or dispute, in our vocabulary.
 *
 * Returns `null` for an event type this build does not treat as money going
 * back, so a caller cannot accidentally route an ordinary event down this path.
 */
export function normalizeStripeRefundEvent(
  event: Stripe.Event,
  linkage: StripeRefundLinkage,
): NormalizedRefundEvent | null {
  const kind = classifyStripeRefundEvent(event.type);
  if (!kind) return null;

  const occurredAt = isoFromUnix(event.created) ?? new Date(0).toISOString();

  if (kind === 'refund') {
    const charge = event.data.object as Stripe.Charge;
    return {
      kind,
      chargeId: linkage.chargeId ?? charge.id ?? null,
      invoiceId: linkage.invoiceId,
      subscriptionId: linkage.subscriptionId,
      // `amount_refunded` is cumulative, which is the number that matters: two
      // partial refunds that add up to the charge are a full refund.
      amountMinor: typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0,
      chargeAmountMinor: linkage.chargeAmountMinor
        ?? (typeof charge.amount === 'number' ? charge.amount : null),
      currency: (charge.currency ?? 'thb').toLowerCase(),
      disputeOutcome: null,
      occurredAt,
    };
  }

  const dispute = event.data.object as Stripe.Dispute;
  return {
    kind,
    chargeId: linkage.chargeId ?? idOf(dispute.charge),
    invoiceId: linkage.invoiceId,
    subscriptionId: linkage.subscriptionId,
    amountMinor: typeof dispute.amount === 'number' ? dispute.amount : 0,
    chargeAmountMinor: linkage.chargeAmountMinor,
    currency: (dispute.currency ?? 'thb').toLowerCase(),
    disputeOutcome: mapStripeDisputeOutcome(dispute.status),
    occurredAt,
  };
}

export function normalizeStripeEvent(
  event: Stripe.Event,
  subscription: Stripe.Subscription | null,
  refund: NormalizedRefundEvent | null = null,
): NormalizedBillingEvent {
  const kind = classifyStripeEvent(event.type);
  const normalized = subscription ? normalizeStripeSubscription(subscription) : null;

  let state: NormalizedSubscriptionState | null = normalized?.state ?? null;

  // A "payment succeeded" event whose invoice does not say `paid` asserts
  // nothing. Fail closed rather than trust the event name over the object.
  if (state && kind === 'payment_succeeded' && !invoiceIsPaid(event)) state = null;

  if (state && kind === 'payment_failed' && !TERMINAL_STATUSES.has(state.status)) {
    state = { ...state, status: 'past_due' };
  }

  // Last, because it is the rule that overrides all of the above: on the invoice
  // rail only a paid invoice may carry a period.
  state = gateEntitlementByCollectionMethod(kind, state, normalized?.collectionMethod ?? null);

  return {
    provider: 'stripe',
    providerMode: stripeProviderMode(event.livemode),
    eventId: event.id,
    eventType: event.type,
    kind,
    occurredAt: isoFromUnix(event.created) ?? new Date(0).toISOString(),
    userId: normalized?.userId ?? checkoutUserId(event),
    customerId: normalized?.customerId ?? checkoutCustomerId(event),
    subscriptionId: normalized?.subscriptionId
      ?? subscriptionIdFromEvent(event)
      ?? refund?.subscriptionId
      ?? null,
    planKey: normalized?.planKey ?? null,
    priceId: normalized?.priceId ?? null,
    invoiceId: invoiceIdFromEvent(event) ?? refund?.invoiceId ?? null,
    paymentStatus: paymentStatusFor(kind),
    collectionMethod: normalized?.collectionMethod ?? null,
    state: kind === 'ignored' ? null : state,
    invoice: invoiceRecordFromEvent(event),
    refund,
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
