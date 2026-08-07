'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';

/**
 * The way back in.
 *
 * A reader stranded on this page has no signal that the product returned, so the
 * page asks — on a slow interval, and whenever the tab becomes visible again.
 * Those two together are what makes it feel immediate without being a poll: the
 * common case is somebody who tabbed away and came back, and that costs one
 * request at the moment they look, not sixty while they were not looking.
 *
 * Rules this deliberately keeps:
 *
 *   * **No polling while hidden.** A backgrounded tab on every phone in the
 *     install base is a request storm aimed at a product that is already down.
 *   * **No tightening under failure.** A failed check waits the same 60 seconds;
 *     retrying harder against a maintenance window is how a maintenance window
 *     becomes an outage.
 *   * **One navigation.** Once the check says the product is back, the interval
 *     is torn down before the router moves, so a slow route transition cannot
 *     stack a second navigation on top of the first.
 */

const CHECK_INTERVAL_MS = 60_000;

export function MaintenanceRecovery() {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<'idle' | 'still-down'>('idle');
  const recovering = useRef(false);

  const check = useCallback(async (): Promise<void> => {
    if (recovering.current) return;
    setChecking(true);
    try {
      const response = await fetch('/api/maintenance/state', { cache: 'no-store' });
      if (!response.ok) return;
      const body = await response.json() as { maintenance?: unknown };
      if (body.maintenance === false) {
        recovering.current = true;
        // `replace`, not `push`: the notice must not sit in the history behind
        // the reader, where Back would drop them onto a page that is no longer
        // true. `refresh` clears the cached RSC payload the gate produced.
        router.replace('/');
        router.refresh();
        return;
      }
      setCheckedAt('still-down');
    } catch {
      // Offline, or the product is still restarting. Neither is worth reporting
      // to somebody who is already looking at a page that says so.
    } finally {
      setChecking(false);
    }
  }, [router]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void check();
    }, CHECK_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check]);

  return (
    <div className="flex min-w-0 flex-col items-center gap-2">
      <Button type="button" isLoading={checking} onClick={() => { setCheckedAt('idle'); void check(); }}>
        <RefreshCw aria-hidden="true" size={16} />
        ลองอีกครั้ง
      </Button>
      <p aria-live="polite" className="min-h-5 text-xs text-[var(--text-muted)]">
        {checkedAt === 'still-down' ? 'ยังปรับปรุงอยู่ ระบบจะพาคุณกลับเข้าใช้งานอัตโนมัติเมื่อพร้อม' : ''}
      </p>
    </div>
  );
}
