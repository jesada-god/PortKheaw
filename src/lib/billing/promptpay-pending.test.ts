import { describe, expect, it } from 'vitest';
import {
  billingPaymentMethods,
  collectionMethodFor,
  isBillingCollectionMethod,
  isBillingPaymentMethod,
  paymentMethodFromCollectionMethod,
  paymentMethodRenewalNote,
  PROMPTPAY_DUE_DAYS,
} from './billing-payment-method';
import {
  pendingPromptPayIsOpen,
  promptPayRenewalReminder,
  resolvePendingPromptPayView,
  type PendingPromptPayRecord,
} from './promptpay-pending';

/**
 * The rails, and the state only one of them has.
 *
 * Everything here is about the gap between an invoice existing and the money
 * arriving. Two questions decide correctness: may this account start another
 * purchase, and what is the reader told. Nothing here grants anything, and the
 * tests are written so that a future change which made it grant something would
 * have to delete an assertion rather than merely pass one.
 */

const NOW = '2026-08-04T12:00:00.000Z';
const HOUR = 3_600_000;

function pending(overrides: Partial<PendingPromptPayRecord> = {}): PendingPromptPayRecord {
  return {
    planKey: 'pro_annual_founder',
    paymentMethod: 'promptpay',
    status: 'awaiting_payment',
    amountBaht: 1_990,
    hostedInvoiceUrl: 'https://invoice.stripe.test/i/one',
    dueAt: new Date(Date.parse(NOW) + 48 * HOUR).toISOString(),
    createdAt: NOW,
    ...overrides,
  };
}

describe('payment methods', () => {
  it('sells exactly two rails and refuses anything else a client could send', () => {
    expect([...billingPaymentMethods]).toEqual(['card', 'promptpay']);
    for (const value of ['CARD', 'promptPay', 'bank', '', null, undefined, 0, {}]) {
      expect(isBillingPaymentMethod(value), String(value)).toBe(false);
    }
  });

  /*
   * The mapping that makes the whole feature necessary: PromptPay leaves no
   * credential behind, so it can only ever be billed by invoice.
   */
  it('bills PromptPay by invoice and a card automatically', () => {
    expect(collectionMethodFor('promptpay')).toBe('send_invoice');
    expect(collectionMethodFor('card')).toBe('charge_automatically');
    expect(paymentMethodFromCollectionMethod('send_invoice')).toBe('promptpay');
    expect(paymentMethodFromCollectionMethod('charge_automatically')).toBe('card');
  });

  /*
   * A record from before the column existed says nothing about its rail, and a
   * guess in either direction would be wrong: guessing `card` promises a renewal
   * that will not happen, guessing `promptpay` warns about one that will.
   */
  it('never guesses a rail from an unrecognised collection method', () => {
    for (const value of [null, undefined, '', 'sepa', 'charge']) {
      expect(paymentMethodFromCollectionMethod(value), String(value)).toBeNull();
      expect(isBillingCollectionMethod(value), String(value)).toBe(false);
    }
  });

  it('states the commitment in the cadence the reader is buying', () => {
    expect(paymentMethodRenewalNote('promptpay', 'month')).toContain('ทุกเดือน');
    expect(paymentMethodRenewalNote('promptpay', 'year')).toContain('ทุกปี');
    expect(paymentMethodRenewalNote('promptpay', 'year')).toContain('ไม่ต่ออายุอัตโนมัติ');
    expect(paymentMethodRenewalNote('card', 'month')).toContain('อัตโนมัติ');
    // Both cadences at once: naming one of them would be wrong for the other.
    expect(paymentMethodRenewalNote('promptpay', null)).toContain('ทุกงวด');
  });
});

