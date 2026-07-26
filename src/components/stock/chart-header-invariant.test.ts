/**
 * Header ↔ chart invariant.
 *
 * During a REGULAR session the accepted market event must appear identically in
 * three places:
 *
 *   acceptedPrice  ===  the header's USD source price  ===  the current candle close
 *
 * under one rounding policy. This is a *data* invariant, not a rendering detail:
 * the three consumers read one accepted event through
 * `candidateFromUpdate → resolveAcceptedPrice → buildAcceptedResource` and the
 * same accepted candle through `mergeLiveCandleIntoBars`. A regression that lets
 * one of them derive its own value (an older snapshot, a re-rounded price, a
 * separately-polled candle) breaks a test here rather than shipping a header that
 * silently disagrees with the chart.
 */

import { describe, expect, it } from 'vitest';
import {
  buildAcceptedResource,
  candidateFromUpdate,
  resolveAcceptedPrice,
  type LiveCandle,
  type MarketUpdate,
} from '@/src/lib/stock-detail/market-source';
import { mergeLiveCandleIntoBars } from './live-candle-bridge';

/** The header's display rounding: 2–4 fraction digits, en-US. */
const headerFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const BUCKET = Math.floor(Date.UTC(2026, 6, 24, 17, 0) / 1_000);
const EXCHANGE_TIME = new Date(BUCKET * 1_000).toISOString();

function liveUpdate(price: number, candle: LiveCandle): MarketUpdate {
  return {
    symbol: 'AAPL',
    price,
    quote: {
      symbol: 'AAPL',
      currency: 'USD',
      price,
      open: 200,
      high: 214,
      low: 199,
      previousClose: 200,
      previousRegularClose: 200,
      change: null,
      changePercent: null,
      volume: 1_000,
      latestTradingDay: '2026-07-24',
    },
    candle,
    label: {
      mode: 'REAL-TIME',
      provider: 'finnhub',
      source: 'aggregate-fallback',
      exchangeTimestamp: EXCHANGE_TIME,
      receivedAt: EXCHANGE_TIME,
      delayAgeSeconds: 0,
      fallbackNote: null,
      realtime: true,
      feed: 'finnhub',
    },
    error: null,
    eventKind: 'trade',
  };
}

const history = [
  { date: new Date((BUCKET - 600) * 1_000).toISOString(), open: 205, high: 206, low: 204, close: 205.5, volume: 400 },
  { date: new Date((BUCKET - 300) * 1_000).toISOString(), open: 205.5, high: 207, low: 205, close: 206.25, volume: 300 },
  { date: new Date(BUCKET * 1_000).toISOString(), open: 206.25, high: 206.4, low: 206.1, close: 206.3, volume: 120, partial: true },
];

describe('accepted price = header price = current candle close', () => {
  it('holds for a same-bucket live tick', () => {
    const candle: LiveCandle = { time: BUCKET, open: 206.25, high: 207.85, low: 206.1, close: 207.42, volume: 190 };
    const update = liveUpdate(207.42, candle);

    const accepted = resolveAcceptedPrice([candidateFromUpdate(update)]);
    const resource = buildAcceptedResource({
      accepted: accepted!,
      snapshotResource: null,
      baseQuote: update.quote,
      symbol: 'AAPL',
    });
    const merged = mergeLiveCandleIntoBars(history, candle);
    const currentCandle = merged.at(-1)!;

    expect(accepted!.price).toBe(207.42);
    expect(resource.data!.price).toBe(accepted!.price);
    expect(currentCandle.close).toBe(accepted!.price);
    // Same displayed string under the header's rounding policy.
    expect(headerFormatter.format(resource.data!.price)).toBe(headerFormatter.format(currentCandle.close));
    // The candle is updated in place — no duplicate bucket, no new timestamp.
    expect(merged).toHaveLength(history.length);
    expect(currentCandle.date).toBe(history[2].date);
    // One accepted event, one exchange timestamp, shared by both consumers.
    expect(resource.freshness.asOf).toBe(EXCHANGE_TIME);
    expect(accepted!.exchangeTimestamp).toBe(EXCHANGE_TIME);
  });

  it('holds across a bucket rollover, appending exactly one bar', () => {
    const rollover: LiveCandle = { time: BUCKET + 300, open: 207.42, high: 208.1, low: 207.4, close: 208.05, volume: 55 };
    const update = liveUpdate(208.05, rollover);

    const accepted = resolveAcceptedPrice([candidateFromUpdate(update)])!;
    const resource = buildAcceptedResource({
      accepted, snapshotResource: null, baseQuote: update.quote, symbol: 'AAPL',
    });
    const merged = mergeLiveCandleIntoBars(history, rollover);

    expect(merged).toHaveLength(history.length + 1);
    expect(merged.slice(0, history.length)).toEqual(history);
    expect(merged.at(-1)!.close).toBe(resource.data!.price);
    expect(merged.at(-1)!.close).toBe(accepted.price);
    // Strictly ascending timestamps with no duplicate bucket.
    const times = merged.map((bar) => Date.parse(bar.date));
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(new Set(times).size).toBe(times.length);
  });

  it('never lets a stale event move the header or the candle', () => {
    const stale: LiveCandle = { time: BUCKET - 600, open: 205, high: 205.2, low: 204.9, close: 205.1, volume: 10 };
    const fresh = candidateFromUpdate(liveUpdate(207.42, {
      time: BUCKET, open: 206.25, high: 207.85, low: 206.1, close: 207.42, volume: 190,
    }))!;
    const older = {
      ...candidateFromUpdate(liveUpdate(205.1, stale))!,
      exchangeTimestamp: new Date((BUCKET - 600) * 1_000).toISOString(),
    };

    // The newest verified exchange timestamp wins for the header…
    expect(resolveAcceptedPrice([fresh, older])!.price).toBe(207.42);
    // …and the stale bucket is ignored by the chart by reference identity.
    expect(mergeLiveCandleIntoBars(history, stale)).toBe(history);
  });

  it('keeps a history-only selection on the newest COMPLETED bar, never the forming one', () => {
    // The forming bucket is excluded from the header's history fallback, so a
    // half-formed bar can never be presented as a completed close.
    const candle: LiveCandle = { time: BUCKET, open: 206.25, high: 207.85, low: 206.1, close: 207.42, volume: 190 };
    const merged = mergeLiveCandleIntoBars(history, candle);
    const newestCompleted = merged.filter((bar) => bar.partial !== true).at(-1)!;
    expect(newestCompleted.close).toBe(206.25);
    expect(merged.at(-1)!.partial).toBe(true);
  });
});
