import { notFound, redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { ReplyForm } from '@/src/components/support/ReplyForm';
import { StatusChip } from '@/src/components/support/StatusChip';
import { ThreadView } from '@/src/components/support/ThreadView';
import { replyToTicketAction } from '@/app/support/actions';
import { createClient } from '@/src/lib/supabase/server';
import { readTicket } from '@/src/lib/support/ticket-repository';
import {
  SUPPORT_CATEGORY_LABEL,
  TICKET_STATUS_LABEL,
  ticketAcceptsReply,
  ticketStatusTone,
} from '@/src/lib/support/presentation';

export const dynamic = 'force-dynamic';

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

/**
 * One ticket, as its owner sees it.
 *
 * `includeInternal` is never set here, so operator notes are excluded from the
 * query as well as being invisible to the row-level policy. The reader's own
 * page has no code path that could render one.
 *
 * A ticket belonging to somebody else is `notFound()`, not "forbidden": the
 * policy returns no row, and telling a stranger that a ticket id exists is
 * itself a disclosure.
 */
export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  if (!supabase) notFound();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/sign-in?next=/support/tickets/${id}`);

  const ticket = await readTicket(supabase, id);
  if (!ticket) notFound();

  const opened = Date.parse(ticket.createdAt);

  return (
    <div className="min-w-0">
      <Header title={ticket.subject} subtitle={`เรื่องหมายเลข ${ticket.reference}`} backFallbackHref="/support" />
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6 p-4 md:p-8">
        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              label={TICKET_STATUS_LABEL[ticket.status]}
              tone={ticketStatusTone(ticket.status)}
            />
            <span className="text-xs text-[var(--text-muted)]">
              {SUPPORT_CATEGORY_LABEL[ticket.category]}
              {Number.isFinite(opened) ? ` · แจ้งเมื่อ ${DATE_FORMAT.format(new Date(opened))}` : ''}
            </span>
          </div>
          {ticket.status === 'waiting_user' && (
            <p className="text-sm text-[var(--text)]">
              ทีมงานรอข้อมูลเพิ่มเติมจากคุณ ตอบกลับด้านล่างเพื่อให้เรื่องเดินต่อได้
            </p>
          )}
        </section>

        <ThreadView
          opening={{ body: ticket.description, createdAt: ticket.createdAt }}
          messages={ticket.messages}
          attachments={ticket.attachments}
        />

        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5">
          <h2 className="text-sm font-semibold text-[var(--text)]">ตอบกลับ</h2>
          <ReplyForm
            action={replyToTicketAction}
            idField="ticketId"
            idValue={ticket.id}
            allowAttachment
            disabledReason={
              ticketAcceptsReply(ticket.status)
                ? undefined
                : 'เรื่องนี้ปิดแล้ว หากยังต้องการความช่วยเหลือ กรุณาแจ้งเรื่องใหม่จากหน้าช่วยเหลือ'
            }
          />
        </section>
      </main>
    </div>
  );
}
