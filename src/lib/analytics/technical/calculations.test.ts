import { describe, expect, it } from 'vitest';
import type { HistoricalPrice } from '@/src/lib/market-data/types';
import { adxWilder, atrWilder, calculateTechnicalAnalysis, ema, ichimoku, keltnerChannels, macd, onBalanceVolume, rateOfChange, rsiWilder, sma, stochastic } from './calculations';

const freshness = { status: 'end-of-day' as const, asOf: '2026-07-18T20:00:00.000Z', maxAgeSeconds: 86_400 };
const context = { symbol: 'TEST', source: 'fixture', freshness, calculatedAt: '2026-07-19T00:00:00.000Z' };

function candles(length: number, transform?: (candle: HistoricalPrice, index: number) => HistoricalPrice): HistoricalPrice[] {
  return Array.from({ length }, (_, index) => {
    const close = index + 10;
    const candle = { date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1_000 + index };
    return transform?.(candle, index) ?? candle;
  });
}

describe('technical indicator formulas', () => {
  it('calculates SMA and seeded EMA from known values', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5]);
  });

  it('calculates Wilder RSI and handles zero losses without Infinity', () => {
    expect(rsiWilder([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, null, 100, 100, 100]);
    expect(rsiWilder([5, 5, 5, 5], 2)).toEqual([null, null, 50, 50]);
  });

  it('calculates MACD, signal, and histogram from a known linear fixture', () => {
    const result = macd([1, 2, 3, 4, 5, 6], 2, 3, 2);
    expect(result.macd).toEqual([null, null, 0.5, 0.5, 0.5, 0.5]);
    expect(result.signal).toEqual([null, null, null, 0.5, 0.5, 0.5]);
    expect(result.histogram).toEqual([null, null, null, 0, 0, 0]);
  });

  it('calculates Wilder ATR from true ranges', () => {
    expect(atrWilder(candles(5), 3)).toEqual([null, null, 2, 2, 2]);
  });

  it('calculates Keltner Channels from typical-price EMA and Wilder ATR without future values', () => {
    const input = candles(8);
    const before = keltnerChannels(input, 3, 3, 1.5);
    expect(before.slice(0, 2)).toEqual([null, null]);
    expect(before[2]).toEqual({ upper: 14, middle: 11, lower: 8 });
    const withFuture = keltnerChannels([...input, { ...input.at(-1)!, date: '2026-01-09', close: 1_000, high: 1_001, low: 999 }], 3, 3, 1.5);
    expect(withFuture.slice(0, input.length)).toEqual(before);
    expect(() => keltnerChannels(input, 3, 3, 0)).toThrow(/multiplier/i);
  });

  it('calculates Stochastic, OBV and ROC from aligned raw candles', () => {
    const input = candles(8);
    const stochasticResult = stochastic(input, 3, 1, 2);
    expect(stochasticResult.k.slice(0, 2)).toEqual([null, null]);
    expect(stochasticResult.k[2]).toBeCloseTo(75);
    expect(stochasticResult.d[3]).toBeCloseTo(75);
    expect(onBalanceVolume(input)).toEqual([0, 1001, 2003, 3006, 4010, 5015, 6021, 7028]);
    expect(rateOfChange([10, 11, 12, 15], 2)).toEqual([null, null, expect.closeTo(20, 10), expect.closeTo(36.363636, 5)]);
  });

  it('calculates finite Wilder ADX/DMI and Ichimoku without reading future candles', () => {
    const input = candles(90, (candle, index) => ({ ...candle, high: candle.high + Math.sin(index), low: candle.low - Math.cos(index) }));
    const dmi = adxWilder(input, 14);
    expect(dmi.adx.slice(27).every((value) => value != null && Number.isFinite(value))).toBe(true);
    const before = ichimoku(input, 9, 26, 52, 26);
    const after = ichimoku([...input, { ...input.at(-1)!, date: '2026-04-01', high: 10_000, close: 9_999 }], 9, 26, 52, 26);
    expect(after.conversion.slice(0, input.length)).toEqual(before.conversion);
    expect(after.leadingA.slice(0, input.length)).toEqual(before.leadingA);
    expect(after.leadingB.slice(0, input.length)).toEqual(before.leadingB);
  });
});

