/**
 * Chart timeframe compatibility — what the Stock Detail chart may actually offer.
 *
 * Candle **interval** and history **lookback** are separate axes, and three
 * independent constraints must ALL hold before a pair is offered to the user:
 *
 *  1. **Readability / warm-up** — the pair must return enough bars to be worth
 *     drawing and to warm the indicators up. That is the existing selection
 *     matrix in `market-data/gateway/capabilities`, reused unchanged.
 *  2. **Historical-provider availability** — the chart's historical primary is
 *     the Yahoo Finance Chart JSON pipeline, and Yahoo caps its intraday
 *     lookbacks (30m/45m reach ~60 days, not a quarter). A combination Yahoo
 *     cannot serve must never be offered.
 *  3. **Minimum lookback for a higher timeframe** — a weekly or monthly candle
 *     is only meaningful over years. 1W over a six-month lookback draws ~26
 *     bars, which cannot warm EMA 200 and shows none of the structure the
 *     timeframe exists for, so 1W and above require at least five years of
 *     history (see {@link MIN_LOOKBACK_DAYS_FOR_INTERVAL}).
 *
 * The offered set is the intersection of all three. A pair outside it is
 * *disabled with a reason* rather than a click that fails after a provider
 * request, so the UI can never promise a range the chart will not honour.
 *
 * Requiring five years never fabricates bars: the request asks for a five-year
 * window and the provider returns whatever real history exists inside it, so a
 * company that listed eighteen months ago simply draws its eighteen months.
 *
 * This module deliberately holds no separate range vocabulary: "12 เดือน" is the
 * canonical `1y` key here exactly as it is everywhere else.
 */

import {
  CANDLE_INTERVALS,
  CANDLE_RANGES,
  YAHOO_CANDLE_CAPABILITIES,
  timeframeCapability,
} from '@/src/lib/market-data/candles/capabilities';
import type { CandleInterval, CandleRange } from '@/src/lib/market-data/candles/contracts';
import { FIVE_YEAR_LOOKBACK_DAYS, rangeMeetsMinimumLookback } from '@/src/lib/market-data/candles/range';
import { defaultIntervalForRange, supportedRangesForInterval } from '@/src/lib/market-data/gateway/capabilities';

/** Compact range tokens for the auto-adjust notices. `1y` reads as "12M". */
const RANGE_SHORT: Record<CandleRange, string> = {
  '1d': '1D', '5d': '5D', '1m': '1M', '3m': '3M', '6m': '6M',
  ytd: 'YTD', '1y': '12M', '3y': '3Y', '5y': '5Y',
};

/**
 * Minimum history a candle interval requires, in calendar days. Intervals absent
 * from this map are constrained only by readability and provider availability.
 */
export const MIN_LOOKBACK_DAYS_FOR_INTERVAL: Partial<Record<CandleInterval, number>> = {
  Week: FIVE_YEAR_LOOKBACK_DAYS,
  Month: FIVE_YEAR_LOOKBACK_DAYS,
};

export { rangeMeetsMinimumLookback };

/**
 * Ranges the chart can offer for an interval: readable, served by the Yahoo
 * historical primary, *and* long enough for the interval. Canonical display order.
 */
export function chartSupportedRanges(interval: CandleInterval): CandleRange[] {
  const readable = new Set(supportedRangesForInterval(interval));
  const available = new Set(timeframeCapability(YAHOO_CANDLE_CAPABILITIES, interval)?.supportedRanges ?? []);
  return CANDLE_RANGES.filter((range) => (
    readable.has(range) && available.has(range) && rangeMeetsMinimumLookback(interval, range)
  ));
}

export function isChartSelectionSupported(interval: CandleInterval, range: CandleRange): boolean {
  return chartSupportedRanges(interval).includes(range);
}

/**
 * The interval to switch to when the user picks a range the current interval
 * cannot serve. Prefers the existing recommendation and only searches when that
 * recommendation is itself unavailable from the historical primary.
 */
export function defaultIntervalForChartRange(range: CandleRange): CandleInterval {
  const preferred = defaultIntervalForRange(range);
  if (isChartSelectionSupported(preferred, range)) return preferred;
  return CANDLE_INTERVALS.find((interval) => isChartSelectionSupported(interval, range)) ?? '1D';
}

export interface ChartCompatibleSelection {
  interval: CandleInterval;
  range: CandleRange;
  changed: boolean;
  /** Beginner-Thai explanation shown as a toast when the selection was adjusted. */
  notice: string | null;
}

/**
 * Resolve a requested (interval, range) pair to one the chart can actually load.
 * The control the user just touched is preserved; the other axis moves.
 */
export function chartCompatibleSelection(
  interval: CandleInterval,
  range: CandleRange,
  changedControl: 'interval' | 'range',
): ChartCompatibleSelection {
  if (isChartSelectionSupported(interval, range)) return { interval, range, changed: false, notice: null };

  if (changedControl === 'range') {
    const nextInterval = defaultIntervalForChartRange(range);
    return {
      interval: nextInterval,
      range,
      changed: true,
      notice: `ช่วง ${RANGE_SHORT[range]} ใช้แท่ง ${nextInterval} เพื่อให้มีข้อมูลเพียงพอ`,
    };
  }

  const supported = chartSupportedRanges(interval);
  const preferredRange: Partial<Record<CandleInterval, CandleRange>> = {
    '1D': '6m',
    // 1W and above always take the full five-year window, never a shorter one.
    Week: '5y',
    Month: '5y',
  };
  const preferred = preferredRange[interval];
  // Every interval has at least one supported range (asserted by test), so the
  // last fallback below is a type-level default only.
  const nextRange: CandleRange = preferred && supported.includes(preferred)
    ? preferred
    : supported[0] ?? '1d';
  return {
    interval,
    range: nextRange,
    changed: true,
    notice: interval === '1D'
      ? 'แท่ง 1D ต้องใช้ช่วงย้อนหลังอย่างน้อย 1 เดือน ระบบเปลี่ยนช่วงเป็น 6M'
      : `แท่ง ${interval} ใช้ช่วง ${RANGE_SHORT[nextRange]} เพื่อให้มีข้อมูลเพียงพอ`,
  };
}
