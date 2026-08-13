'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/src/lib/supabase/server';
import { isAdminRequiredError, requireAdmin } from '@/src/lib/subscription/account-access';
import {
  consumeRateLimit, rateLimitMessage, resolveClientAddress,
} from '@/src/lib/security/rate-limit';
import { storeSupportAttachment } from '@/src/lib/support/attachments';
import {
  adminRefundRequestCreatedNotification,
  refundCompletedNotification,
  refundRequestStatusNotification,
  refundRequestSubmittedNotification,
  supportTicketReplyNotification,
} from '@/src/lib/notifications/account-events';
import { notifyAccount, notifyAdmins } from '@/src/lib/notifications/dispatch';
import { REFUND_WINDOW_CLOSED_MESSAGE } from '@/src/lib/billing/refund-window';
import { displayBaht } from '@/src/lib/support/presentation';
import type { RefundRequestReason, RefundRequestStatus } from '@/src/types/database';

/**
 * Refund requests.
 *
 * The rule this file exists to hold: **nothing here refunds anything.** No
 * Stripe call is made from any path in this module — not on submit, not on
 * approve, not on "mark refunded". A refund is performed by an operator at the
 * provider, deliberately outside the product, and comes back as a signed webhook
 * that the ledger routine applies. Automating it would put a second, unsigned
 * path next to the one that already works, for an action that moves money.
 *
 * The reader's whole input surface is: which of their own purchases (by our
 * uuid), a reason from a closed list, some text, and optionally one image.
 */

export type RefundFailureCode =
  | 'UNAUTHENTICATED'
  /** Signed in, but not an operator. Only the two operator actions raise it. */
  | 'FORBIDDEN'
  | 'UNAVAILABLE'
  | 'INVALID_REASON'
  | 'INVALID_CONTENT'
  | 'NOT_FOUND'
  | 'NOT_REFUNDABLE'
  /** Past `paid_at + 7 days`, judged by the database's clock. */
  | 'WINDOW_CLOSED'
  | 'ALREADY_OPEN'
  | 'ALREADY_REFUNDED'
  | 'RATE_LIMITED'
  | 'NOT_CANCELABLE'
  | 'INVALID_TRANSITION'
  | 'CONFIRMATION_REQUIRED'
  | 'CLOSED';

export type CreateRefundResult =
  | { ok: true; requestId: string; reference: string; attachmentWarning?: string }
  | { ok: false; code: RefundFailureCode; message: string };

export type RefundActionResult =
  | { ok: true }
  | { ok: false; code: RefundFailureCode; message: string };

const MESSAGE: Readonly<Record<RefundFailureCode, string>> = {
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบก่อนส่งคำขอคืนเงิน',
  FORBIDDEN: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
  UNAVAILABLE: 'ระบบไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง',
  INVALID_REASON: 'กรุณาเลือกเหตุผลของการขอคืนเงิน',
  INVALID_CONTENT: 'กรุณากรอกรายละเอียดอย่างน้อย 10 ตัวอักษร',
  NOT_FOUND: 'ไม่พบรายการชำระเงินนี้ในบัญชีของคุณ',
  NOT_REFUNDABLE: 'รายการนี้ยังไม่อยู่ในสถานะที่ขอคืนเงินได้',
  WINDOW_CLOSED: REFUND_WINDOW_CLOSED_MESSAGE,
  ALREADY_OPEN: 'รายการนี้มีคำขอคืนเงินที่ยังไม่ได้ข้อยุติอยู่แล้ว',
  ALREADY_REFUNDED: 'รายการนี้คืนเงินไปแล้ว',
  RATE_LIMITED: 'ส่งคำขอคืนเงินครบจำนวนสูงสุดของวันนี้แล้ว กรุณาลองใหม่ในวันถัดไป',
  NOT_CANCELABLE: 'คำขอนี้ผ่านการพิจารณาแล้ว จึงยกเลิกเองไม่ได้',
  INVALID_TRANSITION: 'เปลี่ยนสถานะนี้ไม่ได้จากสถานะปัจจุบัน',
  CONFIRMATION_REQUIRED: 'ต้องระบุหมายเลขอ้างอิงการคืนเงินจากผู้ให้บริการชำระเงินก่อนบันทึกว่าคืนเงินแล้ว',
  CLOSED: 'คำขอนี้ปิดแล้ว',
};

