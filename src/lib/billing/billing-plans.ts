/**
 * The paid plan catalogue: the one place a price, an interval or a promotion is
 * written down.
 *
 * Everything a checkout needs is derived from a **plan key**. The browser sends
 * that key and nothing else — no amount, no tier, no discount, no price
 * identifier — so a tampered request can only ever name a different plan from
 * this closed list, never invent a cheaper one. The server looks the key up
 * here, and the provider holds the authoritative amount behind the price
 * identifier, so even this file cannot overcharge or undercharge anyone: the
 * numbers below are what we *display*, and they are asserted against the
 * provider's own prices during setup.
 *
 * Pure: no I/O, no environment, no provider import. Provider identifiers are
 * resolved separately and joined onto these rows, which is what keeps the
 * catalogue testable without credentials and swappable if the provider changes.
 */

import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';

/**
 * The closed allowlist. Anything not on this list is refused before any
 * provider call is made — this is the checkout's entire input surface.
 */
export const billingPlanKeys = [
  'pro_monthly',
  'pro_annual',
  'pro_annual_founder',
  'elite_monthly',
  'elite_annual',
  'elite_annual_founder',
] as const;
export type BillingPlanKey = typeof billingPlanKeys[number];

export function isBillingPlanKey(value: unknown): value is BillingPlanKey {
  return typeof value === 'string' && (billingPlanKeys as readonly string[]).includes(value);
}

export type BillingInterval = 'month' | 'year';

/** Every price in this product is Thai baht. Stated once so nothing infers it. */
export const BILLING_CURRENCY = 'THB' as const;
export type BillingCurrency = typeof BILLING_CURRENCY;

/** The paid tiers. `basic` is the absence of a subscription, never a plan key. */
export type PaidTier = Exclude<SubscriptionTier, 'basic'>;

export interface BillingPlanDefinition {
  key: BillingPlanKey;
  tier: PaidTier;
  interval: BillingInterval;
  currency: BillingCurrency;
  /**
   * What the first invoice costs, in whole baht. Equal to `renewalBaht` on every
   * plan except a Founder one — that difference is the promotion.
   */
  firstPeriodBaht: number;
  /** What every invoice after the first costs, in whole baht. */
  renewalBaht: number;
  /**
   * True when the first period is discounted and later ones are not. A Founder
   * plan is annual-only by construction; the invariant is asserted in tests
   * rather than left to a reader to notice.
   */
  founder: boolean;
  /** The non-promotional plan a Founder purchase renews into. */
  renewsIntoKey: BillingPlanKey;
  /** Thai display name, e.g. `Pro รายปี`. */
  name: string;
  /** The billing cadence in Thai, for the price line under the name. */
  intervalLabel: string;
}

const INTERVAL_LABEL: Readonly<Record<BillingInterval, string>> = {
  month: 'ต่อเดือน',
  year: 'ต่อปี',
};

const TIER_NAME: Readonly<Record<PaidTier, string>> = { pro: 'Pro', elite: 'Elite' };

function plan(
  key: BillingPlanKey,
  tier: PaidTier,
  interval: BillingInterval,
  renewalBaht: number,
  options: { firstPeriodBaht?: number; renewsIntoKey?: BillingPlanKey; nameSuffix?: string } = {},
): BillingPlanDefinition {
  const founder = options.firstPeriodBaht !== undefined && options.firstPeriodBaht !== renewalBaht;
  return {
    key,
    tier,
    interval,
    currency: BILLING_CURRENCY,
    firstPeriodBaht: options.firstPeriodBaht ?? renewalBaht,
    renewalBaht,
    founder,
    renewsIntoKey: options.renewsIntoKey ?? key,
    name: `${TIER_NAME[tier]} ${interval === 'year' ? 'รายปี' : 'รายเดือน'}${options.nameSuffix ?? ''}`,
    intervalLabel: INTERVAL_LABEL[interval],
  };
}

/**
 * The catalogue.
 *
 * Founder rows are annual only and discount exactly one invoice: the first.
 * `renewsIntoKey` names the plan the subscription becomes afterwards, so the
 * renewal price shown before checkout is read from the row that will actually
 * be billed rather than typed in twice.
 */
export const billingPlans: Readonly<Record<BillingPlanKey, BillingPlanDefinition>> = {
  pro_monthly: plan('pro_monthly', 'pro', 'month', 349),
  pro_annual: plan('pro_annual', 'pro', 'year', 3_490),
  pro_annual_founder: plan('pro_annual_founder', 'pro', 'year', 3_490, {
    firstPeriodBaht: 1_990,
    renewsIntoKey: 'pro_annual',
    nameSuffix: " · Founder's Club",
  }),
  elite_monthly: plan('elite_monthly', 'elite', 'month', 799),
  elite_annual: plan('elite_annual', 'elite', 'year', 7_990),
  elite_annual_founder: plan('elite_annual_founder', 'elite', 'year', 7_990, {
    firstPeriodBaht: 4_490,
    renewsIntoKey: 'elite_annual',
    nameSuffix: " · Founder's Club",
  }),
};

export function billingPlan(key: BillingPlanKey): BillingPlanDefinition {
  return billingPlans[key];
}

/** Every plan for one tier, cheapest cadence first. Drives the plan cards. */
export function billingPlansForTier(tier: PaidTier): readonly BillingPlanDefinition[] {
  return billingPlanKeys.map((key) => billingPlans[key]).filter((item) => item.tier === tier);
}

/**
 * Thai baht with thousands separators, formatted without `Intl` so the server
 * and the browser cannot disagree about grouping and produce a hydration
 * mismatch on a price. Mirrors the free catalogue's formatter deliberately.
 */
export function formatBillingBaht(amount: number): string {
  return Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
