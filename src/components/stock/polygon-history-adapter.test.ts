import { describe, expect, it } from 'vitest';
import type { NormalizedBarsResult } from '@/src/lib/market-data/gateway/contracts';
import { polygonBarsToChartResult } from './polygon-history-adapter';

describe('polygonBarsToChartResult', () => {
  it('preserves adjusted Polygon OHLCV and timestamps for initial setData()', () => {
    const result = polygonBarsToChartResult({
      symbol: 'NVDA',
      provider: 'polygon',
      interval: '1D',
      range: '1y',
      adjusted: true,
      session: 'regular',
      timezone: 'America/New_York',
      currency: 'USD',
      firstTimestamp: 1_700_000_000,
      lastTimestamp: 1_700_086_400,
      asOf: 1_700_086_400,
      dataStatus: 'end-of-day',
      delayedByMinutes: null,
      bars: [{
        time: 1_700_000_000,
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 1_000,
        partial: false,
      }],
      warnings: [],
    } satisfies NormalizedBarsResult);

    expect(result).toMatchObject({
      provider: 'polygon',
      adjusted: true,
      dataStatus: 'end-of-day',
      actualStart: 1_700_000_000,
      candles: [{
        timestamp: 1_700_000_000,
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 1_000,
      }],
    });
  });
});
