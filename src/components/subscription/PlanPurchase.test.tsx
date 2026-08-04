import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ALREADY_SUBSCRIBED_NOTE,
  BILLING_CLOSED_NOTE,
  OPEN_INVOICE_NOTE,
  PlanPurchase,
} from './PlanPurchase';
import { billingPlanKeys } from '@/src/lib/billing/billing-plans';
import type { BillingAvailability } from '@/src/lib/billing/billing-config';

/**
 * The purchase area of a plan card, and the one rule it exists to keep: it must
 * never render a control the server would refuse.
 *
 * The refusal that made this test necessary was `already-subscribed`. The cards
 * offered Elite to somebody already paying for Pro; pressing it opened a second
 * subscription at the provider, whose every webhook was then rejected as
 * `subscription_mismatch` — so the reader was charged for a plan they were never
 * granted, and both subscriptions kept billing.
 */

const open: BillingAvailability = {
  enabled: true,
  availablePlanKeys: [...billingPlanKeys],
  paymentMethods: ['card', 'promptpay'],
};
const closed: BillingAvailability = { enabled: false, availablePlanKeys: [], paymentMethods: [] };

const render = (props: Partial<Parameters<typeof PlanPurchase>[0]> = {}) =>
  renderToStaticMarkup(<PlanPurchase tier="elite" availability={open} {...props} />);

const buttonCount = (markup: string) => markup.split('data-testid="checkout-button"').length - 1;

describe('PlanPurchase', () => {
  it('offers a button per purchasable plan when nothing is being billed yet', () => {
    const markup = render();
    expect(buttonCount(markup)).toBeGreaterThan(0);
    expect(markup).toContain('data-plan-key="elite_monthly"');
    expect(markup).not.toContain(ALREADY_SUBSCRIBED_NOTE);
  });

  describe('while a subscription is already live', () => {
    it.each(['pro', 'elite'] as const)('offers no checkout control at all on the %s card', (tier) => {
      const markup = render({ tier, hasLiveSubscription: true });
      expect(buttonCount(markup)).toBe(0);
      // Not a disabled button either: a control that looks pressable and cannot
      // complete is worse than a sentence saying where to go instead.
      expect(markup).not.toContain('disabled');
      expect(markup).toContain(ALREADY_SUBSCRIBED_NOTE);
    });

    it('points at the manage card rather than naming a provider', () => {
      const markup = render({ hasLiveSubscription: true });
      expect(markup).toContain('จัดการการชำระเงินและยกเลิก');
      expect(markup).not.toMatch(/stripe|price_|coupon/i);
    });
  });

  /*
   * Billing being closed still wins: with no provider configured there is
   * nothing to manage either, so the older note is the honest one.
   */
  it('says payment is not open when billing is closed, whatever is held', () => {
    for (const hasLiveSubscription of [false, true]) {
      const markup = render({ availability: closed, hasLiveSubscription });
      expect(markup).toContain(BILLING_CLOSED_NOTE);
      expect(buttonCount(markup)).toBe(0);
    }
  });

  it('defaults to offering checkout when told nothing about the subscription', () => {
    expect(buttonCount(render())).toBe(buttonCount(render({ hasLiveSubscription: false })));
  });

  /*
   * The Founder row replaces the ordinary annual row rather than sitting beside
   * it — they are the same subscription at two prices.
   */
  it('shows a Founder row instead of the plain annual one, with its renewal price', () => {
    const markup = render({ tier: 'elite' });
    expect(markup).toContain('data-plan-key="elite_annual_founder"');
    expect(markup).not.toContain('data-plan-key="elite_annual"');
    expect(markup).toContain('7,990');
  });

  /*
   * The rail is a choice with a consequence, so it is made before the purchase
   * rather than discovered on the provider's page: a card renews by itself and
   * PromptPay never will.
   */
  describe('choosing how to pay', () => {
    it('offers both rails, and says what each one commits the reader to', () => {
      const markup = render();
      expect(markup).toContain('data-testid="payment-method-choice"');
      expect(markup).toContain('data-testid="payment-method-card"');
      expect(markup).toContain('data-testid="payment-method-promptpay"');
      expect(markup).toContain('ต่ออายุอัตโนมัติ');
      expect(markup).toContain('ต้องสแกนจ่ายใหม่ทุกงวด');
    });

    /*
     * The default must be the rail that cannot surprise anybody: a reader who
     * presses Subscribe without reading gets the renewing one, not the one that
     * silently stops.
     */
    it('starts on the card rail', () => {
      const markup = render();
      expect(markup).toMatch(/data-testid="checkout-button"[^>]*data-payment-method="card"/);
      expect(markup).not.toContain('data-payment-method="promptpay"');
    });

    it('offers no choice at all when only one rail is open', () => {
      const cardOnly = { ...open, paymentMethods: ['card'] as const };
      const markup = render({ availability: cardOnly });
      expect(markup).not.toContain('data-testid="payment-method-choice"');
      expect(buttonCount(markup)).toBeGreaterThan(0);
      expect(markup).toContain('data-payment-method="card"');
    });

    it('states that payment is closed when no rail is open at all', () => {
      const noRails = { ...open, paymentMethods: [] as const };
      const markup = render({ availability: noRails });
      expect(markup).toContain(BILLING_CLOSED_NOTE);
      expect(buttonCount(markup)).toBe(0);
    });
  });

  /*
   * An unpaid invoice is a purchase already in flight. Offering a second one
   * would open a second subscription at the provider, of which our records can
   * honour exactly one — the same harm as offering a plan to a subscriber.
   */
  describe('while an unpaid invoice is still payable', () => {
    it('offers no checkout control, and points at the pending card', () => {
      const markup = render({ hasOpenInvoice: true });
      expect(buttonCount(markup)).toBe(0);
      expect(markup).toContain(OPEN_INVOICE_NOTE);
      expect(markup).not.toContain('disabled');
    });

    it('yields to the stronger fact that a subscription is already live', () => {
      const markup = render({ hasOpenInvoice: true, hasLiveSubscription: true });
      expect(markup).toContain(ALREADY_SUBSCRIBED_NOTE);
      expect(markup).not.toContain(OPEN_INVOICE_NOTE);
    });
  });
});
