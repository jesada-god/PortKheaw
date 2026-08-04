'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/src/lib/supabase/server';
import { signAttachmentUrl, storeSupportAttachment } from '@/src/lib/support/attachments';
import {
  supportTicketReceivedNotification,
  supportTicketReplyNotification,
  adminTicketCreatedNotification,
} from '@/src/lib/notifications/account-events';
import { notifyAccount, notifyAdmins } from '@/src/lib/notifications/dispatch';
import { SUPPORT_CATEGORY_LABEL } from '@/src/lib/support/presentation';
import type { SupportTicketCategory } from '@/src/types/database';

/**
 * Filing and answering a support ticket.
 *
 * What a caller may send is a category from a closed list, a subject, a body and
 * optionally one image. Not a user id, not a status, not a tier, not a
 * timestamp, not a ticket reference — every one of those is written by the
 * database routine from `auth.uid()` and its own clock. That is the whole
 * security story for this file: the request surface is too narrow to carry a
 * lie, and the parts that matter are not in it.
 *
 * Rate limiting is likewise the database's, not this file's. A limit enforced in
 * a server action is a limit that disappears the moment somebody finds a second
 * way in; enforced in the routine, it holds for every caller.
 */

export type SupportFailureCode =
  | 'UNAUTHENTICATED'
  | 'UNAVAILABLE'
  | 'INVALID_CATEGORY'
  | 'INVALID_CONTENT'
  | 'RATE_LIMITED'
  | 'TOO_SOON'
  | 'NOT_FOUND'
  | 'CLOSED'
  | 'ATTACHMENT_REJECTED';

export type CreateTicketResult =
  | { ok: true; ticketId: string; reference: string; attachmentWarning?: string }
  | { ok: false; code: SupportFailureCode; message: string };

export type ReplyResult =
  | { ok: true }
  | { ok: false; code: SupportFailureCode; message: string };

const MESSAGE: Readonly<Record<SupportFailureCode, string>> = {
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบก่อนแจ้งเรื่อง',
  UNAVAILABLE: 'ระบบไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง',
  INVALID_CATEGORY: 'กรุณาเลือกหมวดหมู่ของเรื่องที่ต้องการแจ้ง',
  INVALID_CONTENT: 'กรุณากรอกหัวข้ออย่างน้อย 3 ตัวอักษร และรายละเอียดอย่างน้อย 10 ตัวอักษร',
  RATE_LIMITED: 'คุณแจ้งเรื่องครบจำนวนสูงสุดของวันนี้แล้ว กรุณาลองใหม่ในวันถัดไป หรือติดต่อผ่าน Facebook หรือ LINE',
  TOO_SOON: 'เพิ่งส่งเรื่องไปเมื่อสักครู่ กรุณารอสักครู่แล้วลองอีกครั้ง',
  NOT_FOUND: 'ไม่พบเรื่องที่ต้องการ',
  CLOSED: 'เรื่องนี้ปิดแล้ว หากยังต้องการความช่วยเหลือ กรุณาแจ้งเรื่องใหม่',
  ATTACHMENT_REJECTED: 'แนบไฟล์ไม่สำเร็จ รองรับเฉพาะรูปภาพ PNG, JPG, WebP หรือ GIF ขนาดไม่เกิน 5 MB',
};

const ATTACHMENT_WARNING =
  'บันทึกเรื่องเรียบร้อยแล้ว แต่แนบรูปไม่สำเร็จ (รองรับ PNG, JPG, WebP, GIF ไม่เกิน 5 MB) คุณแนบใหม่ได้ในหน้าเรื่องนี้';

type TicketAudit =
  | 'support_ticket_created'
  | 'support_ticket_refused'
  | 'support_ticket_replied'
  | 'support_ticket_failed'
  | 'support_attachment_rejected';

/**
 * Structured and sanitized by construction: an event name and a code. No
 * account identifier, no mailbox, and never the reader's own words — a support
 * body is exactly the kind of text that contains something personal.
 */
