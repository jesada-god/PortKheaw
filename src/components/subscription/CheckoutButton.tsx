'use client';

import { useState, useTransition } from 'react';
import { CreditCard, Loader2 } from 'lucide-react';
import { startCheckoutAction } from '@/app/settings/subscription/billing-actions';
import type { BillingPlanKey } from '@/src/lib/billing/billing-plans';

/**
 * The one control that starts a purchase.
 *
 * It sends a plan key. Not a price, not a tier, not a discount — the server
 * looks all of those up, so there is nothing here for a modified client to
 * usefully change.
 *
 * Nothing is unlocked on success. The action returns a URL to the provider's
 * hosted page and this navigates there; the plan changes only when the provider
 * later sends a signed webhook. That is why there is no optimistic state in this
 * component and no reading of the result beyond the URL.
 */
export function CheckoutButton({ planKey, label, emphasis }: {
  planKey: BillingPlanKey;
  label: string;
  emphasis?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await startCheckoutAction(planKey);
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
        onClick={submit}
        /* Held down for the whole transition, and for the navigation that
           follows a success, so a second press cannot open a second checkout. */
        disabled={pending}
        aria-busy={pending}
        className={[
          'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold',
          'motion-safe:transition-colors focus-visible:outline focus-visible:outline-2',
          'focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-60',
          emphasis
            ? 'bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]'
            : 'border border-[var(--border-strong)] text-[var(--text)] hover:bg-[var(--surface-hover)]',
        ].join(' ')}
      >
        {pending
          ? <Loader2 aria-hidden="true" size={16} className="shrink-0 motion-safe:animate-spin" />
          : <CreditCard aria-hidden="true" size={16} className="shrink-0" />}
        {pending ? 'กำลังเปิดหน้าชำระเงิน…' : label}
      </button>
      {error && (
        <p data-testid="checkout-error" role="alert" className="text-xs leading-5 text-[var(--negative)]">
          {error}
        </p>
      )}
    </div>
  );
}
