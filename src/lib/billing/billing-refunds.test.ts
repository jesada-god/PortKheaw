import { describe, expect, it } from 'vitest';
import {
  bahtFromMinor,
  refundEntitlementAction,
  refundIsFull,
  refundNeedsOperatorAlert,
  type NormalizedRefundEvent,
} from './billing-refunds';

const BASE: NormalizedRefundEvent = {
  kind: 'refund',
  chargeId: 'ch_1',
  invoiceId: 'in_1',
  subscriptionId: 'sub_1',
  amountMinor: 799_000,
  chargeAmountMinor: 799_000,
  currency: 'thb',
  disputeOutcome: null,
  occurredAt: '2026-08-05T00:00:00.000Z',
};

function event(overrides: Partial<NormalizedRefundEvent> = {}): NormalizedRefundEvent {
  return { ...BASE, ...overrides };
}

describe('deciding whether a refund is full', () => {
  it('compares the refunded amount against the charge, not against the event name', () => {
    expect(refundIsFull(799_000, 799_000)).toBe(true);
    // Cumulative refunds that reach the charge total are a full refund.
    expect(refundIsFull(800_000, 799_000)).toBe(true);
    expect(refundIsFull(20_000, 799_000)).toBe(false);
  });

  it('fails safe when the charge amount is unknown', () => {
    // Answering `false` records the refund and leaves access alone, which is the
    // direction that cannot take away something somebody paid for by mistake.
    expect(refundIsFull(799_000, null)).toBe(false);
    expect(refundIsFull(799_000, 0)).toBe(false);
    expect(refundIsFull(Number.NaN, 799_000)).toBe(false);
    expect(refundIsFull(0, 799_000)).toBe(false);
  });
});

describe('the entitlement policy', () => {
  it('ends access on a full refund', () => {
    expect(refundEntitlementAction(event())).toBe('revoke');
  });

  it('records a partial refund and changes nothing', () => {
    expect(refundEntitlementAction(event({ amountMinor: 20_000 }))).toBe('record_only');
  });

  it('suspends on a dispute being opened', () => {
    expect(refundEntitlementAction(event({ kind: 'dispute_opened' }))).toBe('suspend');
  });

  it('restores a suspension when the dispute is won', () => {
    expect(refundEntitlementAction(event({
      kind: 'dispute_closed',
      disputeOutcome: 'won',
    }))).toBe('restore');
  });

  it('turns a lost dispute into a revocation', () => {
    expect(refundEntitlementAction(event({
      kind: 'dispute_closed',
      disputeOutcome: 'lost',
    }))).toBe('revoke');
  });

  it('does nothing for a dispute that merely closed without an outcome', () => {
    // The provider's warning states close without deciding anything. Acting on
    // them would suspend or restore an account on a notification.
    expect(refundEntitlementAction(event({
      kind: 'dispute_closed',
      disputeOutcome: 'other',
    }))).toBe('record_only');
    expect(refundEntitlementAction(event({
      kind: 'dispute_closed',
      disputeOutcome: null,
    }))).toBe('record_only');
  });
});

describe('when operators must be told', () => {
  it('pages on a dispute opening and on losing one', () => {
    expect(refundNeedsOperatorAlert(event({ kind: 'dispute_opened' }))).toBe(true);
    expect(refundNeedsOperatorAlert(event({
      kind: 'dispute_closed',
      disputeOutcome: 'lost',
    }))).toBe(true);
  });

  it('stays quiet for ordinary refunds and won disputes', () => {
    expect(refundNeedsOperatorAlert(event())).toBe(false);
    expect(refundNeedsOperatorAlert(event({
      kind: 'dispute_closed',
      disputeOutcome: 'won',
    }))).toBe(false);
  });
});

describe('minor units', () => {
  it('converts satang to baht', () => {
    expect(bahtFromMinor(799_000, 'thb')).toBe(7_990);
    expect(bahtFromMinor(449_000, 'THB')).toBe(4_490);
  });

  it('leaves a zero-decimal currency alone', () => {
    // No zero-decimal currency is sold today; the branch exists so a future one
    // is not silently inflated a hundredfold.
    expect(bahtFromMinor(7_990, 'jpy')).toBe(7_990);
  });

  it('never returns NaN', () => {
    expect(bahtFromMinor(Number.NaN, 'thb')).toBe(0);
  });
});
