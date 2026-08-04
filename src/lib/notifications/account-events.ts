/**
 * The Thai copy for every account event, and the key that makes each of them
 * arrive exactly once.
 *
 * Pure: no I/O, no `Date.now()`, no Supabase client. Each function takes facts
 * and returns the notification that describes them, so the wording and the
 * deduplication can both be tested without a database — and so the one thing
 * that must never vary, the idempotency key, is derived rather than typed.
 *
 * Two rules run through the whole file.
 *
 * **Trusted time.** Every timestamp comes from the provider's event or the
 * database's clock, never from the process that happens to be running. A
 * cancellation notice states the exact day access ends, and getting that day
 * wrong because a container's clock drifted would be worse than not sending it.
 *
 * **One key per fact, not per delivery.** The key names the *thing that
 * happened* — this invoice was paid, this period was activated, this ticket
 * reply — so a webhook redelivery, a scheduler re-run and a retry all collapse
 * onto the row that already exists. `enqueue_account_notification_service`
 * upserts on `(user_id, idempotency_key)`, so the collapse happens in the
 * database rather than in a check that could race.
 */

import type { Json } from '@/src/types/database';

/**
 * Every account event reuses the existing `system` notification type rather than
 * adding new ones. The Inbox, the quiet-hours queue, the digest and the push
 * pipeline all already handle it, and `metadata.kind` is what tells these apart
 * for anything that needs to.
 */
export const ACCOUNT_NOTIFICATION_TYPE = 'system' as const;

export type AccountNotificationKind =
  | 'payment_succeeded'
  | 'package_activated'
  | 'card_payment_failed'
  | 'subscription_canceled'
  | 'entitlement_expired'
  | 'dispute_opened'
  | 'refund_recorded'
  | 'refund_request_submitted'
  | 'refund_request_status'
  | 'refund_completed'
  | 'support_ticket_received'
  | 'support_ticket_reply'
  | 'support_ticket_status'
  /* Operator-only. Never enqueued to a reader. */
  | 'admin_support_ticket_created'
  | 'admin_refund_request_created'
  | 'admin_dispute_opened'
  | 'admin_webhook_dead_letter'
  | 'admin_reconciliation_issues'
  | 'admin_reconciliation_failed';

export interface AccountNotification {
  kind: AccountNotificationKind;
  title: string;
  message: string;
  metadata: Json;
  idempotencyKey: string;
  /** The trusted instant this notification is *about*. Never a local clock. */
  observedAt: string;
}

/**
 * A Thai calendar date in Bangkok time, e.g. `31 ธ.ค. 2569`.
 *
 * Bangkok rather than the reader's stored timezone: the sentence it appears in
 * is about a billing deadline, and a billing deadline for a Thai product is a
 * Thai calendar day. An unparseable value yields `null`, and every caller then
 * writes a sentence that does not claim a date.
 */
export function bangkokDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(timestamp));
}

