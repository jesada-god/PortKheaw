import { describe, expect, it } from 'vitest';
import type { NormalizedTrade } from '@/src/lib/market-data/realtime';
import { MarketCandleEngine } from './candle-engine';

const T0 = Date.UTC(2026, 6, 24, 14, 0);
function trade(id: string, timestampMs: number, price: number, size: number): NormalizedTrade {
  return {
    kind: 'trade', symbol: 'NVDA', price, size, timestampMs,
    provider: 'finnhub', tradeId: id, session: 'regular',
  };
}

describe('MarketCandleEngine', () => {
  it('builds deterministic 1m OHLCV and never doubles reconnect duplicates', () => {
    const engine = new MarketCandleEngine();
    engine.ingest(trade('a', T0 + 1_000, 100, 2));
    engine.ingest(trade('b', T0 + 2_000, 102, 3));
    const third = engine.ingest(trade('c', T0 + 3_000, 99, 4));
    expect(third.bars.at(-1)).toMatchObject({
      open: 100, high: 102, low: 99, close: 99, volume: 9, finalized: false,
    });
    expect(engine.ingest(trade('c', T0 + 3_000, 99, 4))).toMatchObject({
      accepted: false, droppedDuplicate: true, rejectionReason: 'duplicate', bars: [],
    });
    expect(engine.statsFor('NVDA')).toEqual({
      receivedTrades: 4, acceptedTrades: 3, duplicateDropped: 1, outOfOrderDropped: 0,
      staleDropped: 0, invalidDropped: 0,
    });
  });

  it('finalizes the prior minute once and opens the rollover bucket', () => {
    const engine = new MarketCandleEngine();
    engine.ingest(trade('a', T0 + 10_000, 100, 2));
    const rollover = engine.ingest(trade('b', T0 + 60_000, 101, 5));
    expect(rollover.bars).toHaveLength(2);
    expect(rollover.bars[0]).toMatchObject({ close: 100, volume: 2, finalized: true });
    expect(rollover.bars[1]).toMatchObject({ open: 101, close: 101, volume: 5, finalized: false });
  });

  it('accepts a late current-minute trade without regressing the canonical close', () => {
    const engine = new MarketCandleEngine();
    engine.ingest(trade('newer', T0 + 20_000, 101, 2));
    const late = engine.ingest(trade('late', T0 + 10_000, 99, 3));
    expect(late.bars.at(-1)).toMatchObject({ low: 99, close: 101, volume: 5 });
  });

  it('rejects a trade for an already-finalized older minute', () => {
    const engine = new MarketCandleEngine();
    engine.ingest(trade('a', T0 + 10_000, 100, 2));
    engine.ingest(trade('b', T0 + 60_000, 101, 2));
    expect(engine.ingest(trade('late', T0 + 20_000, 98, 10))).toMatchObject({
      accepted: false, droppedOutOfOrder: true, rejectionReason: 'out-of-order',
    });
    expect(engine.statsFor('nvda')).toEqual({
      receivedTrades: 3, acceptedTrades: 2, duplicateDropped: 0, outOfOrderDropped: 1,
      staleDropped: 0, invalidDropped: 0,
    });
  });

  it('counts each pre-normalization rejection exactly once with a deterministic reason', () => {
    const engine = new MarketCandleEngine();
    engine.recordRejected('NVDA', 'invalid');
    engine.recordRejected('NVDA', 'stale');
    engine.ingest(trade('accepted', T0 + 1_000, 100, 1));
    expect(engine.statsFor('NVDA')).toEqual({
      receivedTrades: 3, acceptedTrades: 1, duplicateDropped: 0, outOfOrderDropped: 0,
      staleDropped: 1, invalidDropped: 1,
    });
  });
});
