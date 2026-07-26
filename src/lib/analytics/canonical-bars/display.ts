/**
 * Display transforms over canonical bars.
 *
 * A chart type only ever changes *how a bar is drawn*. The bucket timestamp and
 * the real traded volume are carried through untouched, and the raw OHLC stays
 * attached so a tooltip can show what actually traded next to the smoothed
 * values. Switching chart type is therefore a pure re-derivation of bars already
 * in memory — never a refetch, and never a reason for the volume column to move.
 */

import type { CanonicalBar } from './bars';

export type CanonicalDisplayMode = 'candlestick' | 'heikin-ashi';

export interface DisplayBar {
  time: number;
  /** Drawn OHLC for the selected chart type. */
  open: number;
  high: number;
  low: number;
  close: number;
  /** The bar as it actually traded, regardless of chart type. */
  rawOpen: number;
  rawHigh: number;
  rawLow: number;
  rawClose: number;
  volume: number | null;
  partial: boolean;
  /** True when the drawn OHLC is a transform rather than the traded prints. */
  transformed: boolean;
}

/**
 * Heikin-Ashi over canonical bars.
 *
 *   HA Close = (O + H + L + C) / 4
 *   HA Open  = first bar: (O + C) / 2 · otherwise (prev HA Open + prev HA Close) / 2
 *   HA High  = max(H, HA Open, HA Close)
 *   HA Low   = min(L, HA Open, HA Close)
 *
 * The first bar is seeded deterministically so the same dataset always renders
 * the same series.
 */
export function toDisplayBars(bars: readonly CanonicalBar[], mode: CanonicalDisplayMode): DisplayBar[] {
  const result: DisplayBar[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const base = {
      time: bar.time,
      rawOpen: bar.open,
      rawHigh: bar.high,
      rawLow: bar.low,
      rawClose: bar.close,
      volume: bar.volume,
      partial: bar.partial,
    };
    if (mode !== 'heikin-ashi') {
      result.push({ ...base, open: bar.open, high: bar.high, low: bar.low, close: bar.close, transformed: false });
      continue;
    }
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const previous = result[index - 1];
    const open = previous ? (previous.open + previous.close) / 2 : (bar.open + bar.close) / 2;
    result.push({
      ...base,
      open,
      high: Math.max(bar.high, open, close),
      low: Math.min(bar.low, open, close),
      close,
      transformed: true,
    });
  }
  return result;
}
