import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingConfig } from '../../billing-config';
import { PROMPTPAY_DUE_DAYS } from '../../billing-payment-method';
import { billingPlans } from '../../billing-plans';

/**
 * What we actually send the provider when a PromptPay purchase starts.
 *
 * The parameter object is the thing under test for the same reason it is on the
 * card rail: the failures that matter here are invisible from the outside and
 * would each look like a generic "could not start payment".
 *
 * Three of them are specific to this rail:
 *
 *   * omitting `collection_method: 'send_invoice'` produces a subscription that
 *     tries to charge a payment method which does not exist;
 *   * omitting the PromptPay payment method type produces an invoice the reader
 *     cannot pay by QR at all;
 *   * sending a second, cheaper price instead of the Founder coupon would
 *     discount every renewal rather than only the first.
 */

const subscriptionCreated = vi.fn();
const subscriptionRetrieved = vi.fn();
const subscriptionCanceled = vi.fn();
const customerCreated = vi.fn();
const invoiceRetrieved = vi.fn();
const invoiceFinalized = vi.fn();
const invoiceVoided = vi.fn();
const priceRetrieved = vi.fn();
const couponRetrieved = vi.fn();

vi.mock('stripe', () => {
  class MockStripe {
    checkout = { sessions: { create: vi.fn() } };
    billingPortal = { sessions: { create: vi.fn() } };
    customers = { create: customerCreated };
    subscriptions = {
      create: subscriptionCreated,
      retrieve: subscriptionRetrieved,
      cancel: subscriptionCanceled,
    };
    invoices = {
      retrieve: invoiceRetrieved,
      finalizeInvoice: invoiceFinalized,
      voidInvoice: invoiceVoided,
    };
    prices = { retrieve: priceRetrieved };
    coupons = { retrieve: couponRetrieved };
    static createFetchHttpClient = () => ({});
    static createSubtleCryptoProvider = () => ({});
  }
  return { default: MockStripe };
});

const {
  abandonStripePromptPaySubscription,
  createStripePromptPaySubscription,
} = await import('./stripe-provider');

const config: BillingConfig = {
  provider: 'stripe',
  providerMode: 'test',
  checkoutMode: 'internal',
  internalUserIds: [],
  secretKey: 'sk_test_promptpay_fixture',
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
  paymentMethods: ['card', 'promptpay'],
};

const DUE_DATE = 1_786_000_000;

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_promptpay',
    status: 'open',
    hosted_invoice_url: 'https://invoice.stripe.test/i/one',
    due_date: DUE_DATE,
    amount_due: 199_000,
    total: 199_000,
    ...overrides,
  };
}

async function startPromptPay(
  planKey: keyof typeof billingPlans,
  overrides: { request?: Record<string, unknown>; invoice?: Record<string, unknown> } = {},
) {
  const plan = billingPlans[planKey];
  priceRetrieved.mockResolvedValue({
    id: config.prices[planKey], active: true, livemode: false,
    currency: 'thb', unit_amount: plan.renewalBaht * 100,
    recurring: { interval: plan.interval },
  });
  couponRetrieved.mockResolvedValue({
    id: config.coupons[planKey], valid: true, livemode: false,
    duration: 'once', currency: 'thb',
    amount_off: (plan.renewalBaht - plan.firstPeriodBaht) * 100,
    percent_off: null,
  });
  subscriptionCreated.mockResolvedValue({
    id: 'sub_promptpay',
    livemode: false,
    status: 'active',
    collection_method: 'send_invoice',
    latest_invoice: invoice(overrides.invoice),
  });

  const result = await createStripePromptPaySubscription({
    config,
    plan,
    userId: 'user-1',
    email: 'reader@example.test',
    existingCustomerId: 'cus_existing',
    idempotencyKey: 'key-1',
    ...overrides.request,
  });
  return {
    result,
    params: subscriptionCreated.mock.calls.at(-1)?.[0] as Record<string, unknown>,
    options: subscriptionCreated.mock.calls.at(-1)?.[1] as Record<string, unknown>,
  };
}

