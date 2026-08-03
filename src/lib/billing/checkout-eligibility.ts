/**
 * Who may buy what, decided before any provider is contacted.
 *
 * Pure and total: every refusal is a named value rather than a thrown string, so
 * the server action, the API surface and the tests all agree on the list. The
 * caller supplies facts it read from the session and the database; nothing here
 * trusts an argument that came from a browser except `planKey`, which is checked
 * against the allowlist as its first act.
 */

import { billingPlan, isBillingPlanKey, type BillingPlanDefinition, type BillingPlanKey } from './billing-plans';

export const checkoutRefusalReasons = [
  /** No provider configured, or the deliberate off switch is set. */
  'billing-disabled',
  /** The key is not on the allowlist. The only thing a client can get wrong. */
  'unknown-plan',
  /** A real key, but this deployment has no price identifier for it. */
  'plan-unavailable',
  'unauthenticated',
  /** A mailbox nobody has proved they own must not become a paying account. */
  'email-unverified',
  /** Founder's Club is one first period per account, forever. */
  'founder-already-used',
] as const;
export type CheckoutRefusalReason = typeof checkoutRefusalReasons[number];

export type CheckoutEligibility =
  | { ok: true; plan: BillingPlanDefinition }
  | { ok: false; reason: CheckoutRefusalReason };

export interface CheckoutEligibilityInput {
  /** Straight from the request. Untrusted until it clears the allowlist. */
  planKey: unknown;
  /** Which keys this deployment actually has a price identifier for. */
  availablePlanKeys: readonly BillingPlanKey[];
  billingEnabled: boolean;
  authenticated: boolean;
  emailVerified: boolean;
  /** Read from the account's own row, never from the request. */
  founderPromoApplied: boolean;
}

/**
 * The gate.
 *
 * Order matters: configuration first, then the input allowlist, then identity,
 * then the per-account rule. That way a malformed key is refused before we have
 * looked anything up, and an unauthenticated caller learns nothing about which
 * plans exist.
 */
export function resolveCheckoutEligibility(input: CheckoutEligibilityInput): CheckoutEligibility {
  if (!input.billingEnabled) return { ok: false, reason: 'billing-disabled' };
  if (!isBillingPlanKey(input.planKey)) return { ok: false, reason: 'unknown-plan' };
  if (!input.availablePlanKeys.includes(input.planKey)) return { ok: false, reason: 'plan-unavailable' };
  if (!input.authenticated) return { ok: false, reason: 'unauthenticated' };
  if (!input.emailVerified) return { ok: false, reason: 'email-unverified' };

  const plan = billingPlan(input.planKey);

  /*
   * The Founder rule is enforced against the account's stored flag, which only
   * the webhook can set. A reader who has already had a discounted first period
   * is refused here rather than being sent to a checkout that would quietly
   * discount a second one.
   */
  if (plan.founder && input.founderPromoApplied) {
    return { ok: false, reason: 'founder-already-used' };
  }

  return { ok: true, plan };
}

/** What a reader is told. Never names an environment variable or a provider. */
const REFUSAL_MESSAGE: Readonly<Record<CheckoutRefusalReason, string>> = {
  'billing-disabled': 'ระบบชำระเงินยังไม่เปิดให้บริการ',
  'unknown-plan': 'ไม่พบแพ็กเกจที่เลือก กรุณาลองใหม่อีกครั้ง',
  'plan-unavailable': 'แพ็กเกจนี้ยังไม่เปิดให้สมัครในขณะนี้',
  unauthenticated: 'กรุณาเข้าสู่ระบบก่อนสมัครแพ็กเกจ',
  'email-unverified': 'ยืนยันอีเมลของคุณก่อน จึงจะสมัครแพ็กเกจได้',
  'founder-already-used': 'บัญชีนี้ใช้สิทธิ์ราคา Founder’s Club ไปแล้ว',
};

export function checkoutRefusalMessage(reason: CheckoutRefusalReason): string {
  return REFUSAL_MESSAGE[reason];
}
