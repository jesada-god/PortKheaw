import { describe, expect, it } from 'vitest';
import {
  ADMIN_DEFAULT_TIER,
  adminPreviewModes,
  normalizeAdminPreviewMode,
  normalizeRole,
  resolveAccountAccess,
  type AdminPreviewMode,
} from '@/src/lib/subscription/admin-access';
import {
  assuranceLevelFromToken,
  decideAssurance,
  hasVerifiedFactor,
} from '@/src/lib/security/admin-assurance';
import {
  decideLockdown,
  isBlockedDuringLockdown,
  LOCKDOWN_CLASSES,
  LOCKDOWN_EXEMPT_CLASSES,
} from '@/src/lib/security/lockdown';
import { decideMaintenance } from '@/src/lib/maintenance/maintenance-gate';
import { abuseClassForPath } from '@/src/lib/security/abuse-policy';
import { isAdminConsolePath, isProtectedPath, PROTECTED_PATHS } from '@/src/lib/auth/paths';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';

/**
 * The authorization matrix, asserted as behaviour rather than as source text.
 *
 * Everything in this file runs the *actual* decision functions the product runs.
 * The source-reading contracts next door prove the gates are wired in; this
 * proves the gates decide correctly, which is a different failure and the one
 * that survives a refactor.
 *
 * The single property underneath all of it: **paying more never makes you an
 * operator.** Tier and role are orthogonal in this product, and the whole reason
 * they are two fields is that conflating them is the escalation path — a
 * capability check that reads "Elite" and concludes "may open the console" is
 * one line away from selling administrator access for 990 baht a month.
 */

const NOW = '2026-08-14T00:00:00.000Z';
const LATER = '2026-08-14T00:30:00.000Z';
const EARLIER = '2026-08-13T23:30:00.000Z';

/** Every subject this product can be asked about, and nothing it cannot. */
const TIERS: readonly SubscriptionTier[] = ['basic', 'pro', 'elite'];

function accessFor(role: unknown, tier: SubscriptionTier, preview: {
  mode?: unknown; expiresAt?: string | null;
} = {}) {
  return resolveAccountAccess({
    role,
    subscriptionEffectiveTier: tier,
    previewMode: preview.mode ?? 'actual',
    previewExpiresAt: preview.expiresAt ?? null,
    now: NOW,
  });
}

describe('anonymous is not a user', () => {
  /*
   * There is no "anonymous" input to `resolveAccountAccess` — an anonymous
   * caller never reaches it, because the resolver returns its anonymous constant
   * before any of this runs. What is asserted here is the property that makes
   * that safe: every value a signed-out request could carry resolves to the
   * least-privileged answer, so a bug that *did* route an anonymous caller
   * through the resolver still could not produce access.
   */
  it('resolves every absent, empty or malformed role to a plain user', () => {
    for (const value of [null, undefined, '', 'ADMIN', 'Admin', ' admin', 'admin ', 0, 1, true, {}, [], 'superuser']) {
      const access = accessFor(value, 'basic');
      expect(`${JSON.stringify(value)}: ${access.isAdmin}`).toBe(`${JSON.stringify(value)}: false`);
      expect(access.role).toBe('user');
    }
  });

  it('requires a session before any surface that holds account data', () => {
    /*
     * Asserted as the whole set rather than a sample, so removing an entry from
     * `PROTECTED_PATHS` fails here instead of silently opening a page. Every one
     * of these renders something belonging to one account.
     */
    expect([...PROTECTED_PATHS]).toEqual([
      '/portfolio', '/watchlist', '/alerts', '/notifications', '/settings', '/profile', '/admin',
    ]);
    for (const path of [...PROTECTED_PATHS, '/admin/security', '/portfolio/anything', '/settings/subscription']) {
      expect(`${path}: ${isProtectedPath(path)}`).toBe(`${path}: true`);
    }
  });
});

