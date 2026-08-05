'use server';

import { revalidatePath } from 'next/cache';
import {
  isAdminRequiredError,
  requireAdmin,
  resolveRequestAccountAccess,
  setAdminAccessPreview,
} from '@/src/lib/subscription/account-access';
import { adminPreviewModes, type AdminPreviewMode } from '@/src/lib/subscription/admin-access';
import { SubscriptionRepository } from '@/src/lib/subscription/repository';
/*
 * Shared with the billing webhook on purpose. An access change and a paid-plan
 * change must invalidate exactly the same surfaces, and keeping one definition
 * is what stops the two from drifting apart.
 */
import { revalidateEveryEntitlementSurface } from '@/src/lib/subscription/revalidate-entitlements';
import { createClient } from '@/src/lib/supabase/server';
import { resolveBetaAccessForRequest } from '@/src/lib/beta/beta-server';
import {
  ADMIN_TRIAL_BLOCKED_MESSAGE,
  trialFailureCode,
  trialFailureMessage,
  type TrialFailureCode,
} from '@/src/lib/subscription/trial';

export type StartTrialResult =
  | { ok: true; trialEndsAt: string; message: string }
  | { ok: false; code: TrialFailureCode; message: string };

type AuditEvent =
  | 'trial_started'
  | 'trial_start_failed'
  | 'trial_start_beta_refused'
  | 'admin_access_preview_started'
  | 'admin_access_preview_changed'
  | 'admin_access_preview_cleared'
  | 'admin_access_preview_failed';

/**
 * Surfaces the outcome in the same structured-log shape the rest of the server
 * uses. No identifiers, tokens or account data are logged and no analytics
 * dependency is introduced — the event name and the typed code are the whole
 * record. The preview events name only the mode, which is not personal data.
 */
function record(event: AuditEvent, detail?: string) {
  const payload = JSON.stringify({ event, ...(detail ? { detail } : {}) });
  if (event.endsWith('_failed') || event.endsWith('_refused')) console.warn(payload);
  else console.info(payload);
}

/**
 * Every entitlement surface that reads the subscription. The trial must be
 * visible everywhere the moment it is granted, without the reader signing out.
 */
const ENTITLEMENT_PATHS = ['/settings/subscription', '/settings', '/portfolio', '/tools', '/'] as const;

/**
 * Starts the Elite trial. The action passes no user, tier or timestamp: it
 * calls the trusted RPC, which decides everything from `auth.uid()` and the
 * database clock. Nothing is unlocked optimistically — the caller re-reads the
 * server snapshot after this returns.
 */
export async function startEliteTrialAction(): Promise<StartTrialResult> {
  const client = await createClient();
  if (!client) {
    record('trial_start_failed', 'UNAVAILABLE');
    return { ok: false, code: 'UNAVAILABLE', message: trialFailureMessage('UNAVAILABLE') };
  }

  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) {
    record('trial_start_failed', 'UNAUTHENTICATED');
    return { ok: false, code: 'UNAUTHENTICATED', message: trialFailureMessage('UNAUTHENTICATED') };
  }

  /*
   * An administrator already has the whole product and can simulate a trial
   * without one, so spending the account's single real grant would only destroy
   * a state they may later need to test against. Refused here, before the RPC.
   */
  const access = await resolveRequestAccountAccess();
  if (access.isAdmin) {
    record('trial_start_failed', 'ADMIN_TRIAL_BLOCKED');
    return { ok: false, code: 'UNAVAILABLE', message: ADMIN_TRIAL_BLOCKED_MESSAGE };
  }

  /*
   * The controlled rollout, checked here for the same reason checkout checks it:
   * the trial is a grant of the top plan, so it is a way *in* to the product and
   * the stage that decides who may join has to decide this too. Otherwise the
   * closed door on the plan cards is walked around by taking seven free days of
   * Elite instead.
   *
   * It gates *starting* a trial and nothing else. The database's own rule admits
   * an operator, an account that predates the program and anybody already
   * holding a live subscription — and a trial that has already started is one of
   * those, so a stage change can never cut a running trial short. Reusing
   * `resolveBetaAccessForRequest` is deliberate: the button and this action must
   * read one answer, resolved once per request, from the routine the database
   * decides with.
   */
  const beta = await resolveBetaAccessForRequest();
  if (!beta.admitted) {
    record('trial_start_beta_refused', beta.reason);
    return {
      ok: false,
      code: 'BETA_NOT_ADMITTED',
      message: trialFailureMessage('BETA_NOT_ADMITTED'),
    };
  }

  try {
    const grant = await new SubscriptionRepository(client).startEliteTrial();
    for (const path of ENTITLEMENT_PATHS) revalidatePath(path);
    record('trial_started');
    return {
      ok: true,
      trialEndsAt: grant.trialEndsAt ?? '',
      message: 'เริ่มทดลอง Elite แล้ว ใช้งานได้ทันที 7 วัน',
    };
  } catch (error) {
    const code = trialFailureCode(error);
    record('trial_start_failed', code);
    return { ok: false, code, message: trialFailureMessage(code) };
  }
}

