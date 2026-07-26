import { describe, expect, it } from 'vitest';
import { emaSeries, macdSeries, rsiSeries, MACD_FAST, MACD_SIGNAL, MACD_SLOW } from './series';
import { ema, macd, rsiWilder } from '../technical/calculations';
import type { CanonicalBar } from '../canonical-bars';

const DAY = 86_400;
const START = Date.UTC(2026, 0, 5) / 1_000;

function bars(closes: readonly number[]): CanonicalBar[] {
  return closes.map((close, index) => ({
    time: START + index * DAY,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000 + index,
    partial: false,
  }));
}

/** A deterministic, non-monotonic path so RSI/MACD have both gains and losses. */
const CLOSES = Array.from({ length: 260 }, (_, index) => 100 + Math.sin(index / 7) * 8 + index * 0.05);

describe('EMA series', () => {
  it('matches the shared EMA implementation for period 20', () => {
    const series = emaSeries(bars(CLOSES), 20);
    expect(series.status).toBe('available');
    const expected = ema(CLOSES, 20).filter((value): value is number => value != null);
    if (series.status !== 'available') throw new Error('expected available');
    expect(series.points).toHaveLength(expected.length);
    series.points.forEach((point, index) => expect(point.value).toBeCloseTo(expected[index], 10));
  });

  it('seeds deterministically from the first SMA window', () => {
    const series = emaSeries(bars(CLOSES), 20);
    if (series.status !== 'available') throw new Error('expected available');
    const seed = CLOSES.slice(0, 20).reduce((sum, value) => sum + value, 0) / 20;
    expect(series.points[0].value).toBeCloseTo(seed, 10);
    expect(series.points[0].time).toBe(START + 19 * DAY);
  });

  it('matches the shared EMA implementation for period 50', () => {
    const series = emaSeries(bars(CLOSES), 50);
    if (series.status !== 'available') throw new Error('expected available');
    const expected = ema(CLOSES, 50).filter((value): value is number => value != null);
    expect(series.points.at(-1)?.value).toBeCloseTo(expected.at(-1) as number, 10);
  });

  it('reports EMA 100 unavailable rather than drawing a short-window approximation', () => {
    const series = emaSeries(bars(CLOSES.slice(0, 60)), 100);
    expect(series.status).toBe('unavailable');
    if (series.status !== 'unavailable') throw new Error('expected unavailable');
    expect(series.minimumBars).toBe(100);
    expect(series.actualBars).toBe(60);
  });

  it('reports EMA 200 unavailable on a short dataset', () => {
    const series = emaSeries(bars(CLOSES.slice(0, 120)), 200);
    expect(series.status).toBe('unavailable');
  });
});

describe('RSI series', () => {
  it('matches the shared Wilder RSI', () => {
    const series = rsiSeries(bars(CLOSES), 14);
    if (series.status !== 'available') throw new Error('expected available');
    const expected = rsiWilder(CLOSES, 14).filter((value): value is number => value != null);
    expect(series.points).toHaveLength(expected.length);
    series.points.forEach((point, index) => expect(point.value).toBeCloseTo(expected[index], 10));
  });

  it('stays inside the 0–100 band that the 70/50/30 references live on', () => {
    const series = rsiSeries(bars(CLOSES), 14);
    if (series.status !== 'available') throw new Error('expected available');
    series.points.forEach((point) => {
      expect(point.value).toBeGreaterThanOrEqual(0);
      expect(point.value).toBeLessThanOrEqual(100);
    });
  });

  it('is unavailable with fewer than period + 1 bars', () => {
    const series = rsiSeries(bars(CLOSES.slice(0, 14)), 14);
    expect(series.status).toBe('unavailable');
  });
});

describe('MACD series', () => {
  it('matches the shared MACD line, signal and histogram', () => {
    const series = macdSeries(bars(CLOSES), MACD_FAST, MACD_SLOW, MACD_SIGNAL);
    if (series.status !== 'available') throw new Error('expected available');
    const expected = macd(CLOSES, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
    const first = series.points[0];
    const index = CLOSES.length - series.points.length;
    expect(first.macd).toBeCloseTo(expected.macd[index] as number, 10);
    const last = series.points.at(-1);
    expect(last?.macd).toBeCloseTo(expected.macd.at(-1) as number, 10);
    expect(last?.signal).toBeCloseTo(expected.signal.at(-1) as number, 10);
    expect(last?.histogram).toBeCloseTo(expected.histogram.at(-1) as number, 10);
  });

  it('keeps histogram equal to MACD minus signal at every point that has both', () => {
    const series = macdSeries(bars(CLOSES));
    if (series.status !== 'available') throw new Error('expected available');
    series.points.forEach((point) => {
      if (point.signal == null || point.histogram == null) return;
      expect(point.histogram).toBeCloseTo(point.macd - point.signal, 10);
    });
  });

  it('is unavailable before slow + signal - 1 bars exist', () => {
    const series = macdSeries(bars(CLOSES.slice(0, 20)));
    expect(series.status).toBe('unavailable');
    if (series.status !== 'unavailable') throw new Error('expected unavailable');
    expect(series.minimumBars).toBe(MACD_SLOW + MACD_SIGNAL - 1);
  });
});
