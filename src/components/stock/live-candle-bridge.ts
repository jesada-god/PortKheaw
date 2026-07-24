import type { CandleInterval, MarketSessionMode } from '@/src/lib/market-data/gateway/contracts';
import { isIntradayLiveSelection, type LiveCandle } from '@/src/lib/stock-detail/market-source';

/** The concrete OHLCV display bar the chart panel builds from loaded history. */
export interface ChartDisplayBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
    && bar.volume === candle.volume;
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
): T[] {
  if (!candle || bars.length === 0) return bars as T[];
  const last = bars[bars.length - 1];
  const lastTime = barTimeSeconds(last);
  if (lastTime === null) return bars as T[];

  // Out-of-order / stale bucket: never overwrite a newer bar already shown.
  if (candle.time < lastTime) return bars as T[];

  const liveBar: ChartDisplayBar = {
    date: new Date(candle.time * 1_000).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };

  if (candle.time === lastTime) {
    // Same bucket → replace in place. Skip the copy when nothing changed.
    if (sameOhlcv(last, candle)) return bars as T[];
    const next = bars.slice();
    next[next.length - 1] = liveBar as T;
    return next;
  }

  // Strictly newer bucket → append exactly one bar.
  return [...bars, liveBar as T];
}
