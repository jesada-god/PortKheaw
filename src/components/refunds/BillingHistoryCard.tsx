import Link from 'next/link';
import { ReceiptText } from 'lucide-react';
import { StatusChip } from '@/src/components/support/StatusChip';
import { billingPlans } from '@/src/lib/billing/billing-plans';
import {
  REFUND_STATUS_LABEL,
  displayBaht,
  refundStatusTone,
} from '@/src/lib/support/presentation';
import {
  refundableInvoiceStatus,
  refundWindowSummary,
  resolveRefundWindow,
} from '@/src/lib/billing/refund-window';
import type { BillingInvoiceView } from '@/src/lib/support/refund-repository';

/**
 * The reader's purchases, on the subscription page.
 *
 * Every value here comes from the sanitized projection: our uuid, a plan key, an
 * amount and two dates. There is no provider invoice identifier, no customer
 * identifier, no hosted receipt URL and no card detail — none of it is needed to
 * answer "what did I pay for, and when", and none of it is in the query.
 *
 * The card renders nothing at all when there are no purchases, rather than an
 * empty state: a Basic reader who has never paid does not need to be told they
 * have no billing history.
 */

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

const INVOICE_STATUS_LABEL: Readonly<Record<string, string>> = {
  open: 'รอชำระ',
  paid: 'ชำระแล้ว',
  void: 'ยกเลิกใบแจ้งหนี้',
  uncollectible: 'เก็บเงินไม่ได้',
  refunded: 'คืนเงินแล้ว',
  partially_refunded: 'คืนเงินบางส่วน',
  disputed: 'อยู่ระหว่างโต้แย้ง',
};

/**
 * The window for one purchase, judged against the clock that came with it.
 *
 * `databaseNow` and never `Date.now()`: this card renders on the server and in
 * the browser, and a deadline that moved with whichever machine drew it would be
 * a different promise on each.
 */
function refundWindow(invoice: BillingInvoiceView) {
  return resolveRefundWindow({
    paidAt: invoice.paidAt,
    deadlineAt: invoice.refundDeadlineAt,
    now: invoice.databaseNow,
  });
}

export function BillingHistoryCard({ invoices }: { invoices: readonly BillingInvoiceView[] }) {
  if (invoices.length === 0) return null;

  return (
    <section className="min-w-0 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text)]">
            <ReceiptText aria-hidden="true" size={18} className="text-[var(--text-muted)]" />
            ประวัติการชำระเงิน
          </h2>
          <p className="text-sm text-[var(--text-muted)]">
            รายการที่ระบบได้รับการยืนยันจากผู้ให้บริการชำระเงิน
          </p>
        </div>
        <Link
          href="/settings/refunds"
          className="inline-flex min-h-9 shrink-0 items-center rounded-md border border-[var(--border-strong)] px-3 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          คำขอคืนเงิน
        </Link>
      </div>

      <ul className="min-w-0 divide-y divide-[var(--border)]">
        {invoices.slice(0, 8).map((invoice) => {
          const amount = displayBaht(invoice.amountPaidMinor, invoice.currency);
          const planName = invoice.planKey ? billingPlans[invoice.planKey]?.name : null;
          return (
            <li key={invoice.invoiceRef} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[var(--text)]">
                  {planName ?? 'แพ็กเกจ PortKheaw'}
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  {when(invoice.paidAt ?? invoice.issuedAt)}
                  {invoice.periodEnd ? ` · ใช้ได้ถึง ${when(invoice.periodEnd)}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-medium tabular-nums text-[var(--text)]">
                  {amount ? `${amount} บาท` : '—'}
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  {INVOICE_STATUS_LABEL[invoice.status] ?? invoice.status}
                </span>
              </span>
              {invoice.refundRequestStatus && (
                <StatusChip
                  label={`คำขอคืนเงิน: ${REFUND_STATUS_LABEL[invoice.refundRequestStatus]}`}
                  tone={refundStatusTone(invoice.refundRequestStatus)}
                />
              )}
              {/*
                The deadline, read-only, on every charge that could be asked
                back. Shown after it has passed as well as before: a reader whose
                window has closed is owed the date it closed on, not a row that
                quietly stops mentioning it.
              */}
              {refundableInvoiceStatus(invoice.status) && (
                <span
                  data-testid="refund-window-note"
                  data-state={refundWindow(invoice).state}
                  className="w-full min-w-0 text-xs break-words text-[var(--text-muted)]"
                >
                  {refundWindowSummary(refundWindow(invoice))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
