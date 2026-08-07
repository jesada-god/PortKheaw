'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Megaphone } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { setMaintenanceAction } from '@/app/admin/system/actions';

/**
 * The switch that takes the product away from everybody who is not an operator.
 *
 * Three things this control is careful about:
 *
 *   * **It asks, in its own words.** The confirmation names what is about to
 *     happen — ordinary readers out, operator accounts still in — rather than
 *     asking "are you sure?", so an operator reads the consequence instead of
 *     the shape of a dialog. No `confirm()`: it cannot be styled, cannot be
 *     read by a screen reader in context, and is silently suppressed by some
 *     browsers, which would turn a refusal into an accidental outage.
 *   * **It cannot be submitted twice.** Every control is disabled for the
 *     duration of the transition, and the server refuses without `confirm=yes`
 *     regardless of what the browser did.
 *   * **It does not couple the announcement to the switch.** Turning the product
 *     back on succeeds on its own; the offer to write a release note appears
 *     afterwards, as a link, with an explicit way to decline. A failure writing
 *     an announcement must never be able to keep the product switched off.
 */

export interface MaintenanceControlProps {
  enabled: boolean;
  message: string | null;
  expectedResumeAt: string | null;
  startedAt: string | null;
  startedByLabel: string | null;
  audit: ReadonlyArray<{ id: number; action: string; at: string; enabled: boolean | null }>;
  /** Where the operator goes to write the announcement after switching back on. */
  releaseNotesHref: string;
}

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

