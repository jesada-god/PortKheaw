/**
 * What goes after a reader's name, decided once.
 *
 * The profile card, the subscription centre and the preview banner all show the
 * same identity, so the rule that turns role + subscription + preview into
 * badges lives here rather than being re-derived beside each of them. It is
 * pure: no I/O, no clock, no component imports.
 */

import type { AdminPreviewMode, UserRole } from './admin-access';
import type { SubscriptionStatus, SubscriptionTier } from './subscription-types';

/**
 * The five badges a plan can be. `expired_trial` is only ever a simulation — a
 * real reader whose trial ended is simply Basic, which is the honest thing to
 * show them.
 */
export const planBadgeKinds = ['basic', 'pro', 'elite', 'elite_trial', 'expired_trial'] as const;
export type PlanBadgeKind = typeof planBadgeKinds[number];

/** Uppercase on purpose: these read as a stamp beside the name, not as prose. */
const PLAN_BADGE_LABEL: Readonly<Record<PlanBadgeKind, string>> = {
  basic: 'BASIC',
  pro: 'PRO',
  elite: 'ELITE',
  elite_trial: 'ELITE TRIAL',
  expired_trial: 'EXPIRED TRIAL',
};

export const ADMIN_BADGE_LABEL = 'ADMIN';

export interface AccountBadges {
  role: UserRole;
  /** True only for a stored administrator role — never for a previewed plan. */
  showAdminBadge: boolean;
  plan: PlanBadgeKind;
  /** True when the plan badge describes a simulation rather than the account. */
  isPreview: boolean;
  /** The full badge text, including the ` TEST` suffix a preview carries. */
  planLabel: string;
}

export interface AccountBadgeInput {
  role: UserRole;
  adminPreviewMode: AdminPreviewMode;
  /** The plan actually held — what an ordinary reader is labelled with. */
  subscriptionEffectiveTier: SubscriptionTier;
  /** The stored status, which is what separates a running trial from a purchase. */
  status: SubscriptionStatus;
}

/**
 * The badge row for one account.
 *
 * Three shapes, in order:
 *
 *   ordinary reader        `[BASIC]` · `[PRO]` · `[ELITE]` · `[ELITE TRIAL]`
 *   administrator          `[ADMIN] [ELITE]`
 *   administrator previewing  `[ADMIN] [BASIC TEST]`
 *
 * The administrator badge is driven by the stored role alone, so previewing
 * Basic never hides who the reader is — and no plan, previewed or purchased,
 * can ever produce one.
 */
export function resolveAccountBadges(input: AccountBadgeInput): AccountBadges {
  const isAdmin = input.role === 'admin';
  const previewing = isAdmin && input.adminPreviewMode !== 'actual';
  const plan: PlanBadgeKind = previewing
    ? input.adminPreviewMode as PlanBadgeKind
    : isAdmin
      ? 'elite'
      : planBadgeKindForSubscription(input.subscriptionEffectiveTier, input.status);

  return {
    role: input.role,
    showAdminBadge: isAdmin,
    plan,
    isPreview: previewing,
    planLabel: previewing ? `${PLAN_BADGE_LABEL[plan]} TEST` : PLAN_BADGE_LABEL[plan],
  };
}

/**
 * A trial and a purchase both resolve to Elite access, and a reader deserves to
 * know which one they are on — so the status, not the tier, decides between
 * `ELITE` and `ELITE TRIAL`.
 */
export function planBadgeKindForSubscription(
  effectiveTier: SubscriptionTier,
  status: SubscriptionStatus,
): PlanBadgeKind {
  if (effectiveTier === 'elite' && status === 'trialing') return 'elite_trial';
  return effectiveTier;
}

export function planBadgeLabel(kind: PlanBadgeKind): string {
  return PLAN_BADGE_LABEL[kind];
}
