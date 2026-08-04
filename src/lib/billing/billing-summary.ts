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
import {
  paymentMethodFromCollectionMethod,
  paymentMethodRenewalNote,
  type BillingCollectionMethod,
  type BillingPaymentMethod,
} from './billing-payment-method';
import { promptPayRenewalReminder } from './promptpay-pending';

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
  /** What that date means on this rail — a charge, or a deadline to act. */
  periodEndLabel: string;
  /** What the next invoice will be, in whole baht. */
  renewalBaht: number | null;
  /** What was charged for the current period, when it differed. */
  firstPeriodBaht: number | null;
  cancelAtPeriodEnd: boolean;
  latestPaymentFailed: boolean;
  /** True once a provider customer exists, which is what the portal needs. */
  canOpenPortal: boolean;
  /** The rail this subscription is billed on, or null for an older record. */
  paymentMethod: BillingPaymentMethod | null;
  /**
   * Whether the provider will collect the next period without the reader doing
   * anything. False on PromptPay, and that difference is the whole reason this
   * field exists rather than being inferred from a label.
   */
  autoRenews: boolean;
  /** The rail's commitment, in one sentence. */
  renewalNote: string | null;
  /** Shown only when a PromptPay period is about to lapse. */
  renewalReminder: string | null;
  /** Countdown resolved from the database clock, never from a browser clock. */
  periodRemainingLabel: string | null;
  /** The old paid period is over, so reading its provider-issued next invoice cannot overlap access. */
  promptPayRenewalReady: boolean;
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
  /** The rail, as the provider reports it. Absent on pre-Phase-4.4 records. */
  collectionMethod?: BillingCollectionMethod | null;
  /** The database's clock, for every period boundary on this card. */
  now: string | number | Date;
}

