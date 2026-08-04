import { describe, expect, it } from 'vitest';
import {
  eventChangesEntitlement,
  isFreshEvent,
  mapProviderSubscriptionStatus,
  type NormalizedBillingEvent,
} from './billing-events';
import { subscriptionStatuses } from '@/src/lib/subscription/subscription-types';
import { resolveEffectiveTier } from '@/src/lib/subscription/resolve-effective-tier';

/**
 * Translating a provider's status into ours is the single decision that says who
 * has paid for what. Each case below is asserted against the *consequence* —
 * what the entitlement resolver then grants — rather than only against the label,
 * because the label is not what a reader experiences.
 */

const NOW = '2026-08-04T00:00:00.000Z';
const FUTURE = '2027-01-01T00:00:00.000Z';

function tierFor(status: string): string {
  return resolveEffectiveTier(
    {
      tier: 'pro',
      status: mapProviderSubscriptionStatus(status),
      trialEndsAt: null,
      currentPeriodEnd: FUTURE,
    },
    NOW,
  );
}

describe('provider status mapping', () => {
  it('only ever produces a status the database constraint allows', () => {
    for (const status of [
      'active', 'trialing', 'past_due', 'canceled', 'unpaid',
      'paused', 'incomplete', 'incomplete_expired', 'something_new', '',
    ]) {
      expect(subscriptionStatuses, status).toContain(mapProviderSubscriptionStatus(status));
    }
  });

  it('grants the purchased tier for a paid, running subscription', () => {
    expect(mapProviderSubscriptionStatus('active')).toBe('active');
    expect(tierFor('active')).toBe('pro');
  });

  /*
   * A provider-side trial is a paid plan whose first invoice is deferred, so it
   * grants the plan bought. It must NOT land in our `trialing`, which is the
   * seven-day Elite grant and resolves to Elite whatever the plan says — that
   * mapping would hand Elite to somebody trialing Pro.
   */
  it('maps a provider trial to active, never to our Elite trial status', () => {
    expect(mapProviderSubscriptionStatus('trialing')).toBe('active');
    expect(mapProviderSubscriptionStatus('trialing')).not.toBe('trialing');
    expect(tierFor('trialing')).toBe('pro');
  });

  /*
   * Dunning grace: access continues to the end of the period already paid for.
   */
  it('keeps the tier during past_due', () => {
    expect(mapProviderSubscriptionStatus('past_due')).toBe('past_due');
    expect(tierFor('past_due')).toBe('pro');
  });

  it('ends access for every terminal provider status', () => {
    for (const status of ['canceled', 'unpaid', 'paused', 'incomplete_expired']) {
      expect(tierFor(status), status).toBe('basic');
    }
    expect(mapProviderSubscriptionStatus('canceled')).toBe('canceled');
    // Exhausted retries are not the same as a cancellation somebody asked for.
    expect(mapProviderSubscriptionStatus('unpaid')).toBe('expired');
    expect(mapProviderSubscriptionStatus('paused')).toBe('expired');
  });

  /*
   * A first payment that never completed bought nothing, so nothing is granted
   * and nothing is owed.
   */
  it('treats an incomplete first payment as no purchase at all', () => {
    expect(mapProviderSubscriptionStatus('incomplete')).toBe('basic');
    expect(tierFor('incomplete')).toBe('basic');
  });

  it('fails closed on a status it has never seen', () => {
    for (const status of ['', 'ACTIVE', 'weird_new_status', 'active ']) {
      expect(mapProviderSubscriptionStatus(status), status).toBe('expired');
      expect(tierFor(status), status).toBe('basic');
    }
  });
});

describe('event ordering', () => {
  /*
   * Providers do not guarantee delivery order, and a retry of an old event can
   * arrive after a newer one. Comparing the provider's own clocks is what stops
   * a late failure from pulling a recovered account back into past_due.
   */
  it('accepts a first event and anything at or after what was applied', () => {
    expect(isFreshEvent('2026-08-04T00:00:00.000Z', null)).toBe(true);
    expect(isFreshEvent('2026-08-04T00:00:01.000Z', '2026-08-04T00:00:00.000Z')).toBe(true);
    // Equal timestamps pass: two events can share a second, and the row lock
    // means the later arrival simply wins.
    expect(isFreshEvent('2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z')).toBe(true);
  });

  it('rejects an event older than the one already applied', () => {
    expect(isFreshEvent('2026-08-03T23:59:59.000Z', '2026-08-04T00:00:00.000Z')).toBe(false);
    expect(isFreshEvent('2020-01-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z')).toBe(false);
  });

  it('fails closed on an unparseable incoming clock', () => {
    expect(isFreshEvent('not-a-date', '2026-08-04T00:00:00.000Z')).toBe(false);
    // An unreadable *stored* clock cannot be trusted to reject a real event.
    expect(isFreshEvent('2026-08-04T00:00:00.000Z', 'not-a-date')).toBe(true);
  });
});

describe('entitlement consequence', () => {
  function event(overrides: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent {
    return {
      provider: 'stripe',
      providerMode: 'test',
      eventId: 'evt_1',
      eventType: 'customer.subscription.updated',
      kind: 'subscription_changed',
      occurredAt: NOW,
      userId: 'user-1',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      planKey: 'pro_annual',
      priceId: 'price_1',
      invoiceId: null,
      collectionMethod: 'charge_automatically',
      paymentStatus: null,
      state: {
        tier: 'pro',
        status: 'active',
        interval: 'year',
        currentPeriodStart: NOW,
        currentPeriodEnd: FUTURE,
        cancelAtPeriodEnd: false,
      },
      invoice: null,
      refund: null,
      ...overrides,
    };
  }

  it('acts only on a recognised event that asserts a state', () => {
    expect(eventChangesEntitlement(event())).toBe(true);
    expect(eventChangesEntitlement(event({ kind: 'ignored' }))).toBe(false);
    expect(eventChangesEntitlement(event({ state: null }))).toBe(false);
  });
});