const OUTCOME_CODE: Readonly<Record<string, RefundFailureCode>> = {
  invalid_reason: 'INVALID_REASON',
  invalid_content: 'INVALID_CONTENT',
  not_found: 'NOT_FOUND',
  not_refundable: 'NOT_REFUNDABLE',
  window_closed: 'WINDOW_CLOSED',
  already_open: 'ALREADY_OPEN',
  already_refunded: 'ALREADY_REFUNDED',
  rate_limited: 'RATE_LIMITED',
  not_cancelable: 'NOT_CANCELABLE',
  invalid_transition: 'INVALID_TRANSITION',
  confirmation_required: 'CONFIRMATION_REQUIRED',
  closed: 'CLOSED',
  too_soon: 'UNAVAILABLE',
  invalid_status: 'INVALID_TRANSITION',
};

type RefundAudit =
  | 'refund_request_created'
  | 'refund_request_refused'
  | 'refund_request_failed'
  | 'refund_request_canceled'
  | 'refund_request_replied'
  | 'refund_request_decided';

function record(event: RefundAudit, detail?: string) {
  const payload = JSON.stringify({ event, ...(detail ? { detail } : {}) });
  if (event.endsWith('_failed') || event.endsWith('_refused')) console.warn(payload);
  else console.info(payload);
}

function refusal(code: RefundFailureCode) {
  record('refund_request_refused', code);
  return { ok: false as const, code, message: MESSAGE[code] };
}

export async function createRefundRequestAction(formData: FormData): Promise<CreateRefundResult> {
  const client = await createClient();
  if (!client) return refusal('UNAVAILABLE');

  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) return refusal('UNAUTHENTICATED');

  const invoiceRef = String(formData.get('invoiceRef') ?? '');
  const reason = String(formData.get('reason') ?? '') as RefundRequestReason;
  const details = String(formData.get('details') ?? '');

  let requestId: string;
  let reference: string;
  try {
    const { data, error } = await client.rpc('create_refund_request', {
      input_invoice_ref: invoiceRef,
      input_reason_category: reason,
      input_details: details,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row) throw new Error('REFUND_REQUEST_NO_OUTCOME');
    if (row.outcome !== 'created' || !row.request_id || !row.reference) {
      return refusal(OUTCOME_CODE[row.outcome] ?? 'UNAVAILABLE');
    }
    requestId = row.request_id;
    reference = row.reference;
  } catch {
    record('refund_request_failed', 'CREATE');
    return { ok: false, code: 'UNAVAILABLE', message: MESSAGE.UNAVAILABLE };
  }

  let attachmentWarning: string | undefined;
  const file = formData.get('attachment');
  if (file instanceof File && file.size > 0) {
    const stored = await storeSupportAttachment({
      file,
      uploaderId: user.id,
      refundRequestId: requestId,
    });
    if (!stored.ok) {
      attachmentWarning = 'บันทึกคำขอเรียบร้อยแล้ว แต่แนบรูปไม่สำเร็จ คุณแนบใหม่ได้ในหน้าคำขอนี้';
    }
  }

  const observedAt = new Date().toISOString();
  await notifyAccount(user.id, refundRequestSubmittedNotification({ requestId, reference, observedAt }));

  // The operator alert carries a reference and an amount, never a name or a
  // mailbox — an Inbox item can end up on a lock screen.
  const amountMinor = await requestAmountMinor(client, requestId);
  await notifyAdmins(adminRefundRequestCreatedNotification({
    requestId,
    reference,
    amountBaht: amountMinor === null ? null : Number(displayBaht(amountMinor, 'thb')?.replace(/,/g, '') ?? 0),
    observedAt,
  }));

  record('refund_request_created', reason);
  revalidatePath('/settings/refunds');
  revalidatePath('/settings/subscription');
  revalidatePath('/admin/refunds');
  return { ok: true, requestId, reference, attachmentWarning };
}

