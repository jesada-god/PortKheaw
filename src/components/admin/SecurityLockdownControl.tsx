'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { setSecurityLockdownAction } from '@/app/admin/security/actions';

/**
 * The incident switch, as an operator sees it.
 *
 * This component decides nothing. It renders the state the server resolved and
 * posts a form; whether the caller may move the switch is settled three times
 * before this file is reachable — by middleware, by the page guard, and by the
 * action's own gate — and none of those answers can be reached from here.
 *
 * It is deliberately plainer than the maintenance control it sits beside, and
 * says something the maintenance control does not: **lockdown binds operators
 * too.** An operator who engages this and then closes the tab has refused their
 * own console its privileged writes, and the copy says so before they press it
 * rather than after. The one thing that keeps working is this control.
 */

export interface SecurityLockdownControlProps {
  enabled: boolean;
  reason: string | null;
  startedAt: string | null;
  /**
   * Whether this operator has presented a second factor in this session. The
   * control renders read-only without one — the action would refuse anyway, and
   * offering a button that cannot work is worse than explaining why.
   */
  assured: boolean;
}

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

export function SecurityLockdownControl({
  enabled, reason, startedAt, assured,
}: SecurityLockdownControlProps) {
  const router = useRouter();
  const [draftReason, setDraftReason] = useState(reason ?? '');
  const [confirming, setConfirming] = useState<'on' | 'off' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  /*
   * The state the last successful mutation left behind, falling back to the
   * server's value. An operator must not have to wait on a round trip to see
   * that the switch they just threw actually moved.
   */
  const [confirmedEnabled, setConfirmedEnabled] = useState<boolean | null>(null);
  const [serverEnabled, setServerEnabled] = useState(enabled);
  if (serverEnabled !== enabled) {
    // The revalidated page caught up, or another operator moved the switch.
    // Adjusting state during render is React's supported way to follow a prop.
    setServerEnabled(enabled);
    setConfirmedEnabled(null);
  }
  const shownEnabled = confirmedEnabled ?? enabled;

  /** Guards against a slow first response overwriting a newer one. */
  const requestSeq = useRef(0);

  function submit(target: 'on' | 'off') {
    if (pending) return;
    setResult(null);
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;

    const formData = new FormData();
    formData.set('enabled', target === 'on' ? 'true' : 'false');
    formData.set('reason', draftReason);
    formData.set('confirm', 'yes');

    startTransition(async () => {
      const outcome = await setSecurityLockdownAction(formData);
      if (requestSeq.current !== seq) return;
      setResult(outcome);
      setConfirming(null);
      if (outcome.ok) {
        setConfirmedEnabled(outcome.enabled);
        router.refresh();
      }
    });
  }

  return (
    <section
      className="min-w-0 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]"
      aria-labelledby="lockdown-heading"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 id="lockdown-heading" className="text-base font-semibold text-[var(--text)]">
          ล็อกดาวน์ความปลอดภัย
        </h2>
        <p
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1 text-sm font-medium text-[var(--text)]"
          data-testid="lockdown-status"
        >
          <span aria-hidden="true">{shownEnabled ? '🔴' : '🟢'}</span>
          {shownEnabled ? 'ล็อกดาวน์อยู่' : 'ปกติ'}
        </p>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        แยกจากโหมดปิดปรับปรุง ผู้ใช้ทั่วไปยังใช้งานได้ตามปกติ
        แต่ระบบจะปฏิเสธการทำรายการสิทธิ์พิเศษทั้งหมด —
        รวมถึงของผู้ดูแลระบบเอง เช่น การเปลี่ยนสิทธิ์ การแก้ไขแผนบริการ
        และการลบบัญชี หน้านี้เป็นหน้าเดียวที่ยังทำงานได้
      </p>

      {shownEnabled && (
        <dl className="grid min-w-0 grid-cols-1 gap-1 text-xs text-[var(--text-muted)] sm:grid-cols-2">
          <div className="flex min-w-0 gap-1">
            <dt className="shrink-0">เริ่มล็อกดาวน์:</dt>
            <dd className="min-w-0 break-words text-[var(--text)]">{when(startedAt)}</dd>
          </div>
          {reason && (
            <div className="flex min-w-0 gap-1">
              <dt className="shrink-0">เหตุผล:</dt>
              <dd className="min-w-0 break-words text-[var(--text)]">{reason}</dd>
            </div>
          )}
        </dl>
      )}

      {!assured ? (
        <p className="text-sm text-[var(--text-muted)]">
          ต้องยืนยันตัวตนสองชั้นก่อนจึงจะเปลี่ยนสถานะล็อกดาวน์ได้
        </p>
      ) : (
        <>
          <div className="min-w-0 space-y-2">
            <label htmlFor="lockdown-reason" className="block text-sm font-medium text-[var(--text)]">
              เหตุผล (บันทึกไว้ในระบบตรวจสอบ)
            </label>
            <textarea
              id="lockdown-reason"
              value={draftReason}
              maxLength={300}
              rows={2}
              disabled={pending}
              onChange={(event) => { setDraftReason(event.target.value); setConfirming(null); }}
              placeholder="เช่น พบการเข้าถึงคอนโซลที่ผิดปกติ กำลังตรวจสอบ"
              className="w-full min-w-0 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
            />
            <p className="text-xs text-[var(--text-muted)]">
              ไม่แสดงต่อผู้ใช้ทั่วไป ใช้บันทึกให้ผู้ดูแลคนถัดไปอ่าน ไม่เกิน 300 ตัวอักษร
            </p>
          </div>

          {!confirming && (
            <div className="flex min-w-0 flex-wrap gap-2">
              {shownEnabled ? (
                <Button
                  type="button"
                  disabled={pending}
                  data-testid="lockdown-release"
                  onClick={() => { setConfirming('off'); setResult(null); }}
                >
                  ปลดล็อกดาวน์
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="danger"
                  disabled={pending}
                  data-testid="lockdown-engage"
                  onClick={() => { setConfirming('on'); setResult(null); }}
                >
                  เปิดโหมดล็อกดาวน์
                </Button>
              )}
            </div>
          )}

          {confirming && (
            <div
              role="alertdialog"
              aria-labelledby="lockdown-confirm-heading"
              className="min-w-0 space-y-2 rounded-xl border border-[var(--border-strong)] p-3"
            >
              <p id="lockdown-confirm-heading" className="flex items-start gap-2 text-sm text-[var(--text)]">
                <ShieldAlert aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--negative)]" />
                <span className="min-w-0">
                  {confirming === 'on'
                    ? 'ยืนยันเปิดโหมดล็อกดาวน์หรือไม่? ระบบจะปฏิเสธการทำรายการสิทธิ์พิเศษทั้งหมด รวมถึงของคุณเอง คุณจะยังปลดล็อกได้จากหน้านี้ และการเปลี่ยนนี้จะถูกบันทึกไว้'
                    : 'ยืนยันปลดล็อกดาวน์หรือไม่? การทำรายการของผู้ดูแลระบบจะกลับมาใช้งานได้ทันที และการเปลี่ยนนี้จะถูกบันทึกไว้'}
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={confirming === 'on' ? 'danger' : 'default'}
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
        </>
      )}

      {result && (
        <p role="alert" className={`text-sm ${result.ok ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
          {result.message}
        </p>
      )}
    </section>
  );
}