const NO_SUBSCRIPTION: BillingSummary = {
  kind: 'none',
  planName: null,
  intervalLabel: null,
  statusLabel: 'ฟรีตลอดชีพ',
  statusTone: 'inactive',
  periodEnd: null,
  periodEndLabel: 'รอบบิลถัดไป',
  renewalBaht: null,
  firstPeriodBaht: null,
  cancelAtPeriodEnd: false,
  latestPaymentFailed: false,
  canOpenPortal: false,
  paymentMethod: null,
  autoRenews: false,
  renewalNote: null,
  renewalReminder: null,
  periodRemainingLabel: null,
  promptPayRenewalReady: false,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function subscriptionTimeRemainingLabel(input: {
  periodEnd: string | null;
  now: string | number | Date;
}): string | null {
  if (!input.periodEnd) return null;
  const end = Date.parse(input.periodEnd);
  const now = new Date(input.now).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(now)) return null;
  const remaining = end - now;
  if (remaining <= 0) return 'หมดอายุแล้ว';
  if (remaining < DAY_MS) {
    return `เหลืออีก ${Math.max(1, Math.ceil(remaining / HOUR_MS))} ชั่วโมง`;
  }
  return `เหลืออีก ${Math.max(1, Math.ceil(remaining / DAY_MS))} วัน`;
}

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
  const paymentMethod = paymentMethodFromCollectionMethod(input.collectionMethod ?? null);
  const autoRenews = paymentMethod !== 'promptpay';
  const periodRemainingLabel = subscriptionTimeRemainingLabel({
    periodEnd: input.currentPeriodEnd,
    now: input.now,
  });

  return {
    kind: 'paid',
    planName: plan.name,
    intervalLabel: plan.intervalLabel,
    ...statusPresentation(input),
    periodEnd: input.currentPeriodEnd,
    /*
     * On PromptPay this date is a deadline rather than a schedule: nothing will
     * be collected on it, and the plan ends unless somebody scans a new QR
     * first. Calling it "รอบบิลถัดไป" would promise a renewal that is not going
     * to happen.
     */
    periodEndLabel: input.cancelAtPeriodEnd || !autoRenews ? 'ใช้งานได้ถึง' : 'รอบบิลถัดไป',
    renewalBaht,
    firstPeriodBaht: plan.founder ? plan.firstPeriodBaht : null,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    latestPaymentFailed: input.latestPaymentStatus === 'failed',
    canOpenPortal: input.hasBillingCustomer,
    paymentMethod,
    autoRenews,
    renewalNote: paymentMethod ? paymentMethodRenewalNote(paymentMethod, plan.interval) : null,
    /*
     * The reminder exists only for the rail that needs one. A card subscriber is
     * not warned about a renewal they do not have to do anything about; a
     * PromptPay subscriber loses their plan on this date unless they act.
     */
    renewalReminder: autoRenews || input.cancelAtPeriodEnd
      ? null
      : promptPayRenewalReminder({
        periodEnd: input.currentPeriodEnd,
        now: input.now,
      }),
    periodRemainingLabel,
    promptPayRenewalReady: paymentMethod === 'promptpay'
      && (input.status === 'active' || input.status === 'past_due')
      && periodRemainingLabel === 'หมดอายุแล้ว',
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

/**
 * Whether the provider is still billing this account for a plan.
 *
 * One account is one subscription. The row keeps a single
 * `billing_subscription_id`, and the database routine refuses any event naming a
 * different one, so a *second* checkout produces a subscription at the provider
 * whose every event is rejected as `subscription_mismatch` — the reader pays and
 * is granted nothing, then pays for both every period after that. This predicate
 * is what closes the purchase surface while one subscription is live, and both
 * the checkout gate and the plan cards read it so the button and the server can
 * never disagree about who may buy.
 *
 * `trialing` is deliberately not live: the Elite trial is a grant with no plan
 * key and no provider subscription behind it, so a reader on trial may still buy.
 * `canceled` and `expired` are not live either — nothing is being billed, so a
 * fresh purchase is exactly the right thing.
 *
 * A subscription set to end at the period end IS still live. It is still being
 * billed until that date, and the way to keep it is to resume it in the portal
 * rather than to open a second one alongside it.
 */
export function holdsLiveSubscription(
  input: (Pick<BillingSummaryInput, 'status' | 'planKey'> & {
    /** The rail. `null` for a record from before the column existed. */
    collectionMethod?: BillingCollectionMethod | null;
    currentPeriodEnd?: string | null;
    /** The database's clock. Never the browser's, and never this process's. */
    now?: string | number | Date | null;
  }) | null | undefined,
): boolean {
  if (!input?.planKey) return false;
  if (input.status !== 'active' && input.status !== 'past_due') return false;

  /*
   * On the invoice rail the status alone is not enough.
   *
   * A PromptPay subscription stays `active` at the provider after a period
   * nobody paid for — its events are ignored precisely so an unpaid renewal
   * cannot extend access — so the stored status can outlive the lease by a long
   * way. Reading it as "still being billed" would leave somebody whose plan
   * quietly ended unable to buy anything ever again, which is the opposite of
   * what this predicate is for. The paid period is the authority instead.
   *
   * A card subscription is unchanged: it is judged on status, because the
   * provider charges it before each period and a lapsed one arrives as its own
   * event.
   */
  if (input.collectionMethod !== 'send_invoice') return true;
  if (!input.currentPeriodEnd) return false;
  if (input.now === null || input.now === undefined) return false;
  const end = Date.parse(input.currentPeriodEnd);
  if (!Number.isFinite(end)) return false;
  return end > new Date(input.now).getTime();
}

/**
 * An invoice-collected subscription remains reusable after its paid lease ends:
 * Stripe creates the next invoice on this same subscription. Opening a fresh
 * checkout would create a second subscription and bypass that renewal invoice.
 */
export function holdsReusablePromptPaySubscription(
  input: Pick<BillingSummaryInput, 'status' | 'planKey' | 'collectionMethod'> | null | undefined,
): boolean {
  return Boolean(
    input?.planKey
    && input.collectionMethod === 'send_invoice'
    && (input.status === 'active' || input.status === 'past_due'),
  );
}

/** The reassurance that has to survive a downgrade, stated in one place. */
export const DATA_KEPT_ON_DOWNGRADE_NOTE =
  'หากแพ็กเกจสิ้นสุด ข้อมูลพอร์ตและประวัติทั้งหมดของคุณยังอยู่ครบ เปิดดูได้ตามปกติ';