async function requestAmountMinor(
  client: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  requestId: string,
): Promise<number | null> {
  try {
    const { data } = await client
      .from('refund_requests')
      .select('amount_minor')
      .eq('id', requestId)
      .maybeSingle();
    return data?.amount_minor ?? null;
  } catch {
    return null;
  }
}

export async function cancelRefundRequestAction(formData: FormData): Promise<RefundActionResult> {
  const client = await createClient();
  if (!client) return refusal('UNAVAILABLE');

  const requestId = String(formData.get('requestId') ?? '');
  try {
    const { data, error } = await client.rpc('cancel_my_refund_request', {
      input_request_id: requestId,
    });
    if (error) throw error;
    if (data !== 'canceled') return refusal(OUTCOME_CODE[String(data)] ?? 'UNAVAILABLE');
  } catch {
    record('refund_request_failed', 'CANCEL');
    return { ok: false, code: 'UNAVAILABLE', message: MESSAGE.UNAVAILABLE };
  }

  record('refund_request_canceled');
  revalidatePath('/settings/refunds');
  revalidatePath(`/settings/refunds/${requestId}`);
  revalidatePath('/admin/refunds');
  return { ok: true };
}

export async function replyToRefundRequestAction(formData: FormData): Promise<RefundActionResult> {
  const client = await createClient();
  if (!client) return refusal('UNAVAILABLE');

  const requestId = String(formData.get('requestId') ?? '');
  const body = String(formData.get('body') ?? '');
  try {
    const { data, error } = await client.rpc('reply_to_my_refund_request', {
      input_request_id: requestId,
      input_body: body,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row || row.outcome !== 'replied') {
      return refusal(OUTCOME_CODE[row?.outcome ?? ''] ?? 'UNAVAILABLE');
    }
  } catch {
    record('refund_request_failed', 'REPLY');
    return { ok: false, code: 'UNAVAILABLE', message: MESSAGE.UNAVAILABLE };
  }

  record('refund_request_replied');
  revalidatePath(`/settings/refunds/${requestId}`);
  revalidatePath(`/admin/refunds/${requestId}`);
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Operator
 * ---------------------------------------------------------------------- */

/**
 * An operator answering a refund thread.
 *
 * `requireAdmin()` runs before anything is read from the form. A server action
 * is reachable by its identifier alone — it does not run under the layout of the
 * page that renders its form, and this file lives outside `/admin`, so neither
 * the console's gate nor the middleware filter is between a caller and this
 * function. Without this line the database would be the only thing standing
 * between any signed-in reader and a reply written in an operator's name.
 */
export async function adminReplyToRefundRequestAction(formData: FormData): Promise<RefundActionResult> {
  const client = await createClient();
  if (!client) return refusal('UNAVAILABLE');

  try {
    await requireAdmin();
  } catch (cause) {
    return refusal(isAdminRequiredError(cause) ? 'FORBIDDEN' : 'UNAVAILABLE');
  }

  const requestId = String(formData.get('requestId') ?? '');
  const body = String(formData.get('body') ?? '');
  const internal = formData.get('internal') === 'on' || formData.get('internal') === 'true';

  let messageId: string | null = null;
  try {
    const { data, error } = await client.rpc('admin_reply_refund_request', {
      input_request_id: requestId,
      input_body: body,
      input_internal: internal,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row || (row.outcome !== 'replied' && row.outcome !== 'noted')) {
      return refusal(OUTCOME_CODE[row?.outcome ?? ''] ?? 'UNAVAILABLE');
    }
    messageId = row.message_id;
  } catch {
    record('refund_request_failed', 'ADMIN_REPLY');
    return { ok: false, code: 'UNAVAILABLE', message: MESSAGE.UNAVAILABLE };
  }

  if (!internal && messageId) {
    const recipient = await refundRecipient(client, requestId);
    if (recipient) {
      await notifyAccount(recipient.userId, supportTicketReplyNotification({
        // A refund thread reuses the reply notice; the href points at the refund
        // page, which is what the reader needs to open.
        ticketId: requestId,
        reference: recipient.reference,
        messageId,
        observedAt: new Date().toISOString(),
      }));
    }
  }

  revalidatePath(`/admin/refunds/${requestId}`);
  revalidatePath(`/settings/refunds/${requestId}`);
  return { ok: true };
}

/**
 * Move a request along.
 *
 * `refunded` is the only transition that claims money moved, and the routine
 * refuses it without a completion reference — the provider's own record of the
 * refund an operator performed there. This action does not, and must not, call
 * the provider to create one.
 */
export async function adminSetRefundStatusAction(formData: FormData): Promise<RefundActionResult> {
  const client = await createClient();
  if (!client) return refusal('UNAVAILABLE');

  /*
   * Authorization first, then the bound — in that order, so a non-operator's
   * burst is refused rather than being allowed to spend an operator bucket. This
   * is the action that claims money moved; it is the last one that should be
   * reachable by anybody the database has not already called an operator.
   */
  try {
    await requireAdmin();
  } catch (cause) {
    return refusal(isAdminRequiredError(cause) ? 'FORBIDDEN' : 'UNAVAILABLE');
  }

  /*
   * Same bound as the ticket console, for the same reason: the routine below
   * decides *whether* an operator may move a refund, and this decides how fast.
   * It deliberately sits above the transition graph, so a refused burst never
   * reaches the routine that claims money moved.
   */
  const { data: { user } } = await client.auth.getUser();
  const bound = await consumeRateLimit(client, {
    scope: 'admin.mutation',
    userId: user?.id ?? null,
    clientAddress: await resolveClientAddress(),
  });
  if (!bound.allowed) {
    return { ok: false, code: 'RATE_LIMITED', message: rateLimitMessage(bound.retryAfterSeconds) };
  }

  const requestId = String(formData.get('requestId') ?? '');
  const status = String(formData.get('status') ?? '') as RefundRequestStatus;
  const completionReference = String(formData.get('completionReference') ?? '').trim() || null;

  try {
    const { data, error } = await client.rpc('admin_set_refund_request_status', {
      input_request_id: requestId,
      input_status: status as 'reviewing' | 'approved' | 'rejected' | 'refunded',
      input_completion_reference: completionReference,
    });
    if (error) throw error;
    if (data !== 'updated' && data !== 'unchanged') {
      return refusal(OUTCOME_CODE[String(data)] ?? 'UNAVAILABLE');
    }
    if (data === 'updated') {
      const recipient = await refundRecipient(client, requestId);
      if (recipient) {
        const observedAt = new Date().toISOString();
        await notifyAccount(
          recipient.userId,
          status === 'refunded'
            ? refundCompletedNotification({ requestId, reference: recipient.reference, observedAt })
            : refundRequestStatusNotification({
              requestId,
              reference: recipient.reference,
              status,
              observedAt,
            }),
        );
      }
    }
  } catch {
    record('refund_request_failed', 'ADMIN_STATUS');
    return { ok: false, code: 'UNAVAILABLE', message: MESSAGE.UNAVAILABLE };
  }

  record('refund_request_decided', status);
  revalidatePath(`/admin/refunds/${requestId}`);
  revalidatePath('/admin/refunds');
  revalidatePath(`/settings/refunds/${requestId}`);
  revalidatePath('/settings/refunds');
  return { ok: true };
}

async function refundRecipient(
  client: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  requestId: string,
): Promise<{ userId: string; reference: string } | null> {
  try {
    const { data, error } = await client
      .from('refund_requests')
      .select('user_id, reference')
      .eq('id', requestId)
      .maybeSingle();
    if (error || !data) return null;
    return { userId: data.user_id, reference: data.reference };
  } catch {
    return null;
  }
}
