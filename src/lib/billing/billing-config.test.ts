import { describe, expect, it } from 'vitest';
import {
  billingAvailability,
  checkoutAllowed,
  founderPlansConfigured,
  resolveBillingConfig,
  type BillingEnvironment,
} from './billing-config';

/**
 * The failure this file exists to prevent is a half-configured deployment that
 * renders a Subscribe button, sends someone to a provider, takes their money and
 * then has no webhook secret with which to believe the payment happened.
 *
 * So every branch is asserted to fail *closed*: partial configuration disables
 * billing entirely rather than opening a checkout that cannot complete.
 */

const COMPLETE: BillingEnvironment = {
  BILLING_ENABLED: 'true',
  BILLING_PROVIDER_MODE: 'test',
  BILLING_CHECKOUT_MODE: 'public',
  BILLING_RETURN_ORIGIN: 'https://portkheaw.vercel.app',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_monthly',
  STRIPE_PRICE_PRO_ANNUAL: 'price_pro_annual',
  STRIPE_PRICE_ELITE_MONTHLY: 'price_elite_monthly',
  STRIPE_PRICE_ELITE_ANNUAL: 'price_elite_annual',
  STRIPE_COUPON_FOUNDER_PRO: 'coupon_founder_pro',
  STRIPE_COUPON_FOUNDER_ELITE: 'coupon_founder_elite',
};

