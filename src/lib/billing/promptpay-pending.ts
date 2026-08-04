/**
 * The one thing a PromptPay purchase has that a card purchase does not: a gap
 * between "the invoice exists" and "the money arrived".
 *
 * A card checkout resolves in seconds and the reader never sees the in-between.
 * A PromptPay invoice can sit unpaid for days, and during that time the account
 * is in a state the rest of billing has no vocabulary for: **nothing is granted,
 * and yet a purchase is genuinely in flight**. This module is that vocabulary.
 *
 * Two rules shape everything here, and both are deliberate:
 *
 *   * A pending invoice grants nothing. It is not a tier, not a trial and not a
 *     status — the tier opens when the provider confirms payment and at no other
 *     moment. Everything below describes what to *say*, never what to unlock.
 *
 *   * A pending invoice blocks a second purchase while it is open, because the
 *     account can hold exactly one subscription (see `holdsLiveSubscription`).
 *     It stops blocking the moment it can no longer be paid, so an abandoned
 *     invoice frees the reader to pay by card instead of locking them out.
 *
 * Pure: it takes a record and a clock and returns strings and booleans.
 */

import {
  PROMPTPAY_DUE_DAYS,
  type BillingPaymentMethod,
} from './billing-payment-method';
import { billingPlan, formatBillingBaht, type BillingPlanKey } from './billing-plans';

/** The lifecycle of one PromptPay invoice, as stored. */
export const pendingPaymentStatuses = [
  /** Created at the provider, unpaid, still payable. */
  'awaiting_payment',
  /** The provider confirmed payment. Kept only until the row is cleared. */
  'paid',
  /** Abandoned by the reader, or voided with the subscription. */
  'canceled',
  /** The due date passed without payment. */
  'expired',
] as const;
export type PendingPaymentStatus = typeof pendingPaymentStatuses[number];

/**
 * A pending payment as the reader's own row describes it.
 *
 * Deliberately absent: the provider's customer and subscription identifiers.
 * The hosted invoice URL is here because it is the only way to show somebody
 * their own QR, and it is a provider-issued address for that one invoice —
 * never a key, never a session, and never usable to read anything else.
 */
export interface PendingPromptPayRecord {
  planKey: BillingPlanKey;
  paymentMethod: BillingPaymentMethod;
  status: PendingPaymentStatus;
  amountBaht: number;
  hostedInvoiceUrl: string | null;
  dueAt: string | null;
  createdAt: string;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * When this invoice stops being payable.
 *
 * The provider's own due date is authoritative. A row that somehow lacks one
 * falls back to the standard window measured from creation, so an unbounded
 * pending record cannot exist — a record we cannot date is treated as expiring,
 * never as blocking forever.
 */
export function pendingPromptPayDueAt(record: PendingPromptPayRecord): number | null {
  const due = timestamp(record.dueAt);
  if (due !== null) return due;
  const created = timestamp(record.createdAt);
  return created === null ? null : created + PROMPTPAY_DUE_DAYS * 86_400_000;
}

/**
 * Whether this invoice can still be paid.
 *
 * This is the predicate the purchase gate reads. It is intentionally the *same*
 * question as "would paying this now grant a plan?", because the harm being
 * prevented is precise: two payable subscriptions at the provider, of which our
 * records can only ever honour one.
 */
export function pendingPromptPayIsOpen(
  record: PendingPromptPayRecord | null | undefined,
  now: string | number | Date,
): boolean {
  if (!record || record.status !== 'awaiting_payment') return false;
  const due = pendingPromptPayDueAt(record);
  if (due === null) return false;
  return due > new Date(now).getTime();
}

export type PendingPromptPayTone = 'awaiting' | 'due-soon' | 'overdue';

export interface PendingPromptPayView {
  planName: string;
  /** `1,990 บาท` — the amount actually invoiced, promotion included. */
  amountLabel: string;
  hostedInvoiceUrl: string | null;
  /** ISO, for the date formatter the rest of the product already uses. */
  dueAt: string | null;
  tone: PendingPromptPayTone;
  /** Whole hours left, floored, or null when the invoice can no longer be paid. */
  hoursLeft: number | null;
  /** The reminder line. Sharpens as the deadline approaches, then states it passed. */
  reminder: string;
}

const HOUR = 3_600_000;

/**
 * What the pending-invoice card says.
 *
 * The reminder is derived from the deadline rather than scheduled, so it is
 * correct on every render without a job, a queue or a stored "last reminded at"
 * — and it cannot fire for an invoice that has since been paid, because a paid
 * invoice has no pending row to render.
 */
export function resolvePendingPromptPayView(input: {
  record: PendingPromptPayRecord;
  now: string | number | Date;
}): PendingPromptPayView {
  const { record } = input;
  const plan = billingPlan(record.planKey);
  const due = pendingPromptPayDueAt(record);
  const remaining = due === null ? null : due - new Date(input.now).getTime();

  const tone: PendingPromptPayTone = remaining === null || remaining <= 0
    ? 'overdue'
    : remaining <= 24 * HOUR ? 'due-soon' : 'awaiting';

  return {
    planName: plan.name,
    amountLabel: `${formatBillingBaht(record.amountBaht)} บาท`,
    hostedInvoiceUrl: record.hostedInvoiceUrl,
    dueAt: record.dueAt,
    tone,
    hoursLeft: remaining === null || remaining <= 0 ? null : Math.floor(remaining / HOUR),
    reminder: pendingReminder(tone, remaining),
  };
}

function pendingReminder(tone: PendingPromptPayTone, remaining: number | null): string {
  if (tone === 'overdue' || remaining === null) {
    return 'ใบแจ้งหนี้นี้เลยกำหนดชำระแล้ว สิทธิ์ยังไม่เปิด — เริ่มรายการใหม่ได้เลย';
  }
  if (tone === 'due-soon') {
    const hours = Math.max(1, Math.floor(remaining / HOUR));
    return `เหลืออีกประมาณ ${hours} ชั่วโมงก่อนใบแจ้งหนี้หมดอายุ สแกนจ่ายเพื่อเปิดใช้งานแพ็กเกจ`;
  }
  const days = Math.max(1, Math.ceil(remaining / 86_400_000));
  return `สแกนจ่ายภายใน ${days} วัน สิทธิ์จะเปิดหลังธนาคารยืนยันการชำระเงิน`;
}

/**
 * The reminder a PromptPay subscriber needs *before* their period ends.
 *
 * A card subscriber needs no warning: the provider charges them and the plan
 * continues. A PromptPay subscriber loses their plan on this date unless they
 * act, so the manage card starts saying so a week out. Returns `null` when
 * there is nothing worth interrupting the reader about.
 */
export const PROMPTPAY_RENEWAL_REMINDER_DAYS = 7;

export function promptPayRenewalReminder(input: {
  periodEnd: string | null;
  now: string | number | Date;
  withinDays?: number;
}): string | null {
  const end = timestamp(input.periodEnd);
  if (end === null) return null;
  const remaining = end - new Date(input.now).getTime();
  const window = (input.withinDays ?? PROMPTPAY_RENEWAL_REMINDER_DAYS) * 86_400_000;
  if (remaining <= 0 || remaining > window) return null;
  const days = Math.max(1, Math.ceil(remaining / 86_400_000));
  return `รอบที่ชำระไว้จะสิ้นสุดในอีก ${days} วัน`
    + ' สแกนจ่ายรอบถัดไปเพื่อใช้งานต่อเนื่อง — PromptPay ไม่ต่ออายุอัตโนมัติ';
}
