'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/src/lib/supabase/server';
import { requireAdmin, isAdminRequiredError } from '@/src/lib/subscription/account-access';
import { resolveRequestId } from '@/src/lib/monitoring/request-id';
import { captureServerError } from '@/src/lib/monitoring/report';
import {
  consumeRateLimit, rateLimitMessage, resolveClientAddress,
} from '@/src/lib/security/rate-limit';
import {
  normalizeReleaseImportance, RELEASE_OUTCOME_MESSAGE, RELEASE_PROBLEM_MESSAGE,
  validateReleaseDraft,
} from '@/src/lib/release-notes/release-notes';

/**
 * The operator mutations for maintenance and announcements.
 *
 * Same five steps as the rollout console, in the same order, for the same
 * reasons: authorize against the *stored* role, bound with the shared limiter,
 * validate what the form sent against the rules the database also enforces,
 * mutate through a `security definer` routine that writes its own audit row in
 * the same transaction, and report an outcome an operator can act on.
 *
 * The two concerns stay unlinked on purpose. Switching the product back on and
 * writing the announcement about it are separate transactions, so a release note
 * that fails to save can never be the reason the product stays down.
 */

export type SystemActionResult =
  | { ok: true; message: string; releaseId?: string }
  | { ok: false; message: string };

/**
 * A maintenance mutation reports the state it *left the switch in*, not just
 * that it worked. The console renders from this rather than waiting for the
 * revalidated page to come back, so the status chip can never sit on a stale
 * value after a successful toggle.
 */
export type MaintenanceActionResult =
  | { ok: true; message: string; enabled: boolean }
  | { ok: false; message: string };

const UNAVAILABLE = 'ทำรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
const FORBIDDEN = 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้';
const CONFIRMATION_REQUIRED = 'กรุณายืนยันก่อนเปลี่ยนสถานะการให้บริการ';

/*
 * `unchanged` deliberately has no entry here.
 *
 * It used to read "สถานะไม่มีการเปลี่ยนแปลง", which is the least useful thing
 * this control can say: it is the same sentence whether the operator asked for
 * something that was already true or the request never carried what they
 * pressed. The message is built from the *resulting state* instead, so it always
 * names where the switch actually ended up.
 */
const MAINTENANCE_MESSAGE: Readonly<Record<'enabled' | 'disabled', string>> = {
  enabled: 'ปิดใช้งานสำหรับผู้ใช้ทั่วไปแล้ว บัญชี Admin ยังเข้าใช้งานได้',
  disabled: 'เปิดใช้งานแอปเรียบร้อยแล้ว ผู้ใช้เข้าใช้งานได้ทันที',
};

const ALREADY_MESSAGE: Readonly<Record<'on' | 'off', string>> = {
  on: 'ระบบอยู่ในสถานะปิดปรับปรุงอยู่แล้ว (ข้อความและเวลาไม่มีการเปลี่ยนแปลง)',
  off: 'แอปเปิดใช้งานอยู่แล้ว ผู้ใช้เข้าใช้งานได้ตามปกติ',
};

async function authorizeAndBound(): Promise<
  | { ok: true; client: NonNullable<Awaited<ReturnType<typeof createClient>>>; requestId: string }
  | { ok: false; message: string }
> {
  try {
    await requireAdmin();
  } catch (cause) {
    return { ok: false, message: isAdminRequiredError(cause) ? FORBIDDEN : UNAVAILABLE };
  }

  const client = await createClient();
  if (!client) return { ok: false, message: UNAVAILABLE };

  const { data: { user } } = await client.auth.getUser();
  const limit = await consumeRateLimit(client, {
    scope: 'admin.mutation',
    userId: user?.id ?? null,
    clientAddress: await resolveClientAddress(),
  });
  if (!limit.allowed) return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };

  return { ok: true, client, requestId: await resolveRequestId() };
}

/**
 * A `datetime-local` value carries no zone. Operators enter Bangkok time, so it
 * is read as Bangkok time — reading it as UTC would tell every reader the site
 * comes back seven hours later than it does.
 */
