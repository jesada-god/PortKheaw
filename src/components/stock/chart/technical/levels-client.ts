/**
 * Client-side request coordination for the classic-pivot S/R levels.
 *
 * The levels are derived server-side from the **last completed daily (or weekly)
 * bar** — see `/api/market/chart-levels`. That basis depends on the symbol and on
 * whether the chart is weekly, and on nothing else. In particular it does NOT
 * depend on the displayed history range: switching 6M → 12 เดือน → 5Y cannot
 * change which completed daily bar the pivots come from, so it must cost zero
 * level requests.
 *
 * That mattered because the chart surface is unmounted while a new range loads
 * and remounted when it arrives, which re-runs the levels effect. Keying the
 * request on `symbol:basisInterval` and resolving it through the shared
 * cache/single-flight primitive turns those remounts into cache reads:
 *
 *  - identical concurrent requests collapse onto one in-flight fetch,
 *  - a repeat within the fresh window is served from memory with no network I/O,
 *  - a failure is remembered briefly so a broken symbol cannot spin a retry loop,
 *    while a still-valid previous value keeps serving.
 *
 * Nothing is fabricated here: a cache miss with no cached value rethrows the
 * typed failure so the panel shows its truthful unavailable state.
 */

import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import type { CandleInterval } from '@/src/lib/market-data/candles/contracts';
import { optionToolPivotLevelsSchema, type OptionToolPivotLevels } from '../../option-tool-chart/pivot-levels';

/** The only two bases the level engine has: a completed daily or weekly bar. */
export type LevelBasisInterval = '1D' | 'Week';

/**
 * Daily pivots change once per completed session, so a 5-minute fresh window is
 * comfortably truthful while still absorbing every remount in a browsing
 * session. `staleMs` lets a transient failure keep serving the last real value
 * instead of blanking the panel.
 */
const LEVELS_POLICY = { freshMs: 5 * 60_000, staleMs: 30 * 60_000, errorMs: 30_000 } as const;

/** The pivot basis for a chart interval. Weekly charts pivot off the weekly bar. */
export function levelBasisInterval(interval: CandleInterval): LevelBasisInterval {
  return interval === 'Week' ? 'Week' : '1D';
}

/**
 * Cache/dedup identity. Range is deliberately absent: it is not an input to the
 * pivot calculation, so including it would fork the cache and duplicate requests
 * for an identical result.
 */
export function levelsRequestKey(symbol: string, interval: CandleInterval): string {
  return `chart-levels:${symbol.trim().toUpperCase()}:${levelBasisInterval(interval)}`;
}

export type LevelsFetcher = (url: string, init: { signal?: AbortSignal }) => Promise<Response>;

const cache = new SharedRequestCache();

/** Test seam: drop every cached value, error and in-flight entry. */
export function clearChartLevelsCache(): void {
  cache.clear();
}

/**
 * Load the classic-pivot levels for a symbol + chart interval.
 *
 * The abort signal cancels *this caller's* interest; a shared in-flight request
 * is not aborted on behalf of one of several joined callers, so an unmount during
 * a range change cannot cancel the fetch the remount is about to need.
 */
export async function requestChartLevels(input: {
  symbol: string;
  interval: CandleInterval;
  fetcher?: LevelsFetcher;
}): Promise<OptionToolPivotLevels> {
  const fetcher: LevelsFetcher = input.fetcher ?? ((url, init) => fetch(url, init));
  const basis = levelBasisInterval(input.interval);
  const resolution = await cache.resolve(
    levelsRequestKey(input.symbol, input.interval),
    async () => {
      const query = new URLSearchParams({ symbol: input.symbol, timeframe: basis });
      const response = await fetcher(`/api/market/chart-levels?${query.toString()}`, {});
      const payload = await response.json() as { data: unknown; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? 'ยังไม่มีข้อมูลแนวรับ–แนวต้านสำหรับช่วงนี้');
      const parsed = optionToolPivotLevelsSchema.safeParse(payload.data);
      if (!parsed.success) throw new Error('ข้อมูลแนวรับ–แนวต้านไม่ผ่านการตรวจสอบ');
      return parsed.data;
    },
    LEVELS_POLICY,
  );
  return resolution.value;
}
