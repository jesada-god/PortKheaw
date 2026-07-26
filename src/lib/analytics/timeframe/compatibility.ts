/**
 * Chart timeframe compatibility — what the Stock Detail chart may actually offer.
 *
 * Two independent constraints must BOTH hold before an (interval, range) pair is
 * offered to the user:
 *
 *  1. **Readability / warm-up** — the pair must return enough bars to be worth
 *     drawing and to warm the indicators up. That is the existing selection
 *     matrix in `market-data/gateway/capabilities`, reused unchanged.
 *  2. **Historical-provider availability** — the chart's historical primary is
 *     the Yahoo Finance Chart JSON pipeline, and Yahoo caps its intraday
 *     lookbacks (30m/45m reach ~60 days, not a quarter). A combination Yahoo
 *     cannot serve must never be offered.
 *
 * The offered set is the intersection of the two. A pair outside it is *disabled
 * with a reason* rather than a click that fails after a provider request, so the
 * UI can never promise a range the historical provider cannot serve.
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
import { defaultIntervalForRange, supportedRangesForInterval } from '@/src/lib/market-data/gateway/capabilities';

/** Compact range tokens for the auto-adjust notices. `1y` reads as "12M". */
const RANGE_SHORT: Record<CandleRange, string> = {
  '1d': '1D', '5d': '5D', '1m': '1M', '3m': '3M', '6m': '6M',
  ytd: 'YTD', '1y': '12M', '3y': '3Y', '5y': '5Y',
};

/**
 * Ranges the chart can offer for an interval: readable *and* served by the Yahoo
 * historical primary. Returned in canonical display order.
 */
export function chartSupportedRanges(interval: CandleInterval): CandleRange[] {
  const readable = new Set(supportedRangesForInterval(interval));
  const available = new Set(timeframeCapability(YAHOO_CANDLE_CAPABILITIES, interval)?.supportedRanges ?? []);
  return CANDLE_RANGES.filter((range) => readable.has(range) && available.has(range));
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
  const nextRange: CandleRange = interval === '1D' ? '6m'
    : interval === 'Week' ? '1y'
      : interval === 'Month' ? '5y'
        // Every interval has at least one supported range (asserted by test), so
        // the fallback below is a type-level default only.
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
