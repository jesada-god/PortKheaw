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

  it.each(['basic', 'past_due', 'canceled', 'expired'] as const)('fails closed for %s status', (status) => {
    expect(resolveEffectiveTier(subscription(status, {
      tier: 'elite',
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
      'portfolio.stock.max_count': 1,
      'portfolio.options.create': false,
      'portfolio.options.max_count': 0,
      'chart.sr.levels': true,
      'chart.sr.context': false,
      'chart.vpvr': false,
      'simulator.what_if': false,
      'simulator.monte_carlo': false,
      'options.analytics.walls': false,
    });
    expect(subscriptionCapabilities.pro).toEqual({
      'portfolio.stock.create': true,
      'portfolio.stock.max_count': 10,
      'portfolio.options.create': true,
      'portfolio.options.max_count': 10,
      'chart.sr.levels': true,
      'chart.sr.context': true,
      'chart.vpvr': true,
      'simulator.what_if': true,
      'simulator.monte_carlo': false,
      'options.analytics.walls': false,
    });
    expect(subscriptionCapabilities.elite).toEqual({
      ...subscriptionCapabilities.pro,
      'simulator.monte_carlo': true,
      'options.analytics.walls': true,
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
