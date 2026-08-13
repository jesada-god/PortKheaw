import { describe, expect, it } from 'vitest';
import {
  ADMIN_SECURITY_PATH,
  assuranceLevelFromToken,
  decideAssurance,
  hasVerifiedFactor,
  isAssuranceExemptAdminPath,
} from './admin-assurance';

/**
 * The second-factor decision, and the ways it must fail.
 *
 * The threat is a **stolen ordinary session**: a cookie that is genuinely valid,
 * genuinely belongs to an administrator, and was obtained by somebody else. Every
 * other gate in this product opens for it. This one must not, and the cases
 * below are written to catch the specific ways a gate like this gets quietly
 * weakened — a decode that trusts the token, a default that resolves upward, an
 * unverified enrolment counted as a factor, an exemption that grows.
 */

function token(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${encoded}.not-a-real-signature`;
}

describe('deciding whether the console may open', () => {
  it('opens only for an operator who has actually presented a factor', () => {
    const state = decideAssurance({ isAdmin: true, currentLevel: 'aal2', hasVerifiedFactor: true });
    expect(state.satisfied).toBe(true);
    expect(state.requirement).toBe('satisfied');
  });

  it('sends an operator with a factor to present it', () => {
    const state = decideAssurance({ isAdmin: true, currentLevel: 'aal1', hasVerifiedFactor: true });
    expect(state.satisfied).toBe(false);
    expect(state.requirement).toBe('verify');
  });

  it('sends an operator without a factor to enrol one', () => {
    const state = decideAssurance({ isAdmin: true, currentLevel: 'aal1', hasVerifiedFactor: false });
    expect(state.satisfied).toBe(false);
    expect(state.requirement).toBe('enroll');
  });

  /*
   * The requirement belongs to operators. An ordinary reader must never meet it,
   * on any surface — a product that starts demanding a second factor of everyone
   * because an admin gate leaked into the shared path is a worse outcome than
   * the one being prevented.
   */
  it('is not an ordinary reader\'s requirement, at any assurance level', () => {
    for (const level of ['aal1', 'aal2', null] as const) {
      const state = decideAssurance({ isAdmin: false, currentLevel: level, hasVerifiedFactor: false });
      expect(`${level}: ${state.requirement}`).toBe(`${level}: not-admin`);
      expect(state.satisfied).toBe(false);
    }
  });

  /*
   * Fail closed. An assurance level that could not be read is not evidence that
   * a factor was used — the safe answer is the one that keeps the console shut,
   * and it must never be `satisfied`.
   */
  it('treats an unreadable assurance level as unmet, never as met', () => {
    const state = decideAssurance({ isAdmin: true, currentLevel: null, hasVerifiedFactor: true });
    expect(state.satisfied).toBe(false);
    expect(state.requirement).toBe('verify');
  });
});

describe('reading the assurance level out of a token', () => {
  it('reads aal2 when the claim says so', () => {
    expect(assuranceLevelFromToken(token({ aal: 'aal2', sub: 'u1' }))).toBe('aal2');
  });

  /*
   * Everything unparseable resolves DOWN. A malformed, truncated, absent or
   * unexpected claim must never be read as a satisfied requirement — that is the
   * difference between a gate and a suggestion.
   */
  it('resolves everything it cannot read down to aal1', () => {
    for (const candidate of [
      null,
      undefined,
      '',
      'not-a-jwt',
      'only.two',
      token({ sub: 'u1' }),
      token({ aal: 'aal1' }),
      token({ aal: 'AAL2' }),
      token({ aal: 3 }),
      token({ aal: ['aal2'] }),
      token({ aal: { level: 'aal2' } }),
      'eyJhbGciOiJIUzI1NiJ9.!!!not-base64!!!.sig',
    ]) {
      expect(`${String(candidate).slice(0, 24)} -> ${assuranceLevelFromToken(candidate)}`)
        .toBe(`${String(candidate).slice(0, 24)} -> aal1`);
    }
  });

  it('does not throw on a payload that is valid base64 but not JSON', () => {
    const junk = Buffer.from('not json at all').toString('base64url');
    expect(assuranceLevelFromToken(`header.${junk}.sig`)).toBe('aal1');
  });
});

describe('what counts as an enrolled factor', () => {
  it('counts only a verified one', () => {
    expect(hasVerifiedFactor([{ status: 'verified' }])).toBe(true);
    expect(hasVerifiedFactor([{ status: 'verified' }, { status: 'unverified' }])).toBe(true);
  });

  /*
   * An abandoned enrolment leaves an `unverified` factor behind. Counting it
   * would demand that the operator verify something they never finished setting
   * up, which is a lockout with no way out of it.
   */
  it('does not count an abandoned enrolment', () => {
    expect(hasVerifiedFactor([{ status: 'unverified' }])).toBe(false);
    expect(hasVerifiedFactor([])).toBe(false);
    expect(hasVerifiedFactor(null)).toBe(false);
    expect(hasVerifiedFactor(undefined)).toBe(false);
  });
});

describe('the one exempt console path', () => {
  it('exempts the security page, because it is where the factor is presented', () => {
    expect(isAssuranceExemptAdminPath(ADMIN_SECURITY_PATH)).toBe(true);
    expect(isAssuranceExemptAdminPath(`${ADMIN_SECURITY_PATH}/recovery`)).toBe(true);
  });

  it('exempts nothing else under the console', () => {
    for (const path of [
      '/admin', '/admin/system', '/admin/billing', '/admin/beta',
      '/admin/refunds', '/admin/support',
    ]) {
      expect(`${path}: ${isAssuranceExemptAdminPath(path)}`).toBe(`${path}: false`);
    }
  });

  /*
   * A prefix match on a bare string would exempt `/admin/security-settings` and
   * anything else somebody names similarly. The exemption is the single weakest
   * point in this design and must not be widenable by choosing a path name.
   */
  it('cannot be widened by a path that merely starts with the same letters', () => {
    expect(isAssuranceExemptAdminPath('/admin/security-bypass')).toBe(false);
    expect(isAssuranceExemptAdminPath('/admin/securityx')).toBe(false);
  });
});

describe('there is no way in that is not a factor', () => {
  /*
   * Read as source. The point is not that today's code has no bypass — it is
   * that adding one is a visible, deliberate act that fails this test, rather
   * than a debugging shortcut somebody leaves in.
   */
  it('has no environment flag, header or constant that satisfies the requirement', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    /*
     * Comments are stripped before scanning. These files *discuss* bypasses at
     * length — explaining why there is none is most of what their documentation
     * does — and a scanner that reads prose would either fail on the explanation
     * or have to be weakened until it matched nothing. What is asserted is the
     * executable text.
     */
    const executable = (source: string): string => source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    for (const file of [
      'src/lib/security/admin-assurance.ts',
      'src/lib/security/admin-assurance-server.ts',
      'src/lib/security/admin-assurance-edge.ts',
    ]) {
      const code = executable(readFileSync(resolve(process.cwd(), file), 'utf8'));
      // No environment can turn the requirement off.
      expect(`${file}: ${/process\.env/.test(code)}`).toBe(`${file}: false`);
      expect(`${file}: ${/BYPASS|SKIP_MFA|DISABLE_MFA|OVERRIDE|ALLOW_AAL1/i.test(code)}`).toBe(`${file}: false`);
      // Assurance is never taken from something the caller sends.
      expect(`${file}: ${/headers\(\)\.get|searchParams|formData/.test(code)}`).toBe(`${file}: false`);
    }
  });
});
