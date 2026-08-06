'use client';

import { useState, useTransition } from 'react';
import { CreditCard, QrCode } from 'lucide-react';
import { startCheckoutAction } from '@/app/settings/subscription/billing-actions';
import { PurchaseConsentDialog } from './PurchaseConsentDialog';
import type { PurchasePolicyVersions } from '@/src/lib/billing/purchase-consent';
import type { BillingPaymentMethod } from '@/src/lib/billing/billing-payment-method';
import type { BillingPlanKey } from '@/src/lib/billing/billing-plans';

/**
 * The one control that starts a purchase.
 *
 * Pressing it opens the consent step rather than a checkout: the terms a buyer
 * is agreeing to are shown, and the action below runs only after the box in that
 * dialog has been ticked. The dialog is mounted only while it is open, so the
 * box is unticked on every press — a previous purchase can never leave it
 * pre-accepted.
 *
 * What is sent is a plan key, a payment method, and an acceptance carrying two
 * policy version strings. Not a price, not a tier, not a discount — the server
 * looks all of those up, and both rails bill the same Price object, so there is
 * nothing here for a modified client to usefully change: naming the other rail
 * changes how the money is collected, never how much. The versions are echoed
 * back, not chosen; the server compares them against the ones it publishes and
 * refuses anything else.
 *
 * Nothing is unlocked on success. The action returns a URL to the provider's
 * hosted page and this navigates there; the plan changes only when the provider
 * later sends a signed webhook. On the PromptPay rail that gap is deliberately
 * visible — the destination is an invoice with a QR, and the plan opens when the
 * bank confirms, not when the page loads.
 */
export function CheckoutButton({ planKey, paymentMethod, label, emphasis, policyVersions }: {
  planKey: BillingPlanKey;
  paymentMethod: BillingPaymentMethod;
  label: string;
  emphasis?: boolean;
  /** Published by the server that rendered this page. Echoed back on confirm. */
  policyVersions: PurchasePolicyVersions;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = paymentMethod === 'promptpay' ? QrCode : CreditCard;

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await startCheckoutAction(planKey, paymentMethod, {
        accepted: true,
        subscriptionPolicyVersion: policyVersions.subscriptionPolicy,
        refundPolicyVersion: policyVersions.refundPolicy,
      });
      if (result.ok) {
        // A full navigation, not a router push: the destination is the
        // provider's own origin.
        window.location.assign(result.url);
        return;
      }
      setError(result.message);
    });
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <button
        type="button"
        data-testid="checkout-button"
        data-plan-key={planKey}
        data-payment-method={paymentMethod}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        /* Held down for the whole transition, and for the navigation that
           follows a success, so a second press cannot open a second checkout. */
        disabled={pending}
        aria-busy={pending}
        aria-haspopup="dialog"
        className={[
          'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold',
          'motion-safe:transition-colors focus-visible:outline focus-visible:outline-2',
          'focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-60',
          emphasis
            ? 'bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]'
            : 'border border-[var(--border-strong)] text-[var(--text)] hover:bg-[var(--surface-hover)]',
        ].join(' ')}
      >
        <Icon aria-hidden="true" size={16} className="shrink-0" />
        {label}
      </button>

      {/* Unmounted when closed, which is what keeps the checkbox unticked on
          every press. The error lives out here so a refusal survives the dialog
          being dismissed. */}
      {open && (
        <PurchaseConsentDialog
          planKey={planKey}
          paymentMethod={paymentMethod}
          policyVersions={policyVersions}
          pending={pending}
          error={error}
          onConfirm={confirm}
          onClose={() => setOpen(false)}
        />
      )}

      {!open && error && (
        <p data-testid="checkout-error" role="alert" className="text-xs leading-5 text-[var(--negative)]">
          {error}
        </p>
      )}
    </div>
  );
}
