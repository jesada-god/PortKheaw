/**
 * Turning environment into a billing configuration — or into an honest refusal.
 *
 * Provider processing and checkout rollout are separate decisions. A configured
 * provider can keep signed webhooks and the customer portal working while new
 * checkout stays off. When checkout is internal or public, only plans with a
 * complete Price/Coupon mapping become available.
 *
 * `resolveBillingConfig` is pure and takes its environment as an argument, so
 * every branch below is testable without credentials and without `process.env`.
 *
 * Nothing here is exported to the browser. What the UI receives is
 * `BillingAvailability`: which plan keys can be bought, and nothing else — not a
 * key, not a price identifier, not the name of a missing variable.
 */

import { billingPaymentMethods, type BillingPaymentMethod } from './billing-payment-method';
import { billingPlanKeys, billingPlans, type BillingPlanKey } from './billing-plans';
import {
  isTrustedBillingProviderMode,
  type TrustedBillingProviderMode,
} from './billing-provider-mode';

export const billingCheckoutModes = ['off', 'internal', 'public'] as const;
export type BillingCheckoutMode = typeof billingCheckoutModes[number];

export interface BillingConfig {
  provider: 'stripe';
  providerMode: TrustedBillingProviderMode;
  checkoutMode: BillingCheckoutMode;
  internalUserIds: readonly string[];
  secretKey: string;
  webhookSecret: string;
  /** Provider price identifier per purchasable plan key. */
  prices: Readonly<Partial<Record<BillingPlanKey, string>>>;
  /** Provider coupon identifier, present only for Founder plan keys. */
  coupons: Readonly<Partial<Record<BillingPlanKey, string>>>;
  /** The one origin checkout may return to. Never taken from a request. */
  returnOrigin: string;
  /**
   * The rails this deployment will open a purchase on.
   *
   * `card` is always present — it is the provider's hosted checkout and needs no
   * capability beyond the credentials already required above. `promptpay`
   * additionally requires the provider account to have the Thai rail activated,
   * which is an account setting rather than an environment variable, so the flag
   * below exists to switch it off without a redeploy of the catalogue if that
   * activation is ever withdrawn.
   */
  paymentMethods: readonly BillingPaymentMethod[];
}

/**
 * What a server component may hand to the browser. Deliberately just booleans
 * and plan keys: a reader learns that a plan cannot be bought, never why.
 */
export interface BillingAvailability {
  enabled: boolean;
  availablePlanKeys: readonly BillingPlanKey[];
  /** Which payment rails this reader may start a purchase on. */
  paymentMethods: readonly BillingPaymentMethod[];
}

export type BillingConfigResult =
  | { enabled: true; config: BillingConfig; availablePlanKeys: readonly BillingPlanKey[] }
  | { enabled: false; reason: BillingDisabledReason; missing: readonly string[] };

export type BillingDisabledReason =
  /** `BILLING_ENABLED` is not `true`. The deliberate off switch. */
  | 'switched-off'
  /** The switch is on but provider credentials, mode or return origin are missing. */
  | 'incomplete-config';

