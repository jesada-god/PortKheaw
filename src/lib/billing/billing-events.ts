/**
 * The provider-agnostic shape of "something happened to a subscription", and the
 * rules for turning a provider's vocabulary into ours.
 *
 * A webhook is the only thing in this product allowed to change what someone has
 * paid for, so the translation from the provider's status to ours is written
 * down here, once, as pure functions. Nothing in this file performs I/O, imports
 * a provider SDK or reads a clock — an adapter hands it already-parsed values
 * and it decides what they mean.
 *
 * The interesting decisions, all of which are deliberate:
 *
 *   * A provider trial maps to `active`, never to our `trialing`. Our `trialing`
 *     is the seven-day Elite grant from Phase 2 and resolves to Elite whatever
 *     the plan says — so letting a provider-side trial on *Pro* land in it would
 *     silently hand out Elite.
 *   * `unpaid`, `paused` and `incomplete_expired` all mean access is over, and
 *     they map to `expired` rather than to `canceled`, which is reserved for a
 *     cancellation someone actually asked for.
 *   * `incomplete` — a first payment that never completed — maps to `basic`.
 *     Nothing was bought, so nothing is owed and nothing is granted.
 */

import type { SubscriptionStatus } from '@/src/lib/subscription/subscription-types';
import type { BillingCollectionMethod } from './billing-payment-method';
import type { BillingInterval, BillingPlanKey, PaidTier } from './billing-plans';
import type { TrustedBillingProviderMode } from './billing-provider-mode';
import type { NormalizedRefundEvent } from './billing-refunds';

/** Metadata keys we set on the provider objects, so an event can name our user. */
export const BILLING_METADATA_USER_ID = 'portkheaw_user_id';
export const BILLING_METADATA_PLAN_KEY = 'portkheaw_plan_key';
export const BILLING_METADATA_PROVIDER_MODE = 'portkheaw_provider_mode';
export const BILLING_METADATA_SCHEMA_VERSION = 'portkheaw_billing_schema';
export const BILLING_METADATA_SCHEMA_VERSION_VALUE = '1';

/**
 * What an event does to our records. Narrow on purpose: the adapter collapses
 * the provider's long event catalogue into these, and anything it does not
 * recognise becomes `ignored` rather than a guess.
 */
export type BillingEventKind =
  /** A checkout finished. Carries the identity linkage, not necessarily the state. */
  | 'checkout_completed'
  /** The subscription's own state changed — created, updated, plan switched. */
  | 'subscription_changed'
  /** An invoice was paid. The only event that may *start* a paid period. */
  | 'payment_succeeded'
  /** An invoice failed. Moves to `past_due` under the grace policy below. */
  | 'payment_failed'
  /** The subscription ended, by request or by exhaustion. */
  | 'subscription_canceled'
  /**
   * An invoice was closed without being paid — voided, or written off. It never
   * changes entitlement (nothing was ever granted for it); it exists so an
   * abandoned PromptPay invoice stops occupying the account's one purchase slot.
   */
  | 'invoice_closed'
  /** Received, understood, and deliberately without effect on entitlement. */
  | 'ignored';