beforeEach(() => {
  for (const mock of [
    subscriptionCreated, subscriptionRetrieved, subscriptionCanceled, customerCreated,
    invoiceRetrieved, invoiceFinalized, invoiceVoided, priceRetrieved, couponRetrieved,
  ]) mock.mockReset();
});

describe('promptpay subscription parameters', () => {
  /*
   * The rail itself. PromptPay is only supported on a subscription that bills by
   * invoice, so this is the parameter the whole feature rests on.
   */
  it('bills by invoice, with a due window and the PromptPay method', async () => {
    const { params } = await startPromptPay('pro_monthly');

    expect(params.collection_method).toBe('send_invoice');
    expect(params.days_until_due).toBe(PROMPTPAY_DUE_DAYS);
    expect(params.payment_settings).toEqual({
      payment_method_types: ['promptpay'],
      save_default_payment_method: 'off',
    });
  });

  it('sends a price identifier and never an amount', async () => {
    const { params } = await startPromptPay('elite_annual');
    expect(params.items).toEqual([{ price: 'price_elite_annual', quantity: 1 }]);
    expect(JSON.stringify(params)).not.toMatch(/unit_amount|price_data|amount_off/);
  });

  /*
   * The Founder promotion is one coupon on the ordinary annual price, so the
   * first QR is discounted and every later one is not.
   */
  it.each(['pro_annual_founder', 'elite_annual_founder'] as const)(
    'discounts only the first invoice of %s',
    async (planKey) => {
      const { params } = await startPromptPay(planKey);
      expect(params.discounts).toEqual([{ coupon: config.coupons[planKey] }]);
      // The same price object the non-promotional plan renews on.
      expect(params.items).toEqual([
        { price: config.prices[billingPlans[planKey].renewsIntoKey], quantity: 1 },
      ]);
      // The coupon was read back and checked before anything was created.
      expect(couponRetrieved).toHaveBeenCalledWith(config.coupons[planKey]);
    },
  );

  it.each(['pro_monthly', 'elite_monthly', 'pro_annual', 'elite_annual'] as const)(
    'sends %s at list price with no discount',
    async (planKey) => {
      const { params } = await startPromptPay(planKey);
      expect(params).not.toHaveProperty('discounts');
    },
  );

  it('carries our user id and plan key so a later event names the account', async () => {
    const { params } = await startPromptPay('elite_monthly');
    expect(params.metadata).toEqual({
      portkheaw_user_id: 'user-1',
      portkheaw_plan_key: 'elite_monthly',
      portkheaw_provider_mode: 'test',
      portkheaw_billing_schema: '1',
    });
  });

  it('reuses the account’s existing customer rather than creating a second one', async () => {
    const { params } = await startPromptPay('pro_monthly');
    expect(params.customer).toBe('cus_existing');
    expect(customerCreated).not.toHaveBeenCalled();

    customerCreated.mockResolvedValue({ id: 'cus_new' });
    const firstTime = await startPromptPay('pro_monthly', { request: { existingCustomerId: null } });
    expect(firstTime.params.customer).toBe('cus_new');
  });

  it('collapses a double-pressed button into one subscription', async () => {
    const { options } = await startPromptPay('pro_monthly');
    expect(options.idempotencyKey).toBe('key-1');
  });

  it('returns the invoice a reader can actually pay', async () => {
    const { result } = await startPromptPay('pro_annual_founder');
    expect(result.hostedInvoiceUrl).toBe('https://invoice.stripe.test/i/one');
    expect(result.subscriptionId).toBe('sub_promptpay');
    expect(result.dueAt).toBe(new Date(DUE_DATE * 1000).toISOString());
    // The invoiced amount, which on a Founder purchase is the discounted one.
    expect(result.amountBaht).toBe(1_990);
  });

  /*
   * A draft invoice has no hosted page and no QR. Finalizing is what publishes
   * it, and doing it here means the reader gets a payable link now rather than
   * whenever the provider's own auto-advance happens to run.
   */
  it('finalizes a draft invoice before handing back a link', async () => {
    invoiceFinalized.mockResolvedValue(invoice({ id: 'in_final' }));
    const { result } = await startPromptPay('pro_monthly', { invoice: { status: 'draft', hosted_invoice_url: null } });
    expect(invoiceFinalized).toHaveBeenCalledWith('in_promptpay', { auto_advance: true });
    expect(result.invoiceId).toBe('in_final');
  });

  /*
   * If the provider did not put this on the invoice rail, it is an auto-charging
   * subscription with no payment method — refused rather than left to fail
   * silently at the first renewal.
   */
  it('refuses a subscription that did not end up on the invoice rail', async () => {
    priceRetrieved.mockResolvedValue({
      active: true, livemode: false, currency: 'thb', unit_amount: 34_900,
      recurring: { interval: 'month' },
    });
    subscriptionCreated.mockResolvedValue({
      id: 'sub_wrong', livemode: false, status: 'active',
      collection_method: 'charge_automatically', latest_invoice: invoice(),
    });
    await expect(createStripePromptPaySubscription({
      config,
      plan: billingPlans.pro_monthly,
      userId: 'user-1',
      email: 'reader@example.test',
      existingCustomerId: 'cus_existing',
      idempotencyKey: 'key-wrong',
    })).rejects.toThrow('BILLING_PROMPTPAY_COLLECTION_METHOD_MISMATCH');
  });

  it('refuses a price whose amount, currency, cadence or mode differs', async () => {
    for (const mismatch of [
      { livemode: true }, { currency: 'usd' }, { unit_amount: 1 },
      { recurring: { interval: 'year' } }, { active: false },
    ]) {
      priceRetrieved.mockResolvedValue({
        active: true, livemode: false, currency: 'thb', unit_amount: 34_900,
        recurring: { interval: 'month' }, ...mismatch,
      });
      await expect(createStripePromptPaySubscription({
        config,
        plan: billingPlans.pro_monthly,
        userId: 'user-1',
        email: 'reader@example.test',
        existingCustomerId: null,
        idempotencyKey: `bad-${JSON.stringify(mismatch)}`,
      })).rejects.toThrow('BILLING_PRICE_CONTRACT_MISMATCH');
      expect(subscriptionCreated).not.toHaveBeenCalled();
    }
  });
});