export interface BillingEnvironment {
  BILLING_ENABLED?: string;
  BILLING_PROVIDER_MODE?: string;
  BILLING_CHECKOUT_MODE?: string;
  BILLING_PROMPTPAY_ENABLED?: string;
  BILLING_INTERNAL_USER_IDS?: string;
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

function checkoutMode(value: string | undefined): BillingCheckoutMode {
  const normalized = trimmed(value)?.toLowerCase() ?? 'off';
  return (billingCheckoutModes as readonly string[]).includes(normalized)
    ? normalized as BillingCheckoutMode
    : 'off';
}

/**
 * The rails a purchase may open on.
 *
 * PromptPay is on unless it is explicitly switched off. That direction is
 * deliberate and is the opposite of how a credential would be treated: this flag
 * cannot cause an incorrect charge or expose anything — the worst case of it
 * being wrong is a refusal at the provider that the reader sees as "could not
 * start payment", which is the same outcome as the plan not being configured.
 * Making it opt-in instead would mean a deployment that has every price, every
 * coupon and an activated rail still silently offering only cards.
 */
function paymentMethods(value: string | undefined): readonly BillingPaymentMethod[] {
  const promptPayOff = trimmed(value)?.toLowerCase() === 'false';
  return promptPayOff
    ? billingPaymentMethods.filter((method) => method !== 'promptpay')
    : billingPaymentMethods;
}

function internalUserIds(value: string | undefined): readonly string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function secretMatchesMode(secretKey: string, mode: TrustedBillingProviderMode): boolean {
  return mode === 'live' ? secretKey.startsWith('sk_live_') : secretKey.startsWith('sk_test_');
}

export function resolveBillingConfig(env: BillingEnvironment): BillingConfigResult {
  if (trimmed(env.BILLING_ENABLED)?.toLowerCase() !== 'true') {
    return { enabled: false, reason: 'switched-off', missing: ['BILLING_ENABLED'] };
  }

  const missing: string[] = [];
  const providerMode = trimmed(env.BILLING_PROVIDER_MODE)?.toLowerCase();
  if (!isTrustedBillingProviderMode(providerMode)) missing.push('BILLING_PROVIDER_MODE');
  const resolvedCheckoutMode = checkoutMode(env.BILLING_CHECKOUT_MODE);
  const secretKey = trimmed(env.STRIPE_SECRET_KEY);
  if (!secretKey) missing.push('STRIPE_SECRET_KEY');
  if (secretKey && isTrustedBillingProviderMode(providerMode) && !secretMatchesMode(secretKey, providerMode)) {
    missing.push('STRIPE_SECRET_KEY_MODE_MISMATCH');
  }
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

  /*
   * A configured provider with checkout off is a valid operating state: signed
   * webhooks and the portal must keep working even when no new purchase can be
   * opened. Price identifiers therefore control only plan availability, never
   * whether billing processing itself is enabled.
   */
  if (
    missing.length > 0
    || !secretKey
    || !webhookSecret
    || !returnOrigin
    || !isTrustedBillingProviderMode(providerMode)
  ) {
    return { enabled: false, reason: 'incomplete-config', missing };
  }

  return {
    enabled: true,
    availablePlanKeys,
    config: {
      provider: 'stripe',
      providerMode,
      checkoutMode: resolvedCheckoutMode,
      internalUserIds: internalUserIds(env.BILLING_INTERNAL_USER_IDS),
      secretKey,
      webhookSecret,
      prices,
      coupons,
      returnOrigin,
      paymentMethods: paymentMethods(env.BILLING_PROMPTPAY_ENABLED),
    },
  };
}

export interface BillingCheckoutViewer {
  userId: string | null;
  role: 'user' | 'admin';
}

/** The one rollout decision shared by server-rendered UI and server actions. */
export function checkoutAllowed(config: BillingConfig, viewer: BillingCheckoutViewer): boolean {
  if (config.checkoutMode === 'off') return false;
  if (config.checkoutMode === 'public') return true;
  return viewer.role === 'admin'
    || Boolean(viewer.userId && config.internalUserIds.includes(viewer.userId));
}

/** The browser-safe, viewer-specific projection of a resolved configuration. */
export function billingAvailability(
  result: BillingConfigResult,
  viewer: BillingCheckoutViewer = { userId: null, role: 'user' },
): BillingAvailability {
  return result.enabled && checkoutAllowed(result.config, viewer)
    ? {
      enabled: true,
      availablePlanKeys: result.availablePlanKeys,
      paymentMethods: result.config.paymentMethods,
    }
    : { enabled: false, availablePlanKeys: [], paymentMethods: [] };
}

/**
 * Whether a Founder plan can be offered at all in this deployment. Used by the
 * plan cards to drop the Founder line entirely rather than show a price nobody
 * can be charged.
 */
export function founderPlansConfigured(availability: BillingAvailability): boolean {
  return availability.availablePlanKeys.some((key) => billingPlans[key].founder);
}
