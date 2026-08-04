import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingConfig } from '../../billing-config';
import { billingPlans } from '../../billing-plans';

/**
 * What we actually send the provider when a checkout opens.
 *
 * This exists because of a defect that no pure test could see and no type could
 * catch: the adapter sent `allow_promotion_codes: false` on every session,
 * including the Founder ones that also carry `discounts`. Stripe refuses that
 * combination outright — "You may only specify one of these parameters:
 * allow_promotion_codes, discounts" — so **every** Founder's Club purchase
 * failed at the provider, while the ordinary plans, which carry no discount,
 * went through untouched. The product logged a generic failure and showed the
 * reader "เริ่มการชำระเงินไม่สำเร็จ", and the two paths differed only in a field
 * that is invisible from the outside.
 *
 * So the parameter object itself is the thing under test here.
 */

const created = vi.fn();
const portalCreated = vi.fn();

vi.mock('stripe', () => {
  class MockStripe {
    checkout = { sessions: { create: created } };
    billingPortal = { sessions: { create: portalCreated } };
    static createFetchHttpClient = () => ({});
    static createSubtleCryptoProvider = () => ({});
  }
  return { default: MockStripe };
});

const { createStripeCheckoutSession } = await import('./stripe-provider');

const config: BillingConfig = {
  provider: 'stripe',
  secretKey: 'sk_test_fixture',
  webhookSecret: 'whsec_fixture',
  prices: {
    pro_monthly: 'price_pro_monthly',
    pro_annual: 'price_pro_annual',
    pro_annual_founder: 'price_pro_annual',
    elite_monthly: 'price_elite_monthly',
    elite_annual: 'price_elite_annual',
    elite_annual_founder: 'price_elite_annual',
  },
  coupons: {
    pro_annual_founder: 'coupon_founder_pro',
    elite_annual_founder: 'coupon_founder_elite',
  },
  returnOrigin: 'https://example.test',
};

async function openCheckout(planKey: keyof typeof billingPlans, overrides = {}) {
  created.mockResolvedValue({ id: 'cs_test_fixture', url: 'https://checkout.test/session' });
  await createStripeCheckoutSession({
    config,
    plan: billingPlans[planKey],
    userId: 'user-1',
    email: 'reader@example.test',
    existingCustomerId: null,
    idempotencyKey: 'key-1',
    ...overrides,
  });
  return created.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  created.mockReset();
  portalCreated.mockReset();
});

describe('stripe checkout session parameters', () => {
  /*
   * The regression. Stripe rejects a session carrying both fields, so a plan
   * with a coupon must not also carry the promotion-code flag.
   */
  it.each(['pro_annual_founder', 'elite_annual_founder'] as const)(
    'sends %s with a coupon and without allow_promotion_codes',
    async (planKey) => {
      const params = await openCheckout(planKey);

      expect(params.discounts).toEqual([{ coupon: config.coupons[planKey] }]);
      // The field Stripe refuses to see beside `discounts`.
      expect(params).not.toHaveProperty('allow_promotion_codes');
    },
  );

  it.each(['pro_monthly', 'pro_annual', 'elite_monthly', 'elite_annual'] as const)(
    'sends %s without a discount and with promotion codes explicitly off',
    async (planKey) => {
      const params = await openCheckout(planKey);

      expect(params).not.toHaveProperty('discounts');
      // With no coupon there is a field a reader could type a code into, so it
      // is closed explicitly.
      expect(params.allow_promotion_codes).toBe(false);
    },
  );

  /*
   * The two fields are mutually exclusive in both directions: exactly one of
   * them is present on every session this product opens.
   */
  it('sends exactly one of discounts and allow_promotion_codes on every plan', async () => {
    for (const planKey of Object.keys(billingPlans) as (keyof typeof billingPlans)[]) {
      const params = await openCheckout(planKey);
      const hasDiscount = Object.hasOwn(params, 'discounts');
      const hasFlag = Object.hasOwn(params, 'allow_promotion_codes');
      expect(hasDiscount !== hasFlag, planKey).toBe(true);
    }
  });

  it('sends a price identifier and never an amount', async () => {
    const params = await openCheckout('elite_annual_founder');
    expect(params.line_items).toEqual([{ price: 'price_elite_annual', quantity: 1 }]);
    expect(JSON.stringify(params)).not.toMatch(/unit_amount|price_data/);
  });

  /*
   * A Founder purchase sits on the ordinary annual price with a one-invoice
   * coupon on top — never a second, cheaper price object. That is what makes the
   * second year bill at full rate.
   */
  it('puts a Founder purchase on the same price as its renewal plan', async () => {
    const founder = await openCheckout('elite_annual_founder');
    const ordinary = await openCheckout('elite_annual');
    expect(founder.line_items).toEqual(ordinary.line_items);
  });

  it('carries our user id and plan key on both the session and the subscription', async () => {
    const params = await openCheckout('pro_monthly');
    const metadata = { portkheaw_user_id: 'user-1', portkheaw_plan_key: 'pro_monthly' };
    expect(params.metadata).toEqual(metadata);
    expect(params.subscription_data).toEqual({ metadata });
    expect(params.client_reference_id).toBe('user-1');
  });

  it('reuses an existing customer instead of identifying by mailbox', async () => {
    const returning = await openCheckout('pro_monthly', { existingCustomerId: 'cus_existing' });
    expect(returning.customer).toBe('cus_existing');
    expect(returning).not.toHaveProperty('customer_email');

    const firstTime = await openCheckout('pro_monthly');
    expect(firstTime.customer_email).toBe('reader@example.test');
    expect(firstTime).not.toHaveProperty('customer');
  });

  it('refuses a Founder plan whose coupon is not configured', async () => {
    await expect(
      createStripeCheckoutSession({
        config: { ...config, coupons: {} },
        plan: billingPlans.elite_annual_founder,
        userId: 'user-1',
        email: 'reader@example.test',
        existingCustomerId: null,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toThrow('BILLING_FOUNDER_COUPON_MISSING');
    expect(created).not.toHaveBeenCalled();
  });
});
