/**
 * What a buyer agrees to, immediately before they are asked to pay.
 *
 * Pure: the sentence, the disclosure, and the rule for deciding whether an
 * acceptance a browser sent is one this deployment can act on. No I/O, no clock,
 * no provider import — recording lives in the server action, and the database
 * routine it calls is the only thing that writes a consent row.
 *
 * The security argument, since a checkbox is exactly the kind of control it is
 * tempting to trust:
 *
 *   * **The client cannot supply a policy version, only echo one.** The browser
 *     sends back the versions it was rendered with; the server compares them
 *     against the versions *it* holds and refuses anything else. So a tab left
 *     open across a policy change cannot buy against wording nobody is showing
 *     any more, and a crafted request cannot name a version that was never
 *     published.
 *   * **`accepted: true` on its own buys nothing.** It is necessary, never
 *     sufficient: the versions must match as well, and the consent row must be
 *     written before the provider is contacted at all.
 *   * **Nothing money-bearing crosses the wire.** No amount, no interval, no
 *     rail price. The plan key and the rail were already the checkout's entire
 *     input surface and they still are — the disclosure below is *rendered* from
 *     the catalogue on both sides, never sent.
 *
 * What is deliberately not here: a first-login gate. Consent is asked for at the
 * moment it means something — before a paid checkout — and never as a wall in
 * front of a product somebody has not decided to buy yet. Renewal, the billing
 * portal, refund requests and every entitlement an account already holds are on
 * other paths, and none of them consults this.
 */

import {
  PAYMENT_METHOD_LABEL,
  paymentMethodRenewalNote,
  promptPayDueWindowNote,
  type BillingPaymentMethod,
} from './billing-payment-method';
import {
  billingPlan,
  formatBillingBaht,
  type BillingPlanDefinition,
  type BillingPlanKey,
} from './billing-plans';
import { REFUND_WINDOW_DAYS } from './refund-window';
import { legalDocumentVersion, legalDocuments } from '@/src/lib/legal/documents';

/**
 * The one sentence beside the one checkbox. Stated once so the dialog, the
 * contract test and any future surface cannot each hold their own wording.
 */
export const PURCHASE_CONSENT_LABEL =
  'ฉันได้อ่านและยอมรับเงื่อนไขการสมัครสมาชิก การต่ออายุ การยกเลิก '
  + `และนโยบายคืนเงินภายใน ${REFUND_WINDOW_DAYS} วัน`;

/** The two documents an acceptance is pinned to, in the order they are linked. */
export const PURCHASE_CONSENT_POLICY_SLUGS = ['subscription-policy', 'refund-policy'] as const;

export interface PurchasePolicyVersions {
  subscriptionPolicy: string;
  refundPolicy: string;
}

/** The versions this build publishes. The server's copy is the authority. */
export function currentPurchasePolicyVersions(): PurchasePolicyVersions {
  return {
    subscriptionPolicy: legalDocumentVersion('subscription-policy'),
    refundPolicy: legalDocumentVersion('refund-policy'),
  };
}

/** The links shown beside the checkbox, read from the document catalogue. */
export function purchaseConsentLinks(): readonly { href: string; label: string }[] {
  return PURCHASE_CONSENT_POLICY_SLUGS.map((slug) => ({
    href: legalDocuments[slug].href,
    label: legalDocuments[slug].title,
  }));
}

/** Exactly what a browser may send about consent, and nothing more. */
export interface PurchaseConsentClaim {
  accepted: boolean;
  subscriptionPolicyVersion: string;
  refundPolicyVersion: string;
}

export type PurchaseConsentVerdict =
  /** Checked, and pinned to the versions this build publishes. */
  | 'accepted'
  /** The box was not ticked. */
  | 'not-accepted'
  /** Ticked against wording this build no longer publishes. */
  | 'stale-policy'
  /** Not a consent claim at all. */
  | 'malformed';

/**
 * Whether an acceptance can be acted on.
 *
 * Order matters and is deliberate: shape first, then the box, then the versions.
 * A reader who simply has not ticked the box is told to tick it; only somebody
 * who *has* agreed is told their agreement was against superseded wording, which
 * is the only case where re-reading the policy is the right instruction.
 */
