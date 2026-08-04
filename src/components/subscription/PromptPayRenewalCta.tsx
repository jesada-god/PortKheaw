'use client';

import { useRef, useState, useTransition } from 'react';
import { Loader2, QrCode } from 'lucide-react';
import { openPromptPayRenewalAction } from '@/app/settings/subscription/billing-actions';

export const PROMPTPAY_RENEWAL_DISABLED_NOTE = 'ชำระได้เมื่อใกล้หมดอายุ';

export function PromptPayRenewalCta({
  hasOpenInvoice,
  hostedInvoiceUrl,
  canRequestRenewal,
}: {
  hasOpenInvoice: boolean;
  hostedInvoiceUrl: string | null;
  canRequestRenewal: boolean;
}) {
  const submitting = useRef(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (hasOpenInvoice) {
    return hostedInvoiceUrl ? (
      <a
        data-testid="promptpay-open-qr"
        href={hostedInvoiceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
      >
        <QrCode aria-hidden="true" size={16} className="shrink-0" />
        เปิด QR เพื่อชำระ
      </a>
    ) : (
      <button type="button" disabled className="min-h-11 w-full rounded-xl border border-[var(--border-strong)] px-4 text-sm font-semibold opacity-60">
        เปิด QR เพื่อชำระ
      </button>
    );
  }

  function submit() {
    if (submitting.current || !canRequestRenewal) return;
    submitting.current = true;
    setError(null);
    startTransition(async () => {
      const result = await openPromptPayRenewalAction();
      if (result.ok) {
        window.location.assign(result.url);
        return;
      }
      submitting.current = false;
      setError(result.message);
    });
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <button
        type="button"
        data-testid="promptpay-renewal-button"
        onClick={submit}
        disabled={!canRequestRenewal || pending}
        aria-busy={pending}
        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--text)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending
          ? <Loader2 aria-hidden="true" size={16} className="shrink-0 motion-safe:animate-spin" />
          : <QrCode aria-hidden="true" size={16} className="shrink-0" />}
        ชำระรอบถัดไป
      </button>
      {!canRequestRenewal && (
        <p data-testid="promptpay-renewal-disabled-note" className="text-center text-xs leading-5 text-[var(--text-muted)]">
          {PROMPTPAY_RENEWAL_DISABLED_NOTE}
        </p>
      )}
      {error && <p role="alert" className="text-xs leading-5 text-[var(--negative)]">{error}</p>}
    </div>
  );
}