describe('billing configuration', () => {
  /*
   * The state this product actually ships in today. An empty environment must
   * be an ordinary, expected outcome — not an error, and never an open checkout.
   */
  it('is disabled with an empty environment', () => {
    const result = resolveBillingConfig({});
    expect(result.enabled).toBe(false);
    if (result.enabled) return;
    expect(result.reason).toBe('switched-off');
    expect(billingAvailability(result)).toEqual({
      enabled: false,
      availablePlanKeys: [],
      paymentMethods: [],
    });
  });

  it('stays disabled while the switch is off, however complete the rest is', () => {
    for (const value of [undefined, '', 'false', 'FALSE', '0', 'yes', 'TRUE ']) {
      const result = resolveBillingConfig({ ...COMPLETE, BILLING_ENABLED: value });
      // 'TRUE ' is trimmed and lower-cased, so it is the one that must pass.
      expect(result.enabled, String(value)).toBe(value === 'TRUE ');
    }
  });

  it('enables billing and every plan when the environment is complete', () => {
    const result = resolveBillingConfig(COMPLETE);
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect([...result.availablePlanKeys].sort()).toEqual([
      'elite_annual', 'elite_annual_founder', 'elite_monthly',
      'pro_annual', 'pro_annual_founder', 'pro_monthly',
    ]);
    expect(result.config.returnOrigin).toBe('https://portkheaw.vercel.app');
    expect(founderPlansConfigured(billingAvailability(result))).toBe(true);
  });

  /*
   * Each credential removed in turn. Every one of them is load-bearing, and the
   * point of the loop is that no single omission can leave billing "mostly on".
   */
  it.each([
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ] as const)('fails closed when %s is missing', (key) => {
    const result = resolveBillingConfig({ ...COMPLETE, [key]: undefined });
    expect(result.enabled).toBe(false);
    if (result.enabled) return;
    expect(result.reason).toBe('incomplete-config');
    expect(result.missing).toContain(key);
  });

  it('keeps webhook and portal processing enabled when checkout has no prices', () => {
    const result = resolveBillingConfig({
      ...COMPLETE,
      STRIPE_PRICE_PRO_MONTHLY: undefined,
      STRIPE_PRICE_PRO_ANNUAL: undefined,
      STRIPE_PRICE_ELITE_MONTHLY: undefined,
      STRIPE_PRICE_ELITE_ANNUAL: undefined,
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.availablePlanKeys).toEqual([]);
  });

  it('requires an explicit provider mode and rejects a key from the other mode', () => {
    for (const environment of [
      { ...COMPLETE, BILLING_PROVIDER_MODE: undefined },
      { ...COMPLETE, BILLING_PROVIDER_MODE: 'live' },
      { ...COMPLETE, BILLING_PROVIDER_MODE: 'legacy_unknown' },
    ]) {
      const result = resolveBillingConfig(environment);
      expect(result.enabled).toBe(false);
    }
  });

  it('defaults checkout off and admits only trusted internal viewers in internal mode', () => {
    const off = resolveBillingConfig({ ...COMPLETE, BILLING_CHECKOUT_MODE: undefined });
    expect(off.enabled).toBe(true);
    if (!off.enabled) return;
    expect(off.config.checkoutMode).toBe('off');
    expect(checkoutAllowed(off.config, { userId: 'owner', role: 'admin' })).toBe(false);

    const invalid = resolveBillingConfig({ ...COMPLETE, BILLING_CHECKOUT_MODE: 'surprise' });
    expect(invalid.enabled).toBe(true);
    if (!invalid.enabled) return;
    expect(invalid.config.checkoutMode).toBe('off');

    const internal = resolveBillingConfig({
      ...COMPLETE,
      BILLING_CHECKOUT_MODE: 'internal',
      BILLING_INTERNAL_USER_IDS: 'allowlisted-user, second-user',
    });
    expect(internal.enabled).toBe(true);
    if (!internal.enabled) return;
    expect(checkoutAllowed(internal.config, { userId: 'admin', role: 'admin' })).toBe(true);
    expect(checkoutAllowed(internal.config, { userId: 'allowlisted-user', role: 'user' })).toBe(true);
    expect(checkoutAllowed(internal.config, { userId: 'ordinary-user', role: 'user' })).toBe(false);
    expect(billingAvailability(internal, { userId: 'ordinary-user', role: 'user' }).enabled).toBe(false);
  });

  /*
   * A partially priced catalogue is allowed to sell what it can price. This is
   * the one place partial configuration is not a failure — but the plans without
   * a price must be absent rather than sent to the provider and rejected there.
   */
  it('offers only the plans it holds a price for', () => {
    const result = resolveBillingConfig({
      ...COMPLETE,
      STRIPE_PRICE_ELITE_MONTHLY: undefined,
      STRIPE_PRICE_ELITE_ANNUAL: undefined,
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect([...result.availablePlanKeys].sort()).toEqual(['pro_annual', 'pro_annual_founder', 'pro_monthly']);
    expect(result.config.prices.elite_monthly).toBeUndefined();
  });

  /*
   * The most expensive mistake available here: offering a Founder plan without
   * its coupon would charge the full annual price under a discounted label. The
   * plan disappears instead.
   */
  it('withdraws a Founder plan whose coupon is missing, keeping the ordinary annual', () => {
    const result = resolveBillingConfig({ ...COMPLETE, STRIPE_COUPON_FOUNDER_PRO: undefined });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.availablePlanKeys).not.toContain('pro_annual_founder');
    expect(result.availablePlanKeys).toContain('pro_annual');
    expect(result.availablePlanKeys).toContain('elite_annual_founder');
    expect(result.config.coupons.pro_annual_founder).toBeUndefined();
  });

  it('drops every Founder plan when no coupon is configured', () => {
    const result = resolveBillingConfig({
      ...COMPLETE,
      STRIPE_COUPON_FOUNDER_PRO: undefined,
      STRIPE_COUPON_FOUNDER_ELITE: undefined,
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(founderPlansConfigured(billingAvailability(result))).toBe(false);
  });

  /*
   * A Founder purchase rides on the ordinary annual price plus a one-invoice
   * coupon. If it ever pointed at a separate, cheaper price object, the second
   * year would renew at the promotional rate.
   */
  it('points Founder plans at the ordinary annual price, never a discounted one', () => {
    const result = resolveBillingConfig(COMPLETE);
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.config.prices.pro_annual_founder).toBe(result.config.prices.pro_annual);
    expect(result.config.prices.elite_annual_founder).toBe(result.config.prices.elite_annual);
  });

  /*
   * The return address is where a reader's browser is sent after paying, so it
   * is taken from configuration and validated — never from a request.
   */
  it('refuses a return origin that is not https, and reduces one that is', () => {
    for (const origin of ['http://portkheaw.vercel.app', 'javascript:alert(1)', 'not-a-url', '']) {
      const result = resolveBillingConfig({
        ...COMPLETE,
        BILLING_RETURN_ORIGIN: origin,
        APP_URL: undefined,
      });
      expect(result.enabled, origin).toBe(false);
    }

    const withPath = resolveBillingConfig({
      ...COMPLETE,
      BILLING_RETURN_ORIGIN: 'https://portkheaw.vercel.app/settings/subscription?x=1',
    });
    expect(withPath.enabled).toBe(true);
    if (!withPath.enabled) return;
    expect(withPath.config.returnOrigin).toBe('https://portkheaw.vercel.app');
  });

  it('falls back to APP_URL when no billing-specific origin is set', () => {
    const result = resolveBillingConfig({
      ...COMPLETE,
      BILLING_RETURN_ORIGIN: undefined,
      APP_URL: 'https://portkheaw.vercel.app',
    });
    expect(result.enabled).toBe(true);
  });

  /*
   * What the browser is allowed to learn. A reader may know that a plan cannot
   * be bought; they may not learn a key, a price identifier, or which
   * environment variable is missing.
   */
  it('narrows to plan keys only before anything reaches the browser', () => {
    const result = resolveBillingConfig(COMPLETE);
    const availability = billingAvailability(result);
    expect(Object.keys(availability).sort()).toEqual([
      'availablePlanKeys', 'enabled', 'paymentMethods',
    ]);

    const serialized = JSON.stringify(availability);
    for (const secret of [
      'sk_test_placeholder', 'whsec_placeholder',
      'price_pro_monthly', 'price_elite_annual',
      'coupon_founder_pro', 'coupon_founder_elite',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  /*
   * The one billing variable that is on by default. It guards a provider
   * capability rather than a credential — the worst a wrong value can do is
   * refuse a purchase, never mischarge one — so an otherwise complete
   * deployment sells on both rails without a further variable to remember.
   */
  describe('the PromptPay rail', () => {
    it('is offered by default wherever checkout is open', () => {
      const availability = billingAvailability(resolveBillingConfig(COMPLETE));
      expect([...availability.paymentMethods]).toEqual(['card', 'promptpay']);
    });

    it('is withdrawn only by an explicit false, leaving cards untouched', () => {
      for (const value of ['false', 'FALSE', ' false ']) {
        const availability = billingAvailability(resolveBillingConfig({
          ...COMPLETE,
          BILLING_PROMPTPAY_ENABLED: value,
        }));
        expect([...availability.paymentMethods], value).toEqual(['card']);
        // Withdrawing a rail must not withdraw a plan.
        expect(availability.availablePlanKeys.length, value).toBeGreaterThan(0);
      }

      for (const value of [undefined, '', 'true', 'no', '0']) {
        const availability = billingAvailability(resolveBillingConfig({
          ...COMPLETE,
          BILLING_PROMPTPAY_ENABLED: value,
        }));
        expect(availability.paymentMethods, String(value)).toContain('promptpay');
      }
    });

    it('is offered to nobody while checkout itself is closed', () => {
      const availability = billingAvailability(resolveBillingConfig({
        ...COMPLETE,
        BILLING_CHECKOUT_MODE: 'off',
      }));
      expect(availability.paymentMethods).toEqual([]);
    });
  });

  it('discloses no value in the disabled projection either', () => {
    const result = resolveBillingConfig({ ...COMPLETE, STRIPE_SECRET_KEY: undefined });
    const serialized = JSON.stringify(billingAvailability(result));
    expect(serialized).not.toContain('whsec_placeholder');
    expect(serialized).not.toContain('price_pro_monthly');
  });
});
