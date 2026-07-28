'use client';

import { EyeOff, Gauge, Rabbit } from 'lucide-react';
import { useStore } from '@/src/store/useStore';

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
    className={`relative h-11 w-14 shrink-0 rounded-full border transition-colors ${checked ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border-strong)] bg-[var(--input-bg)]'}`}>
    <span className={`absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full transition-transform ${checked ? 'translate-x-6 bg-[var(--accent)]' : 'translate-x-1 bg-[var(--text-muted)]'}`} />
  </button>;
}

export function DevicePreferences() {
  const privacyMode = useStore((state) => state.privacyMode);
  const setPrivacyMode = useStore((state) => state.setPrivacyMode);
  const dataSaver = useStore((state) => state.dataSaver);
  const setDataSaver = useStore((state) => state.setDataSaver);
  const reducedMotion = useStore((state) => state.reducedMotion);
  const setReducedMotion = useStore((state) => state.setReducedMotion);
  const rows = [
    { icon: EyeOff, label: 'Privacy Mode', description: 'ซ่อนยอด Portfolio และกำไร/ขาดทุนบนอุปกรณ์นี้', checked: privacyMode, change: setPrivacyMode },
    { icon: Gauge, label: 'Data Saver', description: 'ลดการโหลดรูปข่าวและข้อมูลที่ไม่จำเป็น', checked: dataSaver, change: setDataSaver },
    { icon: Rabbit, label: 'Reduced Motion', description: 'ลด animation และ transition แม้ระบบปฏิบัติการไม่ได้ตั้งไว้', checked: reducedMotion, change: setReducedMotion },
  ];
  return <section className="space-y-4"><h2 className="text-lg font-semibold text-[var(--text)]">การใช้งานบนอุปกรณ์นี้</h2><div className="divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 sm:px-6">
    {rows.map(({ icon: Icon, label, description, checked, change }) => <div key={label} className="flex min-h-20 items-center gap-3 py-4"><Icon className="shrink-0 text-[var(--text-muted)]" size={19} /><div className="min-w-0 flex-1"><p className="font-medium text-[var(--text)]">{label}</p><p className="text-xs text-[var(--text-muted)]">{description}</p></div><Toggle checked={checked} onChange={change} label={label} /></div>)}
  </div><p className="text-xs text-[var(--text-muted)]">การตั้งค่าสามรายการนี้บันทึกเฉพาะในเบราว์เซอร์ปัจจุบัน</p></section>;
}
