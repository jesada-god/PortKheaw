import { subscriptionTiers, type SubscriptionTier } from './subscription-types';

export interface SubscriptionCapabilities {
  'portfolio.stock.create': boolean;
  'portfolio.multiple.create': boolean;
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
  /**
   * The paid colour themes in Settings. A presentation preference rather than a
   * data feature, but it is gated on the same ladder as everything else so a
   * trial, an expiry and an administrator preview all move it together.
   */
  'theme.premium': boolean;
}

export type SubscriptionCapability = keyof SubscriptionCapabilities;

/** The keys a tier either has or does not have. */
export type BooleanCapability = {
  [K in SubscriptionCapability]: SubscriptionCapabilities[K] extends boolean ? K : never;
}[SubscriptionCapability];

/** The keys that carry an allowance rather than a yes/no. */
export type CountCapability = Exclude<SubscriptionCapability, BooleanCapability>;

/**
 * Every capability at its locked value: the floor a plan is built up from, and
 * the value an unrecognised state can only ever fall back to.
 */
const LOCKED: Readonly<SubscriptionCapabilities> = {
  'portfolio.stock.create': false,
  'portfolio.multiple.create': false,
  'portfolio.stock.max_count': 0,
  'portfolio.options.create': false,
  'portfolio.options.max_count': 0,
  'chart.sr.levels': false,
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
  'theme.premium': false,
};

/**
 * What one plan adds to the plan below it. Only ever an addition: `unlocks`
 * turns keys on and `raises` lifts an allowance, and neither can express taking
 * something away.
 */
interface TierGrant {
  unlocks: readonly BooleanCapability[];
  raises?: Partial<Readonly<Record<CountCapability, number>>>;
}

/**
 * The product ladder, written once as a table of *additions* in tier order.
 *
 * Phase 3.2 replaced three independently written per-tier records with this.
 * They agreed at the time, but nothing made them agree: a row could be flipped
 * off in Pro while staying on in Basic, and the plan comparison, the paywall and
 * the API guard would all faithfully reproduce a plan that loses a feature by
 * paying for it. Folding the table below makes "Pro is Basic plus…" and "Elite
 * is Pro plus…" structural rather than something a test has to keep watch over —
 * and the test still watches, because the fold is only as good as its own proof.
 */
const TIER_GRANTS: Readonly<Record<SubscriptionTier, TierGrant>> = {
  basic: {
    unlocks: ['portfolio.stock.create', 'chart.sr.levels'],
    raises: { 'portfolio.stock.max_count': 1 },
  },
  pro: {
    unlocks: [
      'portfolio.options.create',
      'portfolio.multiple.create',
      'chart.sr.context',
      'chart.vpvr',
      'simulator.what_if',
      'options.chain.basic',
      'options.signal.summary',
      'theme.premium',
    ],
    raises: { 'portfolio.stock.max_count': 10, 'portfolio.options.max_count': 10 },
  },
  elite: {
    unlocks: [
      'simulator.monte_carlo',
      'options.analytics.walls',
      'options.chain.advanced',
      'options.greeks.full',
      'options.expected_move',
      'options.signal.breakdown',
      'technical.outlook',
    ],
  },
};

/**
 * Fold the additions in `subscriptionTiers` order, each tier starting from the
 * previous tier's complete set. An allowance that a table entry tried to lower
 * is a catalog mistake rather than a runtime state, so it throws at import
 * instead of quietly shipping a plan that shrinks.
 */
function buildCapabilityMatrix(): Record<SubscriptionTier, Readonly<SubscriptionCapabilities>> {
  const matrix = {} as Record<SubscriptionTier, Readonly<SubscriptionCapabilities>>;
  let inherited: SubscriptionCapabilities = { ...LOCKED };

  for (const tier of subscriptionTiers) {
    const grant = TIER_GRANTS[tier];
    const next: SubscriptionCapabilities = { ...inherited };
    for (const capability of grant.unlocks) next[capability] = true;
    for (const [capability, value] of Object.entries(grant.raises ?? {}) as [CountCapability, number][]) {
      if (value < next[capability]) {
        throw new Error(`Tier ${tier} lowers ${capability} from ${next[capability]} to ${value}`);
      }
      next[capability] = value;
    }
    inherited = next;
    matrix[tier] = Object.freeze(next);
  }

  return matrix;
}

export const subscriptionCapabilities: Readonly<Record<SubscriptionTier, Readonly<SubscriptionCapabilities>>> =
  Object.freeze(buildCapabilityMatrix());

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
