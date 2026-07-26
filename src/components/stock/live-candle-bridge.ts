import type { CandleInterval, MarketSessionMode } from '@/src/lib/market-data/gateway/contracts';
import { isIntradayLiveSelection, type LiveCandle } from '@/src/lib/stock-detail/market-source';

/** The concrete OHLCV display bar the chart panel builds from loaded history. */
export interface ChartDisplayBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * Real provider volume, or `null` when the provider reported none. Never
   * coerced to `0`: a fabricated zero is indistinguishable from a real flat
   * bucket and would silently invent traded size.
   */
  volume: number | null;
  /** True while the bucket is still forming; analytics must exclude it. */
  partial?: boolean;
}

/**
 * Bridge between the shared {@link PollingMarketSource} active candle and the
 * mounted chart series. The market source is the single source of truth for the
 * live bucket: the chart loads history once, then consumes the same accepted
 * candle the header uses instead of running its own duplicate poll. Nothing here
 * fabricates, interpolates or forward-fills — an older bucket can never overwrite
 * a newer bar we already show.
 */

/**
 * True when the chart's current selection is one the shared market source
 * streams as a live intraday candle, so the chart consumes that single accepted
 * candle rather than polling `/api/market/candles` itself. The shared source
 * follows the selection (Phase B.2), so this now covers every supported intraday
 * interval and session — not just 5m/regular. Range-agnostic: the newest bucket
 * for an interval is identical whichever history range the chart displays.
 */
export function matchesLiveSelection(interval: CandleInterval, session: MarketSessionMode): boolean {
  if ((interval === '1D' || interval === 'Week') && session === 'regular') return true;
  return isIntradayLiveSelection(interval, session);
}

/**
 * Whether the chart panel should run its own recurring `/api/market/candles` poll.
 * When the shared source covers this selection the answer is always `false`: the
 * candle arrives from the single market-source loop, so a second loop would be a
 * duplicate request for the same bucket.
 */
export function shouldPollChart(input: {
  active: boolean;
  appActive: boolean;
  hasResult: boolean;
  dataStatus: string;
  coveredByLiveSource: boolean;
}): boolean {
  if (!input.active || !input.appActive || !input.hasResult) return false;
  if (input.coveredByLiveSource) return false;
  return input.dataStatus === 'live'
    || input.dataStatus === 'real-time'
    || input.dataStatus === 'partial';
}

function barTimeSeconds(bar: ChartDisplayBar): number | null {
  const value = bar.date;
  if (typeof value !== 'string') return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
  const ms = parsed.valueOf();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1_000);
}

function sameOhlcv(bar: ChartDisplayBar, candle: LiveCandle): boolean {
  return bar.open === candle.open
    && bar.high === candle.high
    && bar.low === candle.low
    && bar.close === candle.close
    && bar.volume === candle.volume
    && bar.partial === true;
}

/**
 * Cumulative bucket volume across a history baseline and a live delta. The two
 * provider totals are never added (an overlapping minute would be double
 * counted): the greatest real observed cumulative value wins, and a bucket with
 * no reported volume on either side stays `null`.
 */
function mergedVolume(historyVolume: number | null, liveVolume: number | null): number | null {
  if (historyVolume == null) return liveVolume;
  if (liveVolume == null) return historyVolume;
  return Math.max(historyVolume, liveVolume);
}

/**
 * Fold the shared active candle into the chart's history bars, mirroring the
 * source's own {@link mergeCandle} semantics one layer up in the display shape:
 *
 *  - same bucket (equal start time) → update the latest bar in place,
 *  - strictly newer bucket → append exactly one bar,
 *  - older/out-of-order bucket → ignore.
 *
 * The input array is returned by reference whenever nothing changes so the chart
 * series is not re-rendered on an idle tick.
 */
export function mergeLiveCandleIntoBars<T extends ChartDisplayBar>(
  bars: readonly T[],
  candle: LiveCandle | null,
  interval?: CandleInterval,
): T[] {
  if (!candle || bars.length === 0) return bars as T[];
  const last = bars[bars.length - 1];
  const lastTime = barTimeSeconds(last);
  if (lastTime === null) return bars as T[];

  if (interval === '1D' || interval === 'Week') {
    const lastDateKey = /^\d{4}-\d{2}-\d{2}/.exec(last.date)?.[0] ?? exchangeDateKey(lastTime);
    const sameBucket = interval === '1D'
      ? lastDateKey === exchangeDateKey(candle.time)
      : weekKeyFromDate(lastDateKey) === exchangeWeekKey(candle.time);
    if (sameBucket) {
      const next = bars.slice();
      next[next.length - 1] = {
        ...last,
        high: Math.max(last.high, candle.high),
        low: Math.min(last.low, candle.low),
        close: candle.close,
        // Yahoo is the historical baseline and the accepted stream is the live
        // delta for the same bucket; see mergedVolume for why they are not summed.
        volume: mergedVolume(last.volume, candle.volume),
        // The bucket the live candle belongs to is by definition still forming.
        partial: true,
      } as T;
      return next;
    }
  }

  // Out-of-order / stale bucket: never overwrite a newer bar already shown.
  if (candle.time < lastTime) return bars as T[];

  const liveBar: ChartDisplayBar = {
    date: interval === '1D'
      ? `${exchangeDateKey(candle.time)}T00:00:00.000Z`
      : interval === 'Week'
        ? `${exchangeWeekKey(candle.time)}T00:00:00.000Z`
        : new Date(candle.time * 1_000).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    // The live bucket is still forming until the stream finalizes it, so it must
    // never be read as a completed bar (pivot basis, indicator warm-up, the
    // header's newest-completed-bar fallback).
    partial: true,
  };

  if (candle.time === lastTime) {
    // Same bucket → replace in place. Skip the copy when nothing changed.
    if (sameOhlcv(last, candle)) return bars as T[];
    const next = bars.slice();
    next[next.length - 1] = { ...last, ...liveBar } as T;
    return next;
  }

  // Strictly newer bucket → append exactly one bar.
  return [...bars, liveBar as T];
}

const EXCHANGE_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

function exchangeDateKey(seconds: number): string {
  const parts = EXCHANGE_DATE.formatToParts(new Date(seconds * 1_000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function exchangeWeekKey(seconds: number): string {
  return weekKeyFromDate(exchangeDateKey(seconds));
}

function weekKeyFromDate(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}