describe('an invoice awaiting payment', () => {
  it('blocks another purchase while it can still be paid', () => {
    expect(pendingPromptPayIsOpen(pending(), NOW)).toBe(true);
  });

  /*
   * The block has to end on its own. An abandoned invoice that kept blocking
   * would lock a reader out of paying by card for as long as the record lived.
   */
  it('stops blocking once it can no longer be paid', () => {
    const expired = pending({ dueAt: new Date(Date.parse(NOW) - HOUR).toISOString() });
    expect(pendingPromptPayIsOpen(expired, NOW)).toBe(false);

    for (const status of ['paid', 'canceled', 'expired'] as const) {
      expect(pendingPromptPayIsOpen(pending({ status }), NOW), status).toBe(false);
    }
    expect(pendingPromptPayIsOpen(null, NOW)).toBe(false);
  });

  /*
   * A row we cannot date must expire rather than block forever, so an absent due
   * date falls back to the standard window measured from creation.
   */
  it('bounds a record with no due date by the standard window', () => {
    const undated = pending({ dueAt: null });
    const withinWindow = new Date(Date.parse(NOW) + (PROMPTPAY_DUE_DAYS - 1) * 24 * HOUR);
    const pastWindow = new Date(Date.parse(NOW) + (PROMPTPAY_DUE_DAYS + 1) * 24 * HOUR);
    expect(pendingPromptPayIsOpen(undated, withinWindow)).toBe(true);
    expect(pendingPromptPayIsOpen(undated, pastWindow)).toBe(false);

    // An unparseable pair cannot be shown to be payable, so it does not block.
    expect(pendingPromptPayIsOpen(pending({ dueAt: null, createdAt: 'not-a-date' }), NOW)).toBe(false);
  });
});

describe('what the pending card says', () => {
  it('names the plan and the amount actually invoiced, promotion included', () => {
    const view = resolvePendingPromptPayView({ record: pending(), now: NOW });
    expect(view.planName).toContain('Pro รายปี');
    // The Founder first-period amount, not the catalogue's renewal price: it is
    // what the QR will ask for.
    expect(view.amountLabel).toBe('1,990 บาท');
    expect(view.hostedInvoiceUrl).toBe('https://invoice.stripe.test/i/one');
  });

  it('sharpens the reminder as the deadline approaches', () => {
    const comfortable = resolvePendingPromptPayView({ record: pending(), now: NOW });
    expect(comfortable.tone).toBe('awaiting');
    expect(comfortable.reminder).toContain('วัน');

    const soon = resolvePendingPromptPayView({
      record: pending({ dueAt: new Date(Date.parse(NOW) + 5 * HOUR).toISOString() }),
      now: NOW,
    });
    expect(soon.tone).toBe('due-soon');
    expect(soon.hoursLeft).toBe(5);
    expect(soon.reminder).toContain('ชั่วโมง');

    const late = resolvePendingPromptPayView({
      record: pending({ dueAt: new Date(Date.parse(NOW) - HOUR).toISOString() }),
      now: NOW,
    });
    expect(late.tone).toBe('overdue');
    expect(late.hoursLeft).toBeNull();
    expect(late.reminder).toContain('เลยกำหนด');
  });

  /*
   * The one sentence this card must never contradict: an unpaid invoice has
   * granted nothing.
   */
  it('never describes a pending invoice as access', () => {
    for (const now of [NOW, new Date(Date.parse(NOW) + 90 * HOUR).toISOString()]) {
      const view = resolvePendingPromptPayView({ record: pending(), now });
      expect(view.reminder).not.toMatch(/ใช้งานอยู่|เปิดใช้งานแล้ว/);
    }
  });
});

describe('the reminder before a PromptPay period lapses', () => {
  const periodEnd = new Date(Date.parse(NOW) + 3 * 24 * HOUR).toISOString();

  it('warns inside the window and says how long is left', () => {
    const reminder = promptPayRenewalReminder({ periodEnd, now: NOW });
    expect(reminder).toContain('3 วัน');
    expect(reminder).toContain('ไม่ต่ออายุอัตโนมัติ');
  });

  it('stays quiet outside the window, and once the period has already ended', () => {
    const distant = new Date(Date.parse(NOW) + 30 * 24 * HOUR).toISOString();
    expect(promptPayRenewalReminder({ periodEnd: distant, now: NOW })).toBeNull();

    const past = new Date(Date.parse(NOW) - HOUR).toISOString();
    expect(promptPayRenewalReminder({ periodEnd: past, now: NOW })).toBeNull();
    expect(promptPayRenewalReminder({ periodEnd: null, now: NOW })).toBeNull();
  });
});
