'use client';

import { useState, useTransition } from 'react';
import { Bell, Clock3, RotateCcw } from 'lucide-react';
import {
  saveNotificationScheduleAction,
  saveNotificationToggleAction,
} from '@/app/settings/actions';
import { Button } from '@/src/components/ui/Button';

type ToggleSetting =
  | 'priceAlertsEnabled'
  | 'dailySummaryEnabled'
  | 'priceAlertExtendedHours'
  | 'quietHoursEnabled';

interface NotificationPreferenceValues {
  priceAlertsEnabled: boolean;
  dailySummaryEnabled: boolean;
  priceAlertExtendedHours: boolean;
  quietHoursEnabled: boolean;
  dailySummaryTime: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: 'Asia/Bangkok' | 'UTC' | 'America/New_York' | 'Europe/London';
}

type Retry =
  | { kind: 'toggle'; setting: ToggleSetting; enabled: boolean }
  | { kind: 'schedule' }
  | null;

function Toggle({ checked, disabled, label, onChange }: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative h-11 w-14 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${checked ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border-strong)] bg-[var(--input-bg)]'}`}
  >
    <span className={`absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full transition-transform ${checked ? 'translate-x-6 bg-[var(--accent)]' : 'translate-x-1 bg-[var(--text-muted)]'}`} />
  </button>;
}

