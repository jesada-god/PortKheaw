import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { InstrumentMetadata } from './types';
import {
  calculateBatchMarketBreadth,
  loadAlpacaBreadthSnapshots,
  type AlpacaStockSnapshot,
} from './market-breadth';

function metadata(symbol: string): InstrumentMetadata {
  return {
    symbol,
    companyName: symbol,
    exchange: 'NASDAQ',
    assetType: 'Stock',
    currency: 'USD',
    sector: null,
    industry: null,
    websiteDomain: null,
    logoUrl: null,
    metadataSource: 'test',
    updatedAt: null,
  };
}

function snapshot(
  close: number,
  previousClose: number,
  date = '2026-07-31',
): AlpacaStockSnapshot {
  return {
    dailyBar: { c: close, t: `${date}T20:00:00Z` },
    prevDailyBar: { c: previousClose, t: '2026-07-30T20:00:00Z' },
  };
}

describe('batch market breadth', () => {
  it('counts only one canonical regular trading date and reports partial failures', () => {
    const universe = ['UP', 'DOWN', 'FLAT', 'OLD', 'FAILED'].map(metadata);
    const snapshots = new Map<string, AlpacaStockSnapshot>([
      ['UP', snapshot(11, 10)],
      ['DOWN', snapshot(9, 10)],
      ['FLAT', snapshot(10, 10)],
      ['OLD', snapshot(99, 10, '2026-07-30')],
    ]);
    const breadth = calculateBatchMarketBreadth({
      universe,
      snapshots,
      failedSymbols: new Set(['FAILED']),
      expectedTradingDate: '2026-07-31',
      evaluatedAt: '2026-08-01T00:00:00.000Z',
      durationMs: 123,
    });
    expect(breadth).toMatchObject({
      advancing: 1,
      declining: 1,
      unchanged: 1,
      validCount: 3,
      universeCount: 5,
      returnedCount: 4,
      staleCount: 1,
      failedCount: 1,
      session: 'regular',
      status: 'partial',
    });
    expect(breadth.advancing + breadth.declining + breadth.unchanged).toBe(breadth.validCount);
  });

  it('loads 1,000 symbols through bounded batch requests instead of per-symbol SSR calls', async () => {
    const symbols = Array.from({ length: 1_000 }, (_, index) => `S${index}`);
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      active += 1;
      peak = Math.max(peak, active);
      const url = new URL(String(input));
      const requested = url.searchParams.get('symbols')!.split(',');
      await Promise.resolve();
      active -= 1;
      return new Response(JSON.stringify(Object.fromEntries(
        requested.map((symbol) => [symbol, snapshot(11, 10)]),
      )), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await loadAlpacaBreadthSnapshots(symbols, {
      keyId: 'key',
      secretKey: 'secret',
      fetchImpl,
      batchSize: 200,
      concurrency: 3,
      maxAttempts: 1,
    });
    expect(result.snapshots.size).toBe(1_000);
    expect(result.failedSymbols.size).toBe(0);
    expect(result.requestCount).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
