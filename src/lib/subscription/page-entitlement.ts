import 'server-only';

import { resolveRequestAccountAccess } from './account-access';
import { previewTrialOffer, type AdminPreviewMode, type UserRole } from './admin-access';
import type { SubscriptionTier } from './subscription-types';
import { resolveTrialOffer, type TrialOffer } from './trial';

/** What a page hands its client subtree so every gate reads one resolved answer. */
export interface PageEntitlement {
  /**
   * The tier that opens features. For an ordinary reader this is their
   * subscription; for an administrator it is Elite, or whichever plan they are
   * previewing. Every capability check reads this and nothing else.
   */
  effectiveAccessTier: SubscriptionTier;
  /**
   * The plan the account actually holds. Only billing and subscription copy may
   * read it, so a preview can never make the site describe the wrong plan as
   * purchased.
   */
  subscriptionEffectiveTier: SubscriptionTier;
  authenticated: boolean;
  role: UserRole;
  isAdmin: boolean;
  /** `actual` when no preview is running. */
  adminPreviewMode: AdminPreviewMode;
  previewExpiresAt: string | null;
  /**
   * Whether the one free Elite trial is still on the table. It decides which
   * call to action the upgrade prompt offers, and only the server can know it.
   * Under a preview it describes the reader being simulated, not the operator.
   */
  trialOffer: TrialOffer;
}

export const ANONYMOUS_PAGE_ENTITLEMENT: PageEntitlement = {
  effectiveAccessTier: 'basic',
  subscriptionEffectiveTier: 'basic',
  authenticated: false,
  role: 'user',
  isAdmin: false,
  adminPreviewMode: 'actual',
  previewExpiresAt: null,
  trialOffer: 'available',
};

/**
 * Resolve the reader's entitlement for a page render.
 *
 * One trusted read answers everything the page asks — which role is in force,
 * which plan is actually held, which plan is being previewed, and whether the
 * trial has been spent — so adding the upgrade UX to a page still costs one
 * round trip. Every failure resolves to the anonymous Basic surface.
 *
 * The underlying resolver is wrapped in React's per-request cache, so the root
 * layout and the page it renders observe one database-clock snapshot.
 */
export async function resolvePageEntitlement(): Promise<PageEntitlement> {
  const access = await resolveRequestAccountAccess();
  if (!access.authenticated) return ANONYMOUS_PAGE_ENTITLEMENT;

  const previewed = previewTrialOffer(access.adminPreviewMode);
  return {
    effectiveAccessTier: access.effectiveAccessTier,
    subscriptionEffectiveTier: access.subscriptionEffectiveTier,
    authenticated: true,
    role: access.role,
    isAdmin: access.isAdmin,
    adminPreviewMode: access.adminPreviewMode,
    previewExpiresAt: access.previewExpiresAt,
    trialOffer: previewed ?? resolveTrialOffer(
      access.databaseNow
        ? {
          tier: access.storedTier,
          status: access.status,
          trialEndsAt: access.trialEndsAt,
          trialUsedAt: access.trialUsedAt,
          currentPeriodEnd: access.currentPeriodEnd,
          databaseNow: access.databaseNow,
        }
        : null,
    ),
  };
}