/** Baht with thousands separators, formatted without `Intl` so it cannot drift. */
export function baht(amount: number): string {
  return Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function notification(input: {
  kind: AccountNotificationKind;
  title: string;
  message: string;
  href: string;
  observedAt: string;
  idempotencyKey: string;
  extra?: Record<string, string | number | boolean | null>;
}): AccountNotification {
  return {
    kind: input.kind,
    title: input.title,
    message: input.message,
    idempotencyKey: input.idempotencyKey,
    observedAt: input.observedAt,
    metadata: {
      kind: input.kind,
      href: input.href,
      ...(input.extra ?? {}),
    } as Json,
  };
}

const SUBSCRIPTION_HREF = '/settings/subscription';

/* -------------------------------------------------------------------------
 * Billing
 * ---------------------------------------------------------------------- */

/**
 * A payment landed. Keyed on the invoice, so every redelivery of
 * `invoice.paid` — and Stripe sends two event types for one payment — produces
 * one Inbox item.
 */
export function paymentSucceededNotification(input: {
  invoiceId: string;
  planName: string;
  amountBaht: number | null;
  occurredAt: string;
}): AccountNotification {
  const amount = input.amountBaht === null || input.amountBaht <= 0
    ? null
    : `${baht(input.amountBaht)} บาท`;
  return notification({
    kind: 'payment_succeeded',
    title: 'ชำระเงินสำเร็จ',
    message: amount
      ? `รับชำระ ${amount} สำหรับแพ็กเกจ ${input.planName} เรียบร้อยแล้ว`
      : `รับชำระเงินสำหรับแพ็กเกจ ${input.planName} เรียบร้อยแล้ว`,
    href: SUBSCRIPTION_HREF,
    observedAt: input.occurredAt,
    idempotencyKey: `billing-paid:${input.invoiceId}`,
    extra: { planName: input.planName, amountBaht: input.amountBaht },
  });
}

/**
 * The plan is open. Keyed on the *period*, not the event, so the several events
 * that accompany one activation collapse — and so next year's renewal, which is
 * a different period, is announced again.
 */
export function packageActivatedNotification(input: {
  subscriptionId: string;
  periodStart: string | null;
  periodEnd: string | null;
  planName: string;
  occurredAt: string;
}): AccountNotification {
  const until = bangkokDate(input.periodEnd);
  return notification({
    kind: 'package_activated',
    title: 'เปิดใช้งานแพ็กเกจแล้ว',
    message: until
      ? `แพ็กเกจ ${input.planName} พร้อมใช้งานแล้ว ใช้ได้ถึง ${until}`
      : `แพ็กเกจ ${input.planName} พร้อมใช้งานแล้ว`,
    href: SUBSCRIPTION_HREF,
    observedAt: input.occurredAt,
    idempotencyKey: `billing-activated:${input.subscriptionId}:${input.periodStart ?? input.periodEnd ?? 'none'}`,
    extra: { planName: input.planName, periodEnd: input.periodEnd },
  });
}

/**
 * A card renewal failed. Only the card rail reaches this: on the PromptPay rail
 * there is no stored credential to fail, and the reader is already being
 * reminded to scan.
 */
export function cardPaymentFailedNotification(input: {
  invoiceId: string;
  planName: string;
  periodEnd: string | null;
  occurredAt: string;
}): AccountNotification {
  const until = bangkokDate(input.periodEnd);
  return notification({
    kind: 'card_payment_failed',
    title: 'เรียกเก็บเงินจากบัตรไม่สำเร็จ',
    message: until
      ? `เรียกเก็บค่าแพ็กเกจ ${input.planName} จากบัตรไม่สำเร็จ ยังใช้งานได้ถึง ${until} กรุณาอัปเดตบัตรในหน้าแพ็กเกจ`
      : `เรียกเก็บค่าแพ็กเกจ ${input.planName} จากบัตรไม่สำเร็จ กรุณาอัปเดตบัตรในหน้าแพ็กเกจ`,
    href: SUBSCRIPTION_HREF,
    observedAt: input.occurredAt,
    idempotencyKey: `billing-payment-failed:${input.invoiceId}`,
    extra: { planName: input.planName, periodEnd: input.periodEnd },
  });
}

/**
 * A cancellation, with the exact day access ends.
 *
 * Two shapes, one key per (subscription, end date): a cancellation scheduled for
 * the end of the paid period, and one that has already taken effect. Saying
 * "ends immediately" when a month remains, or the reverse, is the kind of
 * mistake that turns a routine cancellation into a support ticket.
 */
export function subscriptionCanceledNotification(input: {
  subscriptionId: string;
  planName: string;
  accessEndsAt: string | null;
  immediate: boolean;
  occurredAt: string;
}): AccountNotification {
  const until = bangkokDate(input.accessEndsAt);
  const message = input.immediate || !until
    ? `ยกเลิกแพ็กเกจ ${input.planName} แล้ว สิทธิ์แบบชำระเงินสิ้นสุดแล้ว ข้อมูลพอร์ตและรายการติดตามของคุณยังอยู่ครบ`
    : `ยกเลิกการต่ออายุแพ็กเกจ ${input.planName} แล้ว ใช้งานได้ถึง ${until} หลังจากนั้นบัญชีจะกลับไปใช้ Basic โดยข้อมูลยังอยู่ครบ`;
  return notification({
    kind: 'subscription_canceled',
    title: 'ยกเลิกแพ็กเกจแล้ว',
    message,
    href: SUBSCRIPTION_HREF,
    observedAt: input.occurredAt,
    idempotencyKey: `billing-canceled:${input.subscriptionId}:${input.accessEndsAt ?? 'immediate'}`,
    extra: { planName: input.planName, accessEndsAt: input.accessEndsAt, immediate: input.immediate },
  });
}

/** The period has run out. Keyed on the period that ended, so it is said once. */
export function entitlementExpiredNotification(input: {
  subscriptionId: string;
  planName: string;
  periodEnd: string;
  observedAt: string;
}): AccountNotification {
  const ended = bangkokDate(input.periodEnd);
  return notification({
    kind: 'entitlement_expired',
    title: 'แพ็กเกจหมดอายุแล้ว',
    message: ended
      ? `แพ็กเกจ ${input.planName} หมดอายุเมื่อ ${ended} บัญชีกลับไปใช้ Basic แล้ว ข้อมูลพอร์ตและรายการติดตามยังอยู่ครบ ต่ออายุได้ที่หน้าแพ็กเกจ`
      : `แพ็กเกจ ${input.planName} หมดอายุแล้ว บัญชีกลับไปใช้ Basic ข้อมูลของคุณยังอยู่ครบ`,
    href: SUBSCRIPTION_HREF,
    observedAt: input.observedAt,
    idempotencyKey: `billing-expired:${input.subscriptionId}:${input.periodEnd}`,
    extra: { planName: input.planName, periodEnd: input.periodEnd },
  });
}

/** A chargeback was opened against a payment on this account. */
export function disputeOpenedNotification(input: {
  eventId: string;
  planName: string;
  occurredAt: string;
}): AccountNotification {
  return notification({
    kind: 'dispute_opened',
    title: 'มีการโต้แย้งการชำระเงิน',
    message: `ธนาคารแจ้งการโต้แย้งการชำระเงินของแพ็กเกจ ${input.planName} เราจึงพักสิทธิ์แบบชำระเงินไว้ก่อนระหว่างตรวจสอบ ข้อมูลของคุณยังอยู่ครบ หากไม่ได้เป็นผู้แจ้ง กรุณาติดต่อทีมงานผ่านหน้าช่วยเหลือ`,
    href: '/support',
    observedAt: input.occurredAt,
    idempotencyKey: `billing-dispute:${input.eventId}`,
    extra: { planName: input.planName },
  });
}

/** A refund the provider confirmed, whether or not it was requested here. */
export function refundRecordedNotification(input: {
  eventId: string;
  amountBaht: number;
  full: boolean;
  occurredAt: string;
}): AccountNotification {
  return notification({
    kind: 'refund_recorded',
    title: input.full ? 'คืนเงินเต็มจำนวนแล้ว' : 'คืนเงินบางส่วนแล้ว',
    message: input.full
      ? `คืนเงิน ${baht(input.amountBaht)} บาท เรียบร้อยแล้ว สิทธิ์แบบชำระเงินของรอบนี้จึงสิ้นสุดลง ข้อมูลพอร์ตและรายการติดตามยังอยู่ครบ`
      : `คืนเงินบางส่วน ${baht(input.amountBaht)} บาท เรียบร้อยแล้ว แพ็กเกจของคุณยังใช้งานได้ตามปกติ`,
    href: SUBSCRIPTION_HREF,
    observedAt: input.occurredAt,
    idempotencyKey: `billing-refund:${input.eventId}`,
    extra: { amountBaht: input.amountBaht, full: input.full },
  });
}

/* -------------------------------------------------------------------------
 * Refund requests
 * ---------------------------------------------------------------------- */

const REFUND_STATUS_COPY: Readonly<Record<string, { title: string; message: string }>> = {
  reviewing: {
    title: 'กำลังตรวจสอบคำขอคืนเงิน',
    message: 'ทีมงานกำลังตรวจสอบคำขอคืนเงินของคุณ จะแจ้งผลให้ทราบทางการแจ้งเตือนนี้',
  },
  approved: {
    title: 'อนุมัติคำขอคืนเงินแล้ว',
    message: 'ทีมงานอนุมัติคำขอคืนเงินของคุณแล้ว ขั้นตอนคืนเงินจะดำเนินการผ่านช่องทางที่ชำระมา และจะแจ้งอีกครั้งเมื่อคืนเงินสำเร็จ',
  },
  rejected: {
    title: 'ไม่อนุมัติคำขอคืนเงิน',
    message: 'ทีมงานพิจารณาแล้วไม่สามารถคืนเงินตามคำขอนี้ได้ เปิดดูเหตุผลและตอบกลับได้ในหน้าคำขอคืนเงิน',
  },
  canceled: {
    title: 'ยกเลิกคำขอคืนเงินแล้ว',
    message: 'คำขอคืนเงินนี้ถูกยกเลิกแล้ว',
  },
};

export function refundRequestSubmittedNotification(input: {
  requestId: string;
  reference: string;
  observedAt: string;
}): AccountNotification {
  return notification({
    kind: 'refund_request_submitted',
    title: 'รับคำขอคืนเงินแล้ว',
    message: `รับคำขอคืนเงินหมายเลข ${input.reference} แล้ว ทีมงานจะตรวจสอบและแจ้งผลให้ทราบ การส่งคำขอยังไม่ใช่การคืนเงิน และสิทธิ์การใช้งานของคุณยังเหมือนเดิมจนกว่าจะมีการคืนเงินจริง`,
    href: `/settings/refunds/${input.requestId}`,
    observedAt: input.observedAt,
    idempotencyKey: `refund-request-created:${input.requestId}`,
    extra: { reference: input.reference },
  });
}

/**
 * A status change on a request. Keyed on (request, status), so re-reading the
 * same status never notifies twice while a genuine change always does.
 */
export function refundRequestStatusNotification(input: {
  requestId: string;
  reference: string;
  status: string;
  observedAt: string;
}): AccountNotification | null {
  const copy = REFUND_STATUS_COPY[input.status];
  if (!copy) return null;
  return notification({
    kind: 'refund_request_status',
    title: copy.title,
    message: `${copy.message} (คำขอ ${input.reference})`,
    href: `/settings/refunds/${input.requestId}`,
    observedAt: input.observedAt,
    idempotencyKey: `refund-request-status:${input.requestId}:${input.status}`,
    extra: { reference: input.reference, status: input.status },
  });
}

export function refundCompletedNotification(input: {
  requestId: string;
  reference: string;
  observedAt: string;
}): AccountNotification {
  return notification({
    kind: 'refund_completed',
    title: 'คืนเงินสำเร็จแล้ว',
    message: `คืนเงินตามคำขอ ${input.reference} เรียบร้อยแล้ว ยอดเงินจะกลับเข้าช่องทางที่ชำระมาตามรอบของผู้ให้บริการชำระเงิน`,
    href: `/settings/refunds/${input.requestId}`,
    observedAt: input.observedAt,
    idempotencyKey: `refund-request-status:${input.requestId}:refunded`,
    extra: { reference: input.reference, status: 'refunded' },
  });
}

/* -------------------------------------------------------------------------
 * Support tickets
 * ---------------------------------------------------------------------- */

export function supportTicketReceivedNotification(input: {
  ticketId: string;
  reference: string;
  observedAt: string;
}): AccountNotification {
  return notification({
    kind: 'support_ticket_received',
    title: 'รับเรื่องแล้ว',
    message: `รับเรื่องหมายเลข ${input.reference} แล้ว ทีมงานจะติดต่อกลับผ่านหน้าเรื่องนี้`,
    href: `/support/tickets/${input.ticketId}`,
    observedAt: input.observedAt,
    idempotencyKey: `support-ticket-created:${input.ticketId}`,
    extra: { reference: input.reference },
  });
}

/** Keyed on the reply itself, so one reply is one notification. */
export function supportTicketReplyNotification(input: {
  ticketId: string;
  reference: string;
  messageId: string;
  observedAt: string;
}): AccountNotification {
  return notification({
    kind: 'support_ticket_reply',
    title: 'ทีมงานตอบกลับแล้ว',
    message: `มีการตอบกลับเรื่องหมายเลข ${input.reference} เปิดดูรายละเอียดได้ที่หน้าเรื่องนี้`,
    href: `/support/tickets/${input.ticketId}`,
    observedAt: input.observedAt,
    idempotencyKey: `support-ticket-reply:${input.messageId}`,
    extra: { reference: input.reference },
  });
}

const TICKET_STATUS_LABEL: Readonly<Record<string, string>> = {
  open: 'เปิดเรื่องอยู่',
  in_progress: 'กำลังดำเนินการ',
  waiting_user: 'รอข้อมูลจากคุณ',
  resolved: 'แก้ไขเรียบร้อย',
  closed: 'ปิดเรื่องแล้ว',
};

export function supportTicketStatusNotification(input: {
  ticketId: string;
  reference: string;
  status: string;
  observedAt: string;
}): AccountNotification | null {
  const label = TICKET_STATUS_LABEL[input.status];
  if (!label) return null;
  return notification({
    kind: 'support_ticket_status',
    title: 'อัปเดตสถานะเรื่องที่แจ้ง',
    message: `เรื่องหมายเลข ${input.reference} เปลี่ยนสถานะเป็น “${label}”`,
    href: `/support/tickets/${input.ticketId}`,
    observedAt: input.observedAt,
    idempotencyKey: `support-ticket-status:${input.ticketId}:${input.status}`,
    extra: { reference: input.reference, status: input.status },
  });
}

/* -------------------------------------------------------------------------
 * Operator alerts
 * ---------------------------------------------------------------------- */
//
// Sent to every administrator, and deliberately free of personal data: an
// operator alert names a reference, a type and a count, and the operator opens
// the console to see the rest. That keeps the Inbox — which is synced to a
// device and may sit on a lock screen — clear of anybody else's details.

export function adminTicketCreatedNotification(input: {
  ticketId: string;
  reference: string;
  category: string;
  tierSnapshot: string;
  observedAt: string;
}): AccountNotification {
  return notification({
    kind: 'admin_support_ticket_created',
    title: 'มีเรื่องแจ้งใหม่',
    message: `เรื่องใหม่ ${input.reference} · หมวด ${input.category} · แพ็กเกจ ${input.tierSnapshot}`,
    href: `/admin/support/${input.ticketId}`,
    observedAt: input.observedAt,
    idempotencyKey: `admin-ticket-created:${input.ticketId}`,
    extra: { reference: input.reference, category: input.category },
  });
}

export function adminRefundRequestCreatedNotification(input: {
  requestId: string;
  reference: string;
  amountBaht: number | null;
  observedAt: string;
}): AccountNotification {
  const amount = input.amountBaht && input.amountBaht > 0 ? ` · ${baht(input.amountBaht)} บาท` : '';
  return notification({
    kind: 'admin_refund_request_created',
    title: 'มีคำขอคืนเงินใหม่',
    message: `คำขอคืนเงิน ${input.reference}${amount} รอการตรวจสอบ`,
    href: `/admin/refunds/${input.requestId}`,
    observedAt: input.observedAt,
    idempotencyKey: `admin-refund-created:${input.requestId}`,
    extra: { reference: input.reference },
  });
}

export function adminDisputeNotification(input: {
  eventId: string;
  amountBaht: number;
  observedAt: string;
}): AccountNotification {
  return notification({
    kind: 'admin_dispute_opened',
    title: 'มีการโต้แย้งการชำระเงิน',
    message: `มีการโต้แย้งการชำระเงิน ${baht(input.amountBaht)} บาท และพักสิทธิ์ของบัญชีนั้นไว้แล้ว ตรวจสอบได้ที่หน้าปฏิบัติการบิลลิ่ง`,
    href: '/admin/billing',
    observedAt: input.observedAt,
    idempotencyKey: `admin-dispute:${input.eventId}`,
    extra: { amountBaht: input.amountBaht },
  });
}

export function adminDeadLetterNotification(input: {
  eventId: string;
  eventType: string;
  attemptCount: number;
  observedAt: string;
}): AccountNotification {
  return notification({
    kind: 'admin_webhook_dead_letter',
    title: 'Webhook บิลลิ่งล้มเหลวถาวร',
    message: `เหตุการณ์ ${input.eventType} ล้มเหลว ${input.attemptCount} ครั้งและถูกย้ายไป dead-letter แล้ว ตรวจสอบได้ที่หน้าปฏิบัติการบิลลิ่ง`,
    href: '/admin/billing',
    observedAt: input.observedAt,
    idempotencyKey: `admin-dead-letter:${input.eventId}`,
    extra: { eventType: input.eventType, attemptCount: input.attemptCount },
  });
}

/**
 * The daily reconciliation summary. Keyed on the run's own date, so a day with
 * problems produces one alert however many issues it found — the count is in the
 * sentence, and the list is on the page.
 */
export function adminReconciliationNotification(input: {
  localDate: string;
  providerMode: string;
  criticalCount: number;
  totalCount: number;
  observedAt: string;
}): AccountNotification {
  return notification({
    kind: 'admin_reconciliation_issues',
    title: 'ตรวจสอบบิลลิ่งประจำวันพบรายการที่ต้องดู',
    message: `พบ ${input.totalCount} รายการ (ระดับวิกฤต ${input.criticalCount}) จากการตรวจสอบวันที่ ${input.localDate} ตรวจสอบได้ที่หน้าปฏิบัติการบิลลิ่ง`,
    href: '/admin/billing',
    observedAt: input.observedAt,
    idempotencyKey: `admin-reconciliation:${input.providerMode}:${input.localDate}`,
    extra: {
      localDate: input.localDate,
      criticalCount: input.criticalCount,
      totalCount: input.totalCount,
    },
  });
}

export function adminReconciliationFailedNotification(input: {
  localDate: string;
  providerMode: string;
  errorCode: string;
  observedAt: string;
}): AccountNotification {
  return notification({
    kind: 'admin_reconciliation_failed',
    title: 'ตรวจสอบบิลลิ่งประจำวันไม่สำเร็จ',
    message: `การตรวจสอบวันที่ ${input.localDate} หยุดกลางคัน (${input.errorCode}) ระบบจะลองใหม่ในรอบถัดไป`,
    href: '/admin/billing',
    observedAt: input.observedAt,
    idempotencyKey: `admin-reconciliation-failed:${input.providerMode}:${input.localDate}`,
    extra: { localDate: input.localDate, errorCode: input.errorCode },
  });
}
