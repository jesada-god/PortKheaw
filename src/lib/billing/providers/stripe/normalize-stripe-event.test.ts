import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
  classifyStripeEvent,
  normalizeStripeEvent,
  normalizeStripeSubscription,
  subscriptionIdFromEvent,
  tierFromSubscription,
} from './normalize-stripe-event';
import { BILLING_METADATA_PLAN_KEY, BILLING_METADATA_USER_ID } from '../../billing-events';

/**
 * Stripe object shapes, built by hand from the pinned API version's typings.
 *
 * Two details here are the ones that would break silently if this were written
 * from memory instead of from the installed types, and both are asserted below:
 * the billing period lives on the subscription *item*, and an invoice names its
 * subscription through `parent.subscription_details`.
 */

const USER_ID = '22222222-2222-4222-8222-222222222222';
const PERIOD_START = 1_785_000_000; // 2026-08-01T…Z
const PERIOD_END = 1_816_536_000;

function subscription(overrides: {
  status?: string;
  planKey?: string | null;
  cancelAtPeriodEnd?: boolean;
  interval?: string;
} = {}): Stripe.Subscription {
  const metadata: Record<string, string> = { [BILLING_METADATA_USER_ID]: USER_ID };
  if (overrides.planKey !== null) {
    metadata[BILLING_METADATA_PLAN_KEY] = overrides.planKey ?? 'pro_annual';
  }
  return {
    id: 'sub_123',
    customer: 'cus_123',
    status: overrides.status ?? 'active',
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    metadata,
    items: {
      data: [{
        id: 'si_123',
        current_period_start: PERIOD_START,
        current_period_end: PERIOD_END,
        price: { id: 'price_123', recurring: { interval: overrides.interval ?? 'year' } },
      }],
    },
  } as unknown as Stripe.Subscription;
}

function event(type: string, object: unknown, created = 1_785_000_500): Stripe.Event {
  return { id: 'evt_123', type, created, data: { object } } as unknown as Stripe.Event;
}

describe('stripe event classification', () => {
  it('recognises every lifecycle event this product acts on', () => {
    const expected: Record<string, string> = {
      'checkout.session.completed': 'checkout_completed',
      'checkout.session.async_payment_succeeded': 'checkout_completed',
      'customer.subscription.created': 'subscription_changed',
      'customer.subscription.updated': 'subscription_changed',
      'customer.subscription.deleted': 'subscription_canceled',
      'invoice.paid': 'payment_succeeded',
      'invoice.payment_succeeded': 'payment_succeeded',
      'invoice.payment_failed': 'payment_failed',
      'checkout.session.async_payment_failed': 'payment_failed',
    };
    for (const [type, kind] of Object.entries(expected)) {
      expect(classifyStripeEvent(type), type).toBe(kind);
    }
  });

  /*
   * Refunds and disputes are recognised as traffic but change no entitlement:
   * neither ends a subscription by itself in Stripe, and when one leads to a
   * cancellation that arrives as its own subscription event.
   */
  it('ignores everything it does not act on, rather than guessing', () => {
    for (const type of [
      'charge.refunded', 'charge.dispute.created', 'customer.created',
      'invoice.created', 'payment_intent.succeeded', 'made.up.event',
    ]) {
      expect(classifyStripeEvent(type), type).toBe('ignored');
    }
  });
});

describe('subscription normalization', () => {
  it('reads the period from the subscription item, not the subscription', () => {
    const normalized = normalizeStripeSubscription(subscription());
    expect(normalized).not.toBeNull();
    expect(normalized!.state.currentPeriodStart).toBe(new Date(PERIOD_START * 1000).toISOString());
    expect(normalized!.state.currentPeriodEnd).toBe(new Date(PERIOD_END * 1000).toISOString());
  });

  it('takes identity and plan from our own metadata', () => {
    const normalized = normalizeStripeSubscription(subscription())!;
    expect(normalized.userId).toBe(USER_ID);
    expect(normalized.planKey).toBe('pro_annual');
    expect(normalized.customerId).toBe('cus_123');
    expect(normalized.subscriptionId).toBe('sub_123');
    expect(normalized.priceId).toBe('price_123');
    expect(normalized.state.tier).toBe('pro');
    expect(normalized.state.interval).toBe('year');
  });

  /*
   * Fail closed. A subscription carrying no recognised plan key must not be
   * mapped onto a tier by guessing from an amount or a price identifier.
   */
  it('refuses a subscription with no recognised plan key', () => {
    expect(normalizeStripeSubscription(subscription({ planKey: null }))).toBeNull();
    expect(normalizeStripeSubscription(subscription({ planKey: 'pro_weekly' }))).toBeNull();
    expect(normalizeStripeSubscription(subscription({ planKey: '' }))).toBeNull();
    expect(tierFromSubscription(subscription({ planKey: null }))).toBeNull();
  });

  it('carries the cancel-at-period-end flag through unchanged', () => {
    expect(normalizeStripeSubscription(subscription())!.state.cancelAtPeriodEnd).toBe(false);
    expect(normalizeStripeSubscription(subscription({ cancelAtPeriodEnd: true }))!.state.cancelAtPeriodEnd).toBe(true);
  });

  it('falls back to the plan cadence when the price names one we do not sell', () => {
    const normalized = normalizeStripeSubscription(subscription({ interval: 'week' }))!;
    expect(normalized.state.interval).toBe('year');
  });
});

