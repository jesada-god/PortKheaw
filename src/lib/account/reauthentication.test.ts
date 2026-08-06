import { describe, expect, it } from 'vitest';
import { REAUTH_FRESHNESS_MS, reauthMethodFor, signInIsFresh } from './reauthentication';

/**
 * Which proof an account can give, and whether it has given it recently enough.
 *
 * The rule that matters in both: the answer comes from the identity rows the
 * provider attached to the account, never from the shape of the address. A
 * `@gmail.com` account created with a password re-enters that password; a Google
 * account on a company domain does not have one to re-enter.
 */

const identity = (provider: string) => ({ provider, id: 'x', identity_data: {} });

describe('which proof is asked for', () => {
  it('asks a password account for its password', () => {
    expect(reauthMethodFor({ identities: [identity('email')] })).toBe('password');
    // Both credentials on one account: there is a password, so it is asked for.
    expect(reauthMethodFor({ identities: [identity('google'), identity('email')] })).toBe('password');
  });

  it('asks a Google-only account for a recent sign-in instead', () => {
    expect(reauthMethodFor({ identities: [identity('google')] })).toBe('recent-sign-in');
  });

  it('never decides from the address, and never guesses when it knows nothing', () => {
    // No identities at all is not a password account. Falling back to "password"
    // would render a field nobody can fill and lock the account out of its own
    // deletion.
    expect(reauthMethodFor({ identities: [] })).toBe('recent-sign-in');
    expect(reauthMethodFor(null)).toBe('recent-sign-in');
    expect(reauthMethodFor({ identities: [identity('GOOGLE')] })).toBe('recent-sign-in');
    expect(reauthMethodFor({ identities: [identity('EMAIL')] })).toBe('password');
  });
});

describe('whether the sign-in is recent enough to count', () => {
  const now = Date.parse('2026-08-06T12:00:00.000Z');
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  it('accepts a sign-in inside the window and refuses one outside it', () => {
    expect(signInIsFresh(at(-60_000), now)).toBe(true);
    expect(signInIsFresh(at(-(REAUTH_FRESHNESS_MS - 1_000)), now)).toBe(true);
    expect(signInIsFresh(at(-(REAUTH_FRESHNESS_MS + 1_000)), now)).toBe(false);
    // A session from this morning proves who was at the keyboard this morning.
    expect(signInIsFresh(at(-6 * 3_600_000), now)).toBe(false);
  });

  it('tolerates a little clock skew and refuses a lot', () => {
    expect(signInIsFresh(at(30_000), now)).toBe(true);
    expect(signInIsFresh(at(REAUTH_FRESHNESS_MS + 60_000), now)).toBe(false);
  });

  it('refuses anything it cannot read as a time', () => {
    for (const value of [null, undefined, '', 'yesterday', '2026-13-45T99:99:99Z']) {
      expect(signInIsFresh(value, now)).toBe(false);
    }
  });
});
