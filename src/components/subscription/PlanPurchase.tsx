import { Clock, Settings2 } from 'lucide-react';
import { PaymentMethodChoice, type PurchasablePlan } from './PaymentMethodChoice';
import type { BillingAvailability } from '@/src/lib/billing/billing-config';
import {
  billingPlan,
  billingPlansForTier,
  formatBillingBaht,
  type PaidTier,
} from '@/src/lib/billing/billing-plans';
import { founderRenewalNote } from '@/src/lib/billing/billing-summary';
import { currentPurchasePolicyVersions } from '@/src/lib/billing/purchase-consent';

/**
 * The purchase area of a plan card.
 *
 * Two states, and the honesty of the first one is the point. Until this
 * deployment has provider credentials there is **no** checkout affordance —
 * not a disabled button, not a link that goes nowhere — just a plain statement
 * that payment is not open yet. A control that looks pressable and cannot
 * complete is worse than no control at all.
 *
 * When billing is configured, only the plan keys the server said are actually
 * purchasable get a button, so a half-configured catalogue shows the plans it
 * can sell rather than failing at the provider.
 */
export const BILLING_CLOSED_NOTE = 'ระบบชำระเงินยังไม่เปิด';

/**
 * What a reader who already subscribes is shown instead of a Subscribe button.
 *
 * One account is one subscription — see `holdsLiveSubscription` — so a second
 * checkout would open a second subscription at the provider, be refused by the
 * webhook as a mismatch, and leave the reader paying for a plan they were never
 * granted. A plan change belongs on the subscription that already exists, which
 * is what the manage card above these plans opens.
 */
export const ALREADY_SUBSCRIBED_NOTE = 'เปลี่ยนแพ็กเกจได้ที่ “จัดการการชำระเงินและยกเลิก” ด้านบน';

/**
 * The same reasoning one step earlier: an unpaid PromptPay invoice is a purchase
 * already in flight, and a second one alongside it would be a second
 * subscription at the provider. The pending card above holds both ways out —
 * scan it, or abandon it.
 */
export const OPEN_INVOICE_NOTE = 'มีใบแจ้งหนี้ที่รอชำระอยู่ ดูรายละเอียดได้ที่การ์ดด้านบน';

export function PlanPurchase({
  tier,
  availability,
  emphasis,
  hasLiveSubscription = false,
  hasOpenInvoice = false,
}: {
  tier: PaidTier;
  availability: BillingAvailability;
  emphasis?: boolean;
  /** True when the provider is already billing this account for a plan. */
  hasLiveSubscription?: boolean;
  /**
   * True while an unpaid PromptPay invoice is still payable. The purchase area
   * closes for the same reason it closes for a subscriber — one account, one
   * purchase — and the pending card above these plans holds the way forward.
   */
  hasOpenInvoice?: boolean;
}) {
  const purchasable = billingPlansForTier(tier)
    .filter((plan) => availability.availablePlanKeys.includes(plan.key));

  if (!availability.enabled || purchasable.length === 0 || availability.paymentMethods.length === 0) {
    return (
      <p
        data-testid="billing-closed-note"
        className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-strong)] px-3 py-2.5 text-sm font-medium text-[var(--text-muted)]"
      >
        <Clock aria-hidden="true" size={15} className="shrink-0" />
        {BILLING_CLOSED_NOTE}
      </p>
    );
  }

  /*
   * No control at all rather than a disabled one, for the same reason the
   * billing-closed branch above renders none: a button that looks pressable and
   * cannot complete is worse than a sentence saying where to go instead.
   */
  if (hasLiveSubscription || hasOpenInvoice) {
    return (
      <p
        data-testid={hasLiveSubscription ? 'already-subscribed-note' : 'open-invoice-note'}
        className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-strong)] px-3 py-2.5 text-center text-sm font-medium text-[var(--text-muted)]"
      >
        <Settings2 aria-hidden="true" size={15} className="shrink-0" />
        {hasLiveSubscription ? ALREADY_SUBSCRIBED_NOTE : OPEN_INVOICE_NOTE}
      </p>
    );
  }

  /*
   * A Founder row replaces the ordinary annual row rather than sitting beside
   * it: they are the same subscription at two prices, and offering both would
   * invite somebody to pick the more expensive one by accident.
   */
  const founder = purchasable.find((plan) => plan.founder);
  const shown: PurchasablePlan[] = purchasable
    .filter((plan) => !(founder && plan.key === founder.renewsIntoKey))
    .map((plan) => ({
      key: plan.key,
      interval: plan.interval,
      emphasis: Boolean(emphasis && plan.interval === 'year'),
      label: `สมัคร ${plan.name} · ${formatBillingBaht(plan.firstPeriodBaht)} บาท`,
    }));

  return (
    <div className="min-w-0 space-y-2">
      {/*
        Resolved here, on the server, and handed down. The consent step echoes
        these back and the checkout action compares them against the versions it
        publishes — so a tab left open across a policy edit is refused rather
        than allowed to buy against wording that has been replaced.
      */}
      <PaymentMethodChoice
        plans={shown}
        methods={availability.paymentMethods}
        policyVersions={currentPurchasePolicyVersions()}
      />
      {founder && (
        // The renewal price is stated before anyone reaches the provider, so the
        // second year cannot be a surprise.
        <p data-testid="founder-renewal-note" className="text-xs leading-5 text-[var(--text-muted)]">
          {founderRenewalNote(founder.firstPeriodBaht, billingPlan(founder.renewsIntoKey).renewalBaht)}
        </p>
      )}
    </div>
  );
}
