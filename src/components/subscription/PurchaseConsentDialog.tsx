'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import {
  PURCHASE_CONSENT_LABEL,
  purchaseCommitmentNotes,
  purchaseConsentLinks,
  purchaseDisclosureRows,
  type PurchasePolicyVersions,
} from '@/src/lib/billing/purchase-consent';
import type { BillingPaymentMethod } from '@/src/lib/billing/billing-payment-method';
import type { BillingPlanKey } from '@/src/lib/billing/billing-plans';

/**
 * The step between pressing Subscribe and being sent to the payment provider.
 *
 * It exists because the two things a buyer most often discovers too late — that
 * a card keeps charging until they cancel, and that a refund has a deadline —
 * are both decided here and are both invisible on the provider's own page. So
 * they are stated before the decision, in the reader's language, with the plan
 * and the amount beside them.
 *
 * Three properties worth stating outright:
 *
 *   * **The box starts unticked, every time.** The parent mounts this component
 *     only while the dialog is open, so its state is new on each press. There is
 *     no remembered acceptance, and no way for a previous purchase to pre-tick
 *     anything.
 *   * **Ticking it buys nothing.** The confirm button calls the same server
 *     action as before, which checks the acceptance again — against the policy
 *     versions the *server* publishes — before it will start a checkout. This
 *     control is a way to give consent, never a way to prove it.
 *   * **No amount crosses the wire.** The summary below is rendered from the
 *     plan catalogue on this side and read from the same catalogue on the other;
 *     what the browser sends is still a plan key, a rail, and now a boolean and
 *     two version strings.
 */
export function PurchaseConsentDialog({
  planKey,
  paymentMethod,
  policyVersions,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  planKey: BillingPlanKey;
  paymentMethod: BillingPaymentMethod;
  /** Rendered by the server that published the wording; echoed back on confirm. */
  policyVersions: PurchasePolicyVersions;
  pending: boolean;
  error: string | null;
  onConfirm(): void;
  onClose(): void;
}) {
  const [accepted, setAccepted] = useState(false);
  const checkboxId = `purchase-consent-${useId().replaceAll(':', '')}`;
  const rows = purchaseDisclosureRows({ planKey, paymentMethod });
  const notes = purchaseCommitmentNotes({ planKey, paymentMethod });

  return (
    <ResponsiveDialog
      isOpen
      onClose={pending ? () => undefined : onClose}
      title="ยืนยันก่อนชำระเงิน"
    >
      <div className="min-w-0 space-y-4" data-testid="purchase-consent-dialog">
        <dl
          data-testid="purchase-consent-summary"
          className="min-w-0 divide-y divide-slate-800 rounded-xl border border-slate-700"
        >
          {rows.map((row) => (
            <div key={row.label} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2.5">
              <dt className="shrink-0 text-xs text-slate-400">{row.label}</dt>
              <dd className="min-w-0 flex-1 text-right text-sm font-semibold break-words text-white">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        <ul className="min-w-0 space-y-2">
          {notes.map((note) => (
            <li
              key={note}
              className="flex min-w-0 items-start gap-2 text-xs leading-5 break-words text-slate-300"
            >
              <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-[var(--text-muted)]" />
              <span className="min-w-0">{note}</span>
            </li>
          ))}
        </ul>

        <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {purchaseConsentLinks().map((link) => (
            <Link
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-9 items-center gap-1 text-xs font-medium text-[#D4FF00] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
            >
              {link.label}
              <ExternalLink aria-hidden="true" size={12} className="shrink-0" />
            </Link>
          ))}
        </p>

        {/* The one control that has to be operated deliberately. Nothing else in
            this dialog is a decision. */}
        <label
          htmlFor={checkboxId}
          className="flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border border-slate-700 p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[#D4FF00]"
        >
          <input
            id={checkboxId}
            name="purchaseConsent"
            type="checkbox"
            data-testid="purchase-consent-checkbox"
            checked={accepted}
            disabled={pending}
            onChange={(event) => setAccepted(event.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-[#D4FF00]"
          />
          <span className="min-w-0 text-sm leading-6 break-words text-white">
            {PURCHASE_CONSENT_LABEL}
          </span>
        </label>

        {error && (
          <p
            role="alert"
            data-testid="purchase-consent-error"
            className="flex min-w-0 items-start gap-2 text-xs leading-5 text-[var(--negative)]"
          >
            <AlertTriangle aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}

        <div className="flex min-w-0 flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            data-testid="purchase-consent-confirm"
            onClick={onConfirm}
            /* Held closed until the box is ticked, and held down for the whole
               transition so a second press cannot open a second checkout. */
            disabled={!accepted || pending}
            aria-busy={pending}
            /* `--accent-fg` rather than a fixed navy: the accent is lime in the
               dark appearance and a dark olive in the light one, so the only
               colour that stays legible *on* it is the one the theme pairs with
               it. A literal hex here read as near-black on olive in light mode. */
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[#D4FF00] px-4 text-sm font-semibold text-[var(--accent-fg)] transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4FF00] disabled:opacity-40"
          >
            {pending && <Loader2 aria-hidden="true" size={16} className="shrink-0 motion-safe:animate-spin" />}
            {pending
              ? (paymentMethod === 'promptpay' ? 'กำลังสร้างใบแจ้งหนี้…' : 'กำลังเปิดหน้าชำระเงิน…')
              : 'ยอมรับและไปหน้าชำระเงิน'}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-700 px-4 text-sm font-medium text-slate-300 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4FF00] disabled:opacity-40 sm:flex-1"
          >
            ยกเลิก
          </button>
        </div>

        {/* Never shown; it is what the confirm sends back, and keeping it in the
            markup is what makes "which wording did this browser accept?"
            answerable from the rendered page. */}
        <input type="hidden" name="subscriptionPolicyVersion" value={policyVersions.subscriptionPolicy} />
        <input type="hidden" name="refundPolicyVersion" value={policyVersions.refundPolicy} />
      </div>
    </ResponsiveDialog>
  );
}