/** An ISO instant as the Bangkok wall clock a `datetime-local` input expects. */
function toBangkokLocalInput(value: string | null): string {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const shifted = new Date(timestamp + 7 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}

export function MaintenanceControl({
  enabled, message, expectedResumeAt, startedAt, startedByLabel, audit, releaseNotesHref,
}: MaintenanceControlProps) {
  const router = useRouter();
  const [draftMessage, setDraftMessage] = useState(message ?? '');
  const [draftResume, setDraftResume] = useState(toBangkokLocalInput(expectedResumeAt));
  const [confirming, setConfirming] = useState<'enable' | 'disable' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [offerAnnouncement, setOfferAnnouncement] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(target: 'enable' | 'disable') {
    setResult(null);
    const formData = new FormData();
    formData.set('enabled', target === 'disable' ? 'true' : 'false');
    formData.set('message', draftMessage);
    formData.set('expectedResumeAt', draftResume);
    formData.set('confirm', 'yes');
    startTransition(async () => {
      const outcome = await setMaintenanceAction(formData);
      setResult(outcome);
      setConfirming(null);
      if (outcome.ok) {
        if (target === 'enable') setOfferAnnouncement(true);
        router.refresh();
      }
    });
  }

  return (
    <div className="min-w-0 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--text)]">สถานะระบบ</h2>
        <p
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1 text-sm font-medium text-[var(--text)]"
          data-testid="maintenance-status"
        >
          <span aria-hidden="true">{enabled ? '🟠' : '🟢'}</span>
          {enabled ? 'กำลังปรับปรุงระบบ' : 'เปิดใช้งาน'}
        </p>
      </div>

      {enabled && (
        <dl className="grid min-w-0 grid-cols-1 gap-1 text-xs text-[var(--text-muted)] sm:grid-cols-2">
          <div className="flex min-w-0 gap-1">
            <dt className="shrink-0">เริ่มปรับปรุง:</dt>
            <dd className="min-w-0 break-words text-[var(--text)]">{when(startedAt)}</dd>
          </div>
          <div className="flex min-w-0 gap-1">
            <dt className="shrink-0">ผู้ปิดระบบล่าสุด:</dt>
            <dd className="min-w-0 break-words text-[var(--text)]">{startedByLabel ?? '—'}</dd>
          </div>
        </dl>
      )}

      <div className="min-w-0 space-y-2">
        <label htmlFor="maintenance-message" className="block text-sm font-medium text-[var(--text)]">
          ข้อความแจ้งผู้ใช้
        </label>
        <textarea
          id="maintenance-message"
          value={draftMessage}
          maxLength={500}
          rows={3}
          disabled={pending}
          onChange={(event) => { setDraftMessage(event.target.value); setConfirming(null); }}
          placeholder="เช่น กำลังอัปเดตระบบพอร์ตการลงทุน คาดว่าจะใช้เวลาประมาณ 30 นาที"
          className="w-full min-w-0 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
        />
        <p className="text-xs text-[var(--text-muted)]">
          แสดงบนหน้า /maintenance รองรับข้อความล้วน ไม่เกิน 500 ตัวอักษร
        </p>
      </div>

      <div className="min-w-0 space-y-2">
        <label htmlFor="maintenance-resume" className="block text-sm font-medium text-[var(--text)]">
          คาดว่าจะกลับมาให้บริการ (ไม่บังคับ)
        </label>
        <Input
          id="maintenance-resume"
          type="datetime-local"
          value={draftResume}
          disabled={pending}
          onChange={(event) => { setDraftResume(event.target.value); setConfirming(null); }}
        />
        <p className="text-xs text-[var(--text-muted)]">เวลาประเทศไทย (GMT+7)</p>
      </div>

      {!confirming && (
        <div className="flex min-w-0 flex-wrap gap-2">
          {enabled ? (
            <Button type="button" disabled={pending} onClick={() => { setConfirming('disable'); setResult(null); }}>
              เปิดใช้งานแอป
            </Button>
          ) : (
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() => { setConfirming('enable'); setResult(null); }}
            >
              ปิดใช้งานเพื่ออัปเดต
            </Button>
          )}
          {enabled && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => submit('enable')}
            >
              บันทึกข้อความ
            </Button>
          )}
        </div>
      )}

      {confirming && (
        <div
          role="alertdialog"
          aria-labelledby="maintenance-confirm-heading"
          className="min-w-0 space-y-2 rounded-xl border border-[var(--border-strong)] p-3"
        >
          <p id="maintenance-confirm-heading" className="flex items-start gap-2 text-sm text-[var(--text)]">
            <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--negative)]" />
            <span className="min-w-0">
              {confirming === 'enable'
                ? 'ยืนยันปิดการใช้งานสำหรับผู้ใช้ทั่วไปหรือไม่? บัญชี Admin จะยังเข้าใช้งานได้เพื่อตรวจสอบระบบ และการเปลี่ยนนี้จะถูกบันทึกไว้'
                : 'ยืนยันเปิดใช้งานแอปสำหรับผู้ใช้ทุกคนหรือไม่? ผู้ใช้จะกลับเข้าใช้งานได้ทันที และการเปลี่ยนนี้จะถูกบันทึกไว้'}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={confirming === 'enable' ? 'danger' : 'default'}
              isLoading={pending}
              onClick={() => submit(confirming)}
            >
              ยืนยัน
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirming(null)}>
              ยกเลิก
            </Button>
          </div>
        </div>
      )}

      {result && (
        <p role="alert" className={`text-sm ${result.ok ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
          {result.message}
        </p>
      )}

      {offerAnnouncement && (
        <div className="min-w-0 space-y-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
          <p className="flex items-start gap-2 text-sm text-[var(--text)]">
            <Megaphone aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--accent)]" />
            <span className="min-w-0">ต้องการเขียนประกาศ “มีอะไรใหม่” ให้ผู้ใช้เห็นหลังอัปเดตหรือไม่?</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href={releaseNotesHref}
              onClick={() => setOfferAnnouncement(false)}
              className="inline-flex min-h-9 items-center justify-center rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              เขียนประกาศ
            </Link>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOfferAnnouncement(false)}>
              ไม่ประกาศครั้งนี้
            </Button>
          </div>
        </div>
      )}

      {audit.length > 0 && (
        <details className="min-w-0">
          <summary className="cursor-pointer text-xs font-medium text-[var(--text-muted)]">
            ประวัติการเปิด/ปิดล่าสุด
          </summary>
          <ul className="mt-2 min-w-0 space-y-1 text-xs text-[var(--text-muted)]">
            {audit.map((entry) => (
              <li key={entry.id} className="flex min-w-0 flex-wrap gap-x-2">
                <span className={entry.enabled ? 'text-[var(--negative)]' : 'text-[var(--positive)]'}>
                  {entry.enabled ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                </span>
                <span className="min-w-0 break-words">{when(entry.at)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
