'use client';

import { useState, useTransition } from 'react';
import { ImageIcon } from 'lucide-react';
import { getAttachmentUrlAction } from '@/app/support/actions';
import type { SupportAttachmentRef } from '@/src/lib/support/ticket-repository';

/**
 * Opening a private attachment.
 *
 * The URL is minted on demand and lives for five minutes, so nothing durable is
 * ever rendered into the page — a screenshot link copied out of the HTML would
 * stop working before it could be shared, and one that was never rendered cannot
 * be scraped at all.
 *
 * The click opens the tab *before* awaiting, then points it at the URL. Opening
 * a tab after an await is what Safari's popup blocker exists to stop, and the
 * blocked-tab failure looks exactly like a broken button.
 */
export function AttachmentLink({ attachment }: { attachment: SupportAttachmentRef }) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  const label = `รูปแนบ · ${Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB`;

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setFailed(false);
        const opened = window.open('', '_blank', 'noopener,noreferrer');
        startTransition(async () => {
          const url = await getAttachmentUrlAction(attachment.id);
          if (!url) {
            opened?.close();
            setFailed(true);
            return;
          }
          if (opened) opened.location.href = url;
          else window.location.href = url;
        });
      }}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
    >
      <ImageIcon aria-hidden="true" size={13} />
      {failed ? 'เปิดรูปไม่สำเร็จ' : pending ? 'กำลังเปิด…' : label}
    </button>
  );
}
