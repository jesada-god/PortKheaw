import { describe, expect, it } from 'vitest';
import {
  ADMIN_DEFAULT_TIER,
  adminPreviewLabel,
  adminPreviewModes,
  normalizeAdminPreviewMode,
  normalizeRole,
  previewTrialOffer,
  resolveAccountAccess,
  type ActiveAdminPreviewMode,
  type AdminPreviewMode,
} from './admin-access';
import { resolveAccountBadges } from './account-badges';
import { hasCapability, subscriptionCapabilities, type SubscriptionCapability } from './capabilities';
import type { SubscriptionTier } from './subscription-types';

const NOW = '2026-08-03T12:00:00.000Z';
const LATER = '2026-08-03T12:59:00.000Z';
const EARLIER = '2026-08-03T11:59:00.000Z';

function access(overrides: Partial<Parameters<typeof resolveAccountAccess>[0]> = {}) {
  return resolveAccountAccess({
    role: 'user',
    subscriptionEffectiveTier: 'basic',
    previewMode: 'actual',
    previewExpiresAt: null,
    now: NOW,
    ...overrides,
  });
}

/** The tier each preview is required to grant, stated independently of the map. */
const PREVIEW_EXPECTED_TIER: Record<ActiveAdminPreviewMode, SubscriptionTier> = {
  basic: 'basic',
  pro: 'pro',
  elite: 'elite',
  elite_trial: 'elite',
  expired_trial: 'basic',
};

const EVERY_CAPABILITY = Object.keys(subscriptionCapabilities.basic) as SubscriptionCapability[];
const BOOLEAN_CAPABILITIES = EVERY_CAPABILITY.filter(
  (capability) => typeof subscriptionCapabilities.basic[capability] === 'boolean',
);

describe('normalizeRole', () => {
  it('treats anything that is not exactly admin as a user', () => {
    expect(normalizeRole('admin')).toBe('admin');
    for (const value of ['user', 'ADMIN', 'Admin', 'owner', '', null, undefined, 0, 1, true, {}, ['admin']]) {
      expect(normalizeRole(value)).toBe('user');
    }
  });
});

describe('normalizeAdminPreviewMode', () => {
  it('accepts only the allowlist and falls back to actual', () => {
    for (const mode of adminPreviewModes) expect(normalizeAdminPreviewMode(mode)).toBe(mode);
    for (const value of ['ELITE', 'admin', 'super', '', null, undefined, 7, {}]) {
      expect(normalizeAdminPreviewMode(value)).toBe('actual');
    }
  });
});

describe('resolveAccountAccess', () => {
  it('gives an ordinary reader exactly their subscription and no preview', () => {
    for (const tier of ['basic', 'pro', 'elite'] as const) {
      const resolved = access({ subscriptionEffectiveTier: tier });
      expect(resolved).toEqual({
        role: 'user',
        isAdmin: false,
        subscriptionEffectiveTier: tier,
        effectiveAccessTier: tier,
        adminPreviewMode: 'actual',
        previewExpiresAt: null,
      });
    }
  });

  it('ignores a stored preview for a reader who is not an administrator', () => {
    for (const mode of adminPreviewModes) {
      const resolved = access({ role: 'user', previewMode: mode, previewExpiresAt: LATER });
      expect(resolved.effectiveAccessTier).toBe('basic');
      expect(resolved.adminPreviewMode).toBe('actual');
      expect(resolved.previewExpiresAt).toBeNull();
    }
  });

  it('gives an administrator with no preview Elite access without changing their plan', () => {
    const resolved = access({ role: 'admin', subscriptionEffectiveTier: 'basic' });
    expect(resolved.isAdmin).toBe(true);
    expect(resolved.effectiveAccessTier).toBe(ADMIN_DEFAULT_TIER);
    expect(resolved.effectiveAccessTier).toBe('elite');
    // The plan they actually hold is untouched — this is a role, not a purchase.
    expect(resolved.subscriptionEffectiveTier).toBe('basic');
  });

  it('grants each running preview exactly its own tier', () => {
    for (const [mode, tier] of Object.entries(PREVIEW_EXPECTED_TIER)) {
      const resolved = access({
        role: 'admin',
        subscriptionEffectiveTier: 'basic',
        previewMode: mode,
        previewExpiresAt: LATER,
      });
      expect(resolved.effectiveAccessTier).toBe(tier);
      expect(resolved.adminPreviewMode).toBe(mode);
      expect(resolved.previewExpiresAt).toBe(LATER);
      expect(resolved.subscriptionEffectiveTier).toBe('basic');
      // Still an administrator, whatever plan is being simulated.
      expect(resolved.isAdmin).toBe(true);
      expect(resolved.role).toBe('admin');
    }
  });

  it('matches the real capability matrix in every preview, with no special cases', () => {
    for (const [mode, tier] of Object.entries(PREVIEW_EXPECTED_TIER)) {
      const resolved = access({ role: 'admin', previewMode: mode, previewExpiresAt: LATER });
      for (const capability of BOOLEAN_CAPABILITIES) {
        expect(
          `${mode}/${capability}=${hasCapability(resolved.effectiveAccessTier, capability)}`,
        ).toBe(`${mode}/${capability}=${hasCapability(tier, capability)}`);
      }
    }
  });

  it('never lets a Pro preview reach an Elite-only capability', () => {
    const pro = access({ role: 'admin', previewMode: 'pro', previewExpiresAt: LATER });
    const eliteOnly = BOOLEAN_CAPABILITIES.filter(
      (capability) => hasCapability('elite', capability) && !hasCapability('pro', capability),
    );
    expect(eliteOnly.length).toBeGreaterThan(0);
    for (const capability of eliteOnly) {
      expect(hasCapability(pro.effectiveAccessTier, capability)).toBe(false);
    }
  });

  it('returns an administrator to Elite the moment a preview lapses', () => {
    for (const expiry of [EARLIER, NOW, null, 'not-a-timestamp']) {
      const resolved = access({
        role: 'admin',
        previewMode: 'basic',
        previewExpiresAt: expiry,
        now: NOW,
      });
      expect(resolved.effectiveAccessTier).toBe('elite');
      expect(resolved.adminPreviewMode).toBe('actual');
      expect(resolved.previewExpiresAt).toBeNull();
    }
  });

  it('falls closed on an unrecognised role or mode rather than escalating', () => {
    expect(access({ role: 'superuser', previewMode: 'elite', previewExpiresAt: LATER }).effectiveAccessTier).toBe('basic');
    // An admin sending a mode nobody recognises gets their ordinary access, not more.
    const unknownMode = access({ role: 'admin', previewMode: 'godmode', previewExpiresAt: LATER });
    expect(unknownMode.adminPreviewMode).toBe('actual');
    expect(unknownMode.effectiveAccessTier).toBe('elite');
  });
});