describe('locating the subscription an event concerns', () => {
  it('reads it from a checkout session', () => {
    expect(subscriptionIdFromEvent(event('checkout.session.completed', {
      subscription: 'sub_123',
      customer: 'cus_123',
      metadata: { [BILLING_METADATA_USER_ID]: USER_ID },
    }))).toBe('sub_123');
  });

  it('reads it from the subscription object itself', () => {
    expect(subscriptionIdFromEvent(event('customer.subscription.updated', subscription()))).toBe('sub_123');
  });

  /*
   * `invoice.subscription` no longer exists in this API version. Reading it
   * would yield undefined on every renewal, and every renewal would be ignored.
   */
  it('reads it from an invoice through parent.subscription_details', () => {
    const invoice = { id: 'in_123', parent: { subscription_details: { subscription: 'sub_123' } } };
    expect(subscriptionIdFromEvent(event('invoice.payment_failed', invoice))).toBe('sub_123');
    expect(subscriptionIdFromEvent(event('invoice.paid', invoice))).toBe('sub_123');
  });

  it('returns nothing for an event it does not act on', () => {
    expect(subscriptionIdFromEvent(event('charge.refunded', { id: 'ch_1' }))).toBeNull();
  });
});

describe('full event normalization', () => {
  it('produces an applied state from a subscription event', () => {
    const normalized = normalizeStripeEvent(
      event('customer.subscription.updated', subscription()),
      subscription(),
    );
    expect(normalized.provider).toBe('stripe');
    expect(normalized.eventId).toBe('evt_123');
    expect(normalized.kind).toBe('subscription_changed');
    expect(normalized.userId).toBe(USER_ID);
    expect(normalized.state?.status).toBe('active');
    expect(normalized.occurredAt).toBe(new Date(1_785_000_500 * 1000).toISOString());
  });

  /*
   * A failed renewal asserts past_due, because that is what it means to a reader
   * and what the grace policy is written against.
   */
  it('asserts past_due on a failed payment even while Stripe still reads active', () => {
    const invoice = { id: 'in_9', parent: { subscription_details: { subscription: 'sub_123' } } };
    const normalized = normalizeStripeEvent(
      event('invoice.payment_failed', invoice),
      subscription({ status: 'active' }),
    );
    expect(normalized.state?.status).toBe('past_due');
    expect(normalized.paymentStatus).toBe('failed');
    expect(normalized.invoiceId).toBe('in_9');
  });

  /*
   * …but it must never resurrect a subscription that has already ended.
   */
  it('lets a terminal status win over a late payment failure', () => {
    const invoice = { id: 'in_9', parent: { subscription_details: { subscription: 'sub_123' } } };
    for (const status of ['canceled', 'unpaid', 'incomplete_expired'] as const) {
      const normalized = normalizeStripeEvent(
        event('invoice.payment_failed', invoice),
        subscription({ status }),
      );
      expect(normalized.state?.status, status).not.toBe('past_due');
    }
  });

  it('records a successful payment without inventing a state of its own', () => {
    const invoice = { id: 'in_8', parent: { subscription_details: { subscription: 'sub_123' } } };
    const normalized = normalizeStripeEvent(event('invoice.paid', invoice), subscription());
    expect(normalized.paymentStatus).toBe('succeeded');
    expect(normalized.state?.status).toBe('active');
  });

  it('carries a cancellation through as the provider reported it', () => {
    const canceled = subscription({ status: 'canceled' });
    const normalized = normalizeStripeEvent(event('customer.subscription.deleted', canceled), canceled);
    expect(normalized.kind).toBe('subscription_canceled');
    expect(normalized.state?.status).toBe('canceled');
  });

  /*
   * An ignored event still gets an envelope so it can be recorded, but it must
   * never carry a state — otherwise a refund would rewrite somebody's plan.
   */
  it('never attaches a state to an ignored event', () => {
    const normalized = normalizeStripeEvent(event('charge.refunded', { id: 'ch_1' }), subscription());
    expect(normalized.kind).toBe('ignored');
    expect(normalized.state).toBeNull();
  });

  it('survives an unreadable subscription without asserting anything', () => {
    const normalized = normalizeStripeEvent(event('customer.subscription.updated', subscription()), null);
    expect(normalized.state).toBeNull();
    expect(normalized.eventId).toBe('evt_123');
    // Still recorded against the right subscription for the audit row.
    expect(normalized.subscriptionId).toBe('sub_123');
  });
});