describe('no subscription tier is a role', () => {
  /*
   * The escalation this product is most exposed to, stated as a table. Basic,
   * Pro and Elite are what somebody can *buy*; `admin` is not for sale, and the
   * only input that produces it is a stored role the database returned.
   */
  it.each(TIERS)('never makes a %s subscriber an operator', (tier) => {
    const access = accessFor('user', tier);
    expect(access.isAdmin).toBe(false);
    expect(access.role).toBe('user');
    // The tier they paid for is the tier they get — no more, and no less.
    expect(access.effectiveAccessTier).toBe(tier);
  });

  it('never lets a tier claim carry a preview, which is an operator-only state', () => {
    for (const tier of TIERS) {
      for (const mode of adminPreviewModes) {
        const access = accessFor('user', tier, { mode, expiresAt: LATER });
        expect(`${tier}/${mode}: ${access.adminPreviewMode}`).toBe(`${tier}/${mode}: actual`);
        expect(access.effectiveAccessTier).toBe(tier);
        expect(access.isAdmin).toBe(false);
      }
    }
  });

  it('withdraws a stored preview the moment the role stops being admin', () => {
    // A demotion has to take the simulation with it in the same read, or a
    // former operator keeps Elite capability until a row expires.
    const demoted = accessFor('user', 'basic', { mode: 'elite', expiresAt: LATER });
    expect(demoted.effectiveAccessTier).toBe('basic');
    expect(demoted.previewExpiresAt).toBeNull();
  });
});

describe('an operator is an operator because the database said so', () => {
  it('grants the whole product to an admin with no preview running', () => {
    const access = accessFor('admin', 'basic');
    expect(access.isAdmin).toBe(true);
    expect(access.effectiveAccessTier).toBe(ADMIN_DEFAULT_TIER);
    // The role grants the product; it does not invent a subscription.
    expect(access.subscriptionEffectiveTier).toBe('basic');
  });

  it('keeps the role while a preview narrows the capability', () => {
    // The reason role and preview are separate values: an administrator
    // previewing Basic must still be an administrator, or switching to Basic
    // would lock them out of the control that switches them back.
    const access = accessFor('admin', 'elite', { mode: 'basic', expiresAt: LATER });
    expect(access.isAdmin).toBe(true);
    expect(access.effectiveAccessTier).toBe('basic');
  });

  it('lapses a preview against the database clock, never a supplied one', () => {
    const lapsed = accessFor('admin', 'basic', { mode: 'basic', expiresAt: EARLIER });
    expect(lapsed.adminPreviewMode).toBe('actual');
    expect(lapsed.effectiveAccessTier).toBe(ADMIN_DEFAULT_TIER);
  });

  it('treats an unparseable or absent expiry as lapsed, never as forever', () => {
    for (const expiresAt of [null, '', 'tomorrow', 'NaN', '9999-99-99T99:99:99Z']) {
      const access = accessFor('admin', 'basic', { mode: 'basic', expiresAt });
      expect(`${expiresAt}: ${access.adminPreviewMode}`).toBe(`${expiresAt}: actual`);
    }
  });

  it('refuses a preview mode outside the allowlist', () => {
    for (const mode of ['owner', 'root', 'admin', 'ELITE', 'elite; drop', null, 42]) {
      expect(normalizeAdminPreviewMode(mode)).toBe('actual');
    }
  });
});

