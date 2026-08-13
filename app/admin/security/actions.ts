'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/src/lib/supabase/server';
import { isAdminRequiredError } from '@/src/lib/subscription/account-access';
import {
  ASSURANCE_DENIAL_MESSAGE, isAssuranceRequiredError, requireAdminMutation,
} from '@/src/lib/security/admin-assurance-server';
import { isSecurityLockdownError, LOCKDOWN_DENIAL_MESSAGE } from '@/src/lib/security/lockdown-server';
import { resolveRequestId } from '@/src/lib/monitoring/request-id';
import { captureServerError } from '@/src/lib/monitoring/report';
import {
  consumeRateLimit, rateLimitMessage, resolveClientAddress,
} from '@/src/lib/security/rate-limit';
import { recordSecurityEvent } from '@/src/lib/security/security-audit';

/**
 * The incident switch.
 *
 * Same five steps every operator mutation in this product takes — authorize
 * against the stored role, bound with the shared limiter, validate what the form
 * sent, mutate through a `security definer` routine that writes its own audit row
 * in the same transaction, report an outcome an operator can act on — with one
 * deliberate difference, which is the reason this action does not live in
 * `app/admin/system/actions.ts` beside maintenance.
 *
 * **It names its lockdown class.** `requireAdminMutation()` refuses every
 * operator mutation while the switch is on; this is the one that must not be
 * refused, or the switch could be engaged and never released. That exemption is
 * written here, at the call site, rather than defaulted somewhere — an escape
 * from the incident control should be visible to anybody reading the action that
 * has it.
 *
 * What still stands between a stolen operator session and this switch is the
 * second factor. `requireAdminMutation()` demands `aal2`, which a stolen cookie
 * does not carry and cannot be upgraded to without the device. That is the
 * control here; the lockdown was never going to be it.
 */

export type SecurityLockdownResult =
  | { ok: true; message: string; enabled: boolean }
  | { ok: false; message: string };

const UNAVAILABLE = 'ทำรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
const FORBIDDEN = 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้';
const CONFIRMATION_REQUIRED = 'กรุณายืนยันก่อนเปลี่ยนสถานะล็อกดาวน์ความปลอดภัย';

const LOCKDOWN_MESSAGE: Readonly<Record<'enabled' | 'disabled', string>> = {
  enabled: 'เปิดโหมดล็อกดาวน์แล้ว ระบบปฏิเสธการทำรายการสิทธิ์พิเศษทั้งหมด',
  disabled: 'ปิดโหมดล็อกดาวน์แล้ว การทำรายการของผู้ดูแลระบบกลับมาใช้งานได้ตามปกติ',
};

const ALREADY_MESSAGE: Readonly<Record<'on' | 'off', string>> = {
  on: 'ระบบอยู่ในโหมดล็อกดาวน์อยู่แล้ว (เหตุผลไม่มีการเปลี่ยนแปลง)',
  off: 'ระบบไม่ได้อยู่ในโหมดล็อกดาวน์อยู่แล้ว',
};

export async function setSecurityLockdownAction(
  formData: FormData,
): Promise<SecurityLockdownResult> {
  try {
    // The one mutation in the product that is exempt from the lockdown, named
    // explicitly. See the note above.
    await requireAdminMutation({ lockdownClass: 'security-toggle' });
  } catch (cause) {
    if (isAssuranceRequiredError(cause)) return { ok: false, message: ASSURANCE_DENIAL_MESSAGE };
    if (isSecurityLockdownError(cause)) return { ok: false, message: LOCKDOWN_DENIAL_MESSAGE };
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

  /*
   * Checked on the server, not only in the dialog. A control that refuses every
   * privileged operation in the product must not be reachable by a stray submit,
   * and a browser confirmation is not a check.
   */
  if (formData.get('confirm') !== 'yes') {
    return { ok: false, message: CONFIRMATION_REQUIRED };
  }

  const enabled = formData.get('enabled') === 'true';
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 300);
  const requestId = await resolveRequestId();

  try {
    const { data, error } = await client.rpc('admin_set_security_lockdown', {
      input_enabled: enabled,
      input_reason: reason || null,
      input_request_id: requestId,
    });
    if (error) throw error;
    const outcome = String(data);

    revalidatePath('/admin');
    revalidatePath('/admin/security');

    if (outcome === 'enabled' || outcome === 'disabled') {
      /*
       * The routine has already written its own audit row inside the same
       * transaction as the flag, which is the durable record. This second event
       * is what makes the switch show up in the *detection* stream beside the
       * conditions that probably caused somebody to throw it — an incident is
       * read as one timeline or it is read wrong.
       */
      void recordSecurityEvent({
        event: 'admin.destructive.performed',
        targetRef: `security-lockdown:${outcome}`,
        outcome: 'allowed',
        userId: user?.id ?? null,
      });
    }
    if (outcome === 'enabled') return { ok: true, enabled: true, message: LOCKDOWN_MESSAGE.enabled };
    if (outcome === 'disabled') return { ok: true, enabled: false, message: LOCKDOWN_MESSAGE.disabled };
    /*
     * `unchanged` is returned only when the stored row already matched every
     * field of the request, so for that outcome the resulting state *is* the
     * requested one. Anything outside these three words is a refusal and is
     * never reported as success.
     */
    if (outcome === 'unchanged') {
      return { ok: true, enabled, message: ALREADY_MESSAGE[enabled ? 'on' : 'off'] };
    }
    return { ok: false, message: UNAVAILABLE };
  } catch (cause) {
    captureServerError({
      scope: 'security.lockdown',
      cause,
      context: { operation: enabled ? 'enable' : 'disable', requestId },
    });
    return { ok: false, message: isAdminRequiredError(cause) ? FORBIDDEN : UNAVAILABLE };
  }
}
