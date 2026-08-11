import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTECTED_PATHS } from '@/src/lib/auth/paths';
import { planDescriptors, planFeatureGroups } from '@/src/lib/subscription/plan-catalog';
import { billingPlans } from '@/src/lib/billing/billing-plans';

/**
 * The public pricing page, as a contract.
 *
 * Two things could go wrong here and neither would fail a build: the page could
 * quote a price of its own instead of deriving one, and it could grow a purchase
 * path that skips the consent dialog. Both are asserted against the source.
 */
const pricingPage = readFileSync(join(process.cwd(), 'app/pricing/page.tsx'), 'utf8');
const publicCards = readFileSync(
  join(process.cwd(), 'src/components/subscription/PublicPlanCards.tsx'),
  'utf8',
);

describe('public pricing page', () => {
  it('is reachable without a session', () => {
    for (const path of PROTECTED_PATHS) {
      expect('/pricing'.startsWith(path)).toBe(false);
    }
    expect(PROTECTED_PATHS).not.toContain('/pricing');
  });

  it('compares Basic, Pro and Elite from the one plan catalogue', () => {
    expect(planDescriptors.map((plan) => plan.tier)).toEqual(['basic', 'pro', 'elite']);
    expect(publicCards).toContain('planDescriptors');
    expect(pricingPage).toContain('PlanComparison');
    // Not a second list of features typed beside the first.
    expect(planFeatureGroups.length).toBeGreaterThan(0);
    expect(publicCards).toContain('planFeatureRow');
  });

  it('writes down no price of its own', () => {
    const amounts = new Set(Object.values(billingPlans).flatMap((plan) => [
      String(plan.renewalBaht),
      String(plan.firstPeriodBaht),
    ]));
    for (const source of [pricingPage, publicCards]) {
      for (const amount of amounts) {
        expect(source).not.toContain(amount);
      }
    }
    // Both monthly/annual and the Founder first-year line come from the shared
    // price block, so the visitor and the subscriber read one quotation.
    expect(publicCards).toContain('PlanPriceBlock');
  });

  it('starts no purchase of its own and never bypasses the consent dialog', () => {
    for (const source of [pricingPage, publicCards]) {
      // Nothing that could begin one is imported or rendered here — the prose in
      // the module comments may name them, the code may not.
      expect(source).not.toMatch(/^import .*(PurchaseConsentDialog|PlanPurchase|CheckoutButton)/m);
      expect(source).not.toMatch(/<\s*(PurchaseConsentDialog|PlanPurchase|CheckoutButton)\b/);
      expect(source).not.toContain('startCheckout');
      expect(source).not.toContain('createCheckoutSession');
      expect(source).not.toContain("'use client'");
    }
  });

  it('sends both a visitor and a subscriber into the existing flows', () => {
    expect(publicCards).toContain("'/settings/subscription'");
    expect(publicCards).toContain("'/auth/sign-up?next=/settings/subscription'");
  });

  it('states the Elite trial rule from the shared sentence', () => {
    expect(pricingPage).toContain('TRIAL_ELIGIBILITY_STATEMENT');
  });
});
