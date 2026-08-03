/**
 * Turning environment into a billing configuration — or into an honest refusal.
 *
 * Two states exist and there is no third: billing is **configured**, in which
 * case every value a checkout needs is present and validated here once, or it is
 * **not**, in which case nothing anywhere in the product offers a purchase. The
 * failure mode this shape exists to prevent is a half-configured deployment that
 * renders a Subscribe button, sends someone to a provider, takes their money and
 * then has no webhook secret with which to believe the payment happened.
 *
 * `resolveBillingConfig` is pure and takes its environment as an argument, so
 * every branch below is testable without credentials and without `process.env`.
 *
 * Nothing here is exported to the browser. What the UI receives is
 * `BillingAvailability`: which plan keys can be bought, and nothing else — not a
 * key, not a price identifier, not the name of a missing variable.
 */

import { billingPlanKeys, billingPlans, type BillingPlanKey } from './billing-plans';

export interface BillingConfig {
  provider: 'stripe';
  secretKey: string;
  webhookSecret: string;
  /** Provider price identifier per purchasable plan key. */
  prices: Readonly<Partial<Record<BillingPlanKey, string>>>;
  /** Provider coupon identifier, present only for Founder plan keys. */
  coupons: Readonly<Partial<Record<BillingPlanKey, string>>>;
  /** The one origin checkout may return to. Never taken from a request. */
  returnOrigin: string;
}

/**
 * What a server component may hand to the browser. Deliberately just booleans
 * and plan keys: a reader learns that a plan cannot be bought, never why.
 */
export interface BillingAvailability {
  enabled: boolean;
  availablePlanKeys: readonly BillingPlanKey[];
}

export type BillingConfigResult =
  | { enabled: true; config: BillingConfig; availablePlanKeys: readonly BillingPlanKey[] }
  | { enabled: false; reason: BillingDisabledReason; missing: readonly string[] };

export type BillingDisabledReason =
  /** `BILLING_ENABLED` is not `true`. The deliberate off switch. */
  | 'switched-off'
  /** The switch is on but credentials or price identifiers are missing. */
  | 'incomplete-config';

export interface BillingEnvironment {
  BILLING_ENABLED?: string;
  BILLING_RETURN_ORIGIN?: string;
  APP_URL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO_MONTHLY?: string;
  STRIPE_PRICE_PRO_ANNUAL?: string;
  STRIPE_PRICE_ELITE_MONTHLY?: string;
  STRIPE_PRICE_ELITE_ANNUAL?: string;
  STRIPE_COUPON_FOUNDER_PRO?: string;
  STRIPE_COUPON_FOUNDER_ELITE?: string;
}

/**
 * Which environment variable carries the price for each plan key.
 *
 * Both Founder keys point at the ordinary annual price on purpose. A Founder
 * purchase is the normal annual subscription with a single-invoice coupon on
 * top, so there is no discounted price object that could ever be renewed into.
 */
const PRICE_ENV: Readonly<Record<BillingPlanKey, keyof BillingEnvironment>> = {
  pro_monthly: 'STRIPE_PRICE_PRO_MONTHLY',
  pro_annual: 'STRIPE_PRICE_PRO_ANNUAL',
  pro_annual_founder: 'STRIPE_PRICE_PRO_ANNUAL',
  elite_monthly: 'STRIPE_PRICE_ELITE_MONTHLY',
  elite_annual: 'STRIPE_PRICE_ELITE_ANNUAL',
  elite_annual_founder: 'STRIPE_PRICE_ELITE_ANNUAL',
};

/** Only Founder keys carry a coupon; the rest are billed at list price. */
const COUPON_ENV: Readonly<Partial<Record<BillingPlanKey, keyof BillingEnvironment>>> = {
  pro_annual_founder: 'STRIPE_COUPON_FOUNDER_PRO',
  elite_annual_founder: 'STRIPE_COUPON_FOUNDER_ELITE',
};

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Normalizes to a bare `https://host` origin, or rejects the value entirely. */
function normalizeOrigin(value: string | undefined): string | undefined {
  const text = trimmed(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    // A checkout return address is a destination for a real reader's browser.
    // Anything but HTTPS is refused rather than silently upgraded.
    if (url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function resolveBillingConfig(env: BillingEnvironment): BillingConfigResult {
  if (trimmed(env.BILLING_ENABLED)?.toLowerCase() !== 'true') {
    return { enabled: false, reason: 'switched-off', missing: ['BILLING_ENABLED'] };
  }

  const missing: string[] = [];
  const secretKey = trimmed(env.STRIPE_SECRET_KEY);
  if (!secretKey) missing.push('STRIPE_SECRET_KEY');
  const webhookSecret = trimmed(env.STRIPE_WEBHOOK_SECRET);
  if (!webhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');

  const returnOrigin = normalizeOrigin(env.BILLING_RETURN_ORIGIN) ?? normalizeOrigin(env.APP_URL);
  if (!returnOrigin) missing.push('BILLING_RETURN_ORIGIN');

  const prices: Partial<Record<BillingPlanKey, string>> = {};
  const coupons: Partial<Record<BillingPlanKey, string>> = {};
  const availablePlanKeys: BillingPlanKey[] = [];

  for (const key of billingPlanKeys) {
    const price = trimmed(env[PRICE_ENV[key]]);
    if (!price) continue;

    const couponEnvName = COUPON_ENV[key];
    if (couponEnvName) {
      const coupon = trimmed(env[couponEnvName]);
      /*
       * A Founder plan without its coupon is simply not offered. The alternative
       * — sending someone to checkout at the full annual price under a Founder
       * label — is the one failure here that would take the wrong amount of
       * money, so the plan disappears instead.
       */
      if (!coupon) continue;
      coupons[key] = coupon;
    }

    prices[key] = price;
    availablePlanKeys.push(key);
  }

  // The switch is on but no plan can actually be sold: that is a misconfiguration,
  // not a catalogue with zero rows.
  if (availablePlanKeys.length === 0) missing.push('STRIPE_PRICE_PRO_MONTHLY');

  if (missing.length > 0 || !secretKey || !webhookSecret || !returnOrigin) {
    return { enabled: false, reason: 'incomplete-config', missing };
  }

  return {
    enabled: true,
    availablePlanKeys,
    config: { provider: 'stripe', secretKey, webhookSecret, prices, coupons, returnOrigin },
  };
}

/** The browser-safe projection of a resolved configuration. */
export function billingAvailability(result: BillingConfigResult): BillingAvailability {
  return result.enabled
    ? { enabled: true, availablePlanKeys: result.availablePlanKeys }
    : { enabled: false, availablePlanKeys: [] };
}

/**
 * Whether a Founder plan can be offered at all in this deployment. Used by the
 * plan cards to drop the Founder line entirely rather than show a price nobody
 * can be charged.
 */
export function founderPlansConfigured(availability: BillingAvailability): boolean {
  return availability.availablePlanKeys.some((key) => billingPlans[key].founder);
}
