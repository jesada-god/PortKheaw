import { describe, expect, it } from 'vitest';
import {
  candleRangeBounds,
  canonicalCandleBounds,
  canonicalCandleRange,
  latestTradingDayCandles,
  rangeMeetsMinimumLookback,
} from './range';
import type { NormalizedCandle } from './contracts';

function bar(timestamp: number, close = 10): NormalizedCandle {
  return { timestamp, open: close, high: close, low: close, close, volume: 1 };
}

const NY = 'America/New_York';

describe('candleRangeBounds', () => {
  it('fetches a multi-day window for 1d so a weekend evaluation still contains a session', () => {
    // The production 502 came from a literal 24-hour window evaluated on a
    // Sunday: it contained no trading at all, so the provider returned an empty
    // series. The window must be wide enough to reach the last real session.
    const sunday = new Date('2026-07-26T06:30:00.000Z');
    const { period1, period2 } = candleRangeBounds('1d', sunday);
    const spanDays = (period2 - period1) / 86_400;
    expect(spanDays).toBeGreaterThanOrEqual(3);
    // Still inside the 8-day cap Yahoo enforces on 1-minute history.
    expect(spanDays).toBeLessThanOrEqual(8);
    // Friday's regular open (2026-07-24 13:30Z) is inside the window.
    expect(period1).toBeLessThan(Date.parse('2026-07-24T13:30:00.000Z') / 1_000);
  });

  it('canonicalizes 1W and wider requests to at least five years', () => {
    expect(canonicalCandleRange('Week', '6m')).toBe('5y');
    expect(canonicalCandleRange('Month', '3y')).toBe('5y');
    expect(canonicalCandleRange('1D', '6m')).toBe('6m');
    expect(rangeMeetsMinimumLookback('Week', '3y')).toBe(false);
    expect(rangeMeetsMinimumLookback('Week', '5y')).toBe(true);
  });

  it('widens explicit higher-timeframe bounds without moving the end instant', () => {
    const period2 = Date.parse('2026-07-28T00:00:00.000Z') / 1_000;
    const oneYear = Date.parse('2025-07-28T00:00:00.000Z') / 1_000;
    expect(canonicalCandleBounds('Week', { period1: oneYear, period2 })).toEqual({
      period1: Date.parse('2021-07-28T00:00:00.000Z') / 1_000,
      period2,
    });
  });

  it('leaves every other range on its calendar definition', () => {
    const now = new Date('2026-07-26T00:00:00.000Z');
    expect(candleRangeBounds('5d', now).period1).toBe(Date.parse('2026-07-21T00:00:00.000Z') / 1_000);
    expect(candleRangeBounds('1y', now).period1).toBe(Date.parse('2025-07-26T00:00:00.000Z') / 1_000);
    expect(candleRangeBounds('5y', now).period1).toBe(Date.parse('2021-07-26T00:00:00.000Z') / 1_000);
  });
});

describe('latestTradingDayCandles', () => {
  it('keeps only the newest exchange-local trading date', () => {
    // Thursday and Friday minute bars; only Friday's belong to "1 day back".
    const thursday = Date.parse('2026-07-23T14:00:00.000Z') / 1_000;
    const friday = Date.parse('2026-07-24T14:00:00.000Z') / 1_000;
    const kept = latestTradingDayCandles(
      [bar(thursday), bar(thursday + 60), bar(friday), bar(friday + 60)],
      NY,
    );
    expect(kept.map((candle) => candle.timestamp)).toEqual([friday, friday + 60]);
  });

  it('never splits a session at a UTC midnight inside it', () => {
    // 2026-07-24 23:00 America/New_York is 2026-07-25 03:00Z: same exchange day
    // as 20:00Z, so an after-hours tail stays with its own session.
    const afternoon = Date.parse('2026-07-24T20:00:00.000Z') / 1_000;
    const lateEvening = Date.parse('2026-07-25T03:00:00.000Z') / 1_000;
    const kept = latestTradingDayCandles([bar(afternoon), bar(lateEvening)], NY);
    expect(kept).toHaveLength(2);
  });

  it('returns a contiguous tail and never invents or reorders a bar', () => {
    const friday = Date.parse('2026-07-24T14:00:00.000Z') / 1_000;
    const input = [bar(friday - 86_400), bar(friday), bar(friday + 60), bar(friday + 120)];
    const kept = latestTradingDayCandles(input, NY);
    expect(kept).toEqual(input.slice(1));
    expect(kept.every((candle, index) => index === 0 || candle.timestamp > kept[index - 1].timestamp)).toBe(true);
  });

  it('leaves an empty series empty rather than fabricating a session', () => {
    expect(latestTradingDayCandles([], NY)).toEqual([]);
  });
});