describe('previewTrialOffer', () => {
  it('simulates the trial state that belongs to each previewed reader', () => {
    expect(previewTrialOffer('actual')).toBeNull();
    expect(previewTrialOffer('elite_trial')).toBe('active');
    expect(previewTrialOffer('expired_trial')).toBe('used');
    expect(previewTrialOffer('basic')).toBe('available');
    expect(previewTrialOffer('pro')).toBe('available');
    expect(previewTrialOffer('elite')).toBe('used');
  });
});

describe('resolveAccountBadges', () => {
  it('labels an ordinary reader with the plan they hold', () => {
    const cases = [
      { tier: 'basic', status: 'basic', label: 'BASIC' },
      { tier: 'pro', status: 'active', label: 'PRO' },
      { tier: 'elite', status: 'active', label: 'ELITE' },
      { tier: 'elite', status: 'trialing', label: 'ELITE TRIAL' },
    ] as const;
    for (const { tier, status, label } of cases) {
      const badges = resolveAccountBadges({
        role: 'user',
        adminPreviewMode: 'actual',
        subscriptionEffectiveTier: tier,
        status,
      });
      expect(badges.showAdminBadge).toBe(false);
      expect(badges.isPreview).toBe(false);
      expect(badges.planLabel).toBe(label);
    }
  });

  /*
   * An administrator's second badge names the *grant*, not a plan. `ELITE`
   * would be a claim about billing that is false for the Basic row below, so
   * operator access carries its own badge kind and its own label.
   */
  it('shows an administrator as ADMIN and ELITE ACCESS, whatever they have paid for', () => {
    for (const tier of ['basic', 'pro', 'elite'] as const) {
      const badges = resolveAccountBadges({
        role: 'admin',
        adminPreviewMode: 'actual',
        subscriptionEffectiveTier: tier,
        status: 'basic',
      });
      expect(badges.showAdminBadge).toBe(true);
      expect(badges.plan).toBe('elite_access');
      expect(badges.planLabel).toBe('ELITE ACCESS');
      expect(badges.isPreview).toBe(false);
    }
  });

  /*
   * The grant badge is reachable only through the role. No subscription — not
   * even a genuinely purchased Elite one — may produce it, or the profile would
   * describe a paying customer as an operator.
   */
  it('never gives an ordinary reader the operator access badge', () => {
    for (const tier of ['basic', 'pro', 'elite'] as const) {
      for (const status of ['basic', 'active', 'trialing', 'past_due'] as const) {
        const badges = resolveAccountBadges({
          role: 'user',
          adminPreviewMode: 'actual',
          subscriptionEffectiveTier: tier,
          status,
        });
        expect(badges.plan).not.toBe('elite_access');
        expect(badges.planLabel).not.toContain('ACCESS');
        expect(badges.showAdminBadge).toBe(false);
      }
    }
  });

  it('marks every previewed plan as a test and keeps the ADMIN badge', () => {
    const expected: Record<ActiveAdminPreviewMode, string> = {
      basic: 'BASIC TEST',
      pro: 'PRO TEST',
      elite: 'ELITE TEST',
      elite_trial: 'ELITE TRIAL TEST',
      expired_trial: 'EXPIRED TRIAL TEST',
    };
    for (const [mode, label] of Object.entries(expected)) {
      const badges = resolveAccountBadges({
        role: 'admin',
        adminPreviewMode: mode as AdminPreviewMode,
        subscriptionEffectiveTier: 'basic',
        status: 'basic',
      });
      expect(badges.showAdminBadge).toBe(true);
      expect(badges.isPreview).toBe(true);
      expect(badges.planLabel).toBe(label);
    }
  });

  it('never produces an ADMIN badge from a plan, including a real Elite one', () => {
    for (const mode of adminPreviewModes) {
      const badges = resolveAccountBadges({
        role: 'user',
        adminPreviewMode: mode,
        subscriptionEffectiveTier: 'elite',
        status: 'active',
      });
      expect(badges.showAdminBadge).toBe(false);
      expect(badges.isPreview).toBe(false);
      expect(badges.planLabel).toBe('ELITE');
    }
  });
});

describe('adminPreviewLabel', () => {
  it('names every simulated plan', () => {
    for (const mode of adminPreviewModes) {
      if (mode === 'actual') continue;
      expect(adminPreviewLabel(mode as ActiveAdminPreviewMode)).toBeTruthy();
    }
  });
});
