import { describe, expect, it } from 'vitest';
import type { DataFreshness } from '@/src/lib/market-data/types';
import {
  buildMacroInput,
  buildUnderlyingInputs,
  dataStateFromFreshness,
  finalizedOnly,
  nearestLevels,
  relativeVolume20,
  type UnderlyingCandle,
} from './underlying';

const endOfDay: DataFreshness = { status: 'end-of-day', asOf: '2026-07-27T20:00:00.000Z', maxAgeSeconds: 21_600 };

function candles(length: number, closeAt: (index: number) => number, volumeAt: (index: number) => number = () => 1_000): UnderlyingCandle[] {
  return Array.from({ length }, (_value, index) => {
    const close = closeAt(index);
    return {
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      open: close - 0.2,
      high: close + 1,
      low: close - 1,
      close,
      volume: volumeAt(index),
      finalized: true,
    };
  });
}

describe('dataStateFromFreshness', () => {
  it('maps every pipeline freshness onto a displayable state', () => {
    expect(dataStateFromFreshness({ ...endOfDay, status: 'realtime' })).toBe('LIVE');
    expect(dataStateFromFreshness({ ...endOfDay, status: 'delayed' })).toBe('DELAYED');
    expect(dataStateFromFreshness({ ...endOfDay, status: 'end-of-day' })).toBe('DELAYED');
    expect(dataStateFromFreshness({ ...endOfDay, status: 'cached' })).toBe('DELAYED');
    expect(dataStateFromFreshness({ ...endOfDay, status: 'stale' })).toBe('STALE');
    expect(dataStateFromFreshness({ ...endOfDay, status: 'unavailable' })).toBe('UNAVAILABLE');
    expect(dataStateFromFreshness({ ...endOfDay, status: 'unknown' })).toBe('UNAVAILABLE');
  });
});

describe('finalizedOnly', () => {
  it('removes the still-forming candle so no factor can look ahead', () => {
    const withPartial = [...candles(3, () => 100), { ...candles(1, () => 105)[0], finalized: false }];
    expect(finalizedOnly(withPartial)).toHaveLength(3);
    expect(finalizedOnly(withPartial).every((candle) => !('finalized' in candle))).toBe(true);
  });
});

describe('relativeVolume20', () => {
  it('divides the newest finalized volume by the 20 complete sessions before it', () => {
    const rows = candles(21, () => 100, (index) => (index === 20 ? 2_000 : 1_000));
    expect(relativeVolume20(finalizedOnly(rows))).toBe(2);
  });

  it('returns null rather than a partial average when a volume is missing', () => {
    const rows = finalizedOnly(candles(21, () => 100)).map((candle, index) => (
      index === 5 ? { ...candle, volume: null } : candle
    ));
    expect(relativeVolume20(rows)).toBeNull();
    expect(relativeVolume20(finalizedOnly(candles(10, () => 100)))).toBeNull();
  });
});

describe('nearestLevels', () => {
  it('picks the closest confirmed zone on each side of the price', () => {
    const zones = [
      { type: 'support' as const, midpoint: 80 },
      { type: 'support' as const, midpoint: 95 },
      { type: 'resistance' as const, midpoint: 105 },
      { type: 'resistance' as const, midpoint: 130 },
    ];
    expect(nearestLevels(zones, 100)).toEqual({ support: 95, resistance: 105 });
  });

  it('reports a missing side as null instead of borrowing the wrong side', () => {
    expect(nearestLevels([{ type: 'support', midpoint: 95 }], 100)).toEqual({ support: 95, resistance: null });
    expect(nearestLevels([], 100)).toEqual({ support: null, resistance: null });
  });
});

describe('buildUnderlyingInputs', () => {
  const meta = { symbol: 'TEST', provider: 'fixture', freshness: endOfDay, calculatedAt: '2026-07-28T00:00:00.000Z' };

  it('derives trend, momentum and levels from one finalized dataset', () => {
    const result = buildUnderlyingInputs(candles(320, (index) => 100 + index * 0.5), meta);
    expect(result.trend.status).toBe('available');
    expect(result.momentum.status).toBe('available');
    expect(result.finalizedCandles).toBe(320);
    expect(result.latestCandleAt).toBe(finalizedOnly(candles(320, () => 100)).at(-1)!.date);
    if (result.trend.status === 'available') {
      expect(result.trend.value.close).toBeGreaterThan(result.trend.value.ema20!);
      expect(result.trend.value.ema20!).toBeGreaterThan(result.trend.value.ema50!);
      expect(result.trend.state).toBe('DELAYED');
    }
    expect(result.realizedVolatility).not.toBeNull();
  });

  it('refuses to score anything when there is not enough finalized history', () => {
    const result = buildUnderlyingInputs(candles(20, () => 100), meta);
    expect(result.trend.status).toBe('unavailable');
    expect(result.momentum.status).toBe('unavailable');
    expect(result.levels.status).toBe('unavailable');
    expect(result.realizedVolatility).toBeNull();
  });

  it('refuses to score a dataset the pipeline could not vouch for', () => {
    const result = buildUnderlyingInputs(candles(320, (index) => 100 + index), {
      ...meta,
      freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
    });
    expect(result.trend.status).toBe('unavailable');
    expect(result.momentum.status).toBe('unavailable');
  });
});

describe('buildMacroInput', () => {
  const calculatedAt = '2026-07-28T00:00:00.000Z';

  it('builds benchmarks from real EMA20 values only', () => {
    const slot = buildMacroInput([
      { symbol: 'SPY', candles: candles(120, (index) => 100 + index), provider: 'fixture', freshness: endOfDay },
      { symbol: 'QQQ', candles: candles(120, (index) => 200 - index * 0.5), provider: 'fixture', freshness: endOfDay },
    ], calculatedAt);
    expect(slot.status).toBe('available');
    if (slot.status !== 'available') return;
    expect(slot.value.benchmarks.map((benchmark) => benchmark.symbol)).toEqual(['SPY', 'QQQ']);
    expect(slot.value.benchmarks[0].close).toBeGreaterThan(slot.value.benchmarks[0].ema20!);
    expect(slot.value.benchmarks[1].close).toBeLessThan(slot.value.benchmarks[1].ema20!);
  });

  it('reports the weakest benchmark state for the group', () => {
    const slot = buildMacroInput([
      { symbol: 'SPY', candles: candles(120, (index) => 100 + index), provider: 'a', freshness: { ...endOfDay, status: 'realtime' } },
      { symbol: 'QQQ', candles: candles(120, (index) => 100 + index), provider: 'b', freshness: { ...endOfDay, status: 'stale' } },
    ], calculatedAt);
    expect(slot.state).toBe('STALE');
  });

  it('is unavailable rather than partially invented when no benchmark qualifies', () => {
    const slot = buildMacroInput([
      { symbol: 'SPY', candles: candles(10, () => 100), provider: 'a', freshness: endOfDay },
      { symbol: 'QQQ', candles: [], provider: null, freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null } },
    ], calculatedAt);
    expect(slot.status).toBe('unavailable');
    expect(slot.state).toBe('UNAVAILABLE');
  });
});
