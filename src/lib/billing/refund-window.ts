/**
 * The seven days in which a purchase can be asked back.
 *
 * Pure, like `billing-refunds.ts` beside it: no clock of its own, no I/O, no
 * provider SDK. Every function here takes the two timestamps it needs as
 * arguments, and that is the whole point — the deadline is measured from the
 * moment the *provider* confirmed money arrived, and "now" is the moment the
 * *database* reports. Neither is ever read from the machine running this code.
 *
 * Why that matters enough to be a rule rather than a habit:
 *
 *   * A deadline measured from checkout creation would start running before
 *     anybody had paid — on the PromptPay rail, up to three days before.
 *   * A deadline judged against `Date.now()` in a browser would move by however
 *     far that browser's clock is wrong, in whichever direction suits the
 *     reader. The window is a promise about money; it cannot be a promise a
 *     device gets to reinterpret.
 *
 * One window per successful charge, not per subscription. An initial payment, a
 * card renewal and a PromptPay invoice are three separate charges with three
 * separate `paid_at` values, so each opens its own seven days — which is why
 * nothing here takes a subscription, a plan or a period as input.
 *
 * Seven *calendar* days and seven times twenty-four hours are the same interval
 * in Asia/Bangkok, which observes no daylight saving. The database adds
 * `interval '7 days'` and this adds the milliseconds; they agree, and the
 * migration test asserts it rather than leaving it to the reader to notice.
 */

import type { BillingInvoiceStatus } from '@/src/types/database';

/** The window, written down once. The SQL states the same number. */
export const REFUND_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * `open` — a request may be filed. `closed` — the deadline has passed.
 * `unknown` — there is no confirmed payment timestamp, or no database clock, so
 * no honest answer exists. `unknown` never opens the window: a deadline nobody
 * can compute is not a deadline that has not arrived yet.
 */
export type RefundWindowState = 'open' | 'closed' | 'unknown';

export interface RefundWindow {
  state: RefundWindowState;
  /** ISO, or `null` when the charge carries no confirmed payment timestamp. */
  deadlineAt: string | null;
  /** Milliseconds left, floored at zero. Zero whenever the state is not `open`. */
  remainingMs: number;
}