function record(event: TicketAudit, detail?: string) {
  const payload = JSON.stringify({ event, ...(detail ? { detail } : {}) });
  if (event.endsWith('_failed') || event.endsWith('_refused') || event.endsWith('_rejected')) {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}

function refusal(code: SupportFailureCode) {
  record('support_ticket_refused', code);
  return { ok: false as const, code, message: MESSAGE[code] };
}

/** Outcome strings the routines return, mapped onto the codes above. */
const OUTCOME_CODE: Readonly<Record<string, SupportFailureCode>> = {
  invalid_category: 'INVALID_CATEGORY',
  invalid_content: 'INVALID_CONTENT',
  rate_limited: 'RATE_LIMITED',
  too_soon: 'TOO_SOON',
  not_found: 'NOT_FOUND',
  closed: 'CLOSED',
};

export async function createSupportTicketAction(formData: FormData): Promise<CreateTicketResult> {
  const client = await createClient();
  if (!client) return refusal('UNAVAILABLE');

  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) return refusal('UNAUTHENTICATED');

  const category = String(formData.get('category') ?? '') as SupportTicketCategory;
  const subject = String(formData.get('subject') ?? '');
  const description = String(formData.get('description') ?? '');

  let ticketId: string;
  let reference: string;
  try {
    const { data, error } = await client.rpc('create_support_ticket', {
      input_category: category,
      input_subject: subject,
      input_description: description,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row) throw new Error('SUPPORT_TICKET_NO_OUTCOME');
    if (row.outcome !== 'created' || !row.ticket_id || !row.reference) {
      return refusal(OUTCOME_CODE[row.outcome] ?? 'UNAVAILABLE');
    }
    ticketId = row.ticket_id;
    reference = row.reference;
  } catch {
    record('support_ticket_failed', 'CREATE');
    return { ok: false, code: 'UNAVAILABLE', message: MESSAGE.UNAVAILABLE };
  }

  /*
   * The attachment is optional and, once the ticket exists, non-fatal. A reader
   * who wrote a page of detail should not lose it because their screenshot was
   * a HEIC — the ticket is saved, and the failure is reported so they can try
   * again from the thread.
   */
  let attachmentWarning: string | undefined;
  const file = formData.get('attachment');
  if (file instanceof File && file.size > 0) {
    const stored = await storeSupportAttachment({ file, uploaderId: user.id, ticketId });
    if (!stored.ok) {
      record('support_attachment_rejected', stored.reason);
      attachmentWarning = ATTACHMENT_WARNING;
    }
  }

  const observedAt = new Date().toISOString();
  await notifyAccount(user.id, supportTicketReceivedNotification({ ticketId, reference, observedAt }));
  await notifyAdmins(adminTicketCreatedNotification({
    ticketId,
    reference,
    category: SUPPORT_CATEGORY_LABEL[category] ?? category,
    // The tier the routine snapshotted is not returned to this caller, and it is
    // not worth a second round trip: the console shows it beside the ticket.
    tierSnapshot: '—',
    observedAt,
  }));

  record('support_ticket_created', category);
  revalidatePath('/support');
  revalidatePath('/admin/support');
  return { ok: true, ticketId, reference, attachmentWarning };
}

export async function replyToTicketAction(formData: FormData): Promise<ReplyResult> {
  const client = await createClient();
  if (!client) return refusal('UNAVAILABLE');

  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) return refusal('UNAUTHENTICATED');

  const ticketId = String(formData.get('ticketId') ?? '');
  const body = String(formData.get('body') ?? '');

  try {
    const { data, error } = await client.rpc('reply_to_my_support_ticket', {
      input_ticket_id: ticketId,
      input_body: body,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row || row.outcome !== 'replied') {
      return refusal(OUTCOME_CODE[row?.outcome ?? ''] ?? 'UNAVAILABLE');
    }
  } catch {
    record('support_ticket_failed', 'REPLY');
    return { ok: false, code: 'UNAVAILABLE', message: MESSAGE.UNAVAILABLE };
  }

  const file = formData.get('attachment');
  if (file instanceof File && file.size > 0) {
    const stored = await storeSupportAttachment({ file, uploaderId: user.id, ticketId });
    if (!stored.ok) record('support_attachment_rejected', stored.reason);
  }

  record('support_ticket_replied');
  revalidatePath(`/support/tickets/${ticketId}`);
  revalidatePath('/admin/support');
  return { ok: true };
}

/**
 * An operator answering, or writing a private note.
 *
 * `internal` is accepted from the form because an operator genuinely chooses it,
 * and the routine refuses the whole call unless the caller's stored role is
 * `admin`. A note never notifies the reader and never moves the visible status —
 * that branch is in the routine, not here.
 */
export async function adminReplyToTicketAction(formData: FormData): Promise<ReplyResult> {
  const client = await createClient();
  if (!client) return refusal('UNAVAILABLE');

  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) return refusal('UNAUTHENTICATED');

  const ticketId = String(formData.get('ticketId') ?? '');
  const body = String(formData.get('body') ?? '');
  const internal = formData.get('internal') === 'on' || formData.get('internal') === 'true';

  let messageId: string | null = null;
  try {
    const { data, error } = await client.rpc('admin_reply_support_ticket', {
      input_ticket_id: ticketId,
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
    record('support_ticket_failed', 'ADMIN_REPLY');
    return { ok: false, code: 'UNAVAILABLE', message: MESSAGE.UNAVAILABLE };
  }

  if (!internal && messageId) await notifyTicketOwner(ticketId, messageId);

  record('support_ticket_replied', internal ? 'internal' : 'public');
  revalidatePath(`/admin/support/${ticketId}`);
  revalidatePath(`/support/tickets/${ticketId}`);
  return { ok: true };
}

export async function adminSetTicketStatusAction(formData: FormData): Promise<ReplyResult> {
  const client = await createClient();
  if (!client) return refusal('UNAVAILABLE');

  const ticketId = String(formData.get('ticketId') ?? '');
  const status = String(formData.get('status') ?? '');

  try {
    const { data, error } = await client.rpc('admin_set_support_ticket_status', {
      input_ticket_id: ticketId,
      input_status: status as 'open' | 'in_progress' | 'waiting_user' | 'resolved' | 'closed',
    });
    if (error) throw error;
    if (data !== 'updated' && data !== 'unchanged') {
      return refusal(OUTCOME_CODE[String(data)] ?? 'UNAVAILABLE');
    }
    if (data === 'updated') await notifyTicketOwnerOfStatus(ticketId, status);
  } catch {
    record('support_ticket_failed', 'ADMIN_STATUS');
    return { ok: false, code: 'UNAVAILABLE', message: MESSAGE.UNAVAILABLE };
  }

  revalidatePath(`/admin/support/${ticketId}`);
  revalidatePath(`/support/tickets/${ticketId}`);
  return { ok: true };
}

/**
 * Look up who to tell.
 *
 * Uses the operator's own session, which the ticket policy admits, so this
 * cannot become a way to read a ticket the caller could not already read. A
 * lookup that fails costs a notification, never the reply itself.
 */
async function ticketRecipient(ticketId: string): Promise<{ userId: string; reference: string } | null> {
  try {
    const client = await createClient();
    if (!client) return null;
    const { data, error } = await client
      .from('support_tickets')
      .select('user_id, reference')
      .eq('id', ticketId)
      .maybeSingle();
    if (error || !data) return null;
    return { userId: data.user_id, reference: data.reference };
  } catch {
    return null;
  }
}

async function notifyTicketOwner(ticketId: string, messageId: string): Promise<void> {
  const recipient = await ticketRecipient(ticketId);
  if (!recipient) return;
  await notifyAccount(recipient.userId, supportTicketReplyNotification({
    ticketId,
    reference: recipient.reference,
    messageId,
    observedAt: new Date().toISOString(),
  }));
}

/**
 * A short-lived URL for one attachment the caller is allowed to see.
 *
 * Authorization is the `support_attachments` policy, not a check in this file:
 * the row is read through the caller's own session, and the policy admits only
 * the owner of the thread or an operator. A caller who is neither reads nothing,
 * so there is no path from an attachment id to somebody else's screenshot.
 *
 * The path is looked up rather than accepted, so this cannot be pointed at an
 * arbitrary object in the bucket.
 */
export async function getAttachmentUrlAction(attachmentId: string): Promise<string | null> {
  try {
    const client = await createClient();
    if (!client) return null;
    const { data: { user } } = await client.auth.getUser();
    if (!user) return null;

    const { data, error } = await client
      .from('support_attachments')
      .select('storage_path')
      .eq('id', attachmentId)
      .maybeSingle();
    if (error || !data) return null;
    return await signAttachmentUrl(data.storage_path);
  } catch {
    record('support_ticket_failed', 'ATTACHMENT_URL');
    return null;
  }
}

async function notifyTicketOwnerOfStatus(ticketId: string, status: string): Promise<void> {
  const recipient = await ticketRecipient(ticketId);
  if (!recipient) return;
  const { supportTicketStatusNotification } = await import('@/src/lib/notifications/account-events');
  await notifyAccount(recipient.userId, supportTicketStatusNotification({
    ticketId,
    reference: recipient.reference,
    status,
    observedAt: new Date().toISOString(),
  }));
}
