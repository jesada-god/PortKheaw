'use client';

import { useId, useState, useTransition } from 'react';
import { CircleAlert, FlaskConical } from 'lucide-react';
import { setAdminAccessPreviewAction } from '@/app/settings/subscription/actions';
import { adminPreviewModes, type AdminPreviewMode } from '@/src/lib/subscription/admin-access';
import { formatBangkokDateTime } from '@/src/lib/subscription/trial';
import { reloadAfterAccessChange } from './admin-preview-reload';

const OPTION_LABEL: Readonly<Record<AdminPreviewMode, string>> = {
  actual: 'สิทธิ์จริง',
  basic: 'Basic',
  pro: 'Pro',
  elite: 'Elite',
  elite_trial: 'Elite Trial',
  expired_trial: 'Trial หมดอายุ',
};

const OPTION_HINT: Readonly<Record<AdminPreviewMode, string>> = {
  actual: 'สิทธิ์ผู้ดูแลระบบเต็มรูปแบบ (Elite)',
  basic: 'เห็นเหมือนผู้ใช้แพ็กเกจฟรี',
  pro: 'เห็นเหมือนผู้ใช้แพ็กเกจ Pro',
  elite: 'เห็นเหมือนผู้ใช้แพ็กเกจ Elite แบบชำระเงิน',
  elite_trial: 'เห็นเหมือนผู้ใช้ที่กำลังทดลอง Elite',
  expired_trial: 'เห็นเหมือนผู้ใช้ที่ทดลอง Elite หมดอายุแล้ว',
};

/**
 * The operator's tier switch.
 *
 * Radio inputs, not buttons: a group of mutually exclusive states is exactly
 * what a radio group is, and it brings arrow-key navigation, a single tab stop
 * and the correct announcement for free.
 *
 * Nothing unlocks optimistically. The selection is not moved until the server
 * answers, and the answer is applied by reloading the document — so what the
 * reader sees after a change is always what the server actually granted, never
 * what the browser hoped for.
 */
export function AdminPreviewSelector({ currentMode, expiresAt }: {
  currentMode: AdminPreviewMode;
  expiresAt: string | null;
}) {
  const groupId = useId();
  const [pendingMode, setPendingMode] = useState<AdminPreviewMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const choose = (mode: AdminPreviewMode) => {
    if (pendingMode) return;
    setError(null);
    setPendingMode(mode);
    startTransition(async () => {
      const result = await setAdminAccessPreviewAction(mode);
      if (result.ok) {
        reloadAfterAccessChange();
        return;
      }
      setPendingMode(null);
      setError(result.message);
    });
  };

  return (
    <section
      aria-labelledby={`${groupId}-heading`}
      data-testid="admin-preview-selector"
      className="rounded-2xl border border-[color-mix(in_srgb,var(--role-admin)_40%,transparent)] bg-[var(--surface-elevated)] p-4 sm:p-5"
    >
      <div className="flex items-start gap-2.5">
        <FlaskConical aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-[var(--role-admin)]" />
        <div className="min-w-0">
          <h3 id={`${groupId}-heading`} className="text-sm font-semibold text-[var(--text)]">
            ทดสอบการเข้าถึงในแพ็กเกจ
          </h3>
          <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
            จำลองสิทธิ์เพื่อตรวจ Paywall จริงในทุกหน้า · แพ็กเกจและการเรียกเก็บเงินจริงของคุณไม่เปลี่ยน
            {' · '}สิ้นสุดอัตโนมัติใน 60 นาที
          </p>
        </div>
      </div>

      <fieldset className="mt-4 min-w-0" disabled={pendingMode !== null}>
        <legend className="sr-only">เลือกแพ็กเกจที่ต้องการจำลอง</legend>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          {adminPreviewModes.map((mode) => {
            const selected = mode === currentMode;
            const busy = mode === pendingMode;
            return (
              <label
                key={mode}
                data-testid={`admin-preview-option-${mode}`}
                data-selected={selected ? 'true' : 'false'}
                className={`flex min-h-11 min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border p-3 motion-safe:transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus-ring)] ${
                  selected
                    ? 'border-[var(--role-admin)] bg-[color-mix(in_srgb,var(--role-admin)_12%,transparent)]'
                    : 'border-[var(--border)] hover:bg-[var(--surface-hover)]'
                } ${pendingMode ? 'cursor-wait opacity-70' : ''}`}
              >
                <input
                  type="radio"
                  name={`${groupId}-mode`}
                  value={mode}
                  checked={selected}
                  onChange={() => choose(mode)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--role-admin)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--text)]">
                    {OPTION_LABEL[mode]}
                    {busy && <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">กำลังเปลี่ยน…</span>}
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-[var(--text-muted)]">{OPTION_HINT[mode]}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {currentMode !== 'actual' && expiresAt && (
        <p className="mt-3 text-xs text-[var(--text-secondary)]">
          โหมดทดสอบปัจจุบันหมดอายุ {formatBangkokDateTime(expiresAt)} แล้วกลับสู่สิทธิ์ผู้ดูแลระบบอัตโนมัติ
        </p>
      )}

      <p aria-live="polite" className="sr-only">
        {pendingMode ? 'กำลังเปลี่ยนโหมดทดสอบสิทธิ์' : ''}
      </p>

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-xs leading-5 text-[var(--negative)]">
          <CircleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </section>
  );
}
