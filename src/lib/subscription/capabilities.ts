import { subscriptionTiers, type SubscriptionTier } from './subscription-types';

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
  /** The readable contract ledger: strike, expiry, bid/ask, volume, open interest. */
  'options.chain.basic': boolean;
  /** Everything the ledger adds on top of the basic columns. */
  'options.chain.advanced': boolean;
  /** Delta/gamma/theta/vega/rho and the implied volatility they are solved with. */
  'options.greeks.full': boolean;
  'options.expected_move': boolean;
  /** The Options Signal gauge: signal type, confidence and the one-line summary. */
  'options.signal.summary': boolean;
  /** Per-factor scores, reasons, R:R, IV/earnings diagnostics and the trade setup. */
  'options.signal.breakdown': boolean;
  /** Technical Outlook · Market Signal on the Financials tab. */
  'technical.outlook': boolean;
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
    'options.chain.basic': false,
    'options.chain.advanced': false,
    'options.greeks.full': false,
    'options.expected_move': false,
    'options.signal.summary': false,
    'options.signal.breakdown': false,
    'technical.outlook': false,
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
    'options.chain.basic': true,
    'options.chain.advanced': false,
    'options.greeks.full': false,
    'options.expected_move': false,
    'options.signal.summary': true,
    'options.signal.breakdown': false,
    'technical.outlook': false,
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
    'options.chain.basic': true,
    'options.chain.advanced': true,
    'options.greeks.full': true,
    'options.expected_move': true,
    'options.signal.summary': true,
    'options.signal.breakdown': true,
    'technical.outlook': true,
  },
};

export function capabilityValue<K extends SubscriptionCapability>(
  tier: SubscriptionTier,
  capability: K,
): SubscriptionCapabilities[K] {
  return subscriptionCapabilities[tier][capability];
}

/** True only for the boolean rows — the two `max_count` limits are not gates. */
export function hasCapability(tier: SubscriptionTier, capability: SubscriptionCapability): boolean {
  return capabilityValue(tier, capability) === true;
}

/**
 * The cheapest tier that carries a capability, derived from the matrix rather
 * than written down a second time. Every upgrade prompt names the plan this
 * returns, so a matrix change moves the copy with it.
 *
 * `null` means no tier has it, which for a boolean capability would be a
 * catalog mistake rather than a runtime state.
 */
export function requiredTierFor(capability: SubscriptionCapability): SubscriptionTier | null {
  return subscriptionTiers.find((tier) => hasCapability(tier, capability)) ?? null;
}
