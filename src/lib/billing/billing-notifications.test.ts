import { describe, expect, it } from 'vitest';
import { billingEventNotifications, refundEventNotifications, planNameFor } from './billing-notifications';
import type { NormalizedBillingEvent } from './billing-events';

const NOW = '2026-08-05T03:00:00.000Z';
const PERIOD_END = '2027-08-05T03:00:00.000Z';

function event(overrides: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent {
  return {
    provider: 'stripe',
    providerMode: 'test',
    eventId: 'evt_1',
    eventType: 'invoice.paid',
    kind: 'payment_succeeded',
    occurredAt: NOW,
    userId: 'user-1',
    customerId: 'cus_1',
    subscriptionId: 'sub_1',
    planKey: 'elite_annual',
    priceId: 'price_1',
    invoiceId: 'in_1',
    paymentStatus: 'succeeded',
    collectionMethod: 'charge_automatically',
    state: {
      tier: 'elite',
      status: 'active',
      interval: 'year',
      currentPeriodStart: NOW,
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
    },
    invoice: {
      invoiceId: 'in_1',
      status: 'paid',
      amountDueMinor: 799_000,
      amountPaidMinor: 799_000,
      currency: 'thb',
      periodStart: NOW,
      periodEnd: PERIOD_END,
      issuedAt: NOW,
      paidAt: NOW,
    },
    refund: null,
    ...overrides,
  };
}

function kinds(items: { kind: string }[]): string[] {
  return items.map((item) => item.kind);
}

describe('subscription lifecycle notices', () => {
  it('announces the payment and the activation on a paid renewal', () => {
    const plan = billingEventNotifications(event(), 'applied');
    expect(kinds(plan.account)).toEqual(['payment_succeeded', 'package_activated']);
    expect(plan.admin).toEqual([]);
  });

  it('says nothing at all for an anonymous event', () => {
    const plan = billingEventNotifications(event({ userId: null }), 'applied');
    expect(plan.account).toEqual([]);
  });

  it('still reports the payment when the subscription routine skipped the event', () => {
    // The money moved and the invoice says so, whatever the routine decided
    // about the subscription row.
    const plan = billingEventNotifications(event(), 'duplicate');
    expect(kinds(plan.account)).toEqual(['payment_succeeded']);
  });

  it('does not announce an activation that was held by the revocation rule', () => {
    const plan = billingEventNotifications(
      event({ kind: 'subscription_changed', eventType: 'customer.subscription.updated', invoice: null }),
      'revoked_hold',
    );
    expect(plan.account).toEqual([]);
  });

  it('does not claim a payment for an invoice that is not paid', () => {
    const plan = billingEventNotifications(
      event({ invoice: { ...event().invoice!, status: 'open', amountPaidMinor: 0 } }),
      'applied',
    );
    expect(kinds(plan.account)).not.toContain('payment_succeeded');
  });

  it('tells a card holder about a failed renewal', () => {
    const plan = billingEventNotifications(
      event({
        kind: 'payment_failed',
        eventType: 'invoice.payment_failed',
        paymentStatus: 'failed',
        invoice: null,
        state: { ...event().state!, status: 'past_due' },
      }),
      'applied',
    );
    expect(kinds(plan.account)).toContain('card_payment_failed');
  });

  it('never tells a PromptPay reader their card was declined', () => {
    // There is no stored credential on that rail, and the reader is already
    // being reminded to scan.
    const plan = billingEventNotifications(
      event({
        kind: 'payment_failed',
        eventType: 'invoice.payment_failed',
        collectionMethod: 'send_invoice',
        paymentStatus: 'failed',
        invoice: null,
        state: { ...event().state!, status: 'past_due' },
      }),
      'applied',
    );
    expect(kinds(plan.account)).not.toContain('card_payment_failed');
  });

  it('announces a scheduled cancellation with the period it runs to', () => {
    const plan = billingEventNotifications(
      event({
        kind: 'subscription_changed',
        eventType: 'customer.subscription.updated',
        invoice: null,
        state: { ...event().state!, cancelAtPeriodEnd: true },
      }),
      'applied',
    );
    const notice = plan.account.find((item) => item.kind === 'subscription_canceled');
    expect(notice?.message).toContain('ใช้งานได้ถึง');
  });

  it('announces a cancellation that has already taken effect', () => {
    const plan = billingEventNotifications(
      event({
        kind: 'subscription_canceled',
        eventType: 'customer.subscription.deleted',
        invoice: null,
        state: {
          ...event().state!,
          status: 'canceled',
          currentPeriodEnd: null,
        },
      }),
      'applied',
    );
    expect(kinds(plan.account)).toContain('subscription_canceled');
  });
});

describe('refund and dispute notices', () => {
  const refundEvent = event({
    kind: 'ignored',
    eventType: 'charge.refunded',
    invoice: null,
    state: null,
    refund: {
      kind: 'refund',
      chargeId: 'ch_1',
      invoiceId: 'in_1',
      subscriptionId: 'sub_1',
      amountMinor: 799_000,
      chargeAmountMinor: 799_000,
      currency: 'thb',
      disputeOutcome: null,
      occurredAt: NOW,
    },
  });

  it('tells the reader about a full refund and says access ended', () => {
    const plan = refundEventNotifications(refundEvent);
    const notice = plan.account.find((item) => item.kind === 'refund_recorded');
    expect(notice?.message).toContain('สิทธิ์');
    expect(notice?.message).toContain('7,990');
    expect(plan.admin).toEqual([]);
  });

  it('tells the reader a partial refund leaves the plan alone', () => {
    const plan = refundEventNotifications(event({
      ...refundEvent,
      refund: { ...refundEvent.refund!, amountMinor: 20_000 },
    }));
    const notice = plan.account.find((item) => item.kind === 'refund_recorded');
    expect(notice?.message).toContain('ใช้งานได้ตามปกติ');
  });

  it('tells both the reader and the operators about a dispute', () => {
    const plan = refundEventNotifications(event({
      ...refundEvent,
      eventType: 'charge.dispute.created',
      refund: { ...refundEvent.refund!, kind: 'dispute_opened' },
    }));
    expect(kinds(plan.account)).toContain('dispute_opened');
    expect(kinds(plan.admin)).toContain('admin_dispute_opened');
  });

  it('alerts operators when a dispute is lost', () => {
    const plan = refundEventNotifications(event({
      ...refundEvent,
      eventType: 'charge.dispute.closed',
      refund: { ...refundEvent.refund!, kind: 'dispute_closed', disputeOutcome: 'lost' },
    }));
    expect(kinds(plan.admin)).toContain('admin_dispute_opened');
  });

  it('stays quiet when a dispute is won', () => {
    const plan = refundEventNotifications(event({
      ...refundEvent,
      eventType: 'charge.dispute.closed',
      refund: { ...refundEvent.refund!, kind: 'dispute_closed', disputeOutcome: 'won' },
    }));
    expect(plan.admin).toEqual([]);
    expect(plan.account).toEqual([]);
  });

  it('produces nothing for an event carrying no refund', () => {
    expect(refundEventNotifications(event())).toEqual({ account: [], admin: [] });
  });
});

describe('plan names', () => {
  it('reads the catalogue rather than restating a name', () => {
    expect(planNameFor('elite_annual')).toBe('Elite รายปี');
  });

  it('falls back to the product name for an unknown or absent plan', () => {
    expect(planNameFor(null)).toBe('PortKheaw');
    expect(planNameFor('not_a_plan')).toBe('PortKheaw');
  });
});
