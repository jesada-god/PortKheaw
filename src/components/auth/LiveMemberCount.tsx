'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/src/lib/supabase/client';
import { PUBLIC_STATS_SINGLETON, readPublicMemberCount } from '@/src/lib/public-stats';

const ANIMATION_MS = 260;

function validCount(value: unknown): number | null {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function LiveMemberCount({ initialCount }: { initialCount: number }) {
  const [targetCount, setTargetCount] = useState(initialCount);
  const [shownCount, setShownCount] = useState(initialCount);
  const shownRef = useRef(initialCount);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion || shownRef.current === targetCount) {
      shownRef.current = targetCount;
      setShownCount(targetCount);
      return;
    }

    const startValue = shownRef.current;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / ANIMATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = Math.round(startValue + (targetCount - startValue) * eased);
      shownRef.current = next;
      setShownCount(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [targetCount]);

  useEffect(() => {
    const client = createClient();
    if (!client) return;

    let disposed = false;
    let connectedOnce = false;
    let reconnectPending = false;

    const refetch = async () => {
      const count = await readPublicMemberCount(client);
      if (!disposed && count !== null) setTargetCount(count);
    };

    const channel = client
      .channel('app-public-member-count')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'app_public_stats',
          filter: `singleton=eq.${PUBLIC_STATS_SINGLETON}`,
        },
        (payload) => {
          const count = validCount(payload.new.member_count);
          if (count !== null) setTargetCount(count);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (connectedOnce && reconnectPending) void refetch();
          connectedOnce = true;
          reconnectPending = false;
        } else if (connectedOnce) {
          reconnectPending = true;
        }
      });

    return () => {
      disposed = true;
      void client.removeChannel(channel);
    };
  }, []);

  return (
    <p
      data-testid="live-member-count"
      aria-live="polite"
      className="-mt-3 mb-4 min-h-5 text-center text-xs leading-5"
      style={{ color: 'var(--auth-on-field-muted)' }}
    >
      มีสมาชิก PortKheaw แล้ว{' '}
      <span className="inline-grid w-[7ch] place-items-center tabular-nums" data-testid="member-count-value">
        {shownCount.toLocaleString('th-TH')}
      </span>{' '}
      คน
    </p>
  );
}
