import { describe, expect, it } from 'vitest';
import type { HistoricalPrice } from '@/src/lib/market-data/types';
import {
  classifySqueezeState,
  linearRegressionEndpoint,
  realizedVolatility,
  ttmSqueezeSeries,
} from './indicators';

function series(closes: readonly number[], range = 1): HistoricalPrice[] {
  return closes.map((close, index) => ({
    date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 1_000,
  }));
}

describe('linearRegressionEndpoint', () => {
  it('returns the fitted value at the newest point of a clean trend', () => {
    expect(linearRegressionEndpoint([1, 2, 3, 4, 5])).toBeCloseTo(5, 10);
    expect(linearRegressionEndpoint([5, 4, 3, 2, 1])).toBeCloseTo(1, 10);
  });

  it('refuses to fit a degenerate or non-finite window', () => {
    expect(linearRegressionEndpoint([3])).toBeNull();
    expect(linearRegressionEndpoint([1, Number.NaN, 3])).toBeNull();
  });
});

describe('ttmSqueezeSeries / classifySqueezeState', () => {
  it('reports ON while a flat market compresses the Bollinger Bands inside Keltner', () => {
    // A market with a wide intrabar range but almost no closing movement keeps ATR
    // (Keltner) wide while the close-based bands collapse — the textbook squeeze.
    const flat = ttmSqueezeSeries(series(Array.from({ length: 80 }, () => 100), 4));
    expect(flat.compressed.at(-1)).toBe(true);
    expect(classifySqueezeState(flat)).toBe('ON');
  });

  it('reports OFF while a strongly trending market keeps the bands expanded', () => {
    const trending = ttmSqueezeSeries(series(Array.from({ length: 80 }, (_value, index) => 100 + index * 3), 0.2));
    expect(trending.compressed.at(-1)).toBe(false);
    expect(classifySqueezeState(trending)).toBe('OFF');
  });

  it('returns null before the bands have enough history to be computed', () => {
    expect(classifySqueezeState(ttmSqueezeSeries(series([100, 101, 102])))).toBeNull();
  });

  it('classifies a recent release as FIRED in the direction of the momentum histogram', () => {
    const compressedRun: Array<boolean | null> = Array.from({ length: 30 }, () => true);
    const bullish = classifySqueezeState({
      compressed: [...compressedRun, false],
      momentum: [...compressedRun.map(() => 0), 1.5],
    });
    expect(bullish).toBe('FIRED_BULLISH');
    const bearish = classifySqueezeState({
      compressed: [...compressedRun, false],
      momentum: [...compressedRun.map(() => 0), -1.5],
    });
    expect(bearish).toBe('FIRED_BEARISH');
  });

  it('does not call a release "fired" when the momentum has no sign', () => {
    const compressedRun: Array<boolean | null> = Array.from({ length: 30 }, () => true);
    expect(classifySqueezeState({
      compressed: [...compressedRun, false],
      momentum: [...compressedRun.map(() => 0), null],
    })).toBe('OFF');
    expect(classifySqueezeState({
      compressed: [...compressedRun, false],
      momentum: [...compressedRun.map(() => 0), 0],
    })).toBe('OFF');
  });

  it('stops treating a release as fired once the lookback window has passed', () => {
    const compressed: Array<boolean | null> = [
      ...Array.from({ length: 20 }, () => true),
      ...Array.from({ length: 10 }, () => false),
    ];
    expect(classifySqueezeState({ compressed, momentum: compressed.map(() => 2) })).toBe('OFF');
  });
});

describe('realizedVolatility', () => {
  it('annualizes close-to-close log returns from real candles', () => {
    // Alternating ±1% closes: daily stdev is ~0.01, annualized by sqrt(252).
    const closes = Array.from({ length: 300 }, (_value, index) => (index % 2 === 0 ? 100 : 101));
    const result = realizedVolatility(series(closes), 252, 120);
    expect(result).not.toBeNull();
    expect(result!.observations).toBe(252);
    expect(result!.value).toBeGreaterThan(0.1);
  });

  it('returns null rather than estimating from too little history', () => {
    expect(realizedVolatility(series([100, 101, 102, 103]), 252, 120)).toBeNull();
  });
});
