import { Clock } from 'lucide-react';
import { CheckoutButton } from './CheckoutButton';
import type { BillingAvailability } from '@/src/lib/billing/billing-config';
import {
  billingPlan,
  billingPlansForTier,
  formatBillingBaht,
  type PaidTier,
} from '@/src/lib/billing/billing-plans';
import { founderRenewalNote } from '@/src/lib/billing/billing-summary';

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

export function PlanPurchase({ tier, availability, emphasis }: {
  tier: PaidTier;
  availability: BillingAvailability;
  emphasis?: boolean;
}) {
  const purchasable = billingPlansForTier(tier)
    .filter((plan) => availability.availablePlanKeys.includes(plan.key));

  if (!availability.enabled || purchasable.length === 0) {
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
   * A Founder row replaces the ordinary annual row rather than sitting beside
   * it: they are the same subscription at two prices, and offering both would
   * invite somebody to pick the more expensive one by accident.
   */
  const founder = purchasable.find((plan) => plan.founder);
  const shown = purchasable.filter((plan) => !(founder && plan.key === founder.renewsIntoKey));

  return (
    <div className="min-w-0 space-y-2">
      {shown.map((plan) => (
        <CheckoutButton
          key={plan.key}
          planKey={plan.key}
          emphasis={emphasis && plan.interval === 'year'}
          label={`สมัคร ${plan.name} · ${formatBillingBaht(plan.firstPeriodBaht)} บาท`}
        />
      ))}
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
