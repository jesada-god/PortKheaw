/**
 * Thai labels, tones and ordering for tickets and refund requests.
 *
 * Pure, and shared by the reader's pages and the operator console, so a status
 * cannot be called one thing on one screen and another on the next — which for
 * a refund is not a cosmetic problem: "อนุมัติแล้ว" and "คืนเงินแล้ว" mean very
 * different things to somebody waiting for money.
 */

import type {
  RefundRequestReason,
  RefundRequestStatus,
  SupportTicketCategory,
  SupportTicketStatus,
} from '@/src/types/database';

/** How a status chip is coloured. Mapped to theme tokens by the components. */
export type StatusTone = 'neutral' | 'active' | 'waiting' | 'positive' | 'negative';

export const SUPPORT_CATEGORY_LABEL: Readonly<Record<SupportTicketCategory, string>> = {
  billing: 'การชำระเงิน',
  subscription: 'แพ็กเกจและสิทธิ์',
  portfolio: 'พอร์ตการลงทุน',
  market_data: 'ข้อมูลตลาด',
  technical: 'ปัญหาทางเทคนิค',
  suggestion: 'ข้อเสนอแนะ',
  other: 'อื่น ๆ',
};

export const supportCategoryOptions: readonly { value: SupportTicketCategory; label: string }[] = (
  Object.keys(SUPPORT_CATEGORY_LABEL) as SupportTicketCategory[]
).map((value) => ({ value, label: SUPPORT_CATEGORY_LABEL[value] }));

export const TICKET_STATUS_LABEL: Readonly<Record<SupportTicketStatus, string>> = {
  open: 'เปิดเรื่องอยู่',
  in_progress: 'กำลังดำเนินการ',
  waiting_user: 'รอข้อมูลจากคุณ',
  resolved: 'แก้ไขเรียบร้อย',
  closed: 'ปิดเรื่องแล้ว',
};

const TICKET_STATUS_TONE: Readonly<Record<SupportTicketStatus, StatusTone>> = {
  open: 'active',
  in_progress: 'active',
  waiting_user: 'waiting',
  resolved: 'positive',
  closed: 'neutral',
};

export function ticketStatusTone(status: SupportTicketStatus): StatusTone {
  return TICKET_STATUS_TONE[status] ?? 'neutral';
}

/** Whether a reader can still write on this ticket. */
export function ticketAcceptsReply(status: SupportTicketStatus): boolean {
  return status !== 'closed';
}

export const REFUND_STATUS_LABEL: Readonly<Record<RefundRequestStatus, string>> = {
  pending: 'รอตรวจสอบ',
  reviewing: 'กำลังตรวจสอบ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ไม่อนุมัติ',
  refunded: 'คืนเงินแล้ว',
  canceled: 'ยกเลิกคำขอ',
};

const REFUND_STATUS_TONE: Readonly<Record<RefundRequestStatus, StatusTone>> = {
  pending: 'waiting',
  reviewing: 'active',
  approved: 'active',
  rejected: 'negative',
  refunded: 'positive',
  canceled: 'neutral',
};

export function refundStatusTone(status: RefundRequestStatus): StatusTone {
  return REFUND_STATUS_TONE[status] ?? 'neutral';
}

/**
 * The one sentence under each status that says what it does and does not mean.
 *
 * `approved` is the important one. Somebody reading "อนุมัติแล้ว" will assume the
 * money is on its way back and may not notice that their plan still works, so
 * the copy says both things explicitly.
 */
export const REFUND_STATUS_EXPLANATION: Readonly<Record<RefundRequestStatus, string>> = {
  pending: 'เราได้รับคำขอแล้ว ทีมงานจะเริ่มตรวจสอบเร็ว ๆ นี้ สิทธิ์การใช้งานของคุณยังเหมือนเดิม',
  reviewing: 'ทีมงานกำลังตรวจสอบรายการชำระเงินและรายละเอียดของคุณ สิทธิ์การใช้งานยังเหมือนเดิม',
  approved: 'อนุมัติให้คืนเงินแล้ว และกำลังดำเนินการผ่านช่องทางที่ชำระมา การอนุมัติยังไม่ใช่การคืนเงิน และยังไม่ตัดสิทธิ์การใช้งานของคุณ',
  rejected: 'ทีมงานพิจารณาแล้วไม่สามารถคืนเงินตามคำขอนี้ได้ อ่านเหตุผลได้จากข้อความด้านล่าง และตอบกลับได้หากมีข้อมูลเพิ่มเติม',
  refunded: 'ยืนยันการคืนเงินแล้ว ยอดเงินจะกลับเข้าช่องทางเดิมตามรอบของผู้ให้บริการชำระเงิน',
  canceled: 'คุณยกเลิกคำขอนี้แล้ว',
};

export const REFUND_REASON_LABEL: Readonly<Record<RefundRequestReason, string>> = {
  duplicate_charge: 'ถูกเรียกเก็บซ้ำ',
  not_as_expected: 'ใช้งานแล้วไม่ตรงกับที่คาดหวัง',
  accidental_purchase: 'กดชำระเงินโดยไม่ตั้งใจ',
  technical_issue: 'ใช้ฟีเจอร์ที่ชำระเงินไม่ได้',
  other: 'เหตุผลอื่น',
};

export const refundReasonOptions: readonly { value: RefundRequestReason; label: string }[] = (
  Object.keys(REFUND_REASON_LABEL) as RefundRequestReason[]
).map((value) => ({ value, label: REFUND_REASON_LABEL[value] }));

/** A reader may withdraw a request only while nobody has decided it. */
export function refundIsCancelable(status: RefundRequestStatus): boolean {
  return status === 'pending' || status === 'reviewing';
}

export function refundAcceptsReply(status: RefundRequestStatus): boolean {
  return status !== 'refunded' && status !== 'rejected' && status !== 'canceled';
}

/**
 * The transitions an operator may make, per current status.
 *
 * The same graph the database enforces. Duplicated here so the console cannot
 * offer a control the routine would refuse — but the database is the boundary,
 * and a test asserts the two agree.
 */
export const REFUND_ADMIN_TRANSITIONS: Readonly<Record<RefundRequestStatus, readonly RefundRequestStatus[]>> = {
  pending: ['reviewing', 'approved', 'rejected'],
  reviewing: ['approved', 'rejected'],
  approved: ['refunded', 'rejected'],
  rejected: [],
  refunded: [],
  canceled: [],
};

/** Only this transition claims money moved, so only it demands evidence. */
export function refundTransitionNeedsConfirmation(next: RefundRequestStatus): boolean {
  return next === 'refunded';
}

/** Baht from the currency's minor unit, for display. */
export function displayBaht(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor === null || !Number.isFinite(amountMinor)) return null;
  const zeroDecimal = new Set(['jpy', 'krw', 'vnd', 'clp']);
  const whole = zeroDecimal.has((currency ?? 'thb').toLowerCase())
    ? Math.round(amountMinor)
    : Math.round(amountMinor / 100);
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
