import 'server-only';

import { createClient as createIsolatedClient } from '@supabase/supabase-js';

import { clientEnv, isSupabaseConfigured } from '@/src/config/env/client';

/**
 * Proving, at the moment of the request, that the person at the keyboard is the
 * account holder.
 *
 * A valid session is not that proof. It is an hour old at worst and it travels
 * in a cookie that an unlocked laptop hands to anybody — which is fine for
 * reading a portfolio and not fine for destroying one. So the irreversible
 * action asks again, and it asks in whichever way the account can actually
 * answer:
 *
 *   * an account with a password re-enters it, and the password is checked
 *     against the provider rather than against anything we store;
 *   * an account that signs in with Google has no password to re-enter, so the
 *     proof is a *recent* sign-in with Google. That is real re-authentication —
 *     the provider was asked again, minutes ago — and it is the only form of it
 *     available to an account whose only credential lives at the provider.
 *
 * Neither path ever infers the method from the shape of the address. It is read
 * from the identity rows Supabase attaches to the account, which is the same
 * fact the password flows are gated on.
 */

/** The provider name Supabase gives an email + password identity. */
const PASSWORD_PROVIDER = 'email';

/**
 * How recently an OAuth-only account must have signed in.
 *
 * Long enough to open the settings page, read the warning and decide; short
 * enough that a session left open on a shared machine yesterday cannot delete
 * anything today.
 */
export const REAUTH_FRESHNESS_MS = 10 * 60_000;

export type ReauthMethod = 'password' | 'recent-sign-in';

/**
 * Structural rather than `User`, for the same reason `identity.ts` is: the only
 * field that decides this is `provider`, and demanding the provider's full
 * identity record would make the rule untestable without inventing fields that
 * play no part in it.
 */
interface IdentitiesLike {
  identities?: Array<{ provider?: unknown }> | null;
}

export function reauthMethodFor(user: IdentitiesLike | null | undefined): ReauthMethod {
  const providers = (user?.identities ?? [])
    .map((identity) => (typeof identity?.provider === 'string' ? identity.provider.toLowerCase() : null));
  return providers.includes(PASSWORD_PROVIDER) ? 'password' : 'recent-sign-in';
}

/** Whether the provider was asked for this session recently enough to count. */
export function signInIsFresh(
  lastSignInAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (typeof lastSignInAt !== 'string') return false;
  const signedIn = Date.parse(lastSignInAt);
  if (!Number.isFinite(signedIn)) return false;
  // A clock skew that puts the sign-in slightly in the future is still fresh; one
  // that puts it in the future by more than the window is not trusted at all.
  return now - signedIn < REAUTH_FRESHNESS_MS && signedIn - now < REAUTH_FRESHNESS_MS;
}

export type ReauthOutcome = 'verified' | 'rejected' | 'unavailable';

/**
 * Check a password without touching the caller's session.
 *
 * A deliberately isolated client: signing in on the request's own SSR client
 * would rotate the session cookie as a side effect of a *check*, and a wrong
 * password would then be one refresh away from looking like a sign-out. This one
 * persists nothing, reads no cookie and writes none.
 */
export async function verifyPassword(email: string, password: string): Promise<ReauthOutcome> {
  if (!isSupabaseConfigured) return 'unavailable';
  if (!email || !password) return 'rejected';

  const client = createIsolatedClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL as string,
    clientEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    // A rate limit is not a wrong password, and telling somebody their password
    // is wrong when we simply did not ask would send them to reset it.
    if (error.status === 429) return 'unavailable';
    return 'rejected';
  }
  if (!data.session) return 'rejected';

  // The session this check minted has done its one job. It is never written to a
  // cookie, and it is revoked immediately so no second token is left alive.
  await client.auth.signOut().catch(() => undefined);
  return 'verified';
}
