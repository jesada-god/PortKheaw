/**
 * Chart indicator series computed from the canonical OHLCV already loaded.
 *
 * Toggling an indicator is a pure re-derivation of bars the browser is holding:
 * it must never issue a market request. Every formula reuses the shared,
 * already-tested implementations in `analytics/technical/calculations` so the
 * chart and the rest of the app can never disagree about what EMA-20 means.
 */

import { ema, macd as macdLines, rsiWilder } from '../technical/calculations';
import type { CanonicalBar } from '../canonical-bars';

export interface IndicatorPoint {
  time: number;
  value: number;
}

export interface MacdPoint {
  time: number;
  macd: number;
  signal: number | null;
  histogram: number | null;
}

export type IndicatorSeries =
  | { status: 'available'; points: IndicatorPoint[] }
  | { status: 'unavailable'; reason: string; minimumBars: number; actualBars: number };

export type MacdSeries =
  | { status: 'available'; points: MacdPoint[] }
  | { status: 'unavailable'; reason: string; minimumBars: number; actualBars: number };

export const EMA_PERIODS = [20, 50, 100, 200] as const;
export type EmaPeriod = (typeof EMA_PERIODS)[number];

export const RSI_PERIOD = 14;
export const RSI_OVERBOUGHT = 70;
export const RSI_MIDPOINT = 50;
export const RSI_OVERSOLD = 30;
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;

function insufficient(minimumBars: number, actualBars: number): IndicatorSeries & { status: 'unavailable' } {
  return {
    status: 'unavailable',
    reason: `ต้องมีแท่งเทียนอย่างน้อย ${minimumBars} แท่ง แต่มี ${actualBars} แท่ง`,
    minimumBars,
    actualBars,
  };
}

function pair(bars: readonly CanonicalBar[], values: Array<number | null>): IndicatorPoint[] {
  const points: IndicatorPoint[] = [];
  values.forEach((value, index) => {
    if (value == null || !Number.isFinite(value)) return;
    points.push({ time: bars[index].time, value });
  });
  return points;
}

/**
 * EMA over canonical closes, seeded with the first `period` SMA so the series is
 * deterministic from the first plotted point (no warm-up drift between reloads).
 */
export function emaSeries(bars: readonly CanonicalBar[], period: number): IndicatorSeries {
  if (bars.length < period) return insufficient(period, bars.length);
  const points = pair(bars, ema(bars.map((bar) => bar.close), period));
  return points.length ? { status: 'available', points } : insufficient(period, bars.length);
}

/** Wilder RSI over canonical closes. */
export function rsiSeries(bars: readonly CanonicalBar[], period: number = RSI_PERIOD): IndicatorSeries {
  const minimum = period + 1;
  if (bars.length < minimum) return insufficient(minimum, bars.length);
  const points = pair(bars, rsiWilder(bars.map((bar) => bar.close), period));
  return points.length ? { status: 'available', points } : insufficient(minimum, bars.length);
}

/** MACD(12, 26, 9): line, signal and histogram over canonical closes. */
export function macdSeries(
  bars: readonly CanonicalBar[],
  fast: number = MACD_FAST,
  slow: number = MACD_SLOW,
  signal: number = MACD_SIGNAL,
): MacdSeries {
  const minimum = slow + signal - 1;
  if (bars.length < minimum) {
    return {
      status: 'unavailable',
      reason: `ต้องมีแท่งเทียนอย่างน้อย ${minimum} แท่ง แต่มี ${bars.length} แท่ง`,
      minimumBars: minimum,
      actualBars: bars.length,
    };
  }
  const lines = macdLines(bars.map((bar) => bar.close), fast, slow, signal);
  const points: MacdPoint[] = [];
  lines.macd.forEach((value, index) => {
    if (value == null || !Number.isFinite(value)) return;
    points.push({
      time: bars[index].time,
      macd: value,
      signal: lines.signal[index] ?? null,
      histogram: lines.histogram[index] ?? null,
    });
  });
  return points.length
    ? { status: 'available', points }
    : { status: 'unavailable', reason: 'ไม่สามารถคำนวณ MACD ได้จากชุดข้อมูลนี้', minimumBars: minimum, actualBars: bars.length };
}
