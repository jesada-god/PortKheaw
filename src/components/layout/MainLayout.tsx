'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { AlertEvaluationOnOpen } from '@/src/components/alerts/AlertEvaluationOnOpen';
import { AppRuntime } from './AppRuntime';
import { isAuthShellPath } from '@/src/lib/auth/paths';

export default function MainLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  /*
   * The authentication pages own the viewport. Keeping the sidebar and bottom
   * navigation behind them would offer a signed-out visitor five destinations
   * that bounce straight back here, and would take a fixed 4rem off the bottom
   * of a form that already has to survive a mobile keyboard. The alert and push
   * runtimes are skipped for the same reason: both need a session that, on
   * these pages, does not exist yet.
   */
  if (isAuthShellPath(pathname)) {
    return (
      <div className="min-h-dvh w-full max-w-full overflow-x-hidden bg-[var(--bg)] font-sans text-[var(--text)]">
        {children}
      </div>
    );
  }

  return <div className="flex min-h-dvh w-full max-w-full overflow-x-hidden bg-[var(--bg)] font-sans text-[var(--text)]">
    <AlertEvaluationOnOpen />
    <AppRuntime />
    <Sidebar />
    <main className="flex min-h-dvh min-w-0 flex-1 flex-col bg-[var(--bg)] pb-[calc(4rem+env(safe-area-inset-bottom))] transition-colors duration-200 lg:h-dvh lg:overflow-y-auto lg:pb-0">
      <OfflineNotice />
      <div className="mx-auto w-full max-w-[1600px] flex-1 pb-6">{children}</div>
    </main>
    <BottomNav />
  </div>;
}
