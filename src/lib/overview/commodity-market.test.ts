import { describe, expect, it } from 'vitest';
import { MarketDataError } from '@/src/lib/market-data/errors';
import { commodityContract } from '@/src/lib/market-data/commodities';
import type { NormalizedCandleResult } from '@/src/lib/market-data/candles';
import type { ProviderResult, Quote } from '@/src/lib/market-data/types';
import { loadCommodityMarketPrice } from './commodity-market';
import type { InstrumentMetadata } from './types';

const contract = commodityContract('GC-F')!;

const instrument: InstrumentMetadata = {
  symbol: 'GC-F',
  companyName: 'ทองคำ · COMEX (ดอลลาร์ต่อทรอยออนซ์)',
  exchange: 'COMEX',
  assetType: 'commodity',
  currency: 'USD',
  sector: null,
  industry: null,
  websiteDomain: null,
  logoUrl: null,
  metadataSource: 'overview',
  updatedAt: null,
};

const quote = (
  status: ProviderResult<Quote>['freshness']['status'] = 'realtime',
): ProviderResult<Quote> => ({
  provider: 'yahoo-finance-chart',
  freshness: { status, asOf: '2026-08-17T15:00:00.000Z', maxAgeSeconds: 60 },
  data: {
    symbol: 'GC-F',
    currency: 'USD',
    price: 3_412.5,
    open: 3_400,
    high: 3_420,
    low: 3_395,
    previousClose: 3_390,
    regularClose: 3_412.5,
    previousRegularClose: 3_390,
    change: 22.5,
    changePercent: 0.663717,
    volume: 120_000,
    latestTradingDay: '2026-08-17',
    quoteTimestamp: '2026-08-17T15:00:00.000Z',
    session: 'regular',
    priceSource: 'yahoo-chart-meta.regularMarketPrice',
  },
});

const candles = (): ProviderResult<NormalizedCandleResult> => ({
  provider: 'yahoo-finance-chart',
  freshness: { status: 'realtime', asOf: '2026-08-17T14:55:00.000Z', maxAgeSeconds: 60 },
  data: {
    symbol: 'GC-F',
    provider: 'yahoo-finance-chart',
    attemptedProviders: ['yahoo-finance-chart'],
    requestedInterval: '5m',
    actualInterval: '5m',
    sourceInterval: '5m',
    requestedRange: '1d',
    actualStart: 1_786_000_000,
    actualEnd: 1_786_000_600,
    exchangeTimezone: 'America/Chicago',
    currency: 'USD',
    dataStatus: 'live',
    delayedByMinutes: 0,
    adjusted: false,
    aggregated: false,
    cacheStatus: 'miss',
    candles: [
      { timestamp: 1_786_000_000, open: 3_400, high: 3_405, low: 3_398, close: 3_402, volume: 100 },
      { timestamp: 1_786_000_600, open: 3_402, high: 3_415, low: 3_401, close: 3_412.5, volume: 120 },
    ],
    warnings: [],
    fallbackReason: null,
  },
});

/** Monday 10:00 CT — Globex trading. */
const OPEN_AT = new Date('2026-08-17T15:00:00.000Z');
/** Saturday — the weekend the 24/7 model does not have. */
const WEEKEND_AT = new Date('2026-08-22T18:00:00.000Z');
/** Monday 16:30 CT — the daily maintenance halt. */
const HALT_AT = new Date('2026-08-17T21:30:00.000Z');

describe('commodity Overview adapter', () => {
  it('reports a trading contract as a live regular session', async () => {
    const result = await loadCommodityMarketPrice({
      instrument,
      contract,
      now: OPEN_AT,
      quote: Promise.resolve(quote()),
      candles: Promise.resolve(candles()),
    });
    expect(result).toMatchObject({
      symbol: 'GC-F',
      price: 3_412.5,
      currency: 'USD',
      session: 'REGULAR',
      sessionLabel: 'ตลาดเปิด',
      status: 'live',
      extended: null,
    });
    expect(result.change).toBeCloseTo(22.5);
    expect(result.sparkline).toEqual([3_402, 3_412.5]);
  });

  /**
   * The reason the session is resolved here rather than inherited: with the
   * venue shut, the last print IS a settlement, and saying "ราคาปิดทางการ" is
   * both true and more useful than letting a perfectly good number decay through
   * "ล่าช้า" into "บันทึกไว้" as though a live market had gone quiet.
   */
  it('reports the last print as an official close once Globex shuts', async () => {
    const result = await loadCommodityMarketPrice({
      instrument,
      contract,
      now: WEEKEND_AT,
      quote: Promise.resolve(quote()),
      candles: Promise.resolve(candles()),
    });
    expect(result).toMatchObject({
      session: 'CLOSED',
      sessionLabel: 'ตลาดปิด',
      status: 'closed',
      price: 3_412.5,
    });
  });

  it('treats the daily maintenance halt as closed too', async () => {
    const result = await loadCommodityMarketPrice({
      instrument,
      contract,
      now: HALT_AT,
      quote: Promise.resolve(quote()),
      candles: Promise.resolve(candles()),
    });
    expect(result.session).toBe('CLOSED');
    expect(result.status).toBe('closed');
  });

  it('never claims a 24-hour market', async () => {
    for (const now of [OPEN_AT, WEEKEND_AT, HALT_AT]) {
      const result = await loadCommodityMarketPrice({
        instrument, contract, now,
        quote: Promise.resolve(quote()),
        candles: Promise.resolve(candles()),
      });
      expect(result.session).not.toBe('CONTINUOUS');
      expect(result.sessionLabel).not.toContain('24');
    }
  });

  it('falls back to the latest candle when the snapshot fails', async () => {
    const result = await loadCommodityMarketPrice({
      instrument,
      contract,
      now: OPEN_AT,
      quote: Promise.reject(new MarketDataError('provider-unavailable', 'quote down')),
      candles: Promise.resolve(candles()),
    });
    expect(result.price).toBe(3_412.5);
    expect(result.status).not.toBe('unavailable');
  });

  it('degrades gracefully, and states the session, when the provider has nothing', async () => {
    const result = await loadCommodityMarketPrice({
      instrument,
      contract,
      now: WEEKEND_AT,
      quote: Promise.reject(new MarketDataError('provider-unavailable', 'quote down')),
      candles: Promise.reject(new MarketDataError('provider-unavailable', 'candles down')),
    });
    expect(result).toMatchObject({
      price: null,
      change: null,
      changePercent: null,
      status: 'unavailable',
      session: 'CLOSED',
      sessionLabel: 'ตลาดปิด',
    });
    expect(result.unavailableReason).toBeTruthy();
    expect(result.sparkline).toEqual([]);
  });
});