describe('abandoning an unpaid invoice', () => {
  it('cancels the subscription and voids the open invoice', async () => {
    subscriptionRetrieved.mockResolvedValue({
      id: 'sub_promptpay', status: 'active',
      collection_method: 'send_invoice', latest_invoice: invoice(),
    });

    await expect(abandonStripePromptPaySubscription(config, 'sub_promptpay')).resolves.toBe('abandoned');
    expect(subscriptionCanceled).toHaveBeenCalledWith('sub_promptpay');
    expect(invoiceVoided).toHaveBeenCalledWith('in_promptpay');
  });

  /*
   * The one thing this must never do. Money has moved, so cancelling here would
   * destroy something the reader paid for.
   */
  it('refuses to touch anything once the invoice has been paid', async () => {
    subscriptionRetrieved.mockResolvedValue({
      id: 'sub_promptpay', status: 'active',
      collection_method: 'send_invoice', latest_invoice: invoice({ status: 'paid' }),
    });

    await expect(abandonStripePromptPaySubscription(config, 'sub_promptpay')).resolves.toBe('already-paid');
    expect(subscriptionCanceled).not.toHaveBeenCalled();
    expect(invoiceVoided).not.toHaveBeenCalled();
  });

  it('leaves a card subscription alone entirely', async () => {
    subscriptionRetrieved.mockResolvedValue({
      id: 'sub_card', status: 'active',
      collection_method: 'charge_automatically', latest_invoice: invoice({ status: 'paid' }),
    });

    await expect(abandonStripePromptPaySubscription(config, 'sub_card')).resolves.toBe('already-paid');
    expect(subscriptionCanceled).not.toHaveBeenCalled();
  });
});
