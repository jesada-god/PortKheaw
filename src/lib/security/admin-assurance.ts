/**
 * Second-factor assurance for the operator console.
 *
 * The threat this answers is narrow and specific: **a stolen ordinary session.**
 * Every other layer in this product assumes the session cookie proves who is
 * asking, and for a reader that is fine — the blast radius is their own
 * portfolio. For an operator it is not: one borrowed laptop, one leaked cookie,
 * one XSS on an unrelated page, and the console that changes roles, overrides
 * plans and takes the product offline opens with no further questions.
 *
 * So the console requires a second factor to have been used *in this session* —
 * Supabase's `aal2` — not merely to have been enrolled at some point. That
 * distinction is the whole mechanism. A stolen cookie carries `aal1`; it cannot
 * be upgraded without the factor, and the factor is not in the cookie.
 *
 * Two things this module refuses to do:
 *
 *   * **It has no bypass.** There is no environment variable, no header, no
 *     build flag and no code constant that satisfies the requirement. The only
 *     way to `aal2` is to present a factor Supabase verifies. A gate with an
 *     escape hatch is a gate with a published exploit.
 *   * **It never touches an ordinary reader.** The requirement is scoped to
 *     accounts the database calls operators, and only on operator surfaces. A
 *     Basic reader signing in has exactly the experience they had before.
 *
 * This module is pure and runtime-agnostic (no `server-only`, no Node built-in)
 * because the same decision has to be made in Edge middleware, in a Node server
 * action, and in a test.
 */

export type AssuranceLevel = 'aal1' | 'aal2';

/**
 * What the caller must do before the console will open.
 *
 *   `not-admin`  — nothing; they are not an operator and this rule is not theirs.
 *   `enroll`     — an operator with no verified factor. They must add one.
 *   `verify`     — an operator with a factor who has not used it this session.
 *   `satisfied`  — an operator at `aal2`.
 */
export type AssuranceRequirement = 'not-admin' | 'enroll' | 'verify' | 'satisfied';

export interface AssuranceInput {
  isAdmin: boolean;
  /** The `aal` claim of the access token, once that token has been verified. */
  currentLevel: AssuranceLevel | null;
  /** Whether the account has at least one factor Supabase reports as verified. */
  hasVerifiedFactor: boolean;
}

export interface AssuranceState extends AssuranceInput {
  requirement: AssuranceRequirement;
  /** True only for an operator who has actually presented a second factor. */
  satisfied: boolean;
}

/**
 * The decision, in one place, from three facts.
 *
 * Note what an unreadable `currentLevel` resolves to: not `aal2`. A token whose
 * assurance could not be determined is not evidence a factor was used, and the
 * console stays shut. Every failure path in every caller lands on `aal1`.
 */
export function decideAssurance(input: AssuranceInput): AssuranceState {
  if (!input.isAdmin) {
    return { ...input, requirement: 'not-admin', satisfied: false };
  }
  if (input.currentLevel === 'aal2') {
    return { ...input, requirement: 'satisfied', satisfied: true };
  }
  return {
    ...input,
    requirement: input.hasVerifiedFactor ? 'verify' : 'enroll',
    satisfied: false,
  };
}

/**
 * The `aal` claim, read out of an access token.
 *
 * This decodes; it does not verify. That is safe **only** because every caller
 * has already proved the same token authentic by calling `auth.getUser()`, which
 * checks it against the auth server. Decoding an unverified token to make a
 * security decision would be trusting the caller to state their own assurance
 * level, so the ordering in the callers is not incidental — it is the reason
 * this function is allowed to exist.
 *
 * Anything unparseable, absent, or not one of the two known levels is `aal1`,
 * never `null` and never `aal2`.
 */
export function assuranceLevelFromToken(accessToken: string | null | undefined): AssuranceLevel {
  if (!accessToken) return 'aal1';
  const segments = accessToken.split('.');
  if (segments.length < 2) return 'aal1';
  try {
    const payload = JSON.parse(base64UrlDecode(segments[1])) as { aal?: unknown };
    return payload.aal === 'aal2' ? 'aal2' : 'aal1';
  } catch {
    return 'aal1';
  }
}

/**
 * base64url → UTF-8. `atob` exists in every runtime this product targets (Edge,
 * Node 18+, jsdom) and handles the padding-free variant once the alphabet is
 * translated back.
 */
function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Supabase's factor shape, narrowed to the two fields this decision needs. */
export interface MfaFactorLike {
  status?: string | null;
  factor_type?: string | null;
  id?: string | null;
  friendly_name?: string | null;
}

/**
 * Whether the account holds a factor that can actually be used.
 *
 * `verified` is the only status that counts. An `unverified` factor is an
 * enrollment somebody started and abandoned — treating it as a factor would mean
 * an operator who opened the enrollment page once could never finish, because
 * the console would demand they verify something they never completed.
 */
export function hasVerifiedFactor(factors: readonly MfaFactorLike[] | null | undefined): boolean {
  return (factors ?? []).some((factor) => factor.status === 'verified');
}

/**
 * The console path an operator is sent to when the requirement is unmet, and the
 * one path under `/admin` that the requirement does not apply to.
 *
 * It has to be exempt or the rule is unsatisfiable: the page where a factor is
 * enrolled and verified cannot itself demand a verified factor. It is still
 * behind the operator check — a non-operator gets the same bare 404 there as
 * anywhere else under `/admin` — so the exemption widens nothing except for
 * people who are already administrators.
 */
export const ADMIN_SECURITY_PATH = '/admin/security';

export function isAssuranceExemptAdminPath(pathname: string): boolean {
  return pathname === ADMIN_SECURITY_PATH || pathname.startsWith(`${ADMIN_SECURITY_PATH}/`);
}

/** What an operator is told when an action needs a factor they have not presented. */
export const ASSURANCE_DENIAL_MESSAGE =
  'การทำรายการนี้ต้องยืนยันตัวตนสองชั้น กรุณายืนยันที่หน้าความปลอดภัยผู้ดูแลระบบก่อน';

/**
 * The sentences an operator is shown. Deliberately plain: this is not a refusal
 * of *them*, it is a step they have to complete, and the copy should read like
 * an instruction rather than an accusation.
 */
export const ASSURANCE_COPY: Readonly<Record<'enroll' | 'verify', { title: string; detail: string }>> = {
  enroll: {
    title: 'ตั้งค่ายืนยันตัวตนสองชั้นก่อนใช้งานคอนโซล',
    detail: 'บัญชีผู้ดูแลระบบต้องเปิดใช้ยืนยันตัวตนสองชั้น (2FA) ก่อนเข้าถึงเครื่องมือผู้ดูแล',
  },
  verify: {
    title: 'ยืนยันตัวตนสองชั้นเพื่อเข้าใช้งานคอนโซล',
    detail: 'กรุณากรอกรหัส 6 หลักจากแอปยืนยันตัวตนของคุณเพื่อดำเนินการต่อ',
  },
};
