'use client';

import { useEffect, useState } from 'react';
import { formatTrialRemaining } from '@/src/lib/subscription/trial';

/**
 * How much of the trial is left, without ever reading the browser clock during
 * render.
 *
 * The server measures the remaining time against the database clock and passes
 * the result in. That number is what renders on the server and again on the
 * client's first paint, so the two markups match. Only after mount does the
 * component start measuring locally, and even then it is a display aid: the
 * entitlement itself is re-decided on the server on every request.
 */
export function TrialCountdown({
  endsAt,
  initialRemainingMs,
}: {
  endsAt: string;
  initialRemainingMs: number;
}) {
  const [remainingMs, setRemainingMs] = useState(initialRemainingMs);

  useEffect(() => {
    // The device clock may differ from the database's. Anchoring to the offset
    // measured at mount keeps the countdown continuous instead of jumping by
    // the clock skew on the first tick.
    const skew = Date.parse(endsAt) - Date.now() - initialRemainingMs;
    const tick = () => setRemainingMs(Date.parse(endsAt) - Date.now() - skew);
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [endsAt, initialRemainingMs]);

  /*
   * Deliberately not `suppressHydrationWarning`: the first render on both sides
   * is the server's own number, so the markup genuinely matches. Suppressing
   * here would only hide it the day that stops being true.
   */
  return <span className="tabular-nums">{formatTrialRemaining(remainingMs)}</span>;
}
