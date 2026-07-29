import { describe, expect, it } from 'vitest';
import type { Quote } from '@/src/lib/market-data/types';
import {
  buildAcceptedResource,
  candidateFromUpdate,
  comparisonCloseForAcceptedPrice,
  labelFromAccepted,
  regularComparisonClose,
} from './accepted-quote';
import type { AcceptedPriceCandidate } from './accepted-price';
import type { MarketUpdate } from './types';

// 2026-07-21 is a Tuesday; the base quote belongs to the SAME session as the
// accepted prices below unless a case deliberately says otherwise.
const baseQuote: Quote = {
  symbol: 'AAPL', currency: 'USD', price: 100, open: 99, high: 101, low: 98,
  previousClose: 95, change: 5, changePercent: 5.26, volume: 1_000,
  latestTradingDay: '2026-07-21', quoteTimestamp: '2026-07-21T14:30:00.000Z',
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

  it('does not infer previous close from provider change fields', () => {
    const withoutPreviousClose = {
      ...baseQuote,
      price: 233.66,
      previousClose: null,
      change: -11.19,
      changePercent: -4.5705,
      quoteTimestamp: '2026-07-21T14:45:00.000Z',
    };
    expect(regularComparisonClose(withoutPreviousClose)).toBeNull();
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
      previousClose: null,
      change: null,
      changePercent: null,
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
    // Same session as the base quote: the base quote's previous close IS the
    // comparison base for this price.
    const accepted = history(42.5, '2026-07-21T20:00:00.000Z');
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

  it('states the change as unavailable when the base quote is NEWER than the accepted price', () => {
    // A completed history bar from an earlier session beside a base quote from a
    // later one: that quote's previous close is not the close before this price,
    // and no other real base exists, so the change must be withheld.
    const accepted = history(42.5, '2026-07-20T20:00:00.000Z');
    const resource = buildAcceptedResource({ accepted, snapshotResource: null, baseQuote, symbol: 'AAPL' });
    expect(resource.data?.price).toBe(42.5);
    expect(resource.data?.previousClose).toBeNull();
    expect(resource.data?.change).toBeNull();
    expect(resource.data?.changePercent).toBeNull();
  });

  it('labels a Week/Month history fallback with truthful END-OF-DAY provenance', () => {
    const accepted = history(120.25, '2026-07-21T20:00:00.000Z');
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

  it('compares a live price against the PREVIOUS SESSION close, not the snapshot base', () => {
    // The exact production defect. Polygon's unentitled snapshot is still
    // Friday's end-of-day row (price 63.91, previousClose 69.99 = Thursday), and
    // the entitled stream prints Monday's live trade. Taking the snapshot's
    // previousClose compares Monday's price against THURSDAY's close — a full
    // session out. Friday's close is the only correct base.
    const fridaySnapshot: Quote = {
      symbol: 'RKLB', currency: 'USD', price: 63.91, open: 69.3, high: 69.55, low: 63,
      previousClose: 69.99, regularClose: 63.91, previousRegularClose: 69.99,
      change: -6.08, changePercent: -8.687, volume: 18_959_499,
      latestTradingDay: '2026-07-24', quoteTimestamp: '2026-07-24T20:00:00.000Z',
    };
    const mondayTick: AcceptedPriceCandidate = {
      price: 65.5, source: 'aggregate-fallback', exchangeTimestamp: '2026-07-27T17:22:00.000Z',
      mode: 'REAL-TIME', provider: 'alpaca:iex', realtime: true, feed: 'iex',
    };
    const resource = buildAcceptedResource({
      accepted: mondayTick, snapshotResource: null, baseQuote: fridaySnapshot, symbol: 'RKLB',
    });
    expect(resource.data?.price).toBe(65.5);
    expect(resource.data?.previousClose).toBe(63.91);
    expect(resource.data?.change).toBeCloseTo(1.59, 6);
    expect(resource.data?.changePercent).toBeCloseTo((1.59 / 63.91) * 100, 6);
  });

  it('never reuses a close older than the immediately preceding trading day', () => {
    const staleQuote: Quote = {
      ...baseQuote,
      latestTradingDay: '2026-07-17',
      quoteTimestamp: '2026-07-17T20:00:00.000Z',
    };
    // 2026-07-17 (Fri) is two sessions before 2026-07-21 (Tue), so neither its
    // own close nor its previous close describes Tuesday's price.
    expect(comparisonCloseForAcceptedPrice(staleQuote, '2026-07-21T15:00:00.000Z')).toBeNull();
  });

  it('honours the exchange calendar across a holiday-extended weekend', () => {
    // 2026-07-03 is the observed Independence Day holiday (4 July is a Saturday),
    // so the session before Monday 2026-07-06 is Thursday 2026-07-02.
    const thursday: Quote = {
      ...baseQuote,
      price: 40, regularClose: 40, previousClose: 38,
      latestTradingDay: '2026-07-02', quoteTimestamp: '2026-07-02T20:00:00.000Z',
    };
    expect(comparisonCloseForAcceptedPrice(thursday, '2026-07-06T15:00:00.000Z')).toBe(40);
    // Friday 2026-07-03 did not trade, so nothing may claim it as a base.
    expect(comparisonCloseForAcceptedPrice(
      { ...thursday, latestTradingDay: '2026-07-03', quoteTimestamp: '2026-07-03T20:00:00.000Z' },
      '2026-07-06T15:00:00.000Z',
    )).toBeNull();
  });

  it('reads the trading date from the instant, not a UTC-sliced latestTradingDay', () => {
    // An after-hours print at 20:30 ET is already the next day in UTC, and some
    // providers derive `latestTradingDay` by slicing that UTC timestamp.
    const afterHours: Quote = {
      ...baseQuote,
      price: 101, regularClose: 101,
      latestTradingDay: '2026-07-25',
      quoteTimestamp: '2026-07-25T00:30:00.000Z',
    };
    // The print belongs to Friday 2026-07-24, so it IS the base for Monday.
    expect(comparisonCloseForAcceptedPrice(afterHours, '2026-07-27T15:00:00.000Z')).toBe(101);
  });

  it('is unavailable when either trading date cannot be established', () => {
    const undated: Quote = { ...baseQuote, latestTradingDay: null, quoteTimestamp: null };
    expect(comparisonCloseForAcceptedPrice(undated, '2026-07-21T15:00:00.000Z')).toBeNull();
    expect(comparisonCloseForAcceptedPrice(baseQuote, null)).toBeNull();
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
  function update(
    price: number | null,
    source: MarketUpdate['label']['source'],
    // 15:00Z is 11:00 ET, inside the regular session.
    exchangeTimestamp: string | null = '2026-07-21T15:00:00.000Z',
  ): MarketUpdate {
    return {
      symbol: 'AAPL', price, quote: null, candle: null,
      label: { mode: 'DELAYED', provider: 'polygon', source, exchangeTimestamp, receivedAt: '2026-07-21T15:00:01.000Z', delayAgeSeconds: 1, fallbackNote: null },
      error: null,
    };
  }
  it('maps a priced snapshot/aggregate update to a candidate and ignores empty/history updates', () => {
    expect(candidateFromUpdate(update(12, 'snapshot'))?.source).toBe('snapshot');
    expect(candidateFromUpdate(update(11, 'aggregate-fallback'))?.source).toBe('aggregate-fallback');
    expect(candidateFromUpdate(update(null, 'snapshot'))).toBeNull();
    expect(candidateFromUpdate(update(10, 'history-fallback'))).toBeNull();
  });

  /**
   * Every priced update is filed by the domain its OWN exchange timestamp puts it
   * in. This is the fix for the production defect: Alpaca sends no session on the
   * wire, so the previous code fell through to a `regular` default and filed every
   * after-hours print as a regular price — which then took the main price row.
   */
  it('files a live trade by the session its exchange timestamp falls in', () => {
    // 20:05Z = 16:05 ET, after-hours.
    expect(candidateFromUpdate(
      update(11.05, 'aggregate-fallback', '2026-07-21T20:05:00.000Z'),
    )?.priceRole).toBe('after-hours');
    // 12:25Z = 08:25 ET, pre-market.
    expect(candidateFromUpdate(
      update(11.08, 'aggregate-fallback', '2026-07-21T12:25:00.000Z'),
    )?.priceRole).toBe('pre-market');
    // 15:00Z = 11:00 ET, regular.
    expect(candidateFromUpdate(
      update(11.41, 'aggregate-fallback', '2026-07-21T15:00:00.000Z'),
    )?.priceRole).toBe('regular');
  });

  it('files an unlabelled Alpaca after-hours trade as extended, not regular', () => {
    // The exact production shape: no `session` field at all on the update.
    const candidate = candidateFromUpdate(update(10.42, 'aggregate-fallback', '2026-07-29T20:41:12.000Z'));
    expect(candidate?.priceRole).toBe('after-hours');
    expect(candidate?.priceRole).not.toBe('regular');
  });

  it('lets the timestamp override a declared session that contradicts it', () => {
    // A stream (or a stale request parameter) claiming after-hours for a print
    // executed at 11:00 ET is not evidence; the timestamp is.
    expect(candidateFromUpdate({
      ...update(11.41, 'aggregate-fallback', '2026-07-21T15:00:00.000Z'),
      session: 'after-hours',
    })?.priceRole).toBe('regular');
  });

  /**
   * A REST snapshot is the exception, and only when its `price` demonstrably IS the
   * quote's own `regularClose`: Yahoo's `regularMarketPrice` stays the official close
   * while the provider reports POST, stamped at 16:00:01 ET. Judging that by its
   * timestamp would file the official close as an after-hours print.
   */
  it('keeps a snapshot price that equals its own regularClose in the regular domain', () => {
    const quote = { ...baseQuote, price: 11.41, regularClose: 11.41 };
    expect(candidateFromUpdate({
      ...update(11.41, 'snapshot', '2026-07-21T20:00:01.000Z'),
      quote,
    })?.priceRole).toBe('regular');
  });

  it('files a snapshot price that differs from its regularClose by its timestamp', () => {
    // A genuine extended print carried inside a snapshot response.
    const quote = { ...baseQuote, price: 11.08, regularClose: 11.41 };
    expect(candidateFromUpdate({
      ...update(11.08, 'snapshot', '2026-07-21T20:41:00.000Z'),
      quote,
    })?.priceRole).toBe('after-hours');
  });

  it('drops a print whose domain cannot be established rather than calling it regular', () => {
    // 2026-07-25 is a Saturday: no session, so no domain.
    expect(candidateFromUpdate(update(11.41, 'aggregate-fallback', '2026-07-25T15:00:00.000Z'))).toBeNull();
    // 00:30Z = 20:30 ET, past the after-hours window.
    expect(candidateFromUpdate(update(11.41, 'aggregate-fallback', '2026-07-22T00:30:00.000Z'))).toBeNull();
  });
});
