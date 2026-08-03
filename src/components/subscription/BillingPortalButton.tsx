'use client';

import { useState, useTransition } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { openBillingPortalAction } from '@/app/settings/subscription/billing-actions';

/**
 * The way to the provider's billing portal — where a card is updated, an invoice
 * is downloaded and a subscription is cancelled.
 *
 * It sends nothing. The customer identifier is looked up on the server from the
 * caller's own row, which is what stops this from becoming a way to open
 * somebody else's billing history by supplying an identifier.
 */
export function BillingPortalButton({ canOpen }: { canOpen: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await openBillingPortalAction();
      if (result.ok) {
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
        data-testid="billing-portal-button"
        onClick={submit}
        disabled={pending || !canOpen}
        aria-busy={pending}
        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--text)] motion-safe:transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-60"
      >
        {pending
          ? <Loader2 aria-hidden="true" size={16} className="shrink-0 motion-safe:animate-spin" />
          : <ExternalLink aria-hidden="true" size={16} className="shrink-0" />}
        {pending ? 'กำลังเปิด…' : 'จัดการการชำระเงินและยกเลิก'}
      </button>
      {error && (
        <p data-testid="billing-portal-error" role="alert" className="text-xs leading-5 text-[var(--negative)]">
          {error}
        </p>
      )}
    </div>
  );
}
