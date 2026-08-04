import Link from 'next/link';
import { ChevronRight, ReceiptText } from 'lucide-react';
import { StatusChip } from '@/src/components/support/StatusChip';
import {
  REFUND_REASON_LABEL,
  REFUND_STATUS_LABEL,
  displayBaht,
  refundStatusTone,
} from '@/src/lib/support/presentation';
import type { RefundRequestSummary } from '@/src/lib/support/refund-repository';

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeZone: 'Asia/Bangkok',
});

function when(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

/** Shared by the reader's list and the operator queue; only `hrefBase` differs. */
export function RefundRequestList({
  requests,
  hrefBase,
  emptyMessage,
}: {
  requests: readonly RefundRequestSummary[];
  hrefBase: string;
  emptyMessage: string;
}) {
  if (requests.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border-strong)] p-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-[var(--surface-hover)] text-[var(--text-muted)]">
          <ReceiptText aria-hidden="true" size={20} />
        </span>
        <p className="max-w-sm text-sm text-[var(--text-muted)]">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className="min-w-0 space-y-2">
      {requests.map((request) => {
        const amount = displayBaht(request.amountMinor, request.currency);
        return (
          <li key={request.id} className="min-w-0">
            <Link
              href={`${hrefBase}/${request.id}`}
              className="flex min-w-0 items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-center gap-2">
                  <StatusChip
                    label={REFUND_STATUS_LABEL[request.status]}
                    tone={refundStatusTone(request.status)}
                  />
                  <span className="text-xs text-[var(--text-muted)]">{request.reference}</span>
                </span>
                <span className="block truncate font-medium text-[var(--text)]">
                  {amount ? `${amount} บาท` : 'คำขอคืนเงิน'}
                  <span className="font-normal text-[var(--text-muted)]">
                    {' · '}{REFUND_REASON_LABEL[request.reasonCategory]}
                  </span>
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  ส่งเมื่อ {when(request.createdAt)}
                </span>
              </span>
              <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-[var(--text-muted)]" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
