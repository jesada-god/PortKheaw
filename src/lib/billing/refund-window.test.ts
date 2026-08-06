import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REFUND_WINDOW_CLOSED_MESSAGE,
  REFUND_WINDOW_DAYS,
  refundDeadlineFrom,
  refundDeadlineLabel,
  refundRemainingLabel,
  refundWindowSummary,
  refundableInvoiceStatus,
  resolveRefundWindow,
} from './refund-window';

/**
 * The seven-day window, as arithmetic.
 *
 * The property worth the most here is the negative one: there is no path in this
 * module by which the machine running it can influence the answer. Every test
 * below hands in both timestamps, and the last group proves that a browser whose
 * clock is days out — in either direction — gets exactly the same verdict as one
 * whose clock is right.
 */

const day = 86_400_000;
const PAID = '2026-08-06T03:00:00.000Z';
const DEADLINE = '2026-08-13T03:00:00.000Z';

afterEach(() => {
  vi.useRealTimers();
});

describe('the deadline', () => {
  it('is exactly seven days after the confirmed payment', () => {
    expect(refundDeadlineFrom(PAID)).toBe(DEADLINE);
    expect(Date.parse(DEADLINE) - Date.parse(PAID)).toBe(REFUND_WINDOW_DAYS * day);
  });

  it('does not exist for a charge with no confirmed payment', () => {
    for (const value of [null, undefined, '', 'not a date']) {
      expect(refundDeadlineFrom(value)).toBeNull();
    }
  });
});

describe('where a charge stands', () => {
  it('is open until the deadline and closed after it', () => {
    expect(resolveRefundWindow({ paidAt: PAID, now: '2026-08-06T03:00:01.000Z' }))
      .toMatchObject({ state: 'open' });
    expect(resolveRefundWindow({ paidAt: PAID, now: '2026-08-12T23:59:59.000Z' }))
      .toMatchObject({ state: 'open' });
    expect(resolveRefundWindow({ paidAt: PAID, now: '2026-08-13T03:00:01.000Z' }))
      .toMatchObject({ state: 'closed', remainingMs: 0 });
  });

  /*
   * The seventh day counts in full, and the boundary itself is inside the
   * window. Off by one here is a reader refused on the day they were promised.
   */
  it('accepts the deadline instant itself', () => {
    const window = resolveRefundWindow({ paidAt: PAID, now: DEADLINE });
    expect(window.state).toBe('open');
    expect(window.remainingMs).toBe(0);
  });

  it('prefers the deadline the server derived, and falls back to deriving it', () => {
    const supplied = resolveRefundWindow({
      paidAt: PAID,
      deadlineAt: '2026-08-13T03:00:00.000Z',
      now: '2026-08-10T00:00:00.000Z',
    });
    const derived = resolveRefundWindow({ paidAt: PAID, now: '2026-08-10T00:00:00.000Z' });
    expect(supplied).toEqual(derived);

    // A projection from before the column existed still answers correctly.
    expect(resolveRefundWindow({ paidAt: PAID, deadlineAt: null, now: '2026-08-10T00:00:00.000Z' }))
      .toEqual(derived);
  });

  /*
   * `unknown` is never treated as "not expired yet". A deadline nobody can
   * compute must close the affordance, not open it.
   */
  it('answers unknown, never open, when there is no payment or no clock', () => {
    expect(resolveRefundWindow({ paidAt: null, now: '2026-08-10T00:00:00.000Z' }))
      .toMatchObject({ state: 'unknown', deadlineAt: null, remainingMs: 0 });
    expect(resolveRefundWindow({ paidAt: PAID, now: null }))
      .toMatchObject({ state: 'unknown', remainingMs: 0 });
    expect(resolveRefundWindow({ paidAt: PAID, now: 'yesterday' }))
      .toMatchObject({ state: 'unknown' });
  });

  it('offers a window only for a charge that was actually collected', () => {
    expect(refundableInvoiceStatus('paid')).toBe(true);
    expect(refundableInvoiceStatus('partially_refunded')).toBe(true);
    for (const status of ['open', 'void', 'uncollectible', 'refunded', 'disputed'] as const) {
      expect(refundableInvoiceStatus(status), status).toBe(false);
    }
  });
});

/**
 * The one that matters for fairness: the verdict is a function of its two
 * arguments and nothing else. A device whose clock is wrong cannot buy itself
 * more time, and cannot lose time it was promised either.
 */
describe('a client clock cannot move the deadline', () => {
  it('gives the same answer however wrong the machine’s own clock is', () => {
    const now = '2026-08-10T00:00:00.000Z';
    const truth = resolveRefundWindow({ paidAt: PAID, now });

    for (const pretend of ['2026-07-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(pretend));
      expect(resolveRefundWindow({ paidAt: PAID, now }), pretend).toEqual(truth);
      // And an expired charge stays expired however far back the clock is wound.
      expect(resolveRefundWindow({ paidAt: PAID, now: '2026-09-01T00:00:00.000Z' }).state)
        .toBe('closed');
      vi.useRealTimers();
    }
  });

  it('reads the deadline in Bangkok whatever the device thinks it is', () => {
    // The formatter pins its own time zone, so the printed deadline is the same
    // sentence for every reader rather than one that shifts with the device.
    const label = refundDeadlineLabel(DEADLINE);
    expect(label).not.toBe('—');
    expect(label).toBe(new Intl.DateTimeFormat('th-TH', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Bangkok',
    }).format(new Date(DEADLINE)));
    expect(refundDeadlineLabel(null)).toBe('—');
  });
});

describe('what a reader is told', () => {
  it('rounds the time left down, never up', () => {
    expect(refundRemainingLabel(6 * day + 3 * 3_600_000 + 59 * 60_000))
      .toBe('เหลืออีก 6 วัน 3 ชั่วโมง');
    expect(refundRemainingLabel(2 * day)).toBe('เหลืออีก 2 วัน');
    expect(refundRemainingLabel(5 * 3_600_000 + 59 * 60_000)).toBe('เหลืออีก 5 ชั่วโมง');
    expect(refundRemainingLabel(90_000)).toBe('เหลืออีก 1 นาที');
    // Under a minute is still time left; it never reads as zero.
    expect(refundRemainingLabel(5_000)).toBe('เหลืออีก 1 นาที');
    expect(refundRemainingLabel(0)).toBe('หมดเวลาแล้ว');
    expect(refundRemainingLabel(Number.NaN)).toBe('หมดเวลาแล้ว');
  });

  it('states the exact deadline whether or not it has passed', () => {
    const open = refundWindowSummary(resolveRefundWindow({ paidAt: PAID, now: '2026-08-10T00:00:00.000Z' }));
    const closed = refundWindowSummary(resolveRefundWindow({ paidAt: PAID, now: '2026-09-01T00:00:00.000Z' }));
    expect(open).toContain(refundDeadlineLabel(DEADLINE));
    expect(open).toContain('เหลืออีก');
    expect(closed).toContain(refundDeadlineLabel(DEADLINE));
    expect(closed).toContain('พ้นกำหนด');
  });

  /*
   * The refusal names the rule and does not claim the door is bolted: consumer
   * law can require a refund this policy would not, and the sentence has to
   * leave room for that.
   */
  it('refuses without overstating the refusal', () => {
    expect(REFUND_WINDOW_CLOSED_MESSAGE).toContain(String(REFUND_WINDOW_DAYS));
    expect(REFUND_WINDOW_CLOSED_MESSAGE).toContain('กฎหมาย');
    expect(REFUND_WINDOW_CLOSED_MESSAGE).not.toContain('ไม่มีสิทธิ์');
  });
});