export function verifyPurchaseConsent(
  claim: Partial<PurchaseConsentClaim> | null | undefined,
  current: PurchasePolicyVersions,
): PurchaseConsentVerdict {
  if (!claim || typeof claim !== 'object') return 'malformed';
  const { accepted, subscriptionPolicyVersion, refundPolicyVersion } = claim;
  if (typeof subscriptionPolicyVersion !== 'string' || typeof refundPolicyVersion !== 'string') {
    return 'malformed';
  }
  if (accepted !== true) return 'not-accepted';
  return subscriptionPolicyVersion === current.subscriptionPolicy
    && refundPolicyVersion === current.refundPolicy
    ? 'accepted'
    : 'stale-policy';
}

export const PURCHASE_CONSENT_REQUIRED_MESSAGE =
  'กรุณาอ่านและติ๊กยอมรับเงื่อนไขการสมัครสมาชิกและนโยบายคืนเงินก่อนดำเนินการชำระเงิน';

export const PURCHASE_CONSENT_STALE_MESSAGE =
  'เงื่อนไขการสมัครสมาชิกหรือนโยบายคืนเงินมีการปรับปรุงหลังจากคุณเปิดหน้านี้ '
  + 'กรุณารีเฟรชหน้านี้ อ่านฉบับล่าสุด แล้วยอมรับอีกครั้ง';

/* -------------------------------------------------------------------------
 * The disclosure
 * ---------------------------------------------------------------------- */

export interface PurchaseDisclosureRow {
  label: string;
  value: string;
}

const INTERVAL_PERIOD: Readonly<Record<BillingPlanDefinition['interval'], string>> = {
  month: 'รายเดือน (ทุก 1 เดือน)',
  year: 'รายปี (ทุก 12 เดือน)',
};

/**
 * What is being bought, as four rows.
 *
 * Every value is read from the catalogue the checkout itself charges against, so
 * the summary a reader consents to and the amount the provider collects cannot
 * disagree. A Founder plan states both numbers, because showing only the
 * promotional one is the omission that makes a discount misleading.
 */
export function purchaseDisclosureRows(input: {
  planKey: BillingPlanKey;
  paymentMethod: BillingPaymentMethod;
}): readonly PurchaseDisclosureRow[] {
  const plan = billingPlan(input.planKey);
  const rows: PurchaseDisclosureRow[] = [
    { label: 'แพ็กเกจที่เลือก', value: plan.name },
    { label: 'ราคารอบแรก', value: `${formatBillingBaht(plan.firstPeriodBaht)} บาท` },
    { label: 'รอบการเรียกเก็บ', value: INTERVAL_PERIOD[plan.interval] },
    { label: 'วิธีชำระเงิน', value: PAYMENT_METHOD_LABEL[input.paymentMethod] },
  ];
  if (plan.founder) {
    const renewsInto = billingPlan(plan.renewsIntoKey);
    rows.splice(2, 0, {
      label: 'ราคารอบต่ออายุ',
      value: `${formatBillingBaht(renewsInto.renewalBaht)} บาท (ราคาปกติ)`,
    });
  }
  return rows;
}

/**
 * What the purchase commits the reader to, as sentences.
 *
 * The rail sentence comes from `billing-payment-method`, which is the same
 * string the plan cards and the manage card show — a card renews itself until it
 * is cancelled, PromptPay never does. The refund sentences state the window and
 * then state its limit, in that order, because a reader who reads only the first
 * one has still been told something true.
 */
export function purchaseCommitmentNotes(input: {
  planKey: BillingPlanKey;
  paymentMethod: BillingPaymentMethod;
}): readonly string[] {
  const plan = billingPlan(input.planKey);
  const notes = [paymentMethodRenewalNote(input.paymentMethod, plan.interval)];
  if (input.paymentMethod === 'promptpay') notes.push(promptPayDueWindowNote());
  notes.push(
    `ขอคืนเงินเต็มจำนวนได้ภายใน ${REFUND_WINDOW_DAYS} วันนับจากเวลาที่ชำระเงินสำเร็จของรอบบิลนั้น `
    + 'และการต่ออายุแต่ละรอบจะเริ่มนับใหม่ของรอบนั้นเอง',
    `เมื่อพ้น ${REFUND_WINDOW_DAYS} วันแล้ว ระบบจะไม่รับคำขอคืนเงินตามปกติของรอบนั้น `
    + 'เว้นแต่กรณีที่กฎหมายที่ใช้บังคับกำหนดไว้เป็นอย่างอื่น',
    'การส่งคำขอคืนเงินยังไม่ใช่การคืนเงิน ทีมงานจะตรวจสอบเป็นรายกรณีก่อนตัดสิน',
  );
  return notes;
}
