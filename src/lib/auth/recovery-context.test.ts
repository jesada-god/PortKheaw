import { describe, expect, it } from 'vitest';
import { RECOVERY_CONTEXT_MESSAGE, resolveRecoveryContext } from './recovery-context';

const RECOVERY_CLAIMS = { data: { claims: { amr: [{ method: 'otp', timestamp: 1785439612 }] } } };
const PASSWORD_CLAIMS = { data: { claims: { amr: [{ method: 'password', timestamp: 1785439691 }] } } };
const GOOGLE_CLAIMS = { data: { claims: { amr: [{ method: 'oauth' }] } } };

function clientFor(user: unknown, claims: unknown) {
  return {
    auth: {
      getUser: async () => ({ data: { user } }),
      getClaims: async () => claims as never,
    },
  };
}

const passwordUser = { id: 'u1', identities: [{ provider: 'email' }] };
const googleOnlyUser = { id: 'u2', identities: [{ provider: 'google' }] };

describe('resolveRecoveryContext', () => {
  it('is ready only for a recovery session on a password account', async () => {
    expect(await resolveRecoveryContext(clientFor(passwordUser, RECOVERY_CLAIMS))).toBe('ready');
  });

  it('refuses a Google-only account even with a genuine recovery session', async () => {
    expect(await resolveRecoveryContext(clientFor(googleOnlyUser, RECOVERY_CLAIMS))).toBe('oauth-only');
  });

  it('refuses an ordinary password session that never followed a recovery link', async () => {
    expect(await resolveRecoveryContext(clientFor(passwordUser, PASSWORD_CLAIMS))).toBe('not-recovery');
  });

  it('refuses a Google sign-in session', async () => {
    expect(await resolveRecoveryContext(clientFor(googleOnlyUser, GOOGLE_CLAIMS))).toBe('not-recovery');
  });

  it('refuses when there is no session', async () => {
    expect(await resolveRecoveryContext(clientFor(null, { data: null }))).toBe('no-session');
  });

  it('has a message for every refusal, so the page never renders an empty explanation', () => {
    for (const context of ['no-session', 'not-recovery', 'oauth-only'] as const) {
      expect(RECOVERY_CONTEXT_MESSAGE[context].length).toBeGreaterThan(10);
    }
    // The Google-only case must not be described as an expired link: it will
    // never work, however many new links are requested.
    expect(RECOVERY_CONTEXT_MESSAGE['oauth-only']).not.toBe(RECOVERY_CONTEXT_MESSAGE['no-session']);
  });
});