export type AdminPreviewFailureCode = 'ADMIN_REQUIRED' | 'INVALID_MODE' | 'UNAVAILABLE';

export type AdminPreviewResult =
  | { ok: true; mode: AdminPreviewMode; expiresAt: string | null; message: string }
  | { ok: false; code: AdminPreviewFailureCode; message: string };

const ADMIN_PREVIEW_FAILURE_MESSAGE: Record<AdminPreviewFailureCode, string> = {
  ADMIN_REQUIRED: 'บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ จึงจำลองสิทธิ์ไม่ได้',
  INVALID_MODE: 'โหมดทดสอบไม่ถูกต้อง กรุณาเลือกใหม่อีกครั้ง',
  UNAVAILABLE: 'เปลี่ยนโหมดทดสอบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
};

const ADMIN_PREVIEW_SUCCESS_MESSAGE: Record<AdminPreviewMode, string> = {
  actual: 'กลับสู่สิทธิ์จริงแล้ว',
  basic: 'กำลังจำลองสิทธิ์ Basic',
  pro: 'กำลังจำลองสิทธิ์ Pro',
  elite: 'กำลังจำลองสิทธิ์ Elite',
  elite_trial: 'กำลังจำลองสิทธิ์ Elite Trial',
  expired_trial: 'กำลังจำลองสถานะ Trial หมดอายุ',
};

/**
 * Start, change or end an access preview.
 *
 * The mode is the only input, and it is checked against the same allowlist the
 * database checks. Authorization is not decided here: `requireAdmin()` reads the
 * stored role from the trusted resolver, and the RPC then refuses a second time
 * inside the database. A caller who reaches this action with a forged payload
 * therefore still has to be an administrator for anything to happen.
 *
 * No subscription, billing or trial field is read or written on any path.
 */
export async function setAdminAccessPreviewAction(mode: AdminPreviewMode): Promise<AdminPreviewResult> {
  if (!adminPreviewModes.includes(mode)) {
    record('admin_access_preview_failed', 'INVALID_MODE');
    return { ok: false, code: 'INVALID_MODE', message: ADMIN_PREVIEW_FAILURE_MESSAGE.INVALID_MODE };
  }

  try {
    const before = await requireAdmin();
    const grant = await setAdminAccessPreview(mode);
    revalidateEveryEntitlementSurface();

    record(
      grant.mode === 'actual'
        ? 'admin_access_preview_cleared'
        : before.adminPreviewMode === 'actual'
          ? 'admin_access_preview_started'
          : 'admin_access_preview_changed',
      grant.mode,
    );

    return {
      ok: true,
      mode: grant.mode,
      expiresAt: grant.expiresAt,
      message: ADMIN_PREVIEW_SUCCESS_MESSAGE[grant.mode],
    };
  } catch (error) {
    const code: AdminPreviewFailureCode = isAdminRequiredError(error) ? 'ADMIN_REQUIRED' : 'UNAVAILABLE';
    record('admin_access_preview_failed', code);
    return { ok: false, code, message: ADMIN_PREVIEW_FAILURE_MESSAGE[code] };
  }
}

/** The explicit way back. Identical rules; `actual` is not a stored state. */
export async function clearAdminAccessPreviewAction(): Promise<AdminPreviewResult> {
  return setAdminAccessPreviewAction('actual');
}
