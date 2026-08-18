import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { calculateMarketSignal } from './calculations';
import type { MarketSignalCandle } from './types';

/**
 * An INDEPENDENT recomputation of every Market Signal metric from raw OHLCV.
 *
 * Nothing in this file imports the production indicator library. The formulas
 * below are written out longhand from their textbook definitions so that a
 * mistake in `analytics/technical/calculations` cannot hide behind a test that
 * calls the same mistake twice. Where the two disagree, this file is the
 * question and the engine is the answer under test.
 *
 * It runs against the frozen provider capture in `__golden__/candles/IREN.json`
 * — real Yahoo bars, not synthetic ones — and it asserts the dataset's identity
 * first, so `snapshot-signal --refresh` cannot silently move the ground under
 * the fixture values without failing loudly and specifically here.
 *
 * The three numbers the build brief pins as known-good are asserted by name at
 * the bottom: EMA20 deviation +8.42%, ATR-normalised distance 0.8433, squeeze
 * OFF. The MACD trio is asserted alongside them because it was REPORTED as a
 * bug and is not one — see the note on that test.
 */

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number | null }

const capture = JSON.parse(
  readFileSync(join(process.cwd(), '__golden__', 'candles', 'IREN.json'), 'utf8'),
) as { symbol: string; source: string | null; freshness: never; candles: MarketSignalCandle[] };

const finalized: Bar[] = capture.candles.filter((candle) => candle.finalized);
const closes = finalized.map((bar) => bar.close);

// --- reference formulas, written from the definitions -----------------------

/** EMA seeded with the SMA of the first `period` values (Wilder/StockCharts convention). */
function refEma(values: readonly number[], period: number): Array<number | null> {
  const out = Array<number | null>(values.length).fill(null);
  if (values.length < period) return out;
  let previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = previous;
  const k = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    previous = (values[index] - previous) * k + previous;
    out[index] = previous;
  }
  return out;
}

/** Wilder's RSI: seed from the first `period` changes, then smooth. */
function refRsi(values: readonly number[], period: number): Array<number | null> {
  const out = Array<number | null>(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change > 0) gain += change; else loss -= change;
  }
  gain /= period;
  loss /= period;
  const rsi = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = rsi();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out[index] = rsi();
  }
  return out;
}

/** True range of bar `i`, using the previous close once one exists. */
function refTrueRanges(bars: readonly Bar[]): number[] {
  return bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close)));
}

/** Wilder's ATR: simple mean of the first `period` true ranges, then smoothed. */
function refAtr(bars: readonly Bar[], period: number): Array<number | null> {
  const tr = refTrueRanges(bars);
  const out = Array<number | null>(bars.length).fill(null);
  if (bars.length < period) return out;
  let previous = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = previous;
  for (let index = period; index < bars.length; index += 1) {
    previous = (previous * (period - 1) + tr[index]) / period;
    out[index] = previous;
  }
  return out;
}

/** MACD line, its signal EMA, and the histogram as the difference of the two. */
function refMacd(values: readonly number[], fast: number, slow: number, signal: number) {
  const fastEma = refEma(values, fast);
  const slowEma = refEma(values, slow);
  const line = values.map((_, index) => fastEma[index] === null || slowEma[index] === null
    ? null : (fastEma[index] as number) - (slowEma[index] as number));
  const firstIndex = line.findIndex((value) => value !== null);
  const signalCompact = refEma(line.slice(firstIndex) as number[], signal);
  const signalLine = Array<number | null>(values.length).fill(null);
  signalCompact.forEach((value, index) => { signalLine[index + firstIndex] = value; });
  return {
    line,
    signal: signalLine,
    histogram: line.map((value, index) => value === null || signalLine[index] === null
      ? null : value - (signalLine[index] as number)),
  };
}

/** Bollinger bands on a simple mean with POPULATION standard deviation. */
function refBollinger(values: readonly number[], period: number, deviations: number) {
  return values.map((_, index) => {
    if (index < period - 1) return null;
    const window = values.slice(index - period + 1, index + 1);
    const mean = window.reduce((sum, value) => sum + value, 0) / period;
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
    const offset = Math.sqrt(variance) * deviations;
    return { upper: mean + offset, middle: mean, lower: mean - offset };
  });
}

