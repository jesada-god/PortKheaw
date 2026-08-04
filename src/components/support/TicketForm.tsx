'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Send } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Select } from '@/src/components/ui/Select';
import { createSupportTicketAction } from '@/app/support/actions';
import { supportCategoryOptions } from '@/src/lib/support/presentation';

/**
 * "รายงานปัญหา".
 *
 * The client validates only what the reader benefits from being told early —
 * lengths, and an image that is obviously the wrong type or too large. Every one
 * of those checks exists again on the server and again as a database constraint;
 * this copy is a courtesy, not a control.
 *
 * Nothing about the account, the plan, the status or the time is in this form.
 * They are written by the routine from the session and its own clock, which is
 * why there is no hidden field here to tamper with.
 */

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ACCEPTED = 'image/png,image/jpeg,image/webp,image/gif';

export function TicketForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  return (
    <form
      ref={formRef}
      action={(formData) => {
        setError(null);
        setSuccess(null);

        const file = formData.get('attachment');
        if (file instanceof File && file.size > MAX_ATTACHMENT_BYTES) {
          setError('ไฟล์แนบต้องมีขนาดไม่เกิน 5 MB');
          return;
        }

        startTransition(async () => {
          const result = await createSupportTicketAction(formData);
          if (!result.ok) {
            setError(result.message);
            return;
          }
          formRef.current?.reset();
          setSuccess(
            result.attachmentWarning
            ?? `รับเรื่องหมายเลข ${result.reference} แล้ว ทีมงานจะติดต่อกลับผ่านหน้าเรื่องนี้`,
          );
          router.refresh();
        });
      }}
      className="min-w-0 space-y-4"
    >
      <div className="min-w-0 space-y-1.5">
        <label htmlFor="ticket-category" className="text-sm font-medium text-[var(--text)]">
          หมวดหมู่
        </label>
        <Select id="ticket-category" name="category" defaultValue="technical" required>
          {supportCategoryOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor="ticket-subject" className="text-sm font-medium text-[var(--text)]">
          หัวข้อ
        </label>
        <Input
          id="ticket-subject"
          name="subject"
          required
          minLength={3}
          maxLength={160}
          placeholder="สรุปปัญหาสั้น ๆ"
          autoComplete="off"
        />
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor="ticket-description" className="text-sm font-medium text-[var(--text)]">
          รายละเอียด
        </label>
        <textarea
          id="ticket-description"
          name="description"
          required
          minLength={10}
          maxLength={4000}
          rows={6}
          placeholder="เกิดอะไรขึ้น ทำอะไรอยู่ตอนนั้น และคาดหวังให้เป็นอย่างไร"
          className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 py-2 text-sm leading-6 text-[var(--text)] transition-colors placeholder:text-[var(--text-muted)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
        />
        <p className="text-xs text-[var(--text-muted)]">
          อย่าใส่รหัสผ่านหรือเลขบัตรเครดิตในข้อความ ทีมงานไม่มีความจำเป็นต้องใช้ข้อมูลเหล่านี้
        </p>
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor="ticket-attachment" className="text-sm font-medium text-[var(--text)]">
          แนบรูป (ไม่บังคับ)
        </label>
        <Input id="ticket-attachment" name="attachment" type="file" accept={ACCEPTED} className="h-auto py-2" />
        <p className="text-xs text-[var(--text-muted)]">รองรับ PNG, JPG, WebP, GIF ขนาดไม่เกิน 5 MB</p>
      </div>

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
        ส่งเรื่องให้ทีมงาน
      </Button>
    </form>
  );
}
