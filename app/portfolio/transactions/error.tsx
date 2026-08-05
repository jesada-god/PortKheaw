'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';

/**
 * A failure to read the statement must not read as a failure of the ledger.
 * The rows are still there; only this render did not complete.
 */
export default function PortfolioTransactionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Portfolio transaction history error', error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto flex min-h-[60dvh] max-w-lg flex-col items-center justify-center p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-400">
        <AlertTriangle aria-hidden="true" size={24} />
      </div>
      <h1 className="mt-4 text-2xl font-bold text-white">โหลดประวัติเงินเข้า–ออกไม่สำเร็จ</h1>
      <p className="mt-2 text-sm text-slate-400">
        รายการทั้งหมดยังอยู่ครบใน Transaction Ledger ไม่มีข้อมูลใดถูกลบ กรุณาลองอีกครั้ง
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button onClick={reset}><RotateCcw aria-hidden="true" size={16} /> ลองอีกครั้ง</Button>
        <Link
          href="/portfolio"
          className="inline-flex h-10 items-center justify-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-hover)]"
        >กลับไปหน้าพอร์ต</Link>
      </div>
    </div>
  );
}
