import { describe, expect, it } from 'vitest';
import {
  authMethods,
  hasPasswordIdentity,
  hasRecoveryAssurance,
  identityProviders,
  isOAuthOnlyAccount,
} from './identity';

const googleOnlyUser = { identities: [{ provider: 'google' }] };
const passwordUser = { identities: [{ provider: 'email' }] };
const linkedUser = { identities: [{ provider: 'email' }, { provider: 'google' }] };

describe('account identity', () => {
  it('reads the provider from the identity rows, never from the email domain', () => {
    // The address says gmail; the account is a password account. Domain sniffing
    // would get this exactly backwards.
    const gmailPasswordUser = { email: 'someone@gmail.com', identities: [{ provider: 'email' }] };
    expect(hasPasswordIdentity(gmailPasswordUser)).toBe(true);
    expect(isOAuthOnlyAccount(gmailPasswordUser)).toBe(false);
  });

  it('classifies a Google-only account as having no password identity', () => {
    expect(hasPasswordIdentity(googleOnlyUser)).toBe(false);
    expect(isOAuthOnlyAccount(googleOnlyUser)).toBe(true);
  });

  it('treats an account holding both identities as a password account', () => {
    expect(hasPasswordIdentity(linkedUser)).toBe(true);
    expect(isOAuthOnlyAccount(linkedUser)).toBe(false);
  });

  it('fails closed when the identity list is missing, empty or malformed', () => {
    for (const user of [null, undefined, {}, { identities: null }, { identities: [] }, { identities: [{}] }]) {
      expect(hasPasswordIdentity(user as never)).toBe(false);
    }
    expect(identityProviders({ identities: [{ provider: 42 }] } as never)).toEqual([]);
  });

  it('normalises provider case so a capitalised row is not mistaken for a different provider', () => {
    expect(identityProviders({ identities: [{ provider: 'EMAIL' }] })).toEqual(['email']);
    expect(hasPasswordIdentity({ identities: [{ provider: 'Email' }] })).toBe(true);
  });
});

describe('recovery assurance', () => {
  it('accepts the session Supabase actually mints from a recovery link', () => {
    // Measured against this project with `npm run probe:auth-recovery`:
    // verifying a recovery token produces amr [{ method: 'otp' }].
    expect(hasRecoveryAssurance({ amr: [{ method: 'otp', timestamp: 1785439612 }] })).toBe(true);
  });

  it('accepts the other names GoTrue uses for the same mailbox proof', () => {
    for (const method of ['recovery', 'magiclink', 'invite', 'email_change']) {
      expect(hasRecoveryAssurance({ amr: [{ method }] })).toBe(true);
    }
  });

  it('rejects an ordinary password session — the control case for the whole gate', () => {
    // Also measured: signing in with a password produces amr [{ method: 'password' }].
    expect(hasRecoveryAssurance({ amr: [{ method: 'password', timestamp: 1785439691 }] })).toBe(false);
  });

  it('rejects a Google session, so signing in with Google is not a way to reach the password form', () => {
    expect(hasRecoveryAssurance({ amr: [{ method: 'oauth' }] })).toBe(false);
    expect(hasRecoveryAssurance({ amr: [{ method: 'sso/saml' }] })).toBe(false);
  });

  it('rejects a session with no methods at all', () => {
    for (const claims of [null, undefined, {}, { amr: [] }, { amr: 'otp' }, { amr: [null] }]) {
      expect(hasRecoveryAssurance(claims as never)).toBe(false);
    }
  });

  it('reads both the RFC-8176 string form and the timestamped object form', () => {
    expect(authMethods({ amr: ['otp', 'password'] })).toEqual(['otp', 'password']);
    expect(authMethods({ amr: [{ method: 'OTP' }] })).toEqual(['otp']);
    expect(hasRecoveryAssurance({ amr: ['otp'] })).toBe(true);
  });

  it('still qualifies when a refresh appends token_refresh to the original method', () => {
    expect(hasRecoveryAssurance({ amr: [{ method: 'otp' }, { method: 'token_refresh' }] })).toBe(true);
    // token_refresh alone proves nothing.
    expect(hasRecoveryAssurance({ amr: [{ method: 'token_refresh' }] })).toBe(false);
  });
});
