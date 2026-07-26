import { describe, expect, it } from 'vitest';
import type { MarketDataLabel } from '@/src/lib/stock-detail/market-source';
import { realtimeUpdatePolicy } from './realtime-performance';

const LIVE_LABEL: MarketDataLabel = {
  mode: 'REAL-TIME',
  provider: 'alpaca',
  source: 'aggregate-fallback',
  exchangeTimestamp: '2026-07-25T14:00:00.000Z',
  receivedAt: '2026-07-25T14:00:00.010Z',
  delayAgeSeconds: 0,
  fallbackNote: null,
  realtime: true,
  feed: 'iex',
};

describe('realtimeUpdatePolicy', () => {
  it('commits the first trade so live provenance is rendered', () => {
    expect(realtimeUpdatePolicy(
      { eventKind: 'trade', label: LIVE_LABEL, price: 173.25 },
      false,
    )).toEqual({ transientPrice: true, commitMarketState: true });
  });

  it('keeps subsequent trade ticks off the React state path', () => {
    expect(realtimeUpdatePolicy(
      { eventKind: 'trade', label: LIVE_LABEL, price: 173.26 },
      true,
    )).toEqual({ transientPrice: true, commitMarketState: false });
  });

  it('writes a live snapshot to the imperative price sink and commits its provenance', () => {
    expect(realtimeUpdatePolicy(
      { eventKind: 'snapshot', label: LIVE_LABEL, price: 206.87 },
      false,
    )).toEqual({ transientPrice: true, commitMarketState: true });
  });

  it('commits an official bar so Lightweight Charts can call update()', () => {
    expect(realtimeUpdatePolicy(
      { eventKind: 'bar', label: LIVE_LABEL, price: 173.30, barFinalized: true },
      true,
    )).toEqual({ transientPrice: false, commitMarketState: true });
  });
});
