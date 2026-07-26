import { describe, expect, it } from 'vitest';
import { aggregateCandles } from './aggregate';
import type { NormalizedCandle } from './contracts';

function candle(timestamp: string, open: number, high: number, low: number, close: number, volume: number, session: 'regular' | 'pre' = 'regular'): NormalizedCandle {
  return { timestamp: Date.parse(timestamp) / 1_000, open, high, low, close, volume, session };
}

describe('normalized candle aggregation', () => {
  it('uses first open, max high, min low, last close and summed real volume', () => {
    const result = aggregateCandles([
      candle('2026-07-20T13:30:00.000Z', 10, 12, 9, 11, 100),
      candle('2026-07-20T13:35:00.000Z', 11, 14, 10, 13, 150),
    ], '10m', '5m', 'America/New_York');
    expect(result).toEqual([{ timestamp: Date.parse('2026-07-20T13:30:00.000Z') / 1_000, open: 10, high: 14, low: 9, close: 13, volume: 250, session: 'regular' }]);
  });

  it('never crosses exchange session/date boundaries and never fills a missing source candle', () => {
    const result = aggregateCandles([
      candle('2026-07-20T12:00:00.000Z', 9, 10, 8, 9, 10, 'pre'),
      candle('2026-07-20T13:30:00.000Z', 10, 11, 9, 10, 20),
      candle('2026-07-20T13:40:00.000Z', 12, 13, 11, 12, 30),
      candle('2026-07-21T13:30:00.000Z', 14, 15, 13, 14, 40),
    ], '10m', '5m', 'America/New_York');
    expect(result).toHaveLength(4);
    expect(result.map((bar) => bar.open)).toEqual([9, 10, 12, 14]);
  });

  it('aggregates real daily bars by week and month without creating holidays', () => {
    const daily = [
      candle('2026-06-30T12:00:00.000Z', 10, 12, 9, 11, 100),
      candle('2026-07-01T12:00:00.000Z', 11, 13, 10, 12, 200),
      candle('2026-07-06T12:00:00.000Z', 12, 14, 11, 13, 300),
    ];
    expect(aggregateCandles(daily, 'Week', '1D', 'America/New_York', Date.parse('2026-07-07T12:00:00.000Z') / 1_000)).toEqual(expect.arrayContaining([expect.objectContaining({ partial: true })]));
    expect(aggregateCandles(daily, 'Month', '1D', 'America/New_York', Date.parse('2026-07-07T12:00:00.000Z') / 1_000)).toHaveLength(2);
  });


  it('aggregates 1m candles into 2m and 3m buckets from real source bars only', () => {
    const minutes = Array.from({ length: 6 }, (_, index) => candle(
      `2026-07-20T13:${String(30 + index).padStart(2, '0')}:00.000Z`,
      10 + index, 12 + index, 9 + index, 11 + index, 100,
    ));
    const two = aggregateCandles(minutes, '2m', '1m', 'America/New_York');
    expect(two).toHaveLength(3);
    expect(two[0]).toMatchObject({ open: 10, high: 13, low: 9, close: 12, volume: 200 });

    const three = aggregateCandles(minutes, '3m', '1m', 'America/New_York');
    expect(three).toHaveLength(2);
    expect(three[0]).toMatchObject({ open: 10, high: 14, low: 9, close: 13, volume: 300 });
    // Volume is conserved: aggregation never invents or drops traded shares.
    expect(three.reduce((sum, bar) => sum + bar.volume, 0))
      .toBe(minutes.reduce((sum, bar) => sum + bar.volume, 0));
  });

  it('aggregates 15m candles into a 45m bucket anchored on the session open', () => {
    const source = Array.from({ length: 6 }, (_, index) => candle(
      `2026-07-20T${String(13 + Math.floor((30 + index * 15) / 60)).padStart(2, '0')}:${String((30 + index * 15) % 60).padStart(2, '0')}:00.000Z`,
      10 + index, 12 + index, 9 + index, 11 + index, 50,
    ));
    const result = aggregateCandles(source, '45m', '15m', 'America/New_York');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ open: 10, high: 14, low: 9, close: 13, volume: 150 });
    expect(result[0].timestamp).toBe(Date.parse('2026-07-20T13:30:00.000Z') / 1_000);
  });

  it('aggregates 1h candles into a 3h bucket', () => {
    const source = Array.from({ length: 6 }, (_, index) => candle(
      `2026-07-20T${String(13 + index).padStart(2, '0')}:30:00.000Z`,
      10 + index, 12 + index, 9 + index, 11 + index, 70,
    ));
    const result = aggregateCandles(source, '3h', '1h', 'America/New_York');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ open: 10, high: 14, low: 9, close: 13, volume: 210 });
  });

  it('aggregates 1h candles into a correct 4h OHLCV bucket', () => {
    const result = aggregateCandles([
      candle('2026-07-20T13:30:00.000Z', 100, 103, 99, 102, 100),
      candle('2026-07-20T14:30:00.000Z', 102, 106, 101, 105, 200),
      candle('2026-07-20T15:30:00.000Z', 105, 107, 98, 100, 300),
      candle('2026-07-20T16:30:00.000Z', 100, 104, 97, 103, 400),
    ], '4h', '1h', 'America/New_York');
    expect(result).toEqual([{
      timestamp: Date.parse('2026-07-20T13:30:00.000Z') / 1_000,
      open: 100,
      high: 107,
      low: 97,
      close: 103,
      volume: 1_000,
      session: 'regular',
    }]);
  });

  it('aggregates a completed week with first/max/min/last/sum semantics', () => {
    const result = aggregateCandles([
      candle('2026-07-13T13:30:00.000Z', 10, 12, 9, 11, 100),
      candle('2026-07-14T13:30:00.000Z', 11, 14, 10, 13, 200),
      candle('2026-07-17T13:30:00.000Z', 13, 15, 8, 9, 300),
    ], 'Week', '1D', 'America/New_York', Date.parse('2026-07-24T13:30:00.000Z') / 1_000);
    expect(result).toEqual([{
      timestamp: Date.parse('2026-07-13T13:30:00.000Z') / 1_000,
      open: 10,
      high: 15,
      low: 8,
      close: 9,
      volume: 600,
      session: 'regular',
    }]);
  });
});
