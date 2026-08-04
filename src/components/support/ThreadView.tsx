import { Lock, Paperclip } from 'lucide-react';
import { AttachmentLink } from './AttachmentLink';
import type { SupportAttachmentRef, SupportThreadMessage } from '@/src/lib/support/ticket-repository';

/**
 * The conversation, shared by tickets and refund requests.
 *
 * An internal note renders with a lock and a distinct background, and reaches
 * this component only when the caller asked for internal rows — which only the
 * operator console does, and which the row-level policy independently refuses
 * for anybody else. Two locks, because a note leaking is the failure that makes
 * operators stop writing honest ones.
 */

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

function when(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

const AUTHOR_LABEL: Readonly<Record<string, string>> = {
  user: 'คุณ',
  admin: 'ทีมงาน PortKheaw',
  system: 'ระบบ',
};

export function ThreadView({
  opening,
  messages,
  attachments,
  /** How the reader's own messages are labelled. The console says "ผู้ใช้". */
  ownLabel = 'คุณ',
}: {
  opening: { body: string; createdAt: string };
  messages: readonly SupportThreadMessage[];
  attachments: readonly SupportAttachmentRef[];
  ownLabel?: string;
}) {
  return (
    <div className="min-w-0 space-y-3">
      <article className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
        <header className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-[var(--text)]">{ownLabel}</span>
          <time className="text-xs text-[var(--text-muted)]">{when(opening.createdAt)}</time>
        </header>
        <p className="whitespace-pre-wrap break-words text-sm leading-7 text-[var(--text-muted)]">
          {opening.body}
        </p>
        {attachments.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
            <Paperclip aria-hidden="true" size={14} className="text-[var(--text-muted)]" />
            {attachments.map((attachment) => (
              <AttachmentLink key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
      </article>

      {messages.map((message) => {
        const mine = message.authorRole === 'user';
        return (
          <article
            key={message.id}
            className={`min-w-0 rounded-2xl border p-4 ${message.isInternal
              ? 'border-dashed border-[var(--border-strong)] bg-[var(--surface-hover)]'
              : mine
                ? 'border-[var(--border)] bg-[var(--surface)]'
                : 'border-[var(--border)] bg-[var(--accent-soft)]'}`}
          >
            <header className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
                {message.isInternal && <Lock aria-hidden="true" size={13} />}
                {mine ? ownLabel : AUTHOR_LABEL[message.authorRole] ?? 'ทีมงาน'}
                {message.isInternal && (
                  <span className="text-xs font-normal text-[var(--text-muted)]">
                    · บันทึกภายใน (ผู้ใช้มองไม่เห็น)
                  </span>
                )}
              </span>
              <time className="text-xs text-[var(--text-muted)]">{when(message.createdAt)}</time>
            </header>
            <p className="whitespace-pre-wrap break-words text-sm leading-7 text-[var(--text-muted)]">
              {message.body}
            </p>
          </article>
        );
      })}
    </div>
  );
}
