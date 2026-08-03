/**
 * "What am I paying for?" and "what can I open right now?" — answered as two
 * separate statements, decided once.
 *
 * Before Phase 4 the profile printed a single plan line, which was true for an
 * ordinary reader and quietly wrong for an administrator: the role opens the
 * whole product, so the page said `Elite` beside an account whose subscription
 * row said Basic and whose card had never been charged. A running preview made
 * it worse, because then neither the plan nor the access on screen was the
 * account's own.
 *
 * So this resolver returns two things and keeps them apart:
 *
 *   `actualPlan`  the subscription truth. It is read from the stored plan and
 *                 status and from nothing else — not the role, not a preview.
 *                 This is the only line that may be used to describe billing.
 *
 *   `access`      present only when what opens features differs from the plan
 *                 held, which is exactly the administrator cases. It names the
 *                 reason (`สิทธิ์ผู้ดูแลระบบ`, `โหมดทดสอบ Admin`) so the grant
 *                 can never be mistaken for a purchase.
 *
 * Pure: no I/O, no clock, no component imports. The same rule runs on the
 * profile, in the subscription centre and in a test.
 */

import { adminPreviewLabel, type ActiveAdminPreviewMode, type AdminPreviewMode, type UserRole } from './admin-access';
import { planBadgeKindForSubscription } from './account-badges';
import { planDescriptor } from './plan-catalog';
import type { SubscriptionStatus, SubscriptionTier } from './subscription-types';

/** The label above the subscription truth. One wording, used everywhere. */
export const ACTUAL_PLAN_HEADING = 'แพ็กเกจสมาชิกจริง';
/** The label above an administrator's standing operator grant. */
export const ADMIN_ACCESS_HEADING = 'สิทธิ์การเข้าถึง';
/** The label above a running simulation. Deliberately not the one above. */
export const PREVIEW_ACCESS_HEADING = 'สิทธิ์ที่กำลังจำลอง';

/** Why the access line exists at all — the grant, never the plan. */
export const ADMIN_ACCESS_REASON = 'สิทธิ์ผู้ดูแลระบบ';
export const PREVIEW_ACCESS_REASON = 'โหมดทดสอบ Admin';

/**
 * The sentence that has to survive every preview: nothing about the real
 * subscription, and nothing about money, changes while one is running.
 */
export const PREVIEW_BILLING_UNCHANGED_NOTE = 'แพ็กเกจจริงและการเรียกเก็บเงินไม่ได้เปลี่ยน';

export interface AccountAccessLine {
  /** Which of the two access headings applies. */
  heading: string;
  /** The tier that is open, e.g. `Elite` or `Pro`. */
  planName: string;
  /** Why it is open. Never a plan name, always a grant. */
  reason: string;
  /** `Elite — สิทธิ์ผู้ดูแลระบบ`, assembled once so callers cannot re-punctuate it. */
  value: string;
  /** Extra reassurance a simulation needs and a standing grant does not. */
  note: string | null;
  /** Lets a caller style or test the two cases apart without parsing Thai. */
  kind: 'admin' | 'preview';
}

export interface AccountPlanSummary {
  actualPlanHeading: string;
  /** `Basic` · `Pro` · `Elite` · `Elite Trial` — the plan actually held. */
  actualPlanName: string;
  access: AccountAccessLine | null;
}

export interface AccountPlanSummaryInput {
  role: UserRole;
  adminPreviewMode: AdminPreviewMode;
  /** The plan actually held. Must be the value a preview does not touch. */
  subscriptionEffectiveTier: SubscriptionTier;
  status: SubscriptionStatus;
}

/**
 * The plan name a reader actually holds.
 *
 * Names come from the plan catalogue rather than being typed here, so renaming
 * a plan in one place renames it on the profile too. A running trial is the one
 * case the catalogue cannot answer on its own — Elite by capability, but not a
 * purchase — so the badge rule decides it and the suffix is added here.
 */
export function actualPlanName(tier: SubscriptionTier, status: SubscriptionStatus): string {
  const kind = planBadgeKindForSubscription(tier, status);
  return kind === 'elite_trial'
    ? `${planDescriptor('elite').name} Trial`
    : planDescriptor(tier).name;
}

export function resolveAccountPlanSummary(input: AccountPlanSummaryInput): AccountPlanSummary {
  const summary: AccountPlanSummary = {
    actualPlanHeading: ACTUAL_PLAN_HEADING,
    actualPlanName: actualPlanName(input.subscriptionEffectiveTier, input.status),
    access: null,
  };

  // An ordinary reader's access *is* their plan, so a second line would only
  // repeat the first. Stored role alone decides this — never a preview mode,
  // which a non-administrator can carry but never have applied.
  if (input.role !== 'admin') return summary;

  if (input.adminPreviewMode !== 'actual') {
    const planName = adminPreviewLabel(input.adminPreviewMode as ActiveAdminPreviewMode);
    return {
      ...summary,
      access: {
        heading: PREVIEW_ACCESS_HEADING,
        planName,
        reason: PREVIEW_ACCESS_REASON,
        value: `${planName} — ${PREVIEW_ACCESS_REASON}`,
        note: PREVIEW_BILLING_UNCHANGED_NOTE,
        kind: 'preview',
      },
    };
  }

  const planName = planDescriptor('elite').name;
  return {
    ...summary,
    access: {
      heading: ADMIN_ACCESS_HEADING,
      planName,
      reason: ADMIN_ACCESS_REASON,
      value: `${planName} — ${ADMIN_ACCESS_REASON}`,
      note: null,
      kind: 'admin',
    },
  };
}
