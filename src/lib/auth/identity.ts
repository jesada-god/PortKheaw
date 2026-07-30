/**
 * Answers the two questions the password flows are gated on:
 *
 *   "does this account sign in with a password at all?" and
 *   "did this visitor prove control of the mailbox to get here?"
 *
 * Both are read from provider-issued facts — the identity rows Supabase
 * attaches to the user and the `amr` claim of the verified access token. Neither
 * is ever inferred from a query parameter, a form field, or the shape of the
 * email address: `someone@gmail.com` is not a Google account, and an account
 * created with Google is not identified by its domain.
 */

/** The provider name Supabase gives an email + password identity. */
export const PASSWORD_PROVIDER = 'email';

interface IdentityLike {
  provider?: unknown;
}

interface UserLike {
  identities?: IdentityLike[] | null;
}

export function identityProviders(user: UserLike | null | undefined): string[] {
  if (!user || !Array.isArray(user.identities)) return [];
  return user.identities
    .map((identity) => (typeof identity?.provider === 'string' ? identity.provider.toLowerCase() : null))
    .filter((provider): provider is string => provider !== null);
}

/**
 * True only when Supabase actually holds a password identity for this user.
 *
 * This is the gate that stops a Google-only account from growing a password:
 * a recovery link proves the mailbox, but `updateUser({ password })` on an
 * OAuth-only user would *create* a second way into the account that its owner
 * never asked for, and would do it for whoever happens to reach the mailbox.
 */
export function hasPasswordIdentity(user: UserLike | null | undefined): boolean {
  return identityProviders(user).includes(PASSWORD_PROVIDER);
}

/** True when the account exists but has no password identity at all. */
export function isOAuthOnlyAccount(user: UserLike | null | undefined): boolean {
  const providers = identityProviders(user);
  return providers.length > 0 && !providers.includes(PASSWORD_PROVIDER);
}

interface ClaimsLike {
  amr?: unknown;
}

/**
 * Authentication methods that require possession of the mailbox: Supabase
 * labels a session minted from an emailed link `otp` (measured against this
 * project with `npm run probe:auth-recovery`), and older/other GoTrue builds
 * use the more specific names below for the same class of proof. `password`,
 * `oauth`, `sso/saml`, `anonymous` and `totp` are deliberately absent — an
 * ordinary logged-in session must never be enough to set a new password.
 */
const MAILBOX_PROOF_METHODS = new Set(['otp', 'recovery', 'magiclink', 'email_change', 'invite', 'email_otp']);

export function authMethods(claims: ClaimsLike | null | undefined): string[] {
  const amr = claims?.amr;
  if (!Array.isArray(amr)) return [];
  return amr
    .map((entry) => {
      if (typeof entry === 'string') return entry.toLowerCase();
      if (entry && typeof entry === 'object' && typeof (entry as { method?: unknown }).method === 'string') {
        return ((entry as { method: string }).method).toLowerCase();
      }
      return null;
    })
    .filter((method): method is string => method !== null);
}

/**
 * True when the session in hand was established by following an emailed link.
 * A session obtained by typing a password, or by signing in with Google, does
 * not qualify — which is what makes "open /auth/reset-password while logged in"
 * a dead end rather than a way to change the password without re-proving
 * anything.
 */
export function hasRecoveryAssurance(claims: ClaimsLike | null | undefined): boolean {
  return authMethods(claims).some((method) => MAILBOX_PROOF_METHODS.has(method));
}
