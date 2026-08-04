import { describe, expect, it } from 'vitest';
import {
  DATA_KEPT_ON_DOWNGRADE_NOTE,
  formatBahtAmount,
  founderRenewalNote,
  holdsLiveSubscription,
  resolveBillingSummary,
  type BillingSummaryInput,
} from './billing-summary';

/**
 * What the manage card says. The rule these assertions protect is that the
 * number shown as "ราคาต่ออายุ" is the amount of the *next* invoice — which for
 * a Founder subscription is the full annual price, not the promotion they paid
 * last time.
 */

function input(overrides: Partial<BillingSummaryInput> = {}): BillingSummaryInput {
  return {
    tier: 'pro',
    status: 'active',
    planKey: 'pro_annual',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: '2027-08-01T00:00:00.000Z',
    latestPaymentStatus: 'succeeded',
    trialEndsAt: null,
    hasBillingCustomer: true,
    ...overrides,
  };
}

describe('billing summary', () => {
  it('describes an ordinary active subscription', () => {
    const summary = resolveBillingSummary(input());
    expect(summary.kind).toBe('paid');
    expect(summary.planName).toBe('Pro รายปี');
    expect(summary.statusLabel).toBe('ใช้งานอยู่');
    expect(summary.statusTone).toBe('active');
    expect(summary.renewalBaht).toBe(3_490);
    expect(summary.firstPeriodBaht).toBeNull();
    expect(summary.canOpenPortal).toBe(true);
  });

  /*
   * The Founder case. The card must state the full annual price as the renewal,
   * and say so explicitly, or the second year is a surprise charge.
   */
  it('shows a Founder subscription renewing at the full annual price', () => {
    const summary = resolveBillingSummary(input({ planKey: 'elite_annual_founder', tier: 'elite' }));
    expect(summary.planName).toContain('Founder');
    expect(summary.firstPeriodBaht).toBe(4_490);
    expect(summary.renewalBaht).toBe(7_990);

    const note = founderRenewalNote(summary.firstPeriodBaht!, summary.renewalBaht!);
    expect(note).toContain('4,490');
    expect(note).toContain('7,990');
    expect(note).toContain('ครั้งเดียว');
  });

  /*
   * A subscription set to end takes precedence over "active": it is the fact a
   * reader most needs, because access continues but stops on a date.
   */
  it('leads with the scheduled ending rather than the active state', () => {
    const summary = resolveBillingSummary(input({ cancelAtPeriodEnd: true }));
    expect(summary.statusLabel).toBe('จะสิ้นสุดเมื่อจบรอบบิล');
    expect(summary.statusTone).toBe('ending');
    expect(summary.cancelAtPeriodEnd).toBe(true);
    expect(summary.periodEnd).toBe('2027-08-01T00:00:00.000Z');
  });

  it('surfaces a failed renewal as a warning without ending access', () => {
    const summary = resolveBillingSummary(input({ status: 'past_due', latestPaymentStatus: 'failed' }));
    expect(summary.statusLabel).toBe('ค้างชำระ');
    expect(summary.statusTone).toBe('warning');
    expect(summary.latestPaymentFailed).toBe(true);
    // The period is still stated, because that is when grace runs out.
    expect(summary.periodEnd).toBe('2027-08-01T00:00:00.000Z');
  });

  it.each([
    ['canceled', 'ยกเลิกแล้ว'],
    ['expired', 'หมดอายุแล้ว'],
  ])('describes a %s subscription plainly', (status, label) => {
    const summary = resolveBillingSummary(input({ status }));
    expect(summary.statusLabel).toBe(label);
    expect(summary.statusTone).toBe('inactive');
  });

  /*
   * The Elite trial is a grant, not a purchase. It must never be described with
   * a renewal price, because nothing will be charged.
   */
  it('never attaches a price to the Elite trial', () => {
    const summary = resolveBillingSummary(input({
      status: 'trialing',
      planKey: null,
      trialEndsAt: '2026-08-10T00:00:00.000Z',
    }));
    expect(summary.kind).toBe('trial');
    expect(summary.renewalBaht).toBeNull();
    expect(summary.firstPeriodBaht).toBeNull();
    expect(summary.periodEnd).toBe('2026-08-10T00:00:00.000Z');
  });

  it('reports no subscription when no purchase was ever confirmed', () => {
    const summary = resolveBillingSummary(input({ status: 'basic', planKey: null, hasBillingCustomer: false }));
    expect(summary.kind).toBe('none');
    expect(summary.planName).toBeNull();
    expect(summary.canOpenPortal).toBe(false);
  });

  /*
   * Somebody whose subscription has ended still owns their invoice history, so
   * the portal stays reachable once a provider customer exists.
   */
  it('keeps the portal reachable after a subscription has ended', () => {
    const summary = resolveBillingSummary(input({ status: 'basic', planKey: null, hasBillingCustomer: true }));
    expect(summary.kind).toBe('none');
    expect(summary.canOpenPortal).toBe(true);
  });

  it('formats amounts consistently and promises the data survives', () => {
    expect(formatBahtAmount(3_490)).toBe('3,490 บาท');
    expect(DATA_KEPT_ON_DOWNGRADE_NOTE).toContain('ยังอยู่ครบ');
  });

  /**
   * The predicate that closes the purchase surface while one subscription is
   * live. Getting it wrong in either direction is expensive: too loose and a
   * reader opens a second subscription whose events are all refused downstream
   * as `subscription_mismatch`, so they pay and are granted nothing; too strict
   * and somebody whose plan has ended can never buy again.
   */
  describe('holdsLiveSubscription', () => {
    it.each(['active', 'past_due'])('counts %s with a plan key as live', (status) => {
      expect(holdsLiveSubscription({ status, planKey: 'pro_monthly' })).toBe(true);
    });

    it.each(['canceled', 'expired', 'basic'])('counts %s as not live, so a fresh purchase is allowed', (status) => {
      expect(holdsLiveSubscription({ status, planKey: 'pro_monthly' })).toBe(false);
    });

    /*
     * The Elite trial is a grant, not a purchase: no plan key, no provider
     * subscription. A reader on trial must still be able to buy.
     */
    it('does not count the Elite trial as a live subscription', () => {
      expect(holdsLiveSubscription({ status: 'trialing', planKey: null })).toBe(false);
    });

    /*
     * A subscription set to end is still being billed until it does, so opening
     * a second one alongside it would still double-bill.
     */
    it('counts a subscription scheduled to end as still live', () => {
      expect(holdsLiveSubscription({ status: 'active', planKey: 'elite_annual_founder' })).toBe(true);
    });

    it('treats a missing snapshot as nothing being billed', () => {
      expect(holdsLiveSubscription(null)).toBe(false);
      expect(holdsLiveSubscription(undefined)).toBe(false);
      expect(holdsLiveSubscription({ status: 'active', planKey: null })).toBe(false);
    });

    /*
     * The manage card and this predicate must agree about what "paid" means:
     * anything the card calls a live paid plan is a plan you cannot buy over.
     */
    it('agrees with the manage card about which states are a live paid plan', () => {
      for (const status of ['active', 'past_due', 'canceled', 'expired']) {
        const summary = resolveBillingSummary(input({ status }));
        const live = holdsLiveSubscription({ status, planKey: 'pro_annual' });
        expect(summary.kind, status).toBe('paid');
        expect(live, status).toBe(summary.statusTone === 'active' || summary.statusTone === 'warning');
      }
    });
  });
});
