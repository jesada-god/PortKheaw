import { FlaskConical } from 'lucide-react';
import { demoDataInfo } from '@/src/mocks/marketData';

export function DataSourceBadge() {
  return (
    <span
      /* 🟡: demo prices are real-looking and are not real, which is the "ระวัง"
         the neutral level is for — not a failure, and not something to ignore. */
      className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-[var(--radius-mark)] border border-[var(--warning-line)] bg-[var(--warning-soft)] px-2 text-[10px] font-semibold text-[var(--warning)]"
      title="ข้อมูลตัวอย่างสำหรับสาธิต ไม่ใช่ข้อมูลตลาดจริง"
    >
      <FlaskConical aria-hidden="true" size={12} />
      {demoDataInfo.label}
    </span>
  );
}