/** Keltner: EMA of the typical price, offset by a multiple of Wilder's ATR. */
function refKeltner(bars: readonly Bar[], period: number, atrPeriod: number, multiplier: number) {
  const middle = refEma(bars.map((bar) => (bar.high + bar.low + bar.close) / 3), period);
  const atr = refAtr(bars, atrPeriod);
  return bars.map((_, index) => middle[index] === null || atr[index] === null ? null : {
    upper: (middle[index] as number) + (atr[index] as number) * multiplier,
    middle: middle[index] as number,
    lower: (middle[index] as number) - (atr[index] as number) * multiplier,
  });
}

/** Wilder's +DI/-DI/ADX from directional movement. */
function refAdx(bars: readonly Bar[], period: number) {
  const length = bars.length;
  const tr = refTrueRanges(bars);
  const plusDm = Array<number>(length).fill(0);
  const minusDm = Array<number>(length).fill(0);
  for (let index = 1; index < length; index += 1) {
    const up = bars[index].high - bars[index - 1].high;
    const down = bars[index - 1].low - bars[index].low;
    plusDm[index] = up > down && up > 0 ? up : 0;
    minusDm[index] = down > up && down > 0 ? down : 0;
  }
  let sumTr = 0;
  let sumPlus = 0;
  let sumMinus = 0;
  for (let index = 1; index <= period; index += 1) { sumTr += tr[index]; sumPlus += plusDm[index]; sumMinus += minusDm[index]; }
  const dx: number[] = [];
  let plusDi = 0;
  let minusDi = 0;
  let adx: number | null = null;
  for (let index = period; index < length; index += 1) {
    if (index > period) {
      sumTr = sumTr - sumTr / period + tr[index];
      sumPlus = sumPlus - sumPlus / period + plusDm[index];
      sumMinus = sumMinus - sumMinus / period + minusDm[index];
    }
    plusDi = sumTr === 0 ? 0 : (100 * sumPlus) / sumTr;
    minusDi = sumTr === 0 ? 0 : (100 * sumMinus) / sumTr;
    const total = plusDi + minusDi;
    dx.push(total === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / total);
    if (dx.length === period) adx = dx.reduce((sum, value) => sum + value, 0) / period;
    else if (dx.length > period) adx = ((adx as number) * (period - 1) + dx[dx.length - 1]) / period;
  }
  return { adx, plusDi, minusDi };
}

const signal = calculateMarketSignal(capture.candles, {
  symbol: 'IREN',
  source: capture.source,
  freshness: capture.freshness,
  calculatedAt: '2026-01-01T00:00:00.000Z',
});
const metrics = signal.metrics;
const near = (actual: number | null, expected: number, tolerance = 1e-9) => {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - expected)).toBeLessThan(tolerance);
};

