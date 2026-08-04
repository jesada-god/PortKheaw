import { notFound } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { TicketStatusControl } from '@/src/components/admin/TicketStatusControl';
import { ReplyForm } from '@/src/components/support/ReplyForm';
import { StatusChip } from '@/src/components/support/StatusChip';
import { ThreadView } from '@/src/components/support/ThreadView';
import { adminReplyToTicketAction } from '@/app/support/actions';
import { createClient } from '@/src/lib/supabase/server';
import { readTicket, readTicketAudit } from '@/src/lib/support/ticket-repository';
import {
  SUPPORT_CATEGORY_LABEL,
  TICKET_STATUS_LABEL,
  ticketStatusTone,
} from '@/src/lib/support/presentation';

export const dynamic = 'force-dynamic';

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

/**
 * One ticket, as an operator sees it.
 *
 * This is the only surface in the product that passes `includeInternal`, and the
 * only one that renders the audit trail. Both are reached through the operator's
 * own session, so the admin arm of the row-level policies is what permits them —
 * the page does not hold a privileged client.
 */
export default async function AdminTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  if (!supabase) notFound();

  const ticket = await readTicket(supabase, id, { includeInternal: true });
  if (!ticket) notFound();
  const audit = await readTicketAudit(supabase, id);

  return (
    <div className="min-w-0">
      <Header
        title={ticket.subject}
        subtitle={`${ticket.reference} · ${SUPPORT_CATEGORY_LABEL[ticket.category]}`}
        backFallbackHref="/admin/support"
      />
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6 p-4 md:p-8">
        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              label={TICKET_STATUS_LABEL[ticket.status]}
              tone={ticketStatusTone(ticket.status)}
            />
            <span className="text-xs text-[var(--text-muted)]">
              แพ็กเกจตอนแจ้ง: {ticket.tierSnapshot} · แจ้งเมื่อ {when(ticket.createdAt)}
            </span>
          </div>
          <TicketStatusControl ticketId={ticket.id} current={ticket.status} />
        </section>

        <ThreadView
          opening={{ body: ticket.description, createdAt: ticket.createdAt }}
          messages={ticket.messages}
          attachments={ticket.attachments}
          ownLabel="ผู้ใช้"
        />

        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5">
          <h2 className="text-sm font-semibold text-[var(--text)]">ตอบกลับหรือบันทึกภายใน</h2>
          <ReplyForm
            action={adminReplyToTicketAction}
            idField="ticketId"
            idValue={ticket.id}
            placeholder="ข้อความถึงผู้ใช้ หรือบันทึกภายในสำหรับทีมงาน"
            submitLabel="บันทึกข้อความ"
            internalToggle
          />
        </section>

        <section className="min-w-0 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text)]">บันทึกการตรวจสอบ</h2>
          <ul className="min-w-0 divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {audit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">{entry.action}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">
                  {entry.actorRole}
                  {entry.fromStatus || entry.toStatus
                    ? ` · ${entry.fromStatus ?? '—'} → ${entry.toStatus ?? '—'}`
                    : ''}
                </span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">{when(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
