import { describe, expect, it } from 'vitest';
import {
  billingPlan,
  billingPlanKeys,
  billingPlans,
  billingPlansForTier,
  formatBillingBaht,
  isBillingPlanKey,
} from './billing-plans';
import { planDescriptor } from '@/src/lib/subscription/plan-catalog';

/**
 * The catalogue is the closed list a checkout looks a plan key up in, so the
 * invariants below are the ones a bad edit would break silently: a Founder plan
 * that renews at its promotional price, a monthly plan priced like an annual
 * one, or a price on a card that disagrees with the price charged.
 */
describe('billing plan catalogue', () => {
  it('publishes exactly the six agreed plan keys', () => {
    expect([...billingPlanKeys]).toEqual([
      'pro_monthly',
      'pro_annual',
      'pro_annual_founder',
      'elite_monthly',
      'elite_annual',
      'elite_annual_founder',
    ]);
    expect(Object.keys(billingPlans).sort()).toEqual([...billingPlanKeys].sort());
  });

  it('prices every plan at the agreed amount in baht', () => {
    const expected: Record<string, { first: number; renewal: number }> = {
      pro_monthly: { first: 349, renewal: 349 },
      pro_annual: { first: 3_490, renewal: 3_490 },
      pro_annual_founder: { first: 1_990, renewal: 3_490 },
      elite_monthly: { first: 799, renewal: 799 },
      elite_annual: { first: 7_990, renewal: 7_990 },
      elite_annual_founder: { first: 4_490, renewal: 7_990 },
    };
    for (const [key, amounts] of Object.entries(expected)) {
      const plan = billingPlan(key as never);
      expect(plan.firstPeriodBaht, key).toBe(amounts.first);
      expect(plan.renewalBaht, key).toBe(amounts.renewal);
      expect(plan.currency, key).toBe('THB');
    }
  });

  /*
   * The Founder rules, as agreed: annual only, discounted once, and renewing
   * into the ordinary plan at the ordinary price. The last clause is what stops
   * a promotional price becoming somebody's permanent price.
   */
  it('discounts a Founder plan for one annual period and renews at list price', () => {
    for (const plan of Object.values(billingPlans)) {
      if (!plan.founder) {
        expect(plan.firstPeriodBaht, plan.key).toBe(plan.renewalBaht);
        expect(plan.renewsIntoKey, plan.key).toBe(plan.key);
        continue;
      }
      expect(plan.interval, plan.key).toBe('year');
      expect(plan.firstPeriodBaht, plan.key).toBeLessThan(plan.renewalBaht);

      const renewsInto = billingPlan(plan.renewsIntoKey);
      expect(renewsInto.founder, plan.key).toBe(false);
      expect(renewsInto.tier, plan.key).toBe(plan.tier);
      expect(renewsInto.interval, plan.key).toBe('year');
      // The renewal amount is the ordinary annual price, not the promotion.
      expect(renewsInto.renewalBaht, plan.key).toBe(plan.renewalBaht);
    }
  });

  it('never prices an annual plan below its monthly plan', () => {
    for (const tier of ['pro', 'elite'] as const) {
      const monthly = billingPlan(`${tier}_monthly`);
      const annual = billingPlan(`${tier}_annual`);
      expect(annual.renewalBaht).toBeGreaterThan(monthly.renewalBaht);
      // An annual plan is worth buying: cheaper than twelve monthly payments.
      expect(annual.renewalBaht).toBeLessThan(monthly.renewalBaht * 12);
    }
  });

  it('groups plans by tier without leaking the other tier in', () => {
    for (const tier of ['pro', 'elite'] as const) {
      const plans = billingPlansForTier(tier);
      expect(plans.length).toBe(3);
      for (const plan of plans) expect(plan.tier).toBe(tier);
    }
  });

  /*
   * The allowlist is the checkout's whole input surface, so it has to reject
   * everything that is not exactly one of the six — including the shapes a
   * tampered request would actually take.
   */
  it('accepts only the six keys and nothing that merely looks like one', () => {
    for (const key of billingPlanKeys) expect(isBillingPlanKey(key)).toBe(true);
    for (const value of [
      'pro', 'elite', 'basic', 'PRO_MONTHLY', 'pro_monthly ', ' pro_monthly',
      'pro_annual_founder_founder', '', null, undefined, 0, 1, {}, [], ['pro_monthly'],
      'constructor', '__proto__', 'toString',
    ]) {
      expect(isBillingPlanKey(value), String(value)).toBe(false);
    }
  });

  /*
   * One source of price truth. The plan cards read the free catalogue, the
   * checkout reads this one; before Phase 4 they were separate literals and
   * could disagree about what a reader was about to be charged.
   */
  it('feeds the displayed plan catalogue from these same amounts', () => {
    for (const tier of ['pro', 'elite'] as const) {
      const pricing = planDescriptor(tier).pricing!;
      expect(pricing.monthlyBaht, tier).toBe(billingPlan(`${tier}_monthly`).renewalBaht);
      expect(pricing.yearlyBaht, tier).toBe(billingPlan(`${tier}_annual`).renewalBaht);
      expect(pricing.founderFirstYearBaht, tier).toBe(billingPlan(`${tier}_annual_founder`).firstPeriodBaht);
    }
  });

  it('formats baht without Intl so server and browser cannot disagree', () => {
    expect(formatBillingBaht(349)).toBe('349');
    expect(formatBillingBaht(3_490)).toBe('3,490');
    expect(formatBillingBaht(7_990)).toBe('7,990');
    expect(formatBillingBaht(1_234_567)).toBe('1,234,567');
  });
});
