'use client';

import { useState, useTransition } from 'react';
import { Sparkles } from 'lucide-react';
import { Modal } from '@/src/components/ui/Modal';
import { Button } from '@/src/components/ui/Button';
import { acknowledgeReleaseNoteAction } from '@/src/lib/release-notes/acknowledge-action';
import {
  parseReleaseBody, type ReleaseImportance,
} from '@/src/lib/release-notes/release-notes';

/**
 * "มีอะไรใหม่", once per reader per release.
 *
 * Two decisions are load-bearing:
 *
 *   * **Text, never markup.** Every line below is a React child, so it is
 *     escaped by the renderer. There is no `dangerouslySetInnerHTML` on this
 *     path and there must never be one: this string is written by an operator
 *     and rendered in every reader's session.
 *   * **Seen on dismiss, not on render.** The acknowledgement is sent when the
 *     reader closes the dialog. Sending it on mount would silently consume an
 *     announcement that flashed past during a navigation, and the reader would
 *     never learn what changed.
 *
 * An `important` release is styled differently and is *still* dismissable. A
 * modal a reader cannot close is not an announcement, it is a lockout, and there
 * is nothing here worth locking anybody out of the product over.
 *
 * The dialog closes optimistically — the reader is not made to wait on a round
 * trip to get their app back. A failed acknowledgement simply means the same
 * announcement appears next visit.
 */

export interface ReleaseAnnouncementProps {
  id: string;
  version: string | null;
  title: string;
  content: string;
  importance: ReleaseImportance;
  publishedAt: string;
}

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium', timeZone: 'Asia/Bangkok',
});

function publishedLabel(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : null;
}

export function ReleaseAnnouncement({
  id, version, title, content, importance, publishedAt,
}: ReleaseAnnouncementProps) {
  const [open, setOpen] = useState(true);
  const [, startTransition] = useTransition();
  const lines = parseReleaseBody(content);
  const dateLabel = publishedLabel(publishedAt);

  function dismiss() {
    setOpen(false);
    startTransition(async () => { await acknowledgeReleaseNoteAction(id); });
  }

  return (
    <Modal isOpen={open} onClose={dismiss} title="✨ PortKheaw มีอะไรใหม่">
      <div className="min-w-0 space-y-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {importance === 'important' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent)]">
                <Sparkles aria-hidden="true" size={12} />
                อัปเดตสำคัญ
              </span>
            )}
            {version && (
              <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)]">
                เวอร์ชัน {version}
              </span>
            )}
            {dateLabel && (
              <span className="text-[11px] text-[var(--text-muted)]">{dateLabel}</span>
            )}
          </div>
          <h3 className="min-w-0 break-words text-base font-semibold text-[var(--text)] [overflow-wrap:anywhere]">
            {title}
          </h3>
        </div>

        <ul className="min-w-0 space-y-2">
          {lines.map((line, index) => (
            <li
              key={`${index}-${line.text}`}
              className={
                line.kind === 'bullet'
                  ? 'flex min-w-0 items-start gap-2 text-sm leading-relaxed text-[var(--text)]'
                  : 'min-w-0 text-sm leading-relaxed text-[var(--text-muted)]'
              }
            >
              {line.kind === 'bullet' && (
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
              )}
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{line.text}</span>
            </li>
          ))}
        </ul>

        <Button type="button" className="w-full" onClick={dismiss}>รับทราบ</Button>
      </div>
    </Modal>
  );
}