/** The subscription state an event asserts, already in our vocabulary. */
export interface NormalizedSubscriptionState {
  tier: PaidTier;
  status: SubscriptionStatus;
  interval: BillingInterval | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface NormalizedBillingEvent {
  provider: 'stripe';
  /** Derived only from `livemode` on the signed provider event. */
  providerMode: TrustedBillingProviderMode;
  /** The provider's own event id. The idempotency key, and it must be unique. */
  eventId: string;
  /** The provider's event name, kept verbatim for the audit row. */
  eventType: string;
  kind: BillingEventKind;
  /**
   * The provider's clock, as ISO. This is the ordering key: an event that is
   * older than the one already applied must never overwrite it.
   */
  occurredAt: string;
  /** Our user id, read from metadata we set ourselves. Never from an email. */
  userId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  planKey: BillingPlanKey | null;
  priceId: string | null;
  /** The invoice this event concerned, when it concerned one. */
  invoiceId: string | null;
  /** Recorded for the reader's benefit; entitlement comes from `state`. */
  paymentStatus: BillingPaymentStatus | null;
  /**
   * How the provider collects for this subscription, which is what tells the two
   * rails apart: `charge_automatically` renews itself, `send_invoice` does not.
   * It decides both what the manage card says and — through
   * `gateEntitlementByCollectionMethod` — which events may open a period at all.
   */
  collectionMethod: BillingCollectionMethod | null;
  /** Absent on events that carry identity but assert no subscription state. */
  state: NormalizedSubscriptionState | null;
  /**
   * Phase 5. What the provider billed, when the event concerned an invoice.
   *
   * Recorded separately from entitlement and by a routine that cannot grant
   * one: "an invoice exists and was paid" and "a plan is open" stay two facts,
   * which is what lets reconciliation compare them.
   */
  invoice: NormalizedInvoiceRecord | null;
  /**
   * Phase 5. Money going back. Present only on refund and dispute events, which
   * carry no subscription state of their own — the entitlement consequence is
   * decided by `refundEntitlementAction` and applied by its own routine.
   */
  refund: NormalizedRefundEvent | null;
}

/** The subset of a provider invoice worth keeping. No card detail exists here. */
export interface NormalizedInvoiceRecord {
  invoiceId: string;
  /** Only the four states an invoice ledger row may be *written* into. */
  status: 'open' | 'paid' | 'void' | 'uncollectible';
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string | null;
  paidAt: string | null;
}

/** The outcome of the most recent invoice attempt, as shown on the manage page. */
export const billingPaymentStatuses = ['succeeded', 'failed'] as const;
export type BillingPaymentStatus = typeof billingPaymentStatuses[number];

/**
 * The grace policy, named so it can be pointed at.
 *
 * A failed renewal does not end access on the spot. The provider retries for a
 * dunning window, and during it the subscription keeps the period it has already
 * been granted — so access continues until `current_period_end` and then stops
 * on its own. It is bounded by a timestamp the provider set, never by a timer of
 * ours, which is why a stalled dunning cycle cannot become unlimited free
 * access. When the provider gives up it sends `unpaid` or `canceled`, and both
 * of those end access immediately.
 *
 * The same rule is implemented in `resolve_effective_subscription_tier` in the
 * database, and the two are checked against each other in tests.
 */
export const PAST_DUE_KEEPS_ACCESS_UNTIL_PERIOD_END = true;

/**
 * Provider subscription status → ours.
 *
 * Unrecognised values fail closed to `expired`: a status we do not understand
 * must never be the one that grants a paid tier.
 */
export function mapProviderSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
    // A provider-side trial is a paid plan whose first invoice is deferred. It
    // grants exactly the plan bought, so it is `active` — see the note above on
    // why it must not become our `trialing`.
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    // Nothing was ever successfully bought, so nothing is granted and nothing is
    // owed. Distinct from `expired`, which means access existed and has ended.
    case 'incomplete':
      return 'basic';
    case 'unpaid':
    case 'paused':
    case 'incomplete_expired':
      return 'expired';
    default:
      return 'expired';
  }
}

/**
 * Whether an incoming event may overwrite what is already stored.
 *
 * Providers do not guarantee delivery order, and a retry of an old event can
 * arrive after a newer one. Comparing the provider's own clocks — never ours —
 * is what stops a late `payment_failed` from pulling a since-recovered account
 * back into `past_due`.
 *
 * Equal timestamps are allowed through: two events can share a second, and the
 * database applies them under a row lock, so the later arrival simply wins. The
 * idempotency key is what prevents the *same* event being applied twice.
 */
export function isFreshEvent(occurredAt: string, appliedAt: string | null): boolean {
  if (!appliedAt) return true;
  const incoming = Date.parse(occurredAt);
  const applied = Date.parse(appliedAt);
  if (!Number.isFinite(incoming)) return false;
  if (!Number.isFinite(applied)) return true;
  return incoming >= applied;
}

/** Events that carry no entitlement consequence still get logged, never applied. */
export function eventChangesEntitlement(event: NormalizedBillingEvent): boolean {
  return event.kind !== 'ignored' && event.state !== null;
}

/**
 * The rule that makes an invoice-collected subscription safe: **a paid period is
 * the only period.**
 *
 * A `send_invoice` subscription — which is what PromptPay must be, since there is
 * no credential to charge — behaves in one way that would quietly give away the
 * product if it were treated like a card one. The provider activates it the
 * moment it is created, before a satang has moved, and at every renewal it
 * advances the billing period as soon as the new invoice is *issued*. Applied
 * naively, creating an invoice would grant a year of Elite, and never paying the
 * second year's invoice would extend it by another.
 *
 * So for this rail entitlement is a lease, and only money extends it:
 *
 *   * a paid invoice asserts the period it paid for — the one moment a period
 *     may move forward;
 *   * a cancellation and a failed payment assert their status but carry **no**
 *     period, so the stored, already-paid period stands and expires by itself;
 *   * everything else — created, updated, checkout completed — asserts nothing
 *     at all, because an issued invoice is a request for money, not money.
 *
 * `charge_automatically` is untouched: a card subscription is billed before the
 * period it grants, so its own events are already evidence of payment.
 */
export function gateEntitlementByCollectionMethod(
  kind: BillingEventKind,
  state: NormalizedSubscriptionState | null,
  collectionMethod: BillingCollectionMethod | null,
): NormalizedSubscriptionState | null {
  if (!state || collectionMethod !== 'send_invoice') return state;

  switch (kind) {
    case 'payment_succeeded':
      return state;
    case 'subscription_canceled':
    case 'payment_failed':
      return { ...state, currentPeriodStart: null, currentPeriodEnd: null };
    default:
      return null;
  }
}
