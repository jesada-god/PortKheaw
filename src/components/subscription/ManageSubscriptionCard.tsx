import { AlertTriangle, CalendarClock, CreditCard, QrCode, ShieldCheck } from 'lucide-react';
import { BillingPortalButton } from './BillingPortalButton';
import {
  PAYMENT_METHOD_COMMITMENT,
  PAYMENT_METHOD_LABEL,
} from '@/src/lib/billing/billing-payment-method';
import {
  DATA_KEPT_ON_DOWNGRADE_NOTE,
  formatBahtAmount,
  founderRenewalNote,
  type BillingSummary,
} from '@/src/lib/billing/billing-summary';
import { formatBangkokDateTime } from '@/src/lib/subscription/trial';

/**
 * What a paying reader needs to know about their own subscription, without
 * opening the provider: the plan, the cadence, the state it is in, the date and
 * the amount of the next charge, and how to stop it.
 *
 * Every value arrives already resolved from the sanitized server snapshot. No
 * provider customer, subscription, price or invoice identifier reaches this
 * component, so none of them can reach the browser.
 *
 * The card renders nothing at all when nothing has been purchased — the plan
 * cards above already speak to that reader.
 */

const TONE_CLASS: Readonly<Record<BillingSummary['statusTone'], string>> = {
  active: 'border-[var(--brand-green)] text-[var(--brand-green)] bg-[color-mix(in_srgb,var(--brand-green)_12%,transparent)]',
  ending: 'border-[var(--warning)] text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]',
  warning: 'border-[var(--negative)] text-[var(--negative)] bg-[color-mix(in_srgb,var(--negative)_12%,transparent)]',
  inactive: 'border-[var(--border-strong)] text-[var(--text-secondary)] bg-[var(--surface-hover)]',
};

export function ManageSubscriptionCard({ summary }: { summary: BillingSummary }) {
  if (summary.kind !== 'paid') return null;

  return (
    <section
      aria-labelledby="manage-subscription-heading"
      data-testid="manage-subscription-card"
      data-status-tone={summary.statusTone}
      className="min-w-0 space-y-4 rounded-3xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5 sm:p-7"
    >
      <div className="min-w-0 space-y-2">
        <h2 id="manage-subscription-heading" className="text-lg font-bold text-[var(--text)]">
          การเรียกเก็บเงิน
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p data-testid="billing-plan-name" className="min-w-0 text-base font-semibold break-words text-[var(--text)]">
            {summary.planName}
          </p>
          <span
            data-testid="billing-status"
            className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[summary.statusTone]}`}
          >
            {summary.statusLabel}
          </span>
        </div>
      </div>

      <dl className="min-w-0 space-y-3 border-t border-[var(--border)] pt-4 text-sm">
        {summary.paymentMethod && (
          <div className="flex min-w-0 items-start gap-2">
            {summary.paymentMethod === 'promptpay'
              ? <QrCode aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
              : <CreditCard aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />}
            <div className="min-w-0">
              <dt className="text-[var(--text-muted)]">วิธีชำระเงิน</dt>
              <dd data-testid="billing-payment-method" className="mt-0.5 font-medium break-words text-[var(--text)]">
                {PAYMENT_METHOD_LABEL[summary.paymentMethod]}
                {' · '}
                {PAYMENT_METHOD_COMMITMENT[summary.paymentMethod]}
              </dd>
            </div>
          </div>
        )}

        {summary.periodEnd && (
          <div className="flex min-w-0 items-start gap-2">
            <CalendarClock aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
            <div className="min-w-0">
              <dt className="text-[var(--text-muted)]">{summary.periodEndLabel}</dt>
              <dd data-testid="billing-period-end" className="mt-0.5 font-medium break-words text-[var(--text)]">
                {formatBangkokDateTime(summary.periodEnd)}
              </dd>
            </div>
          </div>
        )}

        {/* The renewal amount, never the promotional one — it is the number a
            reader is most likely to be surprised by. On the invoice rail it is
            what the next QR will ask for rather than what will be collected. */}
        {summary.renewalBaht !== null && !summary.cancelAtPeriodEnd && (
          <div className="min-w-0">
            <dt className="text-[var(--text-muted)]">
              {summary.autoRenews ? 'ราคาต่ออายุ' : 'ราคารอบถัดไป'}
            </dt>
            <dd data-testid="billing-renewal-price" className="mt-0.5 font-medium tabular-nums text-[var(--text)]">
              {formatBahtAmount(summary.renewalBaht)} {summary.intervalLabel}
            </dd>
          </div>
        )}
      </dl>

      {summary.renewalNote && (
        <p data-testid="billing-renewal-note" className="text-xs leading-5 text-[var(--text-secondary)]">
          {summary.renewalNote}
        </p>
      )}

      {/* The one reminder this product sends itself: a PromptPay period that is
          about to lapse, which nobody else will chase. */}
      {summary.renewalReminder && (
        <p
          data-testid="billing-renewal-reminder"
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-2.5 text-sm leading-6 text-[var(--text)]"
        >
          <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--warning)]" />
          <span>{summary.renewalReminder}</span>
        </p>
      )}

      {summary.firstPeriodBaht !== null && summary.renewalBaht !== null && (
        <p data-testid="billing-founder-note" className="text-xs leading-5 text-[var(--text-secondary)]">
          {founderRenewalNote(summary.firstPeriodBaht, summary.renewalBaht)}
        </p>
      )}

      {summary.latestPaymentFailed && (
        <p
          data-testid="billing-payment-failed"
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-[var(--negative)] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] px-3 py-2.5 text-sm leading-6 text-[var(--text)]"
        >
          <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--negative)]" />
          <span>
            การเรียกเก็บเงินครั้งล่าสุดไม่สำเร็จ
            {' '}อัปเดตวิธีการชำระเงินเพื่อใช้แพ็กเกจต่อโดยไม่สะดุด
          </span>
        </p>
      )}

      {summary.cancelAtPeriodEnd && (
        <p data-testid="billing-cancel-note" className="text-sm leading-6 text-[var(--text-secondary)]">
          คุณได้ยกเลิกการต่ออายุแล้ว แพ็กเกจนี้ยังใช้งานได้ตามปกติจนจบรอบบิลปัจจุบัน
          {' '}และจะไม่มีการเรียกเก็บเงินอีก
        </p>
      )}

      <div className="min-w-0 space-y-2 border-t border-[var(--border)] pt-4">
        {/* Cancellation, payment methods and invoices all live in the provider's
            own portal. Rebuilding them here would mean handling a card; sending
            the reader there means a cancellation returns as a signed webhook
            like every other state change. */}
        <BillingPortalButton canOpen={summary.canOpenPortal} />
        <p className="flex items-start gap-2 text-xs leading-5 text-[var(--text-muted)]">
          <ShieldCheck aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
          <span>{DATA_KEPT_ON_DOWNGRADE_NOTE}</span>
        </p>
      </div>
    </section>
  );
}
