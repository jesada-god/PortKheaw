'use client';

import { useState } from 'react';
import { EyeOff, Rabbit } from 'lucide-react';
import { useStore } from '@/src/store/useStore';
import { Switch } from '@/src/components/ui/Switch';

export function DevicePreferences() {
  const [saved, setSaved] = useState(false);
  const privacyMode = useStore((state) => state.privacyMode);
  const setPrivacyMode = useStore((state) => state.setPrivacyMode);
  const motionPreference = useStore((state) => state.motionPreference);
  const setMotionPreference = useStore((state) => state.setMotionPreference);

  const confirmSaved = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2_000);
  };

  return <section className="space-y-4">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-[var(--text)]">การใช้งานบนอุปกรณ์นี้</h2>
      <p className="text-xs text-[var(--positive)]" role="status">{saved ? 'บันทึกแล้ว' : ''}</p>
    </div>
    <div className="box-border w-full min-w-0 divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 sm:px-6">
      <div className="grid min-h-20 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 py-4 max-[360px]:grid-cols-[auto_minmax(0,1fr)]">
        <EyeOff className="shrink-0 text-[var(--text-muted)]" size={19} />
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium text-[var(--text)]">ซ่อนยอดเงินและกำไรขาดทุน</p>
          <p className="break-words text-xs text-[var(--text-muted)]">ซ่อนมูลค่าพอร์ตและผลกำไรขาดทุนบนอุปกรณ์นี้</p>
        </div>
        <Switch
          checked={privacyMode}
          onCheckedChange={(checked) => { setPrivacyMode(checked); confirmSaved(); }}
          label="ซ่อนยอดเงินและกำไรขาดทุน"
          className="justify-self-end max-[360px]:col-start-2 max-[360px]:justify-self-start"
        />
      </div>
      <div className="flex min-h-20 flex-col gap-3 py-4 sm:flex-row sm:items-center">
        <Rabbit className="shrink-0 text-[var(--text-muted)]" size={19} />
        <div className="min-w-0 flex-1">
          <label htmlFor="motionPreference" className="font-medium text-[var(--text)]">ลดการเคลื่อนไหว</label>
          <p className="text-xs text-[var(--text-muted)]">ลดภาพเคลื่อนไหวที่ไม่จำเป็น โดยยังแสดงสถานะกำลังโหลดตามปกติ</p>
        </div>
        <select
          id="motionPreference"
          value={motionPreference}
          onChange={(event) => {
            setMotionPreference(event.target.value as typeof motionPreference);
            confirmSaved();
          }}
          className="min-h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-sm text-[var(--text)] sm:w-56"
        >
          <option value="system">ตามการตั้งค่าอุปกรณ์</option>
          <option value="reduce">ลดการเคลื่อนไหว</option>
          <option value="normal">แสดงตามปกติ</option>
        </select>
      </div>
    </div>
    <p className="text-xs text-[var(--text-muted)]">การตั้งค่าสองรายการนี้บันทึกเฉพาะในเบราว์เซอร์ปัจจุบัน</p>
  </section>;
}
