'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Send } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';

/**
 * One reply box, used by four surfaces: a reader's ticket, a reader's refund
 * request, and the operator's version of each.
 *
 * `internalToggle` is the only difference between the reader's and the
 * operator's rendering, and it is a *display* difference — the routine behind
 * the action refuses an internal note from anybody whose stored role is not
 * `admin`, so rendering the checkbox is not what grants the power.
 */

type ReplyAction = (formData: FormData) => Promise<
  { ok: true } | { ok: false; code: string; message: string }
>;

export function ReplyForm({
  action,
  idField,
  idValue,
  placeholder = 'พิมพ์ข้อความถึงทีมงาน',
  submitLabel = 'ส่งข้อความ',
  internalToggle = false,
  allowAttachment = false,
  disabledReason,
}: {
  action: ReplyAction;
  /** The form field the routine expects: `ticketId` or `requestId`. */
  idField: 'ticketId' | 'requestId';
  idValue: string;
  placeholder?: string;
  submitLabel?: string;
  internalToggle?: boolean;
  allowAttachment?: boolean;
  /** When set, the box renders as a closed notice instead of a form. */
  disabledReason?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (disabledReason) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-3 text-sm text-[var(--text-muted)]">
        {disabledReason}
      </p>
    );
  }

  return (
    <form
      ref={formRef}
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await action(formData);
          if (!result.ok) {
            setError(result.message);
            return;
          }
          formRef.current?.reset();
          router.refresh();
        });
      }}
      className="min-w-0 space-y-3"
    >
      <input type="hidden" name={idField} value={idValue} />
      <textarea
        name="body"
        required
        minLength={1}
        maxLength={4000}
        rows={4}
        placeholder={placeholder}
        className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 py-2 text-sm leading-6 text-[var(--text)] transition-colors placeholder:text-[var(--text-muted)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
      />

      {allowAttachment && (
        <Input
          name="attachment"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label="แนบรูป"
          className="h-auto py-2"
        />
      )}

      {internalToggle && (
        <label className="flex min-h-11 items-center gap-2.5 text-sm text-[var(--text)]">
          <input
            type="checkbox"
            name="internal"
            className="size-4 rounded border-[var(--border-strong)] accent-[var(--accent)]"
          />
          บันทึกภายใน — ผู้ใช้จะไม่เห็นข้อความนี้ และจะไม่ได้รับการแจ้งเตือน
        </label>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-[var(--negative)]">
          <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}

      <Button type="submit" isLoading={pending} className="w-full sm:w-auto">
        {!pending && <Send aria-hidden="true" size={16} className="mr-2" />}
        {submitLabel}
      </Button>
    </form>
  );
}
