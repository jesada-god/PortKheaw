'use server';

import { revalidatePath } from 'next/cache';
import {
  isAdminRequiredError,
  setAdminAccessPreview,
} from '@/src/lib/subscription/account-access';
import { adminPreviewModes, type AdminPreviewMode } from '@/src/lib/subscription/admin-access';
import {
  ASSURANCE_DENIAL_MESSAGE, isAssuranceRequiredError, requireAdminMutation,
} from '@/src/lib/security/admin-assurance-server';
import { recordSecurityEvent } from '@/src/lib/security/security-audit';
/*
 * Shared with the billing webhook on purpose. An access change and a paid-plan
 * change must invalidate exactly the same surfaces, and keeping one definition
 * is what stops the two from drifting apart.
 */
import { revalidateEveryEntitlementSurface } from '@/src/lib/subscription/revalidate-entitlements';
import {
  trialFailureCode,
  trialFailureMessage,
  type TrialFailureCode,
} from '@/src/lib/subscription/trial';
import { resolveTrialEligibility } from '@/src/lib/trial-identity/trial-eligibility';
import { claimAndStartEliteTrial } from '@/src/lib/trial-identity/trial-identity-store';

export type StartTrialResult =
  | { ok: true; trialEndsAt: string; message: string }
  | { ok: false; code: TrialFailureCode; message: string };

type AuditEvent =
  | 'trial_started'
  | 'trial_start_failed'
  | 'trial_start_beta_refused'
  | 'trial_start_beta_unresolved'
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
  if (event.endsWith('_failed') || event.endsWith('_refused') || event.endsWith('_unresolved')) {
    console.warn(payload);
  }
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
  /*
   * One service answers "may this reader start the week?", and it is the same
   * one the hero asked when it decided whether to render a button. Session,
   * account status, mailbox proof, the account's own subscription row, the
   * controlled rollout and the persistent identity ledger are all checked there,
   * in that order — so the control a reader sees and the answer they get on
   * pressing it can never disagree, and no rule can be enforced in one place and
   * forgotten in the other.
   */
  const eligibility = await resolveTrialEligibility();
  if (!eligibility.ok) {
    record(
      eligibility.code === 'BETA_NOT_ADMITTED'
        ? 'trial_start_beta_refused'
        : eligibility.code === 'BETA_ACCESS_UNAVAILABLE'
          ? 'trial_start_beta_unresolved'
          : 'trial_start_failed',
      eligibility.code,
    );
    return { ok: false, code: eligibility.code, message: eligibility.message };
  }

  try {
    /*
     * The claim and the grant are one database transaction. Claiming first and
     * granting after would burn an identity on an attempt that failed — the
     * account could then never have the week it never got — and granting first
     * would leave a trial the ledger never saw, which is the defect this whole
     * path exists to close.
     *
     * The identities are digests the server derived from the verified account
     * record. Nothing the browser sent reaches this call.
     */
    const grant = await claimAndStartEliteTrial(eligibility.userId, eligibility.identities);
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

export type AdminPreviewFailureCode = 'ADMIN_REQUIRED' | 'MFA_REQUIRED' | 'INVALID_MODE' | 'UNAVAILABLE';

export type AdminPreviewResult =
  | { ok: true; mode: AdminPreviewMode; expiresAt: string | null; message: string }
  | { ok: false; code: AdminPreviewFailureCode; message: string };

const ADMIN_PREVIEW_FAILURE_MESSAGE: Record<AdminPreviewFailureCode, string> = {
  ADMIN_REQUIRED: 'บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ จึงจำลองสิทธิ์ไม่ได้',
  MFA_REQUIRED: ASSURANCE_DENIAL_MESSAGE,
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
    const before = await requireAdminMutation();
    const grant = await setAdminAccessPreview(mode);
    revalidateEveryEntitlementSurface();

    /*
     * A privileged override of what an account may open, recorded every time
     * rather than summarised. It is low-frequency and individually consequential
     * — an operator running as Elite is an operator whose subsequent reads look
     * different — so the audit keeps each one, in order.
     *
     * `void`, so the operator's own control never waits on the audit write, and
     * the recorder swallows its own failures.
     */
    void recordSecurityEvent({
      event: 'security.subscription.override',
      targetRef: `preview:${grant.mode}`,
      outcome: 'allowed',
      userId: before.userId,
    });

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
    const code: AdminPreviewFailureCode = isAssuranceRequiredError(error)
      ? 'MFA_REQUIRED'
      : isAdminRequiredError(error) ? 'ADMIN_REQUIRED' : 'UNAVAILABLE';
    record('admin_access_preview_failed', code);
    return { ok: false, code, message: ADMIN_PREVIEW_FAILURE_MESSAGE[code] };
  }
}

/** The explicit way back. Identical rules; `actual` is not a stored state. */
export async function clearAdminAccessPreviewAction(): Promise<AdminPreviewResult> {
  return setAdminAccessPreviewAction('actual');
}
