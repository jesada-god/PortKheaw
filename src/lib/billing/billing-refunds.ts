/**
 * What money going back means for access.
 *
 * Pure, like `billing-events.ts` beside it: no I/O, no clock, no provider SDK.
 * An adapter hands these functions already-parsed numbers and they decide what
 * the product does about them — which is the part worth being able to test
 * exhaustively, because every branch below either takes away something somebody
 * paid for or leaves something in place that was paid for and then reclaimed.
 *
 * The policy, written down once so it can be pointed at:
 *
 *   full refund        Paid access ends, at the provider's refund timestamp.
 *                      The purchase was undone, so the thing it bought is over.
 *   partial refund     Recorded, and nothing else. A partial refund is a price
 *                      adjustment; downgrading somebody refunded 200 baht of
 *                      7,990 would cost a customer to fix an accounting detail.
 *   dispute opened     Paid access is suspended and operators are alerted. The
 *                      funds are already withheld and the outcome is weeks away.
 *                      A suspension can be undone; a month of free Elite handed
 *                      to a fraudulent chargeback cannot.
 *   dispute won        The suspension lifts and the previous status returns, if
 *                      the period it belonged to is still running.
 *   dispute lost       The suspension becomes a revocation.
 *
 * Nothing here deletes anything. A revoked account is a Basic account: every
 * portfolio, transaction, watchlist, alert and simulation survives, exactly as
 * it does when a subscription simply lapses.
 */

/** The three shapes a money-back event takes, in our vocabulary. */
export type BillingRefundKind = 'refund' | 'dispute_opened' | 'dispute_closed';

/** What the event does to entitlement. The database constrains it to these. */
export type BillingRefundAction = 'revoke' | 'suspend' | 'restore' | 'record_only';

/**
 * How a dispute ended, as the provider reports it. `warning_closed` and the
 * other warning states are not outcomes at all — they are notifications about a
 * charge that has not been disputed yet — so they map to `other` and change
 * nothing.
 */
export type BillingDisputeOutcome = 'won' | 'lost' | 'other';

export interface NormalizedRefundEvent {
  kind: BillingRefundKind;
  /** The provider's charge, kept for the ledger and for matching a dispute back. */
  chargeId: string | null;
  /** The invoice the charge paid, when the charge paid one. */
  invoiceId: string | null;
  /** The subscription the invoice belonged to. Identity, not entitlement. */
  subscriptionId: string | null;
  /** Money moved back, in the currency's minor unit (satang for THB). */
  amountMinor: number;
  /** What the charge was for, so "full" is a comparison rather than a guess. */
  chargeAmountMinor: number | null;
  currency: string;
  disputeOutcome: BillingDisputeOutcome | null;
  /** The provider's clock for the event, as ISO. */
  occurredAt: string;
}

/**
 * Whether a refund covers the whole charge.
 *
 * Compared against the charge's own amount rather than against the invoice, and
 * never inferred from the event name: `charge.refunded` fires for a partial
 * refund too. An unknown or non-positive charge amount answers `false`, which is
 * the fail-safe direction — it records the refund and leaves access alone rather
 * than revoking on the strength of a number we do not have.
 */
export function refundIsFull(amountMinor: number, chargeAmountMinor: number | null): boolean {
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return false;
  if (chargeAmountMinor === null || !Number.isFinite(chargeAmountMinor) || chargeAmountMinor <= 0) {
    return false;
  }
  return amountMinor >= chargeAmountMinor;
}

/**
 * The policy above, as one function.
 *
 * Every branch that is not explicitly an entitlement change falls through to
 * `record_only`, so an event shape this build does not understand is written
 * down and left without effect rather than acted on by guesswork.
 */
export function refundEntitlementAction(event: NormalizedRefundEvent): BillingRefundAction {
  switch (event.kind) {
    case 'refund':
      return refundIsFull(event.amountMinor, event.chargeAmountMinor) ? 'revoke' : 'record_only';
    case 'dispute_opened':
      return 'suspend';
    case 'dispute_closed':
      if (event.disputeOutcome === 'won') return 'restore';
      if (event.disputeOutcome === 'lost') return 'revoke';
      return 'record_only';
    default:
      return 'record_only';
  }
}

/** Whether operators must be told. A dispute is always somebody's problem. */
export function refundNeedsOperatorAlert(event: NormalizedRefundEvent): boolean {
  return event.kind === 'dispute_opened'
    || (event.kind === 'dispute_closed' && event.disputeOutcome === 'lost');
}

/**
 * Baht from satang, for display.
 *
 * Thai baht is a two-decimal currency at the provider, so every amount arrives
 * multiplied by a hundred. Rounded to whole baht because every price this
 * product sells is a whole number of them.
 */
export function bahtFromMinor(amountMinor: number, currency = 'thb'): number {
  if (!Number.isFinite(amountMinor)) return 0;
  // Zero-decimal currencies carry no minor unit at all. None is sold today; the
  // branch exists so a future one is not silently inflated a hundredfold.
  const zeroDecimal = new Set(['jpy', 'krw', 'vnd', 'clp']);
  return zeroDecimal.has(currency.toLowerCase())
    ? Math.round(amountMinor)
    : Math.round(amountMinor / 100);
}
