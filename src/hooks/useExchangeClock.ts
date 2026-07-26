'use client';

import { useEffect, useState } from 'react';

/**
 * A ticking "now" for market-session resolution, anchored to a SERVER instant.
 *
 * Two properties matter here:
 *
 *  - **It advances.** A tab left open across 16:00 ET must stop saying
 *    "ตลาดเปิด" without a reload, so the session cannot be resolved once at
 *    render time and frozen.
 *  - **It does not trust the browser's absolute clock.** The returned instant is
 *    `serverAnchor + elapsed`, where `elapsed` is measured locally. A device
 *    whose clock is days off therefore cannot invent a market session; only the
 *    passage of time is taken from the client, never the date.
 *
 * The value it feeds is converted to America/New_York by the session resolver.
 * The reader's own time zone is never consulted.
 */
export function useExchangeClock(anchorIso: string, intervalMs = 30_000): string {
  const [anchor, setAnchor] = useState(anchorIso);
  const [elapsedMs, setElapsedMs] = useState(0);

  // A new server anchor supersedes the locally accumulated elapsed time.
  // (React's documented "adjust state when a prop changes" pattern.)
  if (anchor !== anchorIso) {
    setAnchor(anchorIso);
    setElapsedMs(0);
  }

  useEffect(() => {
    // Elapsed time is measured from when this anchor took effect, so only the
    // DURATION comes from the client — never its notion of the current date.
    const startedAt = Date.now();
    const tick = () => setElapsedMs(Math.max(0, Date.now() - startedAt));
    const timer = window.setInterval(tick, intervalMs);
    // Coming back from a background tab must re-resolve immediately: the session
    // may well have changed while the interval was throttled.
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [anchor, intervalMs]);

  const anchorMs = Date.parse(anchor);
  // An unparseable anchor is passed through untouched rather than replaced by a
  // fabricated instant; the session resolver reports UNKNOWN for it.
  return Number.isFinite(anchorMs) ? new Date(anchorMs + elapsedMs).toISOString() : anchor;
}
