/**
 * What the manage-subscription card says, decided once.
 *
 * Pure: it takes the sanitized snapshot the database returned and the database's
 * own clock, and returns finished strings. No I/O, no `Date.now()` — an expiry
 * is never judged against a browser's idea of the time.
 *
 * The rule that shapes all of it: a reader must be able to answer "what am I on,
 * when am I next charged, and how much" without opening the provider. That means
 * the *renewal* price is the number that matters, not the promotional one they
 * paid last time — so a Founder subscription states both, and states which is
 * which.
 */

import { billingPlan, formatBillingBaht, type BillingPlanKey } from './billing-plans';
import type { BillingPaymentStatus } from './billing-events';

export type BillingSummaryKind =
  /** No paid subscription has ever been recorded against this account. */
  | 'none'
  /** The seven-day Elite grant from Phase 2. Not a purchase, and never billed. */
  | 'trial'
  | 'paid';

export type BillingStatusTone = 'active' | 'warning' | 'ending' | 'inactive';

export interface BillingSummary {
  kind: BillingSummaryKind;
  /** `Pro รายปี · Founder's Club`, or null when nothing is held. */
  planName: string | null;
  intervalLabel: string | null;
  statusLabel: string;
  statusTone: BillingStatusTone;
  /** ISO. The date the next charge or the end of access falls on. */
  periodEnd: string | null;
  /** What the next invoice will be, in whole baht. */
  renewalBaht: number | null;
  /** What was charged for the current period, when it differed. */
  firstPeriodBaht: number | null;
  cancelAtPeriodEnd: boolean;
  latestPaymentFailed: boolean;
  /** True once a provider customer exists, which is what the portal needs. */
  canOpenPortal: boolean;
}

export interface BillingSummaryInput {
  tier: string;
  status: string;
  planKey: BillingPlanKey | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  latestPaymentStatus: BillingPaymentStatus | null;
  trialEndsAt: string | null;
  hasBillingCustomer: boolean;
}

const NO_SUBSCRIPTION: BillingSummary = {
  kind: 'none',
  planName: null,
  intervalLabel: null,
  statusLabel: 'ฟรีตลอดชีพ',
  statusTone: 'inactive',
  periodEnd: null,
  renewalBaht: null,
  firstPeriodBaht: null,
  cancelAtPeriodEnd: false,
  latestPaymentFailed: false,
  canOpenPortal: false,
};

export function resolveBillingSummary(input: BillingSummaryInput): BillingSummary {
  if (input.status === 'trialing') {
    return {
      ...NO_SUBSCRIPTION,
      kind: 'trial',
      statusLabel: 'ทดลองใช้ Elite',
      statusTone: 'active',
      periodEnd: input.trialEndsAt,
      canOpenPortal: input.hasBillingCustomer,
    };
  }

  // No plan key means no purchase was ever confirmed by a webhook. The portal is
  // still offered when a customer exists, so somebody whose subscription has
  // ended can still reach their own invoice history.
  if (!input.planKey) {
    return { ...NO_SUBSCRIPTION, canOpenPortal: input.hasBillingCustomer };
  }

  const plan = billingPlan(input.planKey);
  /*
   * The price of the *next* invoice. For a Founder subscription that is the
   * ordinary annual price, because the promotion was a single-invoice coupon —
   * which is exactly the number a reader is most likely to be surprised by, so
   * it is the one shown as the renewal.
   */
  const renewalBaht = billingPlan(plan.renewsIntoKey).renewalBaht;

  return {
    kind: 'paid',
    planName: plan.name,
    intervalLabel: plan.intervalLabel,
    ...statusPresentation(input),
    periodEnd: input.currentPeriodEnd,
    renewalBaht,
    firstPeriodBaht: plan.founder ? plan.firstPeriodBaht : null,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    latestPaymentFailed: input.latestPaymentStatus === 'failed',
    canOpenPortal: input.hasBillingCustomer,
  };
}

/**
 * The status line.
 *
 * A subscription set to end takes precedence over "active", because that is the
 * fact a reader most needs: they still have access, and it stops on a date.
 */
function statusPresentation(input: BillingSummaryInput): {
  statusLabel: string;
  statusTone: BillingStatusTone;
} {
  if (input.status === 'active' && input.cancelAtPeriodEnd) {
    return { statusLabel: 'จะสิ้นสุดเมื่อจบรอบบิล', statusTone: 'ending' };
  }
  switch (input.status) {
    case 'active':
      return { statusLabel: 'ใช้งานอยู่', statusTone: 'active' };
    case 'past_due':
      return { statusLabel: 'ค้างชำระ', statusTone: 'warning' };
    case 'canceled':
      return { statusLabel: 'ยกเลิกแล้ว', statusTone: 'inactive' };
    case 'expired':
      return { statusLabel: 'หมดอายุแล้ว', statusTone: 'inactive' };
    default:
      return { statusLabel: 'ฟรีตลอดชีพ', statusTone: 'inactive' };
  }
}

/** `3,490 บาท` — one formatter, so a price reads the same on every surface. */
export function formatBahtAmount(amount: number): string {
  return `${formatBillingBaht(amount)} บาท`;
}

/**
 * The sentence a Founder subscriber must see before and after buying: this price
 * was for the first period only, and here is what happens next.
 */
export function founderRenewalNote(firstPeriodBaht: number, renewalBaht: number): string {
  return `ราคา Founder’s Club ${formatBahtAmount(firstPeriodBaht)} ใช้กับรอบบิลแรกครั้งเดียว`
    + ` รอบถัดไปจะเรียกเก็บ ${formatBahtAmount(renewalBaht)} ต่อปี`;
}

/** The reassurance that has to survive a downgrade, stated in one place. */
export const DATA_KEPT_ON_DOWNGRADE_NOTE =
  'หากแพ็กเกจสิ้นสุด ข้อมูลพอร์ตและประวัติทั้งหมดของคุณยังอยู่ครบ เปิดดูได้ตามปกติ';
