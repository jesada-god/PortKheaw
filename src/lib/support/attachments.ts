import 'server-only';

import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/src/lib/supabase/admin';
import type { SupportAttachmentMimeType } from '@/src/types/database';

/**
 * Screenshots, kept private.
 *
 * The whole design is one decision: **the browser never holds a storage
 * credential.** The file arrives in a server action, is validated here, is
 * written to a non-public bucket with the service role, and is read back only
 * through a signed URL minted for somebody the database agrees owns the thread.
 * There is no policy on `storage.objects` granting `anon` or `authenticated`
 * anything, so there is no path from a session to the bucket at all.
 *
 * That costs one upload round trip through our server and buys three things: the
 * type and size are checked before a byte is stored rather than after, the path
 * cannot be chosen by the client, and revoking access to an old attachment is
 * just declining to mint the next URL.
 */

export const SUPPORT_ATTACHMENT_BUCKET = 'support-attachments';

/** Five megabytes. A screenshot of a bug, not a video of one. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Images only, and only these four.
 *
 * An allowlist rather than a blocklist, and no SVG: SVG is a document that can
 * carry script, and it would be served back from a URL we minted. The same list
 * is a check constraint on the table, so a bug here cannot widen it.
 */
const ALLOWED: Readonly<Record<string, { mime: SupportAttachmentMimeType; extension: string }>> = {
  'image/png': { mime: 'image/png', extension: 'png' },
  'image/jpeg': { mime: 'image/jpeg', extension: 'jpg' },
  'image/webp': { mime: 'image/webp', extension: 'webp' },
  'image/gif': { mime: 'image/gif', extension: 'gif' },
};

export type AttachmentRejection =
  | 'unsupported_type'
  | 'too_large'
  | 'empty'
  | 'storage_unavailable'
  | 'upload_failed'
  | 'not_recorded';

export type AttachmentResult =
  | { ok: true; attachmentId: string; storagePath: string }
  | { ok: false; reason: AttachmentRejection };

export interface AttachmentUploadInput {
  file: File;
  uploaderId: string;
  /** Exactly one of these. The routine refuses both or neither. */
  ticketId?: string | null;
  refundRequestId?: string | null;
}

/**
 * Validate, store, record.
 *
 * The path is `<uploader>/<thread>/<random>.<ext>` — derived entirely on the
 * server. A client-supplied filename never reaches the bucket, which removes
 * path traversal and collision as things to reason about, and keeps the original
 * name (which readers sometimes put personal details in) out of storage.
 */
export async function storeSupportAttachment(
  input: AttachmentUploadInput,
): Promise<AttachmentResult> {
  const { file } = input;
  if (!file || file.size === 0) return { ok: false, reason: 'empty' };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'too_large' };

  const allowed = ALLOWED[file.type];
  if (!allowed) return { ok: false, reason: 'unsupported_type' };

  const admin = createAdminClient();
  if (!admin) return { ok: false, reason: 'storage_unavailable' };

  const thread = input.ticketId ?? input.refundRequestId;
  if (!thread || (input.ticketId && input.refundRequestId)) {
    return { ok: false, reason: 'not_recorded' };
  }

  const storagePath = `${input.uploaderId}/${thread}/${randomUUID()}.${allowed.extension}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const upload = await admin.storage
    .from(SUPPORT_ATTACHMENT_BUCKET)
    .upload(storagePath, bytes, {
      contentType: allowed.mime,
      // Never overwrite. A colliding random path is a bug worth failing on, not
      // one worth silently replacing somebody's evidence over.
      upsert: false,
    });
  if (upload.error) return { ok: false, reason: 'upload_failed' };

  const { data, error } = await admin.rpc('record_support_attachment', {
    input_ticket_id: input.ticketId ?? null,
    input_refund_request_id: input.refundRequestId ?? null,
    input_uploaded_by: input.uploaderId,
    input_storage_bucket: SUPPORT_ATTACHMENT_BUCKET,
    input_storage_path: storagePath,
    input_mime_type: allowed.mime,
    input_size_bytes: file.size,
  });

  const row = data?.[0];
  if (error || !row || row.outcome !== 'recorded' || !row.attachment_id) {
    /*
     * The routine re-checks ownership, so this is also where "you attached a
     * file to somebody else's ticket" lands. An object we could not record is
     * unreachable and unattributable, so it is removed rather than left behind.
     */
    await admin.storage.from(SUPPORT_ATTACHMENT_BUCKET).remove([storagePath]).catch(() => undefined);
    return { ok: false, reason: 'not_recorded' };
  }

  return { ok: true, attachmentId: row.attachment_id, storagePath };
}

/** How long a view link lives. Long enough to open, short enough to not share. */
export const ATTACHMENT_URL_TTL_SECONDS = 300;

/**
 * A short-lived URL for one attachment.
 *
 * Callers must have already established that the requester owns the thread or is
 * an operator — this function mints, it does not authorize. It is deliberately
 * given only a path, so it cannot be turned into a "list everybody's
 * attachments" helper by a later caller.
 */
export async function signAttachmentUrl(storagePath: string): Promise<string | null> {
  const admin = createAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.storage
    .from(SUPPORT_ATTACHMENT_BUCKET)
    .createSignedUrl(storagePath, ATTACHMENT_URL_TTL_SECONDS);
  if (error) return null;
  return data?.signedUrl ?? null;
}
