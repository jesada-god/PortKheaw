'use client';

import { useState, useTransition } from 'react';
import { Loader2, XCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { abandonPromptPayInvoiceAction } from '@/app/settings/subscription/billing-actions';

/**
 * Giving up on an unpaid invoice.
 *
 * It exists so that choosing PromptPay is not a three-day commitment: somebody
 * who meant to pay by card would otherwise be locked out of buying anything
 * until the invoice expired, because one account may only have one purchase in
 * flight.
 *
 * It sends nothing. The invoice is found from the caller's own row on the
 * server, so this button cannot be aimed at another account's payment, and it
 * withdraws no entitlement — an unpaid invoice never opened one.
 */
export function AbandonInvoiceButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await abandonPromptPayInvoiceAction();
      if (result.ok) {
        // The server has already revalidated; this re-reads the page so the
        // pending card disappears and the plan buttons come back.
        router.refresh();
        return;
      }
      setError(result.message);
    });
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <button
        type="button"
        data-testid="abandon-invoice-button"
        onClick={submit}
        disabled={pending}
        aria-busy={pending}
        className={[
          'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold',
          'border border-[var(--border-strong)] text-[var(--text-secondary)]',
          'motion-safe:transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
          'disabled:opacity-60',
        ].join(' ')}
      >
        {pending
          ? <Loader2 aria-hidden="true" size={16} className="shrink-0 motion-safe:animate-spin" />
          : <XCircle aria-hidden="true" size={16} className="shrink-0" />}
        {pending ? 'กำลังยกเลิก…' : 'ยกเลิกใบแจ้งหนี้นี้'}
      </button>
      {error && (
        <p data-testid="abandon-invoice-error" role="alert" className="text-xs leading-5 text-[var(--negative)]">
          {error}
        </p>
      )}
    </div>
  );
}
