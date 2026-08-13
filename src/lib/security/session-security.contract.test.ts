import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANONYMOUS_ACCOUNT_ACCESS } from '@/src/lib/subscription/account-access';

/**
 * What a session is allowed to prove, and for how long.
 *
 * The failures this file exists to prevent are all the same shape: **a privilege
 * that outlives the fact that granted it.** An access token is valid for an
 * hour. If any layer caches "this person is an operator" for the life of that
 * token — in a module, in a cookie, in a client store, in a JWT claim read
 * without re-checking — then removing somebody's admin role does nothing for up
 * to an hour, and there is no way to find out except by waiting.
 *
 * The rule that avoids all of it is one sentence: **authority is read from the
 * database on every request, and from nowhere else.** These cases assert that
 * rule at each place it could be broken.
 */

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

/** Executable text only; these files discuss caching at length in their prose. */
function executable(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('authority is resolved per request, never remembered', () => {
  /*
   * Module scope is shared by every request an instance serves. A cached
   * positive there is not a stale answer — it is one reader's operator role
   * handed to the next caller, which is a privilege escalation rather than a
   * consistency bug.
   */
  it('keeps no module-scope memo of who is an operator', () => {
    for (const file of [
      'src/lib/admin/admin-edge.ts',
      'src/lib/security/admin-assurance-edge.ts',
    ]) {
      const code = executable(source(file));
      expect(`${file}: ${/^(let|var) /m.test(code)}`).toBe(`${file}: false`);
      expect(`${file}: ${/new Map\(|new Set\(|= \{\}/.test(code)}`).toBe(`${file}: false`);
    }
  });

  /*
   * `cache()` from React is request-scoped, not process-scoped: it memoises
   * within one render so a layout and eight pages cost one round trip, and it is
   * discarded when the request ends. That is the only caching allowed for an
   * answer this per-reader.
   */
  it('memoises the account snapshot only within a single request', () => {
    const access = source('src/lib/subscription/account-access.ts');
    expect(access).toContain("import { cache } from 'react'");
    expect(access).toContain('export const resolveRequestAccountAccess = cache(resolveUncached)');

    const assurance = source('src/lib/security/admin-assurance-server.ts');
    expect(assurance).toContain("import { cache } from 'react'");
    expect(assurance).toContain('export const resolveAdminAssurance = cache(resolveUncached)');
  });

  it('asks the database for the stored role rather than reading a token claim', () => {
    // The role lives in the database and is resolved from `auth.uid()` inside
    // it. A role claim in a JWT would be frozen for the life of that token.
    expect(source('src/lib/admin/admin-edge.ts')).toContain("client.rpc('get_my_account_access')");
    expect(source('src/lib/subscription/account-access.ts')).toContain("client.rpc('get_my_account_access')");
  });

  /*
   * `getUser()` validates the token against the auth server; `getSession()` only
   * reads what is in the cookie. Any decision made from `getSession()` alone is
   * a decision made from a value the caller supplied.
   */
  it('proves the token authentic before reading anything out of it', () => {
    for (const file of [
      'src/lib/security/admin-assurance-server.ts',
      'src/lib/security/admin-assurance-edge.ts',
    ]) {
      const code = source(file);
      if (!code.includes('getSession()')) continue;
      const usesGetUser = code.includes('auth.getUser()')
        // The edge resolver is handed the already-verified user by middleware,
        // which called `getUser()` before this ran.
        || code.includes('user: User | null');
      expect(`${file}: ${usesGetUser}`).toBe(`${file}: true`);
    }
  });
});

describe('a session that loses its privilege', () => {
  /*
   * Removing a role has to take effect on the next request, not on the next
   * token refresh. Because every gate re-reads the database, the removal is
   * observed immediately — this asserts the *shape* that makes that true: the
   * gates take no role argument and accept nothing from the request.
   */
  it('gives every gate no way to be told a role', () => {
    for (const file of [
      'src/lib/admin/admin-guard.ts',
      'src/lib/admin/admin-edge.ts',
      'src/lib/security/admin-assurance-server.ts',
    ]) {
      const code = executable(source(file));
      expect(`${file}: ${/searchParams|formData|localStorage|sessionStorage/.test(code)}`)
        .toBe(`${file}: false`);

      /*
       * No exported gate takes a role, an account id or an admin flag as an
       * argument. That is the property that makes "told a role" impossible:
       * there is no parameter to pass one through, so a caller cannot assert
       * their own privilege even by mistake.
       *
       * Note this is about the *gates*. `decideAssurance({ isAdmin: true })`
       * inside a branch that already returned for non-operators is fine — the
       * flag there was derived from the database a few lines above, not
       * received.
       */
      const signatures = code.match(/export (?:async )?function \w+\([^)]*\)/g) ?? [];
      for (const signature of signatures) {
        expect(`${file} ${signature}: ${/\b(role|userId|isAdmin|adminOverride)\b/.test(signature)}`)
          .toBe(`${file} ${signature}: false`);
      }
    }
  });

  it('resolves an unreadable session to a signed-out, non-operator, Basic reader', () => {
    // Every failure path in the resolver lands here, so a database blip can
    // never be the thing that makes somebody an administrator.
    expect(ANONYMOUS_ACCOUNT_ACCESS.isAdmin).toBe(false);
    expect(ANONYMOUS_ACCOUNT_ACCESS.role).toBe('user');
    expect(ANONYMOUS_ACCOUNT_ACCESS.authenticated).toBe(false);
    expect(ANONYMOUS_ACCOUNT_ACCESS.effectiveAccessTier).toBe('basic');
    expect(ANONYMOUS_ACCOUNT_ACCESS.adminPreviewMode).toBe('actual');
  });

  /*
   * A deletion begins while a perfectly valid token is still in the reader's
   * browser and stays valid for the rest of its hour. The guarded surfaces
   * refuse on the account's lifecycle, read fresh, rather than on the session
   * expiring — otherwise a closing account keeps writing for an hour.
   */
  it('reads the account lifecycle on every request rather than trusting the token', () => {
    const access = source('src/lib/subscription/account-access.ts');
    expect(access).toContain('accountStatus');
    expect(access).toContain("row.account_status === 'active'");
  });
});