function parseBangkokLocal(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(trimmed)) return null;
  const withSeconds = trimmed.length === 16 ? `${trimmed}:00` : trimmed;
  const parsed = Date.parse(`${withSeconds}+07:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Switch the product off for ordinary readers, or back on. */
export async function setMaintenanceAction(formData: FormData): Promise<MaintenanceActionResult> {
  const gate = await authorizeAndBound();
  if (!gate.ok) return gate;

  /*
   * Checked on the server, not only in the dialog. The control that takes a
   * product away from everybody who paid for it must not be reachable by a stray
   * submit, and a browser confirmation is not a check.
   */
  if (formData.get('confirm') !== 'yes') {
    return { ok: false, message: CONFIRMATION_REQUIRED };
  }

  const enabled = formData.get('enabled') === 'true';
  const message = String(formData.get('message') ?? '').trim().slice(0, 500);
  const resumeAt = parseBangkokLocal(String(formData.get('expectedResumeAt') ?? ''));

  try {
    const { data, error } = await gate.client.rpc('admin_set_maintenance', {
      input_enabled: enabled,
      input_message: message || null,
      input_expected_resume_at: resumeAt,
      input_request_id: gate.requestId,
    });
    if (error) throw error;
    const outcome = String(data);
    // The console reads the switch on every render, so both surfaces that show
    // it have to drop their cached copy the moment it moves.
    revalidatePath('/admin');
    revalidatePath('/admin/system');
    revalidatePath('/maintenance');

    /*
     * The routine returns `unchanged` only when the stored row already matched
     * every field of the request — so for that outcome the resulting state *is*
     * the requested one. Anything outside these three words is a refusal, and is
     * never reported as success.
     */
    if (outcome === 'enabled') return { ok: true, enabled: true, message: MAINTENANCE_MESSAGE.enabled };
    if (outcome === 'disabled') return { ok: true, enabled: false, message: MAINTENANCE_MESSAGE.disabled };
    if (outcome === 'unchanged') {
      return { ok: true, enabled, message: ALREADY_MESSAGE[enabled ? 'on' : 'off'] };
    }
    return { ok: false, message: UNAVAILABLE };
  } catch (cause) {
    captureServerError({
      scope: 'admin.maintenance',
      cause,
      context: { operation: enabled ? 'enable' : 'disable', requestId: gate.requestId },
    });
    return { ok: false, message: isAdminRequiredError(cause) ? FORBIDDEN : UNAVAILABLE };
  }
}

/**
 * Create, edit, publish or unpublish one release note.
 *
 * `publish` is tri-state and arrives as a string, because "save this edit" must
 * not silently publish a draft and "publish" must not be the only way to save.
 */
export async function saveReleaseNoteAction(formData: FormData): Promise<SystemActionResult> {
  const gate = await authorizeAndBound();
  if (!gate.ok) return gate;

  const rawId = String(formData.get('id') ?? '').trim();
  if (rawId && !/^[0-9a-f-]{36}$/i.test(rawId)) return { ok: false, message: UNAVAILABLE };

  const draft = {
    version: String(formData.get('version') ?? ''),
    title: String(formData.get('title') ?? ''),
    content: String(formData.get('content') ?? ''),
    importance: normalizeReleaseImportance(formData.get('importance')),
  };
  const problem = validateReleaseDraft(draft);
  if (problem) return { ok: false, message: RELEASE_PROBLEM_MESSAGE[problem] };

  const publishValue = String(formData.get('publish') ?? '');
  const publish = publishValue === 'true' ? true : publishValue === 'false' ? false : null;

  try {
    const { data, error } = await gate.client.rpc('admin_save_release_note', {
      input_id: rawId || null,
      input_version: draft.version.trim() || null,
      input_title: draft.title.trim(),
      input_content: draft.content.trim(),
      input_importance: draft.importance,
      input_publish: publish,
      input_request_id: gate.requestId,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row) return { ok: false, message: UNAVAILABLE };

    const failed = row.outcome === 'not_found'
      || row.outcome === 'invalid_title'
      || row.outcome === 'invalid_content';
    if (failed) return { ok: false, message: RELEASE_OUTCOME_MESSAGE[row.outcome] ?? UNAVAILABLE };

    revalidatePath('/admin/system');
    // Every signed-in reader resolves the announcement from the root layout, so
    // a publish has to invalidate the whole tree, not one route.
    revalidatePath('/', 'layout');
    return {
      ok: true,
      message: RELEASE_OUTCOME_MESSAGE[row.outcome] ?? 'บันทึกแล้ว',
      releaseId: row.release_id ?? undefined,
    };
  } catch (cause) {
    captureServerError({
      scope: 'admin.release-note',
      cause,
      context: { operation: rawId ? 'update' : 'create', requestId: gate.requestId },
    });
    return { ok: false, message: isAdminRequiredError(cause) ? FORBIDDEN : UNAVAILABLE };
  }
}
