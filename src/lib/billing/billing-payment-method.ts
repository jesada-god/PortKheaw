/**
 * How a subscription is paid for, and what that choice actually commits a reader
 * to.
 *
 * There are two rails in this product and they are not variations of one flow —
 * they differ in the only way a buyer cares about:
 *
 *   * `card` is a stored credential. The provider charges it again every period
 *     without anybody doing anything, so the subscription renews on its own.
 *   * `promptpay` is a bank transfer against an invoice. Nothing is stored, so
 *     **nothing renews by itself**: each period produces a new invoice and the
 *     reader has to scan a new QR to keep their plan.
 *
 * That difference is a product fact, not an implementation detail, so the
 * sentence a reader is shown before they choose lives here beside the enum
 * rather than in a component — the plan cards, the manage card and the pending
 * invoice card all say the same thing because they all read these strings.
 *
 * Pure: no provider import, no environment, no I/O.
 */

import type { BillingInterval } from './billing-plans';

/**
 * The closed allowlist a browser may name. Anything else is refused before a
 * provider is contacted, exactly like a plan key.
 */
export const billingPaymentMethods = ['card', 'promptpay'] as const;
export type BillingPaymentMethod = typeof billingPaymentMethods[number];

export function isBillingPaymentMethod(value: unknown): value is BillingPaymentMethod {
  return typeof value === 'string' && (billingPaymentMethods as readonly string[]).includes(value);
}

/**
 * How the provider collects for each rail.
 *
 * PromptPay cannot be charged automatically — there is no credential to keep —
 * so a PromptPay subscription is always `send_invoice`, and that is precisely
 * what makes it a per-period scan rather than a renewal. The mapping is stated
 * once here because entitlement gating in the webhook keys off it.
 */
export const billingCollectionMethods = ['charge_automatically', 'send_invoice'] as const;
export type BillingCollectionMethod = typeof billingCollectionMethods[number];

const COLLECTION_METHOD: Readonly<Record<BillingPaymentMethod, BillingCollectionMethod>> = {
  card: 'charge_automatically',
  promptpay: 'send_invoice',
};

export function collectionMethodFor(method: BillingPaymentMethod): BillingCollectionMethod {
  return COLLECTION_METHOD[method];
}

export function isBillingCollectionMethod(value: unknown): value is BillingCollectionMethod {
  return typeof value === 'string'
    && (billingCollectionMethods as readonly string[]).includes(value);
}

/**
 * Which rail a stored subscription is on, read back from the collection method
 * the provider itself reports. `null` for a record from before this column
 * existed, which is treated as "unknown rail" and never guessed into either.
 */
export function paymentMethodFromCollectionMethod(
  value: unknown,
): BillingPaymentMethod | null {
  if (value === 'send_invoice') return 'promptpay';
  if (value === 'charge_automatically') return 'card';
  return null;
}

/**
 * How long a PromptPay invoice stays payable.
 *
 * Three days is long enough that somebody who starts a purchase in the evening
 * can finish it at the bank's convenience, and short enough that an abandoned
 * invoice releases the account's one-open-purchase slot quickly instead of
 * locking the reader out of switching to a card for a week.
 */
export const PROMPTPAY_DUE_DAYS = 3;

/** Thai names for the two rails, as shown on every purchase surface. */
export const PAYMENT_METHOD_LABEL: Readonly<Record<BillingPaymentMethod, string>> = {
  card: 'บัตรเครดิต/เดบิต · Apple Pay',
  promptpay: 'PromptPay (สแกน QR)',
};

/** The commitment each rail carries. Never softened, because it is the choice. */
export const PAYMENT_METHOD_COMMITMENT: Readonly<Record<BillingPaymentMethod, string>> = {
  card: 'ต่ออายุอัตโนมัติ',
  promptpay: 'ต้องสแกนจ่ายใหม่ทุกงวด',
};

const INTERVAL_NOUN: Readonly<Record<BillingInterval, string>> = {
  month: 'เดือน',
  year: 'ปี',
};

/**
 * The renewal sentence for one rail and one cadence — "ต้องสแกนจ่ายใหม่ทุกเดือน"
 * rather than the vaguer "ทุกงวด", because a reader buying an annual plan and a
 * reader buying a monthly one are agreeing to very different amounts of work.
 *
 * A `null` cadence is for a surface that offers both at once, where naming one
 * of them would be wrong for the other.
 */
export function paymentMethodRenewalNote(
  method: BillingPaymentMethod,
  interval: BillingInterval | null,
): string {
  const noun = interval ? INTERVAL_NOUN[interval] : 'งวด';
  return method === 'card'
    ? `บัตรจะถูกเรียกเก็บอัตโนมัติทุก${noun} ยกเลิกได้ทุกเมื่อ`
    : `PromptPay ไม่ต่ออายุอัตโนมัติ ต้องสแกนจ่ายใหม่ทุก${noun} มิฉะนั้นสิทธิ์จะสิ้นสุดเมื่อจบรอบ`;
}

/** How long the reader has to pay, stated wherever a QR is offered. */
export function promptPayDueWindowNote(days: number = PROMPTPAY_DUE_DAYS): string {
  return `ใบแจ้งหนี้นี้ต้องชำระภายใน ${days} วัน หากเลยกำหนดใบแจ้งหนี้จะถูกยกเลิกและสิทธิ์จะไม่เปิด`;
}
