import { describe, expect, it } from 'vitest';
import type { Quote } from '@/src/lib/market-data/types';
import { buildAcceptedResource, candidateFromUpdate, labelFromAccepted, regularComparisonClose } from './accepted-quote';
import type { AcceptedPriceCandidate } from './accepted-price';
import type { MarketUpdate } from './types';

const baseQuote: Quote = {
  symbol: 'AAPL', currency: 'USD', price: 100, open: 99, high: 101, low: 98,
  previousClose: 95, change: 5, changePercent: 5.26, volume: 1_000, latestTradingDay: '2026-07-20',
};

function history(price: number, ts: string, mode: AcceptedPriceCandidate['mode'] = 'END-OF-DAY'): AcceptedPriceCandidate {
  return { price, source: 'history-fallback', exchangeTimestamp: ts, mode, provider: 'polygon' };
}

describe('buildAcceptedResource — the header and chart price line share one value/timestamp', () => {
  it('preserves the canonical previous regular close through normalization', () => {
    expect(regularComparisonClose({
      ...baseQuote,
      previousClose: null,
      previousRegularClose: 94.75,
      change: null,
      changePercent: null,
    })).toBe(94.75);
  });

  it('recovers a provider-verifiable previous close when Polygon omitted prevDay', () => {
    const withoutPreviousClose = {
      ...baseQuote,
      price: 233.66,
      previousClose: null,
      change: -11.19,
      changePercent: -4.5705,
    };
    expect(regularComparisonClose(withoutPreviousClose)).toBeCloseTo(244.85, 2);
    const accepted: AcceptedPriceCandidate = {
      price: 233.66,
      source: 'aggregate-fallback',
      exchangeTimestamp: '2026-07-21T15:00:00.000Z',
      mode: 'REAL-TIME',
      provider: 'alpaca:iex',
      realtime: true,
    };
    const resource = buildAcceptedResource({
      accepted,
      snapshotResource: null,
      baseQuote: withoutPreviousClose,
      symbol: 'AAPL',
    });
    expect(resource.data).toMatchObject({
      previousClose: expect.closeTo(244.85, 2),
      change: expect.closeTo(-11.19, 2),
      changePercent: expect.closeTo(-4.57, 2),
    });
  });

  it('rejects inconsistent provider change fields instead of guessing a base', () => {
    expect(regularComparisonClose({
      ...baseQuote,
      previousClose: null,
      change: -11.19,
      changePercent: 12,
    })).toBeNull();
  });

  it('exposes exactly the accepted price and exchange timestamp for a history fallback', () => {
    const accepted = history(42.5, '2026-07-20T20:00:00.000Z');
    const resource = buildAcceptedResource({ accepted, snapshotResource: null, baseQuote, symbol: 'AAPL' });
    // The chart's currentPrice reads resource.data.price; the header reads the
    // same resource — they can never diverge onto two market events.
    expect(resource.data?.price).toBe(accepted.price);
    expect(resource.freshness.asOf).toBe(accepted.exchangeTimestamp);
    expect(resource.freshness.status).toBe('end-of-day');
    // Change is recomputed against the known previous close — nothing fabricated.
    expect(resource.data?.change).toBeCloseTo(42.5 - 95);
    expect(resource.data?.previousClose).toBe(95);
  });

  it('labels a Week/Month history fallback with truthful END-OF-DAY provenance', () => {
    const accepted = history(120.25, '2026-07-17T20:00:00.000Z');
    const resource = buildAcceptedResource({ accepted, snapshotResource: null, baseQuote, symbol: 'AAPL' });
    expect(resource.fallbackLabel).toBe('Previous trading day');
    expect(resource.provider).toBe('polygon');
    const label = labelFromAccepted(accepted, '2026-07-21T00:00:00.000Z');
    expect(label.mode).toBe('END-OF-DAY');
    expect(label.source).toBe('history-fallback');
    expect(label.exchangeTimestamp).toBe(accepted.exchangeTimestamp);
    expect(label.mode).not.toBe('REAL-TIME');
  });

  it('does not lose previousClose/change when a WebSocket tick carries only a price', () => {
    // A live WS tick emits a realtime aggregate-fallback candidate with a fresh
    // price and no quote of its own; the base quote (SSR/last snapshot) supplies
    // the previous close. The merge must keep the base's previousClose and
    // recompute the daily change against it — never blank the fields.
    const accepted: AcceptedPriceCandidate = {
      price: 102, source: 'aggregate-fallback', exchangeTimestamp: '2026-07-21T15:00:00.000Z',
      mode: 'REAL-TIME', provider: 'alpaca:iex', realtime: true, feed: 'iex',
    };
    const resource = buildAcceptedResource({ accepted, snapshotResource: null, baseQuote, symbol: 'AAPL' });
    expect(resource.data?.price).toBe(102);
    expect(resource.data?.previousClose).toBe(95);
    // Change reflects the NEW live price against the known previous close.
    expect(resource.data?.change).toBeCloseTo(102 - 95);
    expect(resource.data?.changePercent).toBeCloseTo(((102 - 95) / 95) * 100);
    // A genuine live stream stays truthful (not tagged as a fallback).
    expect(resource.fallbackLabel).toBeNull();
  });

  it('keeps the full verified snapshot quote when the snapshot is the accepted source', () => {
    const snapshotResource = {
      data: baseQuote, freshness: { status: 'delayed' as const, asOf: '2026-07-21T14:00:00.000Z', maxAgeSeconds: 60 },
      provider: 'polygon', reason: null, error: null, fallbackLabel: null,
    };
    const accepted: AcceptedPriceCandidate = { price: 100, source: 'snapshot', exchangeTimestamp: '2026-07-21T14:00:00.000Z', mode: 'DELAYED', provider: 'polygon' };
    const resource = buildAcceptedResource({ accepted, snapshotResource, baseQuote, symbol: 'AAPL' });
    expect(resource).toBe(snapshotResource);
    expect(resource.fallbackLabel).toBeNull();
  });
});

describe('candidateFromUpdate', () => {
  function update(price: number | null, source: MarketUpdate['label']['source']): MarketUpdate {
    return {
      symbol: 'AAPL', price, quote: null, candle: null,
      label: { mode: 'DELAYED', provider: 'polygon', source, exchangeTimestamp: '2026-07-21T15:00:00.000Z', receivedAt: '2026-07-21T15:00:01.000Z', delayAgeSeconds: 1, fallbackNote: null },
      error: null,
    };
  }
  it('maps a priced snapshot/aggregate update to a candidate and ignores empty/history updates', () => {
    expect(candidateFromUpdate(update(12, 'snapshot'))?.source).toBe('snapshot');
    expect(candidateFromUpdate(update(11, 'aggregate-fallback'))?.source).toBe('aggregate-fallback');
    expect(candidateFromUpdate(update(null, 'snapshot'))).toBeNull();
    expect(candidateFromUpdate(update(10, 'history-fallback'))).toBeNull();
  });
});
