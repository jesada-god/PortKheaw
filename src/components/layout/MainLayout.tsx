'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import FloatingDock from './FloatingDock';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { AppRuntime } from './AppRuntime';
import { isAuthShellPath } from '@/src/lib/auth/paths';

export default function MainLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  /*
   * The authentication pages own the viewport. Keeping the primary navigation
   * behind them would offer a signed-out visitor five destinations that bounce
   * straight back here, and would take a fixed strip off the bottom of a form
   * that already has to survive a mobile keyboard. The alert and push runtimes
   * are skipped for the same reason: both need a session that, on these pages,
   * does not exist yet.
   */
  if (isAuthShellPath(pathname)) {
    return (
      <div className="min-h-dvh w-full max-w-full overflow-x-hidden bg-[var(--bg)] font-sans text-[var(--text)]">
        {children}
      </div>
    );
  }

  /*
   * One column, centred, with the dock floating over it.
   *
   * The sidebar used to make this a two-column flex row in which <main> was its
   * own scroll container on desktop (`lg:h-dvh lg:overflow-y-auto`) so the
   * sticky sidebar could stay put. With the sidebar gone that nested scroller
   * has nothing left to serve and two costs: a second scrollbar, and sticky
   * offsets inside pages resolving against <main> rather than the viewport. The
   * document scrolls instead, which is what the sticky header and every
   * `scroll-mt-*` anchor already assume.
   *
   * The bottom padding is the dock's whole footprint — capsule, the gap it
   * floats above the edge, and the home indicator underneath it — so the last
   * row of any page clears it rather than hiding beneath it.
   */
  return <div className="min-h-dvh w-full max-w-full overflow-x-hidden bg-[var(--bg)] font-sans text-[var(--text)]">
    <AppRuntime />
    <main className="flex min-h-dvh min-w-0 flex-col bg-[var(--bg)] pb-[var(--dock-clearance)] transition-colors duration-200">
      <OfflineNotice />
      <div className="mx-auto w-full max-w-[1600px] flex-1">{children}</div>
    </main>
    <FloatingDock />
  </div>;
}
