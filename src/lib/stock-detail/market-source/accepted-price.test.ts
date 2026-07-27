import { describe, expect, it } from 'vitest';
import {
  historyFallbackModeFromStatus,
  resolveAcceptedPrice,
  resolveAcceptedPriceDomains,
  type AcceptedPriceCandidate,
} from './accepted-price';

function snapshot(price: number, ts = '2026-07-21T14:00:00.000Z'): AcceptedPriceCandidate {
  return { price, source: 'snapshot', exchangeTimestamp: ts, mode: 'DELAYED', provider: 'polygon' };
}
function aggregate(price: number, ts = '2026-07-21T15:00:00.000Z'): AcceptedPriceCandidate {
  return { price, source: 'aggregate-fallback', exchangeTimestamp: ts, mode: 'DELAYED', provider: 'polygon' };
}
function history(price: number, ts = '2026-07-20T20:00:00.000Z', mode: AcceptedPriceCandidate['mode'] = 'END-OF-DAY'): AcceptedPriceCandidate {
  return { price, source: 'history-fallback', exchangeTimestamp: ts, mode, provider: 'polygon' };
}

describe('resolveAcceptedPrice — shared accepted-price priority', () => {
  it('prefers an entitled snapshot when candidates share the same exchange timestamp', () => {
    const timestamp = '2026-07-21T15:00:00.000Z';
    const accepted = resolveAcceptedPrice([
      history(10, timestamp),
      aggregate(11, timestamp),
      snapshot(12, timestamp),
    ]);
    expect(accepted?.source).toBe('snapshot');
    expect(accepted?.price).toBe(12);
  });

  it('prefers an accepted live aggregate over a history bar when there is no snapshot', () => {
    const accepted = resolveAcceptedPrice([history(10), aggregate(11), null]);
    expect(accepted?.source).toBe('aggregate-fallback');
    expect(accepted?.price).toBe(11);
  });

  it('falls back to the newest displayed history bar when snapshot and aggregate are absent (daily 403)', () => {
    // Daily/Week/Month with a snapshot 403 and no live aggregate: the header must
    // show the newest displayed history close, not go unavailable.
    const accepted = resolveAcceptedPrice([null, null, history(42.5)]);
    expect(accepted?.source).toBe('history-fallback');
    expect(accepted?.price).toBe(42.5);
    expect(accepted?.mode).toBe('END-OF-DAY');
  });

  it('uses the newest verified event and source rank only as a timestamp tie-breaker', () => {
    const newerHistory = history(99, '2026-07-21T23:59:00.000Z');
    const olderAggregate = aggregate(11, '2026-07-21T15:00:00.000Z');
    expect(resolveAcceptedPrice([newerHistory, olderAggregate, null])?.source).toBe('history-fallback');
    expect(resolveAcceptedPrice([newerHistory, olderAggregate, null])?.price).toBe(99);
    // An older history bar still never replaces a newer snapshot.
    expect(resolveAcceptedPrice([history(1, '1999-01-01T00:00:00.000Z'), null, snapshot(12)])?.price).toBe(12);
  });

  it('keeps the Yahoo latest candle and header accepted price in sync when the snapshot is older', () => {
    const previousCloseSnapshot = snapshot(381.58, '2026-07-23T20:00:00.000Z');
    const latestYahooDaily = history(384.3575, '2026-07-24T13:30:00.000Z', 'DELAYED');
    expect(resolveAcceptedPrice([previousCloseSnapshot, null, latestYahooDaily])).toEqual(latestYahooDaily);
  });

  it('within the same source, the newer exchange timestamp wins (out-of-order guard)', () => {
    const older = aggregate(11, '2026-07-21T15:00:00.000Z');
    const newer = aggregate(12, '2026-07-21T15:05:00.000Z');
    expect(resolveAcceptedPrice([older, newer])?.price).toBe(12);
    expect(resolveAcceptedPrice([newer, older])?.price).toBe(12);
  });

  it('never lets a stale REST/cache snapshot override a fresh WebSocket tick', () => {
    const staleSnapshot = {
      ...snapshot(10, '2026-07-27T14:00:00.000Z'),
      mode: 'STALE' as const,
    };
    const freshWs = {
      ...aggregate(11.475, '2026-07-27T19:22:00.000Z'),
      mode: 'REAL-TIME' as const,
      realtime: true,
      feed: 'iex',
    };
    expect(resolveAcceptedPrice([freshWs, staleSnapshot])).toBe(freshWs);
    expect(resolveAcceptedPrice([staleSnapshot, freshWs])).toBe(freshWs);
  });

  it('keeps AFTER WebSocket trades out of the canonical regular domain', () => {
    const regular = {
      ...snapshot(11.41, '2026-07-27T20:00:01.000Z'),
      priceRole: 'regular' as const,
    };
    const after = {
      ...aggregate(11.05, '2026-07-27T21:08:30.000Z'),
      priceRole: 'after-hours' as const,
      mode: 'REAL-TIME' as const,
      realtime: true,
      feed: 'finnhub',
    };

    const domains = resolveAcceptedPriceDomains([regular, after]);

    expect(domains.regular).toEqual(regular);
    expect(domains.regular?.price).toBe(11.41);
    expect(domains.extended).toEqual(after);
    expect(domains.extended?.price).toBe(11.05);
  });

  it('updates only the extended domain across a sequence of AFTER trades', () => {
    const regular = {
      ...snapshot(11.41, '2026-07-27T20:00:01.000Z'),
      priceRole: 'regular' as const,
    };
    const afterTrades = [11.30, 11.20, 11.08, 11.05].map((price, index) => ({
      ...aggregate(price, `2026-07-27T21:0${index}:00.000Z`),
      priceRole: 'after-hours' as const,
      mode: 'REAL-TIME' as const,
    }));

    const domains = resolveAcceptedPriceDomains([regular, ...afterTrades]);

    expect(domains.regular?.price).toBe(11.41);
    expect(domains.extended?.price).toBe(11.05);
  });

  it('returns null (unavailable) when no candidate carries a finite price', () => {
    expect(resolveAcceptedPrice([null, undefined, null])).toBeNull();
    expect(resolveAcceptedPrice([{ ...snapshot(Number.NaN) }])).toBeNull();
  });

  it('never emits a REAL-TIME mode for a history fallback', () => {
    // Even if the provider tags the series real-time, a displayed history bar is
    // at best delayed and is never labelled REAL-TIME.
    expect(historyFallbackModeFromStatus('real-time')).toBe('DELAYED');
    expect(historyFallbackModeFromStatus('partial')).toBe('DELAYED');
    expect(historyFallbackModeFromStatus('delayed')).toBe('DELAYED');
    expect(historyFallbackModeFromStatus('end-of-day')).toBe('END-OF-DAY');
    expect(historyFallbackModeFromStatus('cached')).toBe('CACHED');
    expect(historyFallbackModeFromStatus('stale')).toBe('STALE');
  });
});
