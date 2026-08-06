'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Send } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Select } from '@/src/components/ui/Select';
import { createRefundRequestAction } from '@/app/settings/refunds/actions';
import { billingPlans } from '@/src/lib/billing/billing-plans';
import {
  REFUND_WINDOW_DAYS,
  refundableInvoiceStatus,
  refundWindowSummary,
  resolveRefundWindow,
} from '@/src/lib/billing/refund-window';
import { displayBaht, refundReasonOptions } from '@/src/lib/support/presentation';
import type { BillingInvoiceView } from '@/src/lib/support/refund-repository';

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '';
}

/**
 * Asking for a refund.
 *
 * The purchase is chosen from a list the server produced for this reader, and
 * what the form submits is *our* uuid for it. That value identifies nothing at
 * the payment provider and nothing on another account, so the worst a tampered
 * submission achieves is a `not_found` from the ownership lookup.
 *
 * The notice above the button is not decoration. Readers routinely believe that
 * asking for a refund cancels their plan on the spot; saying otherwise here is
 * cheaper than the ticket that follows when they discover it did not.
 */
export function RefundRequestForm({ invoices }: { invoices: readonly BillingInvoiceView[] }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /*
   * A purchase that is refundable in principle: collected, and with no request
   * against it that is still undecided or already settled.
   */
  const owned = invoices.filter(
    (invoice) =>
      refundableInvoiceStatus(invoice.status)
      && invoice.refundRequestStatus !== 'pending'
      && invoice.refundRequestStatus !== 'reviewing'
      && invoice.refundRequestStatus !== 'approved'
      && invoice.refundRequestStatus !== 'refunded',
  );

  /*
   * …and still inside its seven days, judged against the clock the server sent
   * with the row. The server checks this again — it is the authority, and this
   * filter only decides what is worth offering. A charge whose window has closed
   * is dropped from the list rather than offered and then refused.
   */
  const windows = new Map(owned.map((invoice) => [
    invoice.invoiceRef,
    resolveRefundWindow({
      paidAt: invoice.paidAt,
      deadlineAt: invoice.refundDeadlineAt,
      now: invoice.databaseNow,
    }),
  ]));
  const eligible = owned.filter((invoice) => windows.get(invoice.invoiceRef)?.state === 'open');
  const [selected, setSelected] = useState<string | null>(eligible[0]?.invoiceRef ?? null);
  const expired = owned.filter((invoice) => windows.get(invoice.invoiceRef)?.state === 'closed');

  if (eligible.length === 0) {
    return (
      <div className="min-w-0 space-y-3">
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-3 text-sm leading-6 text-[var(--text-muted)]">
          ตอนนี้ยังไม่มีรายการชำระเงินที่ขอคืนเงินได้
          {expired.length > 0 && ` มี ${expired.length} รายการที่พ้นกำหนด ${REFUND_WINDOW_DAYS} วันไปแล้ว`}
          {' '}หากคิดว่ามีรายการที่ควรขอคืนได้ ติดต่อทีมงานผ่านหน้าช่วยเหลือได้เลย
        </p>
        {/* The dates they closed on, so "why not?" is answerable here rather
            than only in a support thread. */}
        {expired.length > 0 && (
          <ul data-testid="refund-expired-list" className="min-w-0 space-y-1">
            {expired.map((invoice) => (
              <li key={invoice.invoiceRef} className="min-w-0 text-xs break-words text-[var(--text-muted)]">
                {invoice.planKey ? billingPlans[invoice.planKey]?.name : 'แพ็กเกจ'}
                {' · '}
                {refundWindowSummary(windows.get(invoice.invoiceRef)!)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const selectedWindow = selected ? windows.get(selected) : undefined;

  return (
    <form
      ref={formRef}
      action={(formData) => {
        setError(null);
        setSuccess(null);
        startTransition(async () => {
          const result = await createRefundRequestAction(formData);
          if (!result.ok) {
            setError(result.message);
            return;
          }
          formRef.current?.reset();
          setSuccess(
            result.attachmentWarning
            ?? `รับคำขอหมายเลข ${result.reference} แล้ว ทีมงานจะตรวจสอบและแจ้งผลให้ทราบ`,
          );
          router.refresh();
        });
      }}
      className="min-w-0 space-y-4"
    >
      <div className="min-w-0 space-y-1.5">
        <label htmlFor="refund-invoice" className="text-sm font-medium text-[var(--text)]">
          รายการชำระเงิน
        </label>
        <Select
          id="refund-invoice"
          name="invoiceRef"
          required
          value={selected ?? undefined}
          onChange={(event) => setSelected(event.target.value)}
        >
          {eligible.map((invoice) => {
            const amount = displayBaht(invoice.amountPaidMinor, invoice.currency);
            const planName = invoice.planKey ? billingPlans[invoice.planKey]?.name : 'แพ็กเกจ';
            const paid = when(invoice.paidAt ?? invoice.issuedAt);
            return (
              <option key={invoice.invoiceRef} value={invoice.invoiceRef}>
                {planName}{amount ? ` · ${amount} บาท` : ''}{paid ? ` · ${paid}` : ''}
              </option>
            );
          })}
        </Select>
        {/* The exact deadline for the purchase currently selected, and how long
            is left of it. Both come from the server's clock; nothing here reads
            the device's. */}
        {selectedWindow && (
          <p data-testid="refund-window-deadline" className="text-xs leading-5 break-words text-[var(--text-muted)]">
            {refundWindowSummary(selectedWindow)}
          </p>
        )}
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor="refund-reason" className="text-sm font-medium text-[var(--text)]">
          เหตุผล
        </label>
        <Select id="refund-reason" name="reason" required defaultValue="not_as_expected">
          {refundReasonOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor="refund-details" className="text-sm font-medium text-[var(--text)]">
          รายละเอียด
        </label>
        <textarea
          id="refund-details"
          name="details"
          required
          minLength={10}
          maxLength={4000}
          rows={5}
          placeholder="อธิบายสิ่งที่เกิดขึ้น เพื่อให้ทีมงานตรวจสอบได้เร็วขึ้น"
          className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 py-2 text-sm leading-6 text-[var(--text)] transition-colors placeholder:text-[var(--text-muted)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
        />
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor="refund-attachment" className="text-sm font-medium text-[var(--text)]">
          แนบรูป (ไม่บังคับ)
        </label>
        <Input
          id="refund-attachment"
          name="attachment"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="h-auto py-2"
        />
      </div>

      <p className="rounded-xl border border-[var(--border)] bg-[var(--accent-soft)] px-4 py-3 text-sm leading-6 text-[var(--text)]">
        การส่งคำขอยังไม่ใช่การคืนเงิน และไม่ตัดสิทธิ์การใช้งานของคุณ
        แพ็กเกจจะยังใช้งานได้ตามปกติจนกว่าจะมีการคืนเงินจริงจากผู้ให้บริการชำระเงิน
        ทีมงานจะตรวจสอบเป็นรายกรณีก่อนตัดสิน
      </p>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-[var(--negative)]">
          <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}
      {success && (
        <p role="status" className="flex items-start gap-2 text-sm text-[var(--positive)]">
          <CheckCircle2 aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{success}</span>
        </p>
      )}

      <Button type="submit" isLoading={pending} className="w-full sm:w-auto">
        {!pending && <Send aria-hidden="true" size={16} className="mr-2" />}
        ส่งคำขอคืนเงิน
      </Button>
    </form>
  );
}
