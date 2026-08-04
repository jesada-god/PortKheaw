import Link from 'next/link';
import { ChevronRight, Inbox } from 'lucide-react';
import { StatusChip } from './StatusChip';
import {
  SUPPORT_CATEGORY_LABEL,
  TICKET_STATUS_LABEL,
  ticketStatusTone,
} from '@/src/lib/support/presentation';
import type { SupportTicketSummary } from '@/src/lib/support/ticket-repository';

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

function when(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

/**
 * The ticket list, for both the reader and the operator.
 *
 * `hrefBase` is what tells them apart — `/support/tickets` and
 * `/admin/support` — because the row markup, the status vocabulary and the
 * layout are the same job on both surfaces and keeping two copies is how they
 * drift.
 */
export function TicketList({
  tickets,
  hrefBase,
  emptyMessage,
}: {
  tickets: readonly SupportTicketSummary[];
  hrefBase: string;
  emptyMessage: string;
}) {
  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border-strong)] p-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-[var(--surface-hover)] text-[var(--text-muted)]">
          <Inbox aria-hidden="true" size={20} />
        </span>
        <p className="max-w-sm text-sm text-[var(--text-muted)]">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className="min-w-0 space-y-2">
      {tickets.map((ticket) => (
        <li key={ticket.id} className="min-w-0">
          <Link
            href={`${hrefBase}/${ticket.id}`}
            className="flex min-w-0 items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <span className="min-w-0 flex-1 space-y-1">
              <span className="flex flex-wrap items-center gap-2">
                <StatusChip
                  label={TICKET_STATUS_LABEL[ticket.status]}
                  tone={ticketStatusTone(ticket.status)}
                />
                <span className="text-xs text-[var(--text-muted)]">
                  {SUPPORT_CATEGORY_LABEL[ticket.category]} · {ticket.reference}
                </span>
              </span>
              <span className="block truncate font-medium text-[var(--text)]">{ticket.subject}</span>
              <span className="block text-xs text-[var(--text-muted)]">
                อัปเดตล่าสุด {when(ticket.updatedAt)}
              </span>
            </span>
            <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-[var(--text-muted)]" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
