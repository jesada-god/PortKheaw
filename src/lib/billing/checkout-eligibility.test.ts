import { describe, expect, it } from 'vitest';
import { billingPaymentMethods } from './billing-payment-method';
import { billingPlanKeys } from './billing-plans';
import {
  checkoutRefusalMessage,
  checkoutRefusalReasons,
  resolveCheckoutEligibility,
  type CheckoutEligibilityInput,
} from './checkout-eligibility';

/**
 * The gate every purchase passes through. It runs before any provider is
 * contacted, so a refusal here costs nothing and a mistake here is the one that
 * charges the wrong person the wrong amount.
 */

function input(overrides: Partial<CheckoutEligibilityInput> = {}): CheckoutEligibilityInput {
  return {
    planKey: 'pro_monthly',
    paymentMethod: 'card',
    availablePlanKeys: [...billingPlanKeys],
    availablePaymentMethods: [...billingPaymentMethods],
    billingEnabled: true,
    authenticated: true,
    emailVerified: true,
    founderPromoApplied: false,
    hasLiveSubscription: false,
    hasOpenPromptPayInvoice: false,
    ...overrides,
  };
}

describe('checkout eligibility', () => {
  it('admits a verified reader buying an available plan', () => {
    const result = resolveCheckoutEligibility(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.key).toBe('pro_monthly');
    expect(result.plan.tier).toBe('pro');
  });

  /*
   * Configuration is checked first, so a deployment with no provider refuses
   * before it has looked anything up — and the refusal is the same whoever asks.
   */
  it('refuses everything while billing is disabled', () => {
    for (const key of billingPlanKeys) {
      const result = resolveCheckoutEligibility(input({ planKey: key, billingEnabled: false }));
      expect(result.ok, key).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('billing-disabled');
    }
  });

  /*
   * The allowlist is the whole input surface. These are the shapes a tampered
   * request actually takes: a tier name, a made-up key, a wrong type.
   */
  it('refuses any plan key that is not on the allowlist', () => {
    for (const planKey of [
      'pro', 'elite', 'basic', 'free', 'pro_weekly', 'PRO_MONTHLY',
      '', null, undefined, 0, {}, [], { key: 'pro_monthly' }, '__proto__',
    ]) {
      const result = resolveCheckoutEligibility(input({ planKey }));
      expect(result.ok, String(planKey)).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unknown-plan');
    }
  });

  it('refuses a real plan this deployment cannot price', () => {
    const result = resolveCheckoutEligibility(input({
      planKey: 'elite_annual',
      availablePlanKeys: ['pro_monthly'],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('plan-unavailable');
  });

  it('refuses a signed-out caller before any account lookup matters', () => {
    const result = resolveCheckoutEligibility(input({ authenticated: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unauthenticated');
  });

  /*
   * A mailbox nobody has proved they own must not become a recurring charge.
   */
  it('refuses an unverified mailbox', () => {
    const result = resolveCheckoutEligibility(input({ emailVerified: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('email-unverified');
  });

  /*
   * Founder's Club is one discounted first period per account, forever. The flag
   * is only ever set by the webhook, so this cannot be reset from a browser.
   */
  it('allows a Founder plan once and refuses it afterwards', () => {
    for (const planKey of ['pro_annual_founder', 'elite_annual_founder'] as const) {
      expect(resolveCheckoutEligibility(input({ planKey })).ok, planKey).toBe(true);

      const second = resolveCheckoutEligibility(input({ planKey, founderPromoApplied: true }));
      expect(second.ok, planKey).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe('founder-already-used');
    }
  });

  /*
   * A spent promotion must not block ordinary purchasing — otherwise a Founder
   * subscriber could never change plan.
   */
  it('still allows every non-Founder plan after the promotion is spent', () => {
    for (const planKey of billingPlanKeys.filter((key) => !key.endsWith('_founder'))) {
      const result = resolveCheckoutEligibility(input({ planKey, founderPromoApplied: true }));
      expect(result.ok, planKey).toBe(true);
    }
  });

  /*
   * One account is one subscription.
   *
   * Without this rule the plan cards happily offered Elite to somebody already
   * paying for Pro; the second checkout opened a *second* subscription at the
   * provider, every event for it was refused downstream as
   * `subscription_mismatch`, and the reader was charged 4,490 baht for a plan
   * they were never granted — while the first subscription kept billing too.
   */
  describe('while a subscription is already live', () => {
    it.each([...billingPlanKeys])('refuses %s', (planKey) => {
      const result = resolveCheckoutEligibility(input({ planKey, hasLiveSubscription: true }));
      expect(result.ok, planKey).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('already-subscribed');
    });

    /*
     * Checked before the Founder rule, so a subscriber asking for a Founder plan
     * is told the useful thing rather than that the promotion is spent.
     */
    it('says the plan is already held rather than that the promotion is spent', () => {
      const result = resolveCheckoutEligibility(
        input({ planKey: 'elite_annual_founder', hasLiveSubscription: true, founderPromoApplied: true }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('already-subscribed');
    });

    /*
     * Configuration and the input allowlist still come first: a caller learns
     * nothing about the account from a malformed key.
     */
    it('still refuses an unknown plan key as unknown', () => {
      const result = resolveCheckoutEligibility(input({ planKey: 'free_forever', hasLiveSubscription: true }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unknown-plan');
    });

    it('still refuses an unauthenticated caller as unauthenticated', () => {
      const result = resolveCheckoutEligibility(input({ hasLiveSubscription: true, authenticated: false }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unauthenticated');
    });
  });

  /*
   * A subscription that has ended is not live, so buying again is exactly the
   * right thing and must not be blocked.
   */
  it('admits a purchase once nothing is being billed any more', () => {
    expect(resolveCheckoutEligibility(input({ hasLiveSubscription: false })).ok).toBe(true);
  });

  /*
   * The second thing a browser may send. It selects a rail, never a price — both
   * rails bill the same Price object — so the only harm a tampered value can do
   * is name a rail this deployment does not offer, which is refused here.
   */
  describe('the payment method', () => {
    it('admits either rail when both are offered', () => {
      for (const paymentMethod of billingPaymentMethods) {
        const result = resolveCheckoutEligibility(input({ paymentMethod }));
        expect(result.ok, paymentMethod).toBe(true);
        if (!result.ok) return;
        expect(result.paymentMethod).toBe(paymentMethod);
      }
    });

    it('refuses anything that is not a rail this product sells', () => {
      for (const paymentMethod of ['bank_transfer', 'CARD', '', null, undefined, 7, {}]) {
        const result = resolveCheckoutEligibility(input({ paymentMethod }));
        expect(result.ok, String(paymentMethod)).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('unknown-payment-method');
      }
    });

    it('refuses a real rail this deployment has switched off', () => {
      const result = resolveCheckoutEligibility(input({
        paymentMethod: 'promptpay',
        availablePaymentMethods: ['card'],
      }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('payment-method-unavailable');
    });
  });

  /*
   * An unpaid PromptPay invoice is a purchase already in flight. Starting
   * another one would leave two payable subscriptions at the provider, of which
   * our records can honour exactly one — the reader would pay twice and be
   * granted once.
   */
  describe('while an unpaid invoice is still payable', () => {
    it('refuses a second purchase on either rail', () => {
      for (const paymentMethod of billingPaymentMethods) {
        const result = resolveCheckoutEligibility(input({
          paymentMethod,
          hasOpenPromptPayInvoice: true,
        }));
        expect(result.ok, paymentMethod).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('promptpay-invoice-open');
      }
    });

    /*
     * Told the actionable thing rather than that a promotion is spent — it is
     * not spent, because nothing has been paid.
     */
    it('says the invoice is open rather than that Founder is used', () => {
      const result = resolveCheckoutEligibility(input({
        planKey: 'pro_annual_founder',
        hasOpenPromptPayInvoice: true,
        founderPromoApplied: false,
      }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('promptpay-invoice-open');
    });

    it('yields to the stronger fact that a subscription is already live', () => {
      const result = resolveCheckoutEligibility(input({
        hasOpenPromptPayInvoice: true,
        hasLiveSubscription: true,
      }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('already-subscribed');
    });

    it('admits a purchase again once the invoice can no longer be paid', () => {
      expect(resolveCheckoutEligibility(input({ hasOpenPromptPayInvoice: false })).ok).toBe(true);
    });
  });

  it('gives every refusal a Thai message that names no internals', () => {
    for (const reason of checkoutRefusalReasons) {
      const message = checkoutRefusalMessage(reason);
      expect(message.length, reason).toBeGreaterThan(0);
      // No environment variable, provider or identifier leaks into what a
      // reader is shown.
      expect(message, reason).not.toMatch(/stripe|sk_|whsec|price_|coupon|env|undefined/i);
    }
  });
});