describe('market signal metrics against an independent reference implementation', () => {
  it('runs against the exact frozen capture the fixtures were taken from', () => {
    // If this fails, `snapshot-signal --refresh` moved the dataset. The pinned
    // fixture values below describe THIS capture and have to be re-derived.
    expect(capture.symbol).toBe('IREN');
    expect(finalized.at(-1)?.date).toBe('2026-08-14');
    near(finalized.at(-1)?.close ?? null, 44.060001373291016, 1e-9);
    expect(finalized).toHaveLength(1189);
  });

  it('reproduces the moving averages and their slopes', () => {
    near(metrics.ema20, refEma(closes, 20).at(-1) as number, 1e-9);
    near(metrics.ema50, refEma(closes, 50).at(-1) as number, 1e-9);
    near(metrics.ema200, refEma(closes, 200).at(-1) as number, 1e-9);

    const slope = (period: number, lookback: number) => {
      const series = refEma(closes, period);
      const current = series.at(-1) as number;
      const previous = series.at(-(lookback + 1)) as number;
      return ((current - previous) / Math.abs(previous)) * 100;
    };
    near(metrics.ema20SlopePct, Number(slope(20, 5).toFixed(4)), 1e-9);
    near(metrics.ema50SlopePct, Number(slope(50, 10).toFixed(4)), 1e-9);
    near(metrics.ema200SlopePct, Number(slope(200, 20).toFixed(4)), 1e-9);
  });

  it('reproduces RSI, ATR and ADX/DMI', () => {
    near(metrics.rsi14, refRsi(closes, 14).at(-1) as number, 1e-9);
    near(metrics.atr14, refAtr(finalized, 14).at(-1) as number, 1e-9);
    const adx = refAdx(finalized, 14);
    near(metrics.adx14, adx.adx as number, 1e-9);
    near(metrics.plusDi14, adx.plusDi, 1e-9);
    near(metrics.minusDi14, adx.minusDi, 1e-9);
  });

  it('reproduces both volatility envelopes', () => {
    const bands = refBollinger(closes, 20, 2).at(-1)!;
    near(metrics.bollingerUpper, bands.upper, 1e-9);
    near(metrics.bollingerMiddle, bands.middle, 1e-9);
    near(metrics.bollingerLower, bands.lower, 1e-9);

    const channel = refKeltner(finalized, 20, 14, 1.5).at(-1)!;
    near(metrics.keltnerUpper, channel.upper, 1e-9);
    near(metrics.keltnerMiddle, channel.middle, 1e-9);
    near(metrics.keltnerLower, channel.lower, 1e-9);
  });

  it('reproduces relative volume over the twenty bars BEFORE the latest one', () => {
    const trailing = finalized.slice(-21, -1).map((bar) => bar.volume as number);
    const average = trailing.reduce((sum, value) => sum + value, 0) / 20;
    near(metrics.relativeVolume20, (finalized.at(-1)!.volume as number) / average, 1e-9);
  });

  /*
   * The build brief reported this as a bug: "MACD -0.1121, Signal -0.1386, so
   * the histogram must be +0.0265, but the system shows +1.2741".
   *
   * The engine is right and the reported signal value was a transcription of
   * -1.3862 with a digit dropped. This capture's MACD line climbed from -3.75 to
   * -0.11 in twelve sessions; a nine-period EMA of that line cannot have caught
   * up, and it has not — it sits at -1.3862, which is exactly what an
   * independent implementation produces here. The histogram is therefore
   * genuinely +1.2741, and it is large *because* momentum turned hard.
   *
   * This test exists so the claim is settled by arithmetic rather than re-argued:
   * it checks the trio against the reference AND checks the defining identity
   * histogram = MACD - signal, which is the invariant a real indexing bug would
   * break.
   */
  it('reproduces the MACD trio, including the histogram reported as wrong', () => {
    const reference = refMacd(closes, 12, 26, 9);
    near(metrics.macd, reference.line.at(-1) as number, 1e-9);
    near(metrics.macdSignal, reference.signal.at(-1) as number, 1e-9);
    near(metrics.macdHistogram, reference.histogram.at(-1) as number, 1e-9);

    near(metrics.macd, -0.11205758719454195, 1e-9);
    near(metrics.macdSignal, -1.3861779991116565, 1e-9);
    near(metrics.macdHistogram, 1.2741204119171146, 1e-9);
    near(metrics.macdHistogram, (metrics.macd as number) - (metrics.macdSignal as number), 1e-12);
  });

  it('reproduces the three fixture values the brief pins as known-good', () => {
    const ema20 = refEma(closes, 20).at(-1) as number;
    const atr14 = refAtr(finalized, 14).at(-1) as number;
    const close = finalized.at(-1)!.close;

    // deviation +8.42%
    near(metrics.ema20DeviationPct, ((close - ema20) / Math.abs(ema20)) * 100, 1e-9);
    expect((metrics.ema20DeviationPct as number).toFixed(2)).toBe('8.42');

    // ATR-normalised distance 0.8433
    near(metrics.atrNormalizedDistance, (close - ema20) / atr14, 1e-9);
    expect((metrics.atrNormalizedDistance as number).toFixed(4)).toBe('0.8433');

    // squeeze OFF
    const bands = refBollinger(closes, 20, 2).at(-1)!;
    const channel = refKeltner(finalized, 20, 14, 1.5).at(-1)!;
    expect(bands.upper <= channel.upper && bands.lower >= channel.lower).toBe(false);
    expect(metrics.squeezeOn).toBe(false);
  });
});
