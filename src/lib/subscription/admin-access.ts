/**
 * Role, subscription and preview — kept apart, resolved once.
 *
 * Phase 1–3 had one question to answer ("what has this reader paid for?") and
 * one answer to give. Phase 3.1 adds an operator role that is not a plan, and a
 * way for that operator to look at the product through a plan they do not have.
 * That makes three different values which are easy to conflate and dangerous to:
 *
 *   `role`                      who this account *is*. Never derived from an
 *                               email, a display name or anything a client sends.
 *   `subscriptionEffectiveTier` what this account has actually paid for or is
 *                               trialing. The only tier that may describe
 *                               billing to the reader.
 *   `effectiveAccessTier`       what opens features right now. The only tier a
 *                               paywall, an API guard or a capability check may
 *                               read.
 *
 * Nothing here performs I/O. It takes what the database already decided and
 * turns it into those three values, so the same rule runs on a page render, in
 * an API route and in a test.
 */

import type { SubscriptionTier } from './subscription-types';

export const userRoles = ['user', 'admin'] as const;
export type UserRole = typeof userRoles[number];

export const adminPreviewModes = [
  'actual',
  'basic',
  'pro',
  'elite',
  'elite_trial',
  'expired_trial',
] as const;
export type AdminPreviewMode = typeof adminPreviewModes[number];

/** The modes that are a simulation. `actual` is the absence of one. */
export type ActiveAdminPreviewMode = Exclude<AdminPreviewMode, 'actual'>;

/**
 * The tier each preview carries. Two modes deliberately share a tier with
 * another: an Elite trial grants exactly Elite capability, and an expired trial
 * grants exactly Basic. The difference between them and the plain tiers is what
 * the reader is *told*, never what they can do — so the capability matrix stays
 * the single source of what is unlocked.
 */
const PREVIEW_TIER: Readonly<Record<ActiveAdminPreviewMode, SubscriptionTier>> = {
  basic: 'basic',
  pro: 'pro',
  elite: 'elite',
  elite_trial: 'elite',
  expired_trial: 'basic',
};

/** An administrator with no preview running sees the whole product. */
export const ADMIN_DEFAULT_TIER: SubscriptionTier = 'elite';

/**
 * A value that is not exactly `admin` is a user. Fail closed: an unreadable,
 * missing or unrecognised role can only ever lose access, never grant it.
 */
export function normalizeRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'user';
}

/** Anything not on the allowlist is "no preview", for the same reason. */
export function normalizeAdminPreviewMode(value: unknown): AdminPreviewMode {
  return adminPreviewModes.includes(value as AdminPreviewMode)
    ? value as AdminPreviewMode
    : 'actual';
}

export interface AccountAccess {
  role: UserRole;
  isAdmin: boolean;
  /** The plan the account actually holds. Billing copy reads this and only this. */
  subscriptionEffectiveTier: SubscriptionTier;
  /** The plan that opens features right now. Every gate reads this. */
  effectiveAccessTier: SubscriptionTier;
  adminPreviewMode: AdminPreviewMode;
  /** ISO timestamp the running preview lapses at, or `null` when none is running. */
  previewExpiresAt: string | null;
}

export interface AccountAccessInput {
  role: unknown;
  subscriptionEffectiveTier: SubscriptionTier;
  previewMode: unknown;
  previewExpiresAt: string | null;
  /** The database clock, so an expiry is never judged against a browser's idea of now. */
  now: string;
}

function previewHasLapsed(expiresAt: string | null, now: string): boolean {
  if (!expiresAt) return true;
  const lapse = Date.parse(expiresAt);
  const current = Date.parse(now);
  // An unparseable timestamp counts as lapsed — the failure mode of a bad clock
  // value is losing a preview, not holding one forever.
  if (!Number.isFinite(lapse) || !Number.isFinite(current)) return true;
  return lapse <= current;
}

/**
 * The whole authorization decision, in one place.
 *
 * Three rules, in order of precedence:
 *
 *   1. A non-administrator has no preview, whatever is stored against their
 *      account. Demoting an account withdraws its simulation in the same read.
 *   2. An administrator with no live preview has Elite access — the role grants
 *      the product, it does not grant a *subscription*.
 *   3. An administrator with a live preview has exactly that preview's tier.
 *
 * `subscriptionEffectiveTier` is never touched by any of them.
 */
export function resolveAccountAccess(input: AccountAccessInput): AccountAccess {
  const role = normalizeRole(input.role);
  const subscriptionEffectiveTier = input.subscriptionEffectiveTier;

  if (role !== 'admin') {
    return {
      role,
      isAdmin: false,
      subscriptionEffectiveTier,
      effectiveAccessTier: subscriptionEffectiveTier,
      adminPreviewMode: 'actual',
      previewExpiresAt: null,
    };
  }

  const requested = normalizeAdminPreviewMode(input.previewMode);
  const running = requested !== 'actual' && !previewHasLapsed(input.previewExpiresAt, input.now);

  return {
    role: 'admin',
    isAdmin: true,
    subscriptionEffectiveTier,
    effectiveAccessTier: running
      ? PREVIEW_TIER[requested as ActiveAdminPreviewMode]
      : ADMIN_DEFAULT_TIER,
    adminPreviewMode: running ? requested : 'actual',
    previewExpiresAt: running ? input.previewExpiresAt : null,
  };
}

/**
 * Which trial call to action a previewed surface should offer.
 *
 * A preview is only worth running if the upgrade prompts behave the way they
 * would for the reader being simulated, so the trial state is simulated with
 * the tier. It is a display decision — no trial is started, and `trial_used_at`
 * is never written, in any of these states.
 */
export function previewTrialOffer(mode: AdminPreviewMode): 'available' | 'active' | 'used' | null {
  switch (mode) {
    case 'actual': return null;
    case 'elite_trial': return 'active';
    case 'expired_trial': return 'used';
    // A reader on Elite is never shown an upgrade prompt, so the offer behind it
    // cannot be seen; Basic and Pro are the states where the trial CTA matters.
    case 'elite': return 'used';
    default: return 'available';
  }
}

const PREVIEW_LABEL: Readonly<Record<ActiveAdminPreviewMode, string>> = {
  basic: 'Basic',
  pro: 'Pro',
  elite: 'Elite',
  elite_trial: 'Elite Trial',
  expired_trial: 'Trial หมดอายุ',
};

/** The plan name a running preview is simulating, for banners and badges. */
export function adminPreviewLabel(mode: ActiveAdminPreviewMode): string {
  return PREVIEW_LABEL[mode];
}
