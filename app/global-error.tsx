'use client';

import { appConfig } from '@/src/config/app';

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="th" data-theme="portkheaw" data-appearance="dark">
      <body className="min-h-dvh bg-[var(--bg)] text-[var(--text)]">
        <main role="alert" className="min-h-dvh p-6 flex flex-col items-center justify-center text-center">
          <p className="font-semibold text-[var(--accent)]">{appConfig.name}</p>
          <h1 className="mt-3 text-2xl font-bold text-white">ระบบไม่พร้อมใช้งานชั่วคราว</h1>
          <p className="mt-2 max-w-md text-sm text-slate-400">กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง</p>
          <button onClick={reset} className="mt-6 min-h-11 rounded-lg bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-fg)]">
            ลองอีกครั้ง
          </button>
        </main>
      </body>
    </html>
  );
}