export function NotificationPreferences({ initial }: { initial: NotificationPreferenceValues }) {
  const [values, setValues] = useState(initial);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<Retry>(null);
  const [pending, startTransition] = useTransition();

  function saveToggle(setting: ToggleSetting, enabled: boolean) {
    const previous = values[setting];
    setValues((current) => ({ ...current, [setting]: enabled }));
    setMessage('');
    setError('');
    startTransition(async () => {
      const result = await saveNotificationToggleAction({ setting, enabled });
      if (!result.ok) {
        setValues((current) => ({ ...current, [setting]: previous }));
        setError(result.message);
        setRetry({ kind: 'toggle', setting, enabled });
        return;
      }
      setRetry(null);
      setMessage('บันทึกแล้ว');
    });
  }

  function saveSchedule() {
    setMessage('');
    setError('');
    startTransition(async () => {
      const result = await saveNotificationScheduleAction({
        dailySummaryTime: values.dailySummaryTime,
        quietHoursStart: values.quietHoursStart,
        quietHoursEnd: values.quietHoursEnd,
        timezone: values.timezone,
      });
      if (!result.ok) {
        setError(result.message);
        setRetry({ kind: 'schedule' });
        return;
      }
      setRetry(null);
      setMessage(result.message);
    });
  }

  const retrySave = () => {
    if (retry?.kind === 'toggle') saveToggle(retry.setting, retry.enabled);
    if (retry?.kind === 'schedule') saveSchedule();
  };

  return <section className="space-y-4">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-[var(--text)]">การแจ้งเตือน</h2>
      <div className="text-xs" role="status" aria-live="polite">
        {pending && <span className="text-[var(--text-muted)]">กำลังบันทึก…</span>}
        {!pending && message && <span className="text-[var(--positive)]">{message}</span>}
      </div>
    </div>

    <div className="space-y-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
      <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
        <Bell className="shrink-0 text-[var(--text-muted)]" size={20} />
        <p className="text-sm text-[var(--text-secondary)]">การแจ้งเตือนบนอุปกรณ์นี้ยังไม่เปิดใช้งาน</p>
      </div>

      <div className="divide-y divide-[var(--border)]">
        <div className="flex min-h-20 items-center justify-between gap-4 py-4">
          <div>
            <p className="font-medium text-[var(--text)]">แจ้งเตือนเมื่อราคาถึงเป้าหมาย</p>
            <p className="text-xs text-[var(--text-muted)]">แสดงในกล่องการแจ้งเตือนเมื่อราคาข้ามเป้าหมายที่ตั้งไว้</p>
          </div>
          <Toggle checked={values.priceAlertsEnabled} disabled={pending} label="แจ้งเตือนเมื่อราคาถึงเป้าหมาย" onChange={(enabled) => saveToggle('priceAlertsEnabled', enabled)} />
        </div>
        <div className="flex min-h-20 items-center justify-between gap-4 py-4">
          <div>
            <p className="font-medium text-[var(--text)]">รวมก่อนและหลังตลาด</p>
            <p className="text-xs text-[var(--text-muted)]">ค่าเริ่มต้นตรวจเฉพาะช่วงตลาดปกติ เปิดเมื่อต้องการรวมราคานอกเวลา</p>
          </div>
          <Toggle checked={values.priceAlertExtendedHours} disabled={pending} label="รวมก่อนและหลังตลาด" onChange={(enabled) => saveToggle('priceAlertExtendedHours', enabled)} />
        </div>
        <div className="flex min-h-20 items-center justify-between gap-4 py-4">
          <div>
            <p className="font-medium text-[var(--text)]">สรุปพอร์ตรายวัน</p>
            <p className="text-xs text-[var(--text-muted)]">รับมูลค่าพอร์ตรวม ผลของวันนี้ และสินทรัพย์ที่ส่งผลมากที่สุด</p>
          </div>
          <Toggle checked={values.dailySummaryEnabled} disabled={pending} label="สรุปพอร์ตรายวัน" onChange={(enabled) => saveToggle('dailySummaryEnabled', enabled)} />
        </div>
        <div className="flex min-h-20 items-center justify-between gap-4 py-4">
          <div>
            <p className="font-medium text-[var(--text)]">ช่วงเวลางดแจ้งเตือน</p>
            <p className="text-xs text-[var(--text-muted)]">พักรายการไว้ก่อน แล้วส่งเป็นสรุปรวมเมื่อพ้นช่วงเวลานี้</p>
          </div>
          <Toggle checked={values.quietHoursEnabled} disabled={pending} label="ช่วงเวลางดแจ้งเตือน" onChange={(enabled) => saveToggle('quietHoursEnabled', enabled)} />
        </div>
      </div>

      <div className="space-y-4 border-t border-[var(--border)] pt-5">
        <div className="flex items-center gap-2">
          <Clock3 className="text-[var(--text-muted)]" size={18} />
          <h3 className="font-medium text-[var(--text)]">เวลาแจ้งเตือน</h3>
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="min-w-0 space-y-1">
            <span className="text-xs text-[var(--text-muted)]">เวลาสรุปพอร์ตรายวัน</span>
            <input type="time" value={values.dailySummaryTime} onChange={(event) => setValues((current) => ({ ...current, dailySummaryTime: event.target.value }))} className="min-h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-[var(--text)]" />
          </label>
          <label className="min-w-0 space-y-1">
            <span className="text-xs text-[var(--text-muted)]">เขตเวลา</span>
            <select value={values.timezone} onChange={(event) => setValues((current) => ({ ...current, timezone: event.target.value as NotificationPreferenceValues['timezone'] }))} className="min-h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-[var(--text)]">
              <option value="Asia/Bangkok">Asia/Bangkok (UTC+7)</option>
              <option value="UTC">UTC</option>
              <option value="America/New_York">America/New_York</option>
              <option value="Europe/London">Europe/London</option>
            </select>
          </label>
          <label className="min-w-0 space-y-1">
            <span className="text-xs text-[var(--text-muted)]">เริ่มงดแจ้งเตือน</span>
            <input type="time" value={values.quietHoursStart} onChange={(event) => setValues((current) => ({ ...current, quietHoursStart: event.target.value }))} className="min-h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-[var(--text)]" />
          </label>
          <label className="min-w-0 space-y-1">
            <span className="text-xs text-[var(--text-muted)]">สิ้นสุดการงดแจ้งเตือน</span>
            <input type="time" value={values.quietHoursEnd} onChange={(event) => setValues((current) => ({ ...current, quietHoursEnd: event.target.value }))} className="min-h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-[var(--text)]" />
          </label>
        </div>
        <p className="text-xs text-[var(--text-muted)]">รองรับช่วงข้ามเที่ยงคืน เช่น 22:00–07:00</p>
        <Button type="button" onClick={saveSchedule} isLoading={pending} className="w-full sm:w-auto">
          บันทึกการแจ้งเตือน
        </Button>
      </div>

      {error && <div className="flex flex-col gap-3 rounded-xl border border-[var(--negative)]/30 bg-[var(--negative-soft)] p-3 text-sm text-[var(--negative)] sm:flex-row sm:items-center sm:justify-between" role="alert">
        <span>{error}</span>
        {retry && <button type="button" onClick={retrySave} disabled={pending} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-current px-3 font-medium">
          <RotateCcw size={15} /> ลองอีกครั้ง
        </button>}
      </div>}
    </div>
  </section>;
}