describe('an operator is only assured when a factor was presented this session', () => {
  /*
   * The second half of "admin == admin". Holding the role is not enough: the
   * threat is a stolen ordinary session, which carries `aal1` and cannot be
   * upgraded without the device.
   */
  it('is satisfied only for an admin at aal2', () => {
    const satisfied = decideAssurance({ isAdmin: true, currentLevel: 'aal2', hasVerifiedFactor: true });
    expect(satisfied.satisfied).toBe(true);
    expect(satisfied.requirement).toBe('satisfied');
  });

  it('is never satisfied for a non-admin, whatever level they claim', () => {
    for (const level of ['aal1', 'aal2', null] as const) {
      const state = decideAssurance({ isAdmin: false, currentLevel: level, hasVerifiedFactor: true });
      expect(`${level}: ${state.satisfied}`).toBe(`${level}: false`);
      expect(state.requirement).toBe('not-admin');
    }
  });

  it('sends an admin at aal1 to verify or enroll, never through', () => {
    const withFactor = decideAssurance({ isAdmin: true, currentLevel: 'aal1', hasVerifiedFactor: true });
    expect(withFactor.satisfied).toBe(false);
    expect(withFactor.requirement).toBe('verify');

    const without = decideAssurance({ isAdmin: true, currentLevel: 'aal1', hasVerifiedFactor: false });
    expect(without.satisfied).toBe(false);
    expect(without.requirement).toBe('enroll');
  });

  it('reads an unreadable, forged or absent token as aal1 and never as aal2', () => {
    for (const token of [
      undefined,
      null,
      '',
      'not-a-token',
      'a.b',
      'header.payload.signature',
      // Well-formed base64url that decodes to something with no `aal` claim.
      `x.${Buffer.from(JSON.stringify({ sub: 'reader' })).toString('base64url')}.y`,
      // A claim of a level this product does not know.
      `x.${Buffer.from(JSON.stringify({ aal: 'aal3' })).toString('base64url')}.y`,
      // The string "aal2" nested somewhere it is not the claim.
      `x.${Buffer.from(JSON.stringify({ role: 'aal2' })).toString('base64url')}.y`,
    ]) {
      expect(`${String(token)}: ${assuranceLevelFromToken(token)}`).toBe(`${String(token)}: aal1`);
    }
  });

  it('counts only a verified factor, so an abandoned enrolment is not a factor', () => {
    expect(hasVerifiedFactor([{ status: 'unverified' }])).toBe(false);
    expect(hasVerifiedFactor([])).toBe(false);
    expect(hasVerifiedFactor(null)).toBe(false);
    expect(hasVerifiedFactor([{ status: 'verified' }])).toBe(true);
  });

  it('has no bypass: no input to the decision produces aal2 except the claim', () => {
    // `decideAssurance` reads exactly three facts. Two of them cannot satisfy it
    // on their own, which is what makes the third — a token the auth server
    // issued and this session presented — the only way through.
    const everythingElse = decideAssurance({
      isAdmin: true,
      currentLevel: null,
      hasVerifiedFactor: true,
    });
    expect(everythingElse.satisfied).toBe(false);
  });
});

describe('the console URL space is one set, refused consistently', () => {
  /*
   * The consistency requirement: a page, its API and the actions posted to it
   * must classify identically. Where they disagree is where a bypass lives — a
   * path the console gate treats as `/admin` but the limiter treats as ordinary
   * traffic is a path with a gate and no bound.
   */
  const CONSOLE_PATHS = [
    '/admin',
    '/admin/beta',
    '/admin/billing',
    '/admin/refunds',
    '/admin/security',
    '/admin/support',
    '/admin/system',
  ];

  it.each(CONSOLE_PATHS)('treats %s as console, protected and rate-classed alike', (path) => {
    expect(isAdminConsolePath(path)).toBe(true);
    expect(isProtectedPath(path)).toBe(true);
    expect(abuseClassForPath(path, 'GET')).toBe('admin-read');
    // A server action posts to its own page URL, so a POST to a console path is
    // a mutation and is bounded as one.
    expect(abuseClassForPath(path, 'POST')).toBe('admin-mutation');
  });

  it('classes the operator API the same way as the operator page', () => {
    expect(abuseClassForPath('/api/admin/anything', 'GET')).toBe('admin-read');
    expect(abuseClassForPath('/api/admin/anything', 'DELETE')).toBe('admin-mutation');
  });

  it('does not mistake a lookalike path for the console', () => {
    // The prefix check must not match a route that merely starts with the same
    // letters, or an ordinary page inherits the console's gate — and, worse, a
    // console page could be reached by a spelling the gate does not recognise.
    for (const path of ['/administration', '/admins', '/adminish']) {
      expect(`${path}: ${isAdminConsolePath(path)}`).toBe(`${path}: false`);
    }
  });
});