describe('technical analysis contract', () => {
  it('returns per-indicator unavailable results when candles are insufficient', () => {
    const result = calculateTechnicalAnalysis(candles(10), context);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.indicators.sma).toMatchObject({ status: 'unavailable', minimumDataPoints: 20, actualDataPoints: 10 });
      expect(result.indicators.rsi).toMatchObject({ status: 'unavailable', minimumDataPoints: 15 });
      expect(result.indicators.macd).toMatchObject({ status: 'unavailable', minimumDataPoints: 34 });
      expect(result.indicators.keltner).toMatchObject({ status: 'unavailable', minimumDataPoints: 20 });
    }
  });

  it('returns deterministic metadata and finite results for identical input', () => {
    const first = calculateTechnicalAnalysis(candles(60), context);
    const second = calculateTechnicalAnalysis(candles(60), context);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 'available', symbol: 'TEST', dataSource: 'fixture', dataPoints: 60, latestDataAt: '2026-03-01', calculatedAt: context.calculatedAt, freshness });
    expect(JSON.stringify(first)).not.toMatch(/NaN|Infinity/);
  });

  it('accepts zero OHLCV values but rejects NaN, Infinity, and invalid ordering', () => {
    const zero = calculateTechnicalAnalysis(candles(40, (candle) => ({ ...candle, open: 0, high: 0, low: 0, close: 0, volume: 0 })), context);
    expect(zero.status).toBe('available');
    const nan = calculateTechnicalAnalysis(candles(40, (candle, index) => index === 5 ? { ...candle, close: Number.NaN } : candle), context);
    expect(nan).toMatchObject({ status: 'unavailable' });
    const infinite = calculateTechnicalAnalysis(candles(40, (candle, index) => index === 5 ? { ...candle, high: Number.POSITIVE_INFINITY } : candle), context);
    expect(infinite).toMatchObject({ status: 'unavailable' });
    const reversed = calculateTechnicalAnalysis(candles(40).reverse(), context);
    expect(reversed).toMatchObject({ status: 'unavailable' });
  });

  it('preserves stale freshness instead of presenting stale data as current', () => {
    const result = calculateTechnicalAnalysis(candles(40), { ...context, freshness: { ...freshness, status: 'cached' } });
    expect(result.freshness.status).toBe('cached');
  });

  it('validates extreme periods and MACD ordering', () => {
    expect(() => calculateTechnicalAnalysis(candles(40), context, { smaPeriod: 251 })).toThrow();
    expect(() => calculateTechnicalAnalysis(candles(40), context, { macdFastPeriod: 30, macdSlowPeriod: 20 })).toThrow();
  });

  it('provides requested 20/50/100/200 presets, aligned volume, and refuses daily VWAP', () => {
    const input = candles(220);
    const result = calculateTechnicalAnalysis(input, context);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.indicators.sma.status === 'available' && result.indicators.sma.latest.date).toBe(input.at(-1)!.date);
      expect(result.indicators.sma50.status).toBe('available');
      expect(result.indicators.sma100.status).toBe('available');
      expect(result.indicators.sma200.status).toBe('available');
      expect(result.indicators.ema50.status).toBe('available');
      expect(result.indicators.ema100.status).toBe('available');
      expect(result.indicators.ema200.status).toBe('available');
      expect(result.indicators.volume.status === 'available' && result.indicators.volume.latest).toEqual({ date: input.at(-1)!.date, value: input.at(-1)!.volume });
      expect(result.indicators.vwap).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('session boundaries') });
    }
  });

  it('keeps price indicators available but marks volume-dependent indicators unavailable on a missing-volume slot', () => {
    const input = candles(60);
    input[20] = { ...input[20], volume: null };
    const result = calculateTechnicalAnalysis(input, context);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.indicators.sma.status).toBe('available');
      expect(result.indicators.ema50.status).toBe('available');
      expect(result.indicators.volume).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('missing volume') });
      expect(result.indicators.averageVolume).toMatchObject({ status: 'unavailable' });
      expect(result.indicators.obv).toMatchObject({ status: 'unavailable' });
    }
  });
});
