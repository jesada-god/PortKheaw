import { describe, expect, it } from 'vitest';
import {
  adminDeadLetterNotification,
  adminReconciliationNotification,
  bangkokDate,
  cardPaymentFailedNotification,
  entitlementExpiredNotification,
  packageActivatedNotification,
  paymentSucceededNotification,
  refundCompletedNotification,
  refundRequestStatusNotification,
  subscriptionCanceledNotification,
  supportTicketReplyNotification,
  supportTicketStatusNotification,
  ACCOUNT_NOTIFICATION_TYPE,
} from './account-events';

const OCCURRED = '2026-08-05T03:00:00.000Z';

/**
 * The idempotency key is the whole deduplication story: the Inbox routine
 * upserts on `(user_id, idempotency_key)`, so a key that is stable across
 * redeliveries produces one row and a key that varies produces several.
 *
 * These tests are therefore about *identity* — what fact does this key name —
 * rather than about wording.
 */
describe('deduplication keys name a fact, not a delivery', () => {
  it('keys a payment on its invoice, so both Stripe events collapse into one', () => {
    const first = paymentSucceededNotification({
      invoiceId: 'in_1', planName: 'Elite รายปี', amountBaht: 7_990, occurredAt: OCCURRED,
    });
    const redelivery = paymentSucceededNotification({
      invoiceId: 'in_1', planName: 'Elite รายปี', amountBaht: 7_990, occurredAt: '2026-08-05T03:00:09.000Z',
    });
    expect(first.idempotencyKey).toBe(redelivery.idempotencyKey);

    const nextYear = paymentSucceededNotification({
      invoiceId: 'in_2', planName: 'Elite รายปี', amountBaht: 7_990, occurredAt: OCCURRED,
    });
    expect(nextYear.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('keys an activation on the period, so the several events for one activation collapse', () => {
    const fromCheckout = packageActivatedNotification({
      subscriptionId: 'sub_1', periodStart: OCCURRED, periodEnd: '2027-08-05T03:00:00.000Z',
      planName: 'Elite รายปี', occurredAt: OCCURRED,
    });
    const fromSubscriptionUpdate = packageActivatedNotification({
      subscriptionId: 'sub_1', periodStart: OCCURRED, periodEnd: '2027-08-05T03:00:00.000Z',
      planName: 'Elite รายปี', occurredAt: '2026-08-05T03:00:04.000Z',
    });
    expect(fromCheckout.idempotencyKey).toBe(fromSubscriptionUpdate.idempotencyKey);

    // Next year is a different period and must be announced again.
    const renewal = packageActivatedNotification({
      subscriptionId: 'sub_1', periodStart: '2027-08-05T03:00:00.000Z', periodEnd: '2028-08-05T03:00:00.000Z',
      planName: 'Elite รายปี', occurredAt: '2027-08-05T03:00:00.000Z',
    });
    expect(renewal.idempotencyKey).not.toBe(fromCheckout.idempotencyKey);
  });

  it('keys a lapse on the period that ended, so a three-day window sends once', () => {
    const monday = entitlementExpiredNotification({
      subscriptionId: 'sub_1', planName: 'Pro รายเดือน', periodEnd: OCCURRED, observedAt: OCCURRED,
    });
    const tuesday = entitlementExpiredNotification({
      subscriptionId: 'sub_1', planName: 'Pro รายเดือน', periodEnd: OCCURRED, observedAt: '2026-08-06T03:00:00.000Z',
    });
    expect(monday.idempotencyKey).toBe(tuesday.idempotencyKey);
  });

  it('keys a status change on the status, so re-reading it never notifies twice', () => {
    const first = supportTicketStatusNotification({
      ticketId: 't1', reference: 'TK-1', status: 'resolved', observedAt: OCCURRED,
    });
    const again = supportTicketStatusNotification({
      ticketId: 't1', reference: 'TK-1', status: 'resolved', observedAt: '2026-08-06T03:00:00.000Z',
    });
    expect(first?.idempotencyKey).toBe(again?.idempotencyKey);

    const moved = supportTicketStatusNotification({
      ticketId: 't1', reference: 'TK-1', status: 'closed', observedAt: OCCURRED,
    });
    expect(moved?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  it('keys a reply on the reply, so each answer is its own notice', () => {
    const one = supportTicketReplyNotification({
      ticketId: 't1', reference: 'TK-1', messageId: 'm1', observedAt: OCCURRED,
    });
    const two = supportTicketReplyNotification({
      ticketId: 't1', reference: 'TK-1', messageId: 'm2', observedAt: OCCURRED,
    });
    expect(one.idempotencyKey).not.toBe(two.idempotencyKey);
  });

  it('gives "refunded" the same key from both paths, so it cannot arrive twice', () => {
    // One path is an operator recording a completion, the other is the provider
    // confirming it. They describe the same fact and must collapse.
    const fromStatus = refundRequestStatusNotification({
      requestId: 'r1', reference: 'RF-1', status: 'refunded', observedAt: OCCURRED,
    });
    const fromCompletion = refundCompletedNotification({
      requestId: 'r1', reference: 'RF-1', observedAt: OCCURRED,
    });
    // `refundRequestStatusNotification` has no copy for `refunded` — the
    // dedicated one is used — but the key it would produce is the same.
    expect(fromStatus).toBeNull();
    expect(fromCompletion.idempotencyKey).toBe('refund-request-status:r1:refunded');
  });

  it('keys the daily reconciliation on the day, so one alert covers any count', () => {
    const few = adminReconciliationNotification({
      localDate: '2026-08-05', providerMode: 'live', criticalCount: 1, totalCount: 3, observedAt: OCCURRED,
    });
    const many = adminReconciliationNotification({
      localDate: '2026-08-05', providerMode: 'live', criticalCount: 9, totalCount: 40, observedAt: OCCURRED,
    });
    expect(few.idempotencyKey).toBe(many.idempotencyKey);
  });

  it('keys a dead letter on the event, so one failure alerts once', () => {
    const first = adminDeadLetterNotification({
      eventId: 'evt_1', eventType: 'invoice.paid', attemptCount: 8, observedAt: OCCURRED,
    });
    const second = adminDeadLetterNotification({
      eventId: 'evt_1', eventType: 'invoice.paid', attemptCount: 9, observedAt: OCCURRED,
    });
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });
});

describe('the wording that decides what a reader does next', () => {
  it('states the exact access-end date on a scheduled cancellation', () => {
    const notice = subscriptionCanceledNotification({
      subscriptionId: 'sub_1',
      planName: 'Elite รายปี',
      accessEndsAt: '2027-08-05T03:00:00.000Z',
      immediate: false,
      occurredAt: OCCURRED,
    });
    expect(notice.message).toContain(bangkokDate('2027-08-05T03:00:00.000Z')!);
    expect(notice.message).toContain('ใช้งานได้ถึง');
    // The reassurance a cancelling reader actually needs.
    expect(notice.message).toContain('ข้อมูล');
  });

  it('does not promise remaining access when there is none', () => {
    const notice = subscriptionCanceledNotification({
      subscriptionId: 'sub_1',
      planName: 'Elite รายปี',
      accessEndsAt: null,
      immediate: true,
      occurredAt: OCCURRED,
    });
    expect(notice.message).toContain('สิ้นสุดแล้ว');
    expect(notice.message).not.toContain('ใช้งานได้ถึง');
  });

  it('tells a card holder what to fix and by when', () => {
    const notice = cardPaymentFailedNotification({
      invoiceId: 'in_1',
      planName: 'Pro รายเดือน',
      periodEnd: '2026-09-05T03:00:00.000Z',
      occurredAt: OCCURRED,
    });
    expect(notice.message).toContain('บัตร');
    expect(notice.message).toContain(bangkokDate('2026-09-05T03:00:00.000Z')!);
  });

  it('says the data survives when a plan lapses', () => {
    const notice = entitlementExpiredNotification({
      subscriptionId: 'sub_1', planName: 'Elite รายปี', periodEnd: OCCURRED, observedAt: OCCURRED,
    });
    expect(notice.message).toContain('Basic');
    expect(notice.message).toContain('ยังอยู่ครบ');
  });

  it('uses the existing system notification type rather than inventing one', () => {
    expect(ACCOUNT_NOTIFICATION_TYPE).toBe('system');
  });

  it('carries an href so the Inbox item is actionable', () => {
    const notice = paymentSucceededNotification({
      invoiceId: 'in_1', planName: 'Elite รายปี', amountBaht: 7_990, occurredAt: OCCURRED,
    });
    expect(notice.metadata).toMatchObject({ href: '/settings/subscription' });
  });

  it('uses the provider’s clock as the observed time, never a local one', () => {
    const notice = paymentSucceededNotification({
      invoiceId: 'in_1', planName: 'Elite รายปี', amountBaht: 7_990, occurredAt: OCCURRED,
    });
    expect(notice.observedAt).toBe(OCCURRED);
  });
});

describe('date formatting', () => {
  it('renders a Bangkok calendar day', () => {
    // 03:00 UTC is 10:00 the same day in Bangkok.
    expect(bangkokDate('2026-08-05T03:00:00.000Z')).toBeTruthy();
    // 22:00 UTC is already the next day in Bangkok, which is the case that would
    // otherwise state a deadline one day early.
    expect(bangkokDate('2026-08-05T22:00:00.000Z'))
      .not.toBe(bangkokDate('2026-08-05T03:00:00.000Z'));
  });

  it('returns null rather than an invalid date string', () => {
    expect(bangkokDate(null)).toBeNull();
    expect(bangkokDate('not-a-date')).toBeNull();
  });
});
