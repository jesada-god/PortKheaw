import { describe, expect, it } from 'vitest';
import {
  EXPIRED_LINK_ERROR,
  GENERIC_AUTH_ERROR,
  OFFLINE_ERROR,
  RATE_LIMITED_ERROR,
  describeAuthError,
  describeOAuthCallbackError,
} from './errors';

const CONTEXTS = ['sign-in', 'sign-up', 'forgot-password', 'reset-password', 'oauth'] as const;

/** True when the string contains at least one character in the Thai block. */
function isThai(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x0e00 && code <= 0x0e7f;
  });
}

describe('describeAuthError', () => {
  it('never forwards provider text, however alarming the payload is', () => {
    const leaky = {
      code: 'unexpected_failure',
      status: 500,
      message: 'Database error saving new user: duplicate key value violates unique constraint "profiles_pkey"',
      stack: 'at GoTrueClient.signUp (/app/node_modules/...)',
    };
    for (const context of CONTEXTS) {
      const shown = describeAuthError(leaky, context);
      expect(shown).not.toContain('Database');
      expect(shown).not.toContain('profiles_pkey');
      expect(shown).not.toContain('node_modules');
      expect(shown).not.toContain('constraint');
      // Thai only — a raw English provider sentence would fail this.
      expect(isThai(shown)).toBe(true);
    }
  });

  it('gives one indistinguishable answer for a wrong password and an unknown address', () => {
    const wrongPassword = describeAuthError({ code: 'invalid_credentials', status: 400 }, 'sign-in');
    const unknownAddress = describeAuthError({ code: 'invalid_credentials', status: 400 }, 'sign-in');
    expect(wrongPassword).toBe(unknownAddress);
    expect(wrongPassword).toBe('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  });

  it('reports a spent or forged link as expired rather than as a login failure', () => {
    for (const code of ['otp_expired', 'flow_state_expired', 'flow_state_not_found', 'bad_code_verifier']) {
      expect(describeAuthError({ code, status: 401 }, 'reset-password')).toBe(EXPIRED_LINK_ERROR);
    }
  });

  it('recognises rate limiting from either the code or a 429', () => {
    expect(describeAuthError({ code: 'over_email_send_rate_limit', status: 429 }, 'forgot-password')).toBe(RATE_LIMITED_ERROR);
    expect(describeAuthError({ code: 'something_else', status: 429 }, 'sign-in')).toBe(RATE_LIMITED_ERROR);
  });

  it('separates being offline from the provider rejecting the request', () => {
    expect(describeAuthError({ name: 'AuthRetryableFetchError', status: 0 }, 'sign-in')).toBe(OFFLINE_ERROR);
    expect(describeAuthError(new TypeError('Failed to fetch'), 'sign-in')).toBe(OFFLINE_ERROR);
  });

  it('explains an unconfirmed address instead of claiming the password is wrong', () => {
    expect(describeAuthError({ code: 'email_not_confirmed', status: 400 }, 'sign-in')).toContain('ยืนยันอีเมล');
  });

  it('points a rejected password at the checklist', () => {
    expect(describeAuthError({ code: 'weak_password', status: 422 }, 'reset-password')).toContain('เกณฑ์ความปลอดภัย');
  });

  it('falls back to a neutral sentence for anything it has never seen', () => {
    expect(describeAuthError({ code: 'brand_new_code_from_the_future' }, 'forgot-password')).toBe(GENERIC_AUTH_ERROR);
    expect(describeAuthError(null, 'forgot-password')).toBe(GENERIC_AUTH_ERROR);
    expect(describeAuthError('a bare string', 'forgot-password')).toBe(GENERIC_AUTH_ERROR);
  });
});

describe('describeOAuthCallbackError', () => {
  it('treats a cancelled consent screen as a cancellation, not a failure', () => {
    const params = new URLSearchParams({ error: 'access_denied', error_description: 'The user denied the request' });
    const shown = describeOAuthCallbackError(params);
    expect(shown).toContain('ยกเลิก');
    expect(shown).not.toContain('denied');
  });

  it('never renders the attacker-supplied description that came with the redirect', () => {
    const params = new URLSearchParams({
      error: 'server_error',
      error_description: '<img src=x onerror=alert(1)>',
    });
    const shown = describeOAuthCallbackError(params);
    expect(shown).not.toContain('<img');
    expect(shown).not.toContain('onerror');
  });

  it('answers an empty callback with the generic OAuth failure', () => {
    expect(describeOAuthCallbackError(new URLSearchParams())).toContain('Google');
  });
});
