import type { SubscriptionTier } from './subscription-types';

export interface SubscriptionCapabilities {
  'portfolio.stock.create': boolean;
  'portfolio.stock.max_count': number;
  'portfolio.options.create': boolean;
  'portfolio.options.max_count': number;
  'chart.sr.levels': boolean;
  'chart.sr.context': boolean;
  'chart.vpvr': boolean;
  'simulator.what_if': boolean;
  'simulator.monte_carlo': boolean;
  'options.analytics.walls': boolean;
}

export type SubscriptionCapability = keyof SubscriptionCapabilities;

export const subscriptionCapabilities: Readonly<Record<SubscriptionTier, Readonly<SubscriptionCapabilities>>> = {
  basic: {
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
  },
  pro: {
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
  },
  elite: {
    'portfolio.stock.create': true,
    'portfolio.stock.max_count': 10,
    'portfolio.options.create': true,
    'portfolio.options.max_count': 10,
    'chart.sr.levels': true,
    'chart.sr.context': true,
    'chart.vpvr': true,
    'simulator.what_if': true,
    'simulator.monte_carlo': true,
    'options.analytics.walls': true,
  },
};

export function capabilityValue<K extends SubscriptionCapability>(
  tier: SubscriptionTier,
  capability: K,
): SubscriptionCapabilities[K] {
  return subscriptionCapabilities[tier][capability];
}
