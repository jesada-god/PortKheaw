import { describe, expect, it } from 'vitest';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { calculateMarketSignal } from './calculations';
import type { MarketSignalCandle } from './types';

const freshness: DataFreshness = {
  status: 'end-of-day',
  asOf: '2026-07-24T20:00:00.000Z',
  maxAgeSeconds: 21_600,
};
const context = {
  symbol: 'TEST',
  source: 'canonical-fixture',
  freshness,
  calculatedAt: '2026-07-25T00:00:00.000Z',
};

function candles(
  length: number,
  closeAt: (index: number) => number,
  volumeAt: (index: number) => number = () => 1_000,
): MarketSignalCandle[] {
  return Array.from({ length }, (_, index) => {
    const close = closeAt(index);
    return {
      date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
      open: close - 0.2,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: volumeAt(index),
      finalized: true,
    };
  });
}

describe('calculateMarketSignal', () => {
  it('classifies a bullish EMA/MACD/OBV fixture without treating hot RSI as automatically bearish', () => {
    const input = candles(260, (index) => 50 + index * 0.35, (index) => index === 259 ? 2_000 : 1_000);
    const result = calculateMarketSignal(input, context);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.signal).toBe('bullish');
    expect(result.score).toBeGreaterThanOrEqual(25);
    expect(result.components.trend.score).toBeGreaterThan(0.8);
    expect(result.indicators.ema20).toBeGreaterThan(result.indicators.ema50!);
    expect(result.indicators.ema50).toBeGreaterThan(result.indicators.ema200!);
    expect(result.indicators.rsi14).toBeGreaterThanOrEqual(70);
    expect(result.indicators.macdHistogram).toBeGreaterThanOrEqual(0);
    expect(result.indicators.relativeVolume20).toBe(2);
    expect(result.indicators.obvTrend).toBe('rising');
    expect(result.reasons.some((reason) => reason.id === 'rsi-hot' && reason.polarity === 'caution')).toBe(true);
  });

  it('classifies a neutral fixture inside the -25..+25 band', () => {
    const result = calculateMarketSignal(candles(260, () => 100), context);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.signal).toBe('neutral');
    expect(result.score).toBeGreaterThan(-25);
    expect(result.score).toBeLessThan(25);
  });

  it('classifies a bearish EMA/MACD/OBV fixture', () => {
    const input = candles(260, (index) => 200 - index * 0.35, (index) => index === 259 ? 2_000 : 1_000);
    const result = calculateMarketSignal(input, context);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.signal).toBe('bearish');
    expect(result.score).toBeLessThanOrEqual(-25);
    expect(result.components.trend.score).toBeLessThan(-0.8);
    expect(result.indicators.obvTrend).toBe('falling');
  });

  it('returns insufficient-data instead of filling missing indicators with zero', () => {
    const result = calculateMarketSignal(candles(30, (index) => 100 + index), context);
    expect(result.status).toBe('insufficient-data');
    expect(result.signal).toBeNull();
    expect(result.score).toBeNull();
    expect(result.confidence).toBe('Insufficient');
    expect(result.components.trend.score).toBeNull();
  });

  it('uses only finalized candles and is deterministic for identical inputs', () => {
    const finalized = candles(260, (index) => 50 + index * 0.35);
    const baseline = calculateMarketSignal(finalized, context);
    const withPartialCrash = calculateMarketSignal([
      ...finalized,
      {
        ...finalized.at(-1)!,
        date: '2026-07-26',
        open: 10,
        high: 11,
        low: 1,
        close: 2,
        volume: 9_000_000,
        finalized: false,
      },
    ], context);
    expect(calculateMarketSignal(finalized, context)).toEqual(baseline);
    expect(withPartialCrash.status).toBe(baseline.status);
    expect(withPartialCrash.signal).toBe(baseline.signal);
    expect(withPartialCrash.score).toBe(baseline.score);
    expect(withPartialCrash.latestCandleAt).toBe(baseline.latestCandleAt);
    expect(withPartialCrash.indicators).toEqual(baseline.indicators);
    expect(withPartialCrash.dataPoints).toEqual({ received: 261, finalized: 260 });
  });

  it.each([
    {
      name: 'confirmed resistance breakout',
      last: 108,
      expected: 1,
    },
    {
      name: 'confirmed support breakdown',
      last: 92,
      expected: -1,
    },
  ])('scores market structure for a $name', ({ last, expected }) => {
    const input = candles(
      260,
      (index) => index === 259 ? last : 100 + Math.sin(index * Math.PI / 5) * 5,
      (index) => index === 259 ? 3_000 : 1_000,
    );
    const result = calculateMarketSignal(input, context);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(Math.sign(result.components.structure.score ?? 0)).toBe(expected);
    expect(Math.sign(result.components.volume.score ?? 0)).toBe(expected);
  });

  it('reduces confidence when EMA200 history is unavailable but does not fabricate it', () => {
    const result = calculateMarketSignal(candles(80, (index) => 50 + index * 0.2), context);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.indicators.ema200).toBeNull();
    expect(result.components.trend.coverage).toBeLessThan(1);
    expect(result.confidence).not.toBe('High');
  });
});