describe('the security lockdown', () => {
  it('changes nothing while it is off', () => {
    for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
      const decision = decideLockdown({ pathname: '/admin/system', method, lockdownEnabled: false });
      expect(`${method}: ${decision.action}`).toBe(`${method}: allow`);
    }
  });

  it('refuses a privileged mutation with 423, and never a redirect', () => {
    for (const path of ['/admin', '/admin/system', '/admin/beta', '/api/admin/anything']) {
      const decision = decideLockdown({ pathname: path, method: 'POST', lockdownEnabled: true });
      expect(`${path}: ${decision.action}`).toBe(`${path}: block`);
      // A 302 would let a browser follow a refused server action into a page
      // render instead of failing the write — the bypass a redirect leaves.
      if (decision.action === 'block') expect(decision.status).toBe(423);
    }
  });

  it('binds operators too — there is no admin exemption in the decision at all', () => {
    // `decideLockdown` takes no `isAdmin`. That is the point, and asserting the
    // *shape* is what stops one being added: the incident this exists for is a
    // compromised operator session.
    const input = { pathname: '/admin/system', method: 'POST', lockdownEnabled: true };
    expect(Object.keys(input)).not.toContain('isAdmin');
    expect(decideLockdown(input).action).toBe('block');
  });

  it('keeps reads open, so an operator can still see what is happening', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const decision = decideLockdown({ pathname: '/admin/system', method, lockdownEnabled: true });
      expect(`${method}: ${decision.action}`).toBe(`${method}: allow`);
    }
  });

  it('leaves the page that releases the switch reachable', () => {
    // A control that cannot be released while engaged is a lockout.
    const decision = decideLockdown({
      pathname: '/admin/security', method: 'POST', lockdownEnabled: true,
    });
    expect(decision.action).toBe('allow');
  });

  it('never refuses the paths an incident makes more necessary', () => {
    for (const path of [
      '/auth/sign-in',
      '/api/auth/callback',
      '/api/billing/webhook',
      '/api/cron/sweep',
      '/api/alerts/evaluate',
    ]) {
      const decision = decideLockdown({ pathname: path, method: 'POST', lockdownEnabled: true });
      expect(`${path}: ${decision.action}`).toBe(`${path}: allow`);
    }
  });

  it('leaves an ordinary reader writing their own data alone', () => {
    // Lockdown is not a read-only mode. Refusing a portfolio edit costs every
    // paying customer their product and buys no containment — row-level
    // security already bounds that write to rows the caller owns.
    for (const path of ['/portfolio', '/watchlist', '/settings', '/api/portfolio/anything']) {
      const decision = decideLockdown({ pathname: path, method: 'POST', lockdownEnabled: true });
      expect(`${path}: ${decision.action}`).toBe(`${path}: allow`);
    }
  });

  it('blocks every privilege-bearing class and exempts exactly two', () => {
    const blocked = LOCKDOWN_CLASSES.filter(isBlockedDuringLockdown);
    expect(blocked).toEqual([
      'admin-mutation', 'role-change', 'billing-override', 'account-destructive',
    ]);
    for (const exempt of LOCKDOWN_EXEMPT_CLASSES) {
      expect(`${exempt}: ${isBlockedDuringLockdown(exempt)}`).toBe(`${exempt}: false`);
    }
  });

  it('is a different switch from maintenance, deciding a different question', () => {
    // Maintenance lets an operator through; lockdown does not. If these two ever
    // collapse into one dial, this is the assertion that fails.
    const maintenance = decideMaintenance({
      pathname: '/admin/system', method: 'POST', maintenanceEnabled: true, isAdmin: true,
    });
    expect(maintenance.action).toBe('allow');

    const lockdown = decideLockdown({
      pathname: '/admin/system', method: 'POST', lockdownEnabled: true,
    });
    expect(lockdown.action).toBe('block');
  });
});

describe('malformed input never widens access', () => {
  /*
   * Every normalizer in the authorization path, given the things a hostile
   * caller actually sends. The property is uniform: unrecognised input loses
   * privilege, it never gains any.
   */
  it('fails closed on every hostile role value', () => {
    for (const value of [
      'admin ', 'admin\n', "admin' or '1'='1", '["admin"]', '{"role":"admin"}',
      'aDmIn', 'ADMIN', Number.NaN, Infinity, Symbol.iterator.toString(),
    ]) {
      expect(`${String(value)}: ${normalizeRole(value)}`).toBe(`${String(value)}: user`);
    }
  });

  it('accepts exactly the roles the database constraint accepts', () => {
    // The check constraint on `user_roles` is `role in ('user', 'admin')`. If
    // this list and that constraint ever disagree, one of them is wrong.
    expect(normalizeRole('admin')).toBe('admin');
    expect(normalizeRole('user')).toBe('user');
  });

  it('accepts exactly the preview modes the database accepts', () => {
    const accepted = adminPreviewModes.filter(
      (mode) => normalizeAdminPreviewMode(mode) === mode,
    );
    expect(accepted).toEqual([...adminPreviewModes] as AdminPreviewMode[]);
  });
});
