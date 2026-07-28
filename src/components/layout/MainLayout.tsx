import { ReactNode } from 'react';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { AlertEvaluationOnOpen } from '@/src/components/alerts/AlertEvaluationOnOpen';
import { AppRuntime } from './AppRuntime';

export default function MainLayout({ children }: { children: ReactNode }) {
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