function parse(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The deadline for one charge.
 *
 * `null` for a charge with no confirmed payment — an issued-but-unpaid invoice
 * has nothing to refund, so it has no window either.
 */
export function refundDeadlineFrom(paidAt: string | null | undefined): string | null {
  const paid = parse(paidAt);
  return paid === null ? null : new Date(paid + REFUND_WINDOW_DAYS * DAY_MS).toISOString();
}

/**
 * Where one charge stands.
 *
 * `deadlineAt` may be supplied by the server that already derived it; when it is
 * absent or unreadable the deadline is recomputed from `paidAt`, so a projection
 * from before the column existed still answers correctly rather than silently
 * reporting `unknown`.
 *
 * The comparison is inclusive: a request filed at exactly the deadline is inside
 * the window. Seven days means the whole of the seventh day.
 */
export function resolveRefundWindow(input: {
  /** The provider-confirmed payment timestamp, as the database stores it. */
  paidAt: string | null | undefined;
  /** The database's clock. Never `Date.now()`. */
  now: string | null | undefined;
  /** The deadline the server derived, when it sent one. */
  deadlineAt?: string | null;
}): RefundWindow {
  const deadlineAt = parse(input.deadlineAt) === null
    ? refundDeadlineFrom(input.paidAt)
    : input.deadlineAt ?? null;
  const deadline = parse(deadlineAt);
  const now = parse(input.now);

  if (deadline === null || now === null) {
    return { state: 'unknown', deadlineAt: deadline === null ? null : deadlineAt, remainingMs: 0 };
  }
  const remainingMs = deadline - now;
  return remainingMs >= 0
    ? { state: 'open', deadlineAt, remainingMs }
    : { state: 'closed', deadlineAt, remainingMs: 0 };
}

/**
 * The invoice states a refund can be asked for at all.
 *
 * Mirrors the routine's own check. A void, uncollectible or still-open invoice
 * was never collected, and a fully refunded one has already been given back.
 */
export function refundableInvoiceStatus(status: BillingInvoiceStatus): boolean {
  return status === 'paid' || status === 'partially_refunded';
}

const DEADLINE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

/**
 * The deadline as a reader sees it: Bangkok time, stated to the minute.
 *
 * The time zone is pinned rather than taken from the device for the same reason
 * the comparison above is: a deadline that reads differently depending on where
 * the phone thinks it is would be a different promise to each reader. It is also
 * what keeps the server render and the browser render identical.
 */
export function refundDeadlineLabel(deadlineAt: string | null): string {
  const deadline = parse(deadlineAt);
  return deadline === null ? '—' : DEADLINE_FORMAT.format(new Date(deadline));
}

/**
 * How long is left, in the largest honest unit.
 *
 * Days while there are whole days; hours inside the last day; minutes inside the
 * last hour. Rounded *down* throughout, so the number never overstates the time
 * a reader actually has.
 */
export function refundRemainingLabel(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'หมดเวลาแล้ว';
  const days = Math.floor(remainingMs / DAY_MS);
  if (days >= 1) {
    const hours = Math.floor((remainingMs - days * DAY_MS) / HOUR_MS);
    return hours > 0 ? `เหลืออีก ${days} วัน ${hours} ชั่วโมง` : `เหลืออีก ${days} วัน`;
  }
  const hours = Math.floor(remainingMs / HOUR_MS);
  if (hours >= 1) return `เหลืออีก ${hours} ชั่วโมง`;
  const minutes = Math.max(Math.floor(remainingMs / 60_000), 1);
  return `เหลืออีก ${minutes} นาที`;
}

/**
 * The whole window in one line, for a list row.
 *
 * States the exact deadline in every case — a reader who has run out of time is
 * owed the date they ran out on, not just the fact that they did.
 */
export function refundWindowSummary(window: RefundWindow): string {
  switch (window.state) {
    case 'open':
      return `ขอคืนเงินได้ถึง ${refundDeadlineLabel(window.deadlineAt)} · ${refundRemainingLabel(window.remainingMs)}`;
    case 'closed':
      return `พ้นกำหนดขอคืนเงินแล้ว (ครบกำหนด ${refundDeadlineLabel(window.deadlineAt)})`;
    default:
      return 'ยังไม่มีวันที่ยืนยันการชำระเงินสำหรับรายการนี้';
  }
}

/**
 * What the server says when it refuses a late request.
 *
 * It names the rule, and it does not pretend the door is bolted: consumer law
 * can require a refund this policy would not, and saying so is both true and the
 * only version of this sentence that is safe to write down.
 */
export const REFUND_WINDOW_CLOSED_MESSAGE =
  `เลยกำหนด ${REFUND_WINDOW_DAYS} วันนับจากเวลาที่ชำระเงินสำเร็จของรอบนี้แล้ว `
  + 'ระบบจึงรับคำขอคืนเงินตามปกติสำหรับรายการนี้ไม่ได้ '
  + 'หากเป็นการเรียกเก็บผิดพลาด หรือคุณมีสิทธิ์ตามกฎหมายที่ใช้บังคับ ติดต่อทีมงานผ่านหน้าช่วยเหลือได้';

/** The same rule, in the voice the purchase and refund surfaces state it in. */
export const REFUND_WINDOW_RULE_NOTE =
  `ขอคืนเงินเต็มจำนวนได้ภายใน ${REFUND_WINDOW_DAYS} วันนับจากเวลาที่ชำระเงินสำเร็จของรอบบิลนั้น `
  + 'และการต่ออายุแต่ละครั้งจะเริ่มนับใหม่ของรอบนั้นเอง';
