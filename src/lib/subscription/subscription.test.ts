import { describe, expect, it } from 'vitest';
import { capabilityValue, subscriptionCapabilities } from './capabilities';
import { EntitlementError, requireEntitlement } from './require-entitlement';
import { resolveEffectiveTier } from './resolve-effective-tier';
import { portfolioCreationEntitlement } from './subscription-limits';
import type { SubscriptionRecord, SubscriptionStatus, SubscriptionTier } from './subscription-types';

const NOW = '2026-08-02T12:00:00.000Z';

function subscription(
  status: SubscriptionStatus,
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    tier: 'basic',
    status,
    trialStartedAt: null,
    trialEndsAt: null,
    trialUsedAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingCustomerId: null,
    billingSubscriptionId: null,
    billingPriceId: null,
    founderPromoApplied: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('resolveEffectiveTier', () => {
  it('grants Elite only while a trial is strictly in the future', () => {
    expect(resolveEffectiveTier(subscription('trialing', { trialEndsAt: '2026-08-02T12:00:00.001Z' }), NOW)).toBe('elite');
    expect(resolveEffectiveTier(subscription('trialing', { trialEndsAt: NOW }), NOW)).toBe('basic');
    expect(resolveEffectiveTier(subscription('trialing', { trialEndsAt: '2026-08-02T11:59:59.999Z' }), NOW)).toBe('basic');
    expect(resolveEffectiveTier(subscription('trialing'), NOW)).toBe('basic');
  });

  it.each(['basic', 'pro', 'elite'] as const)('uses the stored %s tier only for an unexpired active period', (tier) => {
    expect(resolveEffectiveTier(subscription('active', {
      tier,
      currentPeriodEnd: '2026-08-02T12:00:00.001Z',
    }), NOW)).toBe(tier);
    expect(resolveEffectiveTier(subscription('active', { tier, currentPeriodEnd: NOW }), NOW)).toBe('basic');
    expect(resolveEffectiveTier(subscription('active', { tier }), NOW)).toBe('basic');
  });

  it.each(['basic', 'canceled', 'expired'] as const)('fails closed for %s status', (status) => {
    expect(resolveEffectiveTier(subscription(status, {
      tier: 'elite',
      trialEndsAt: '2099-01-01T00:00:00.000Z',
      currentPeriodEnd: '2099-01-01T00:00:00.000Z',
    }), NOW)).toBe('basic');
  });

  /*
   * Phase 4 dunning grace. A failed renewal does not cut access off mid-period:
   * the provider retries, and the reader keeps the period they have already paid
   * for. The bound is the provider's own timestamp, which is what stops a
   * stalled dunning cycle from becoming unlimited free access — so the second
   * half of this test is the half that matters.
   */
  it.each(['pro', 'elite'] as const)('grants %s during past_due only until the paid period ends', (tier) => {
    expect(resolveEffectiveTier(subscription('past_due', {
      tier,
      currentPeriodEnd: '2026-08-02T12:00:00.001Z',
    }), NOW)).toBe(tier);

    // The instant the period ends, and every instant after it.
    expect(resolveEffectiveTier(subscription('past_due', { tier, currentPeriodEnd: NOW }), NOW)).toBe('basic');
    expect(resolveEffectiveTier(subscription('past_due', {
      tier,
      currentPeriodEnd: '2026-08-02T11:59:59.999Z',
    }), NOW)).toBe('basic');
    // A past_due row with no period at all grants nothing.
    expect(resolveEffectiveTier(subscription('past_due', { tier }), NOW)).toBe('basic');
  });

  /*
   * Grace never promotes. `past_due` opens the tier that was purchased, so a
   * Basic row cannot become paid by failing to pay.
   */
  it('never lets past_due grace grant more than the stored tier', () => {
    expect(resolveEffectiveTier(subscription('past_due', {
      tier: 'basic',
      trialEndsAt: '2099-01-01T00:00:00.000Z',
      currentPeriodEnd: '2099-01-01T00:00:00.000Z',
    }), NOW)).toBe('basic');
  });

  it('fails closed for missing rows or invalid clock inputs', () => {
    expect(resolveEffectiveTier(null, NOW)).toBe('basic');
    expect(resolveEffectiveTier(subscription('active', {
      tier: 'elite',
      currentPeriodEnd: '2099-01-01T00:00:00.000Z',
    }), 'not-a-date')).toBe('basic');
  });
});

describe('subscription capability matrix', () => {
  it('matches the Basic, Pro and Elite product contract', () => {
    expect(subscriptionCapabilities.basic).toEqual({
      'portfolio.stock.create': true,
      'portfolio.multiple.create': false,
      'portfolio.stock.max_count': 1,
      'portfolio.options.create': false,
      'portfolio.options.max_count': 0,
      'chart.sr.levels': true,
      'chart.sr.context': false,
      'chart.vpvr': false,
      'simulator.what_if': false,
      'simulator.monte_carlo': false,
      'planner.stock': false,
      'options.analytics.walls': false,
      'options.chain.basic': false,
      'options.chain.advanced': false,
      'options.greeks.full': false,
      'options.expected_move': false,
      'options.signal.summary': false,
      'options.signal.breakdown': false,
      'technical.outlook': false,
      'technical.outlook.commodity': false,
      'theme.premium': false,
    });
    expect(subscriptionCapabilities.pro).toEqual({
      'portfolio.stock.create': true,
      'portfolio.multiple.create': true,
      'portfolio.stock.max_count': 10,
      'portfolio.options.create': true,
      'portfolio.options.max_count': 10,
      'chart.sr.levels': true,
      'chart.sr.context': true,
      'chart.vpvr': true,
      'simulator.what_if': true,
      'simulator.monte_carlo': false,
      'planner.stock': true,
      'options.analytics.walls': false,
      'options.chain.basic': true,
      'options.chain.advanced': false,
      'options.greeks.full': false,
      'options.expected_move': false,
      'options.signal.summary': true,
      'options.signal.breakdown': false,
      'technical.outlook': false,
      // Sold on the Pro step: on a commodity page the signal is the whole
      // Financials tab, not the top of a stack of paid equity analysis.
      'technical.outlook.commodity': true,
      'theme.premium': true,
    });
    expect(subscriptionCapabilities.elite).toEqual({
      ...subscriptionCapabilities.pro,
      'simulator.monte_carlo': true,
      'options.analytics.walls': true,
      'options.chain.advanced': true,
      'options.greeks.full': true,
      'options.expected_move': true,
      'options.signal.breakdown': true,
      'technical.outlook': true,
    });
  });

  it.each([
    ['basic', 1, false, 0],
    ['pro', 10, true, 10],
    ['elite', 10, true, 10],
  ] as const)('maps %s portfolio creation limits', (tier, stockMax, optionsCreate, optionsMax) => {
    expect(portfolioCreationEntitlement(tier, 'STOCK')).toEqual({ canCreate: true, maxCount: stockMax });
    expect(portfolioCreationEntitlement(tier, 'OPTION')).toEqual({ canCreate: optionsCreate, maxCount: optionsMax });
  });

  it('returns typed upgrade failures for disabled boolean capabilities', () => {
    expect(() => requireEntitlement('basic', 'portfolio.options.create')).toThrowError(EntitlementError);
    try {
      requireEntitlement('basic', 'portfolio.options.create');
    } catch (error) {
      expect(error).toMatchObject({ code: 'UPGRADE_REQUIRED' });
    }
    expect(() => requireEntitlement('elite', 'options.analytics.walls')).not.toThrow();
    expect(() => requireEntitlement('elite', 'portfolio.stock.max_count')).toThrowError(TypeError);
  });

  it.each(['basic', 'pro', 'elite'] as SubscriptionTier[])('keeps S/R levels available for %s', (tier) => {
    expect(capabilityValue(tier, 'chart.sr.levels')).toBe(true);
  });
});