describe('no client decides its own authority', () => {
  it('never lets a browser store or send an operator flag', () => {
    const store = executable(source('src/store/useStore.ts'));
    expect(/isAdmin|is_admin|platformAdmin|role\s*[:=]\s*['"]admin/.test(store)).toBe(false);
  });

  it('decides nothing about the console in a client component', () => {
    for (const file of [
      'src/lib/admin/admin-guard.ts',
      'src/lib/admin/admin-edge.ts',
      'src/lib/security/admin-assurance-server.ts',
      'src/lib/security/admin-assurance-edge.ts',
    ]) {
      expect(`${file}: ${source(file).includes("'use client'")}`).toBe(`${file}: false`);
    }
  });

  /*
   * The MFA control runs in the browser — it has to, because only the browser
   * client writes the upgraded `aal2` session back to the cookie the server
   * reads. What it must never do is *decide* anything: it reports state and
   * calls Supabase, and every gate re-derives assurance on the server.
   */
  it('lets the security control present a factor without deciding whether one was presented', () => {
    const control = executable(source('src/components/admin/AdminSecurityControl.tsx'));
    expect(control).toContain("'use client'");
    // It calls Supabase directly; it does not tell our server the answer.
    expect(control).toContain('supabase.auth.mfa.challengeAndVerify');
    expect(/fetch\(['"`]\/api\/(admin|security)/.test(control)).toBe(false);
    expect(/aal2|assuranceLevelFromToken|decideAssurance/.test(control)).toBe(false);
  });
});

describe('signing out ends the session it was given', () => {
  it('revokes the session at the provider rather than only clearing a cookie', () => {
    const actions = source('app/auth/actions.ts');
    expect(actions).toContain('supabase.auth.signOut()');
  });

  it('ends the recovery session once the password it existed for has changed', () => {
    const actions = source('app/auth/actions.ts');
    const reset = actions.slice(actions.indexOf('export async function resetPasswordAction'));
    // A shared or borrowed device must not be left signed in by a password
    // reset, and the new password has to be used at least once.
    expect(reset).toContain('await supabase.auth.signOut()');
  });

  it('signs out an account whose deletion has completed', () => {
    const actions = source('app/auth/actions.ts');
    const remove = actions.slice(actions.indexOf('export async function deleteAccountAction'));
    expect(remove).toContain('supabase.auth.signOut()');
  });
});
