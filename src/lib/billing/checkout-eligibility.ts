/**
 * Who may buy what, decided before any provider is contacted.
 *
 * Pure and total: every refusal is a named value rather than a thrown string, so
 * the server action, the API surface and the tests all agree on the list. The
 * caller supplies facts it read from the session and the database; nothing here
 * trusts an argument that came from a browser except `planKey`, which is checked
 * against the allowlist as its first act.
 */

import {
  isBillingPaymentMethod,
  type BillingPaymentMethod,
} from './billing-payment-method';
import { billingPlan, isBillingPlanKey, type BillingPlanDefinition, type BillingPlanKey } from './billing-plans';

export const checkoutRefusalReasons = [
  /** No provider configured, or the deliberate off switch is set. */
  'billing-disabled',
  /** The key is not on the allowlist. The only thing a client can get wrong. */
  'unknown-plan',
  /** A real key, but this deployment has no price identifier for it. */
  'plan-unavailable',
  /** The rail is not one this product sells. The other client-supplied value. */
  'unknown-payment-method',
  /** A real rail, switched off in this deployment. */
  'payment-method-unavailable',
  'unauthenticated',
  /** A mailbox nobody has proved they own must not become a paying account. */
  'email-unverified',
  /** Founder's Club is one first period per account, forever. */
  'founder-already-used',
  /**
   * The account already has a live paid subscription. Buying a second one is
   * refused here — see the note on `hasLiveSubscription` below for why this is a
   * correctness rule rather than a convenience.
   */
  'already-subscribed',
  /**
   * A PromptPay invoice is open and still payable. Starting anything else now
   * would leave two payable subscriptions at the provider, of which our records
   * can honour exactly one — see `pendingPromptPayIsOpen`.
   */
  'promptpay-invoice-open',
] as const;
export type CheckoutRefusalReason = typeof checkoutRefusalReasons[number];

export type CheckoutEligibility =
  | { ok: true; plan: BillingPlanDefinition; paymentMethod: BillingPaymentMethod }
  | { ok: false; reason: CheckoutRefusalReason };

export interface CheckoutEligibilityInput {
  /** Straight from the request. Untrusted until it clears the allowlist. */
  planKey: unknown;
  /**
   * The other half of what a browser may send, and equally untrusted. It selects
   * a rail, never a price: both rails bill the same Price object, so this value
   * cannot change what anyone is charged.
   */
  paymentMethod: unknown;
  /** Which keys this deployment actually has a price identifier for. */
  availablePlanKeys: readonly BillingPlanKey[];
  /** Which rails this deployment will open a purchase on. */
  availablePaymentMethods: readonly BillingPaymentMethod[];
  billingEnabled: boolean;
  authenticated: boolean;
  emailVerified: boolean;
  /** Read from the account's own row, never from the request. */
  founderPromoApplied: boolean;
  /**
   * Whether the account already holds a subscription the provider is still
   * billing.
   *
   * One account is one subscription, everywhere below this gate: the row keeps a
   * single `billing_subscription_id`, and the database routine refuses — as
   * `subscription_mismatch` — any event naming a different one. A second
   * checkout therefore produces a second subscription at the provider whose
   * every event is rejected, which means the reader is charged for a plan they
   * are never granted, and then charged again each period for both.
   *
   * A plan change belongs on the subscription that already exists, which is what
   * the provider's billing portal does and what the webhook path is built to
   * receive.
   */
  hasLiveSubscription: boolean;
  /**
   * Whether a PromptPay invoice this account can still pay is outstanding.
   *
   * Read from the account's own pending row, never from the request. It is a
   * weaker fact than `hasLiveSubscription` — nothing has been granted and
   * nothing may ever be — but it carries the same hazard: the invoice can be
   * paid at any moment until it expires, and whichever subscription is paid
   * second is one our records will refuse as a mismatch.
   */
  hasOpenPromptPayInvoice: boolean;
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
  if (!isBillingPaymentMethod(input.paymentMethod)) {
    return { ok: false, reason: 'unknown-payment-method' };
  }
  if (!input.availablePaymentMethods.includes(input.paymentMethod)) {
    return { ok: false, reason: 'payment-method-unavailable' };
  }
  if (!input.authenticated) return { ok: false, reason: 'unauthenticated' };
  if (!input.emailVerified) return { ok: false, reason: 'email-unverified' };

  /*
   * Before the per-plan rules, because it does not depend on which plan was
   * asked for: while one subscription is live, no second one may be opened. This
   * is checked ahead of the Founder rule so that a subscriber who asks for a
   * Founder plan is told the useful thing — manage the plan you have — rather
   * than being told the promotion is spent.
   */
  if (input.hasLiveSubscription) return { ok: false, reason: 'already-subscribed' };

  /*
   * Immediately after, and for the same reason: an unpaid PromptPay invoice is a
   * purchase already in flight. It is refused ahead of the Founder rule so the
   * reader is told the actionable thing — pay or abandon the invoice you have —
   * rather than being told a promotion is spent that in fact is not.
   */
  if (input.hasOpenPromptPayInvoice) return { ok: false, reason: 'promptpay-invoice-open' };

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

  return { ok: true, plan, paymentMethod: input.paymentMethod };
}

/** What a reader is told. Never names an environment variable or a provider. */
const REFUSAL_MESSAGE: Readonly<Record<CheckoutRefusalReason, string>> = {
  'billing-disabled': 'ระบบชำระเงินยังไม่เปิดให้บริการ',
  'unknown-plan': 'ไม่พบแพ็กเกจที่เลือก กรุณาลองใหม่อีกครั้ง',
  'plan-unavailable': 'แพ็กเกจนี้ยังไม่เปิดให้สมัครในขณะนี้',
  'unknown-payment-method': 'ไม่พบวิธีชำระเงินที่เลือก กรุณาลองใหม่อีกครั้ง',
  'payment-method-unavailable': 'วิธีชำระเงินนี้ยังไม่เปิดให้ใช้งานในขณะนี้',
  unauthenticated: 'กรุณาเข้าสู่ระบบก่อนสมัครแพ็กเกจ',
  'email-unverified': 'ยืนยันอีเมลของคุณก่อน จึงจะสมัครแพ็กเกจได้',
  'founder-already-used': 'บัญชีนี้ใช้สิทธิ์ราคา Founder’s Club ไปแล้ว',
  'already-subscribed': 'บัญชีนี้มีแพ็กเกจที่ใช้งานอยู่แล้ว หากต้องการเปลี่ยนแพ็กเกจ กรุณาไปที่ “จัดการการชำระเงินและยกเลิก”',
  'promptpay-invoice-open': 'มีใบแจ้งหนี้ PromptPay ที่รอชำระอยู่ กรุณาสแกนจ่ายให้เสร็จ หรือยกเลิกใบแจ้งหนี้นั้นก่อนเริ่มรายการใหม่',
};

export function checkoutRefusalMessage(reason: CheckoutRefusalReason): string {
  return REFUSAL_MESSAGE[reason];
}
