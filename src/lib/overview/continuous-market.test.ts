import { describe, expect, it } from 'vitest';
import { MarketDataError } from '@/src/lib/market-data/errors';
import type { NormalizedCandleResult } from '@/src/lib/market-data/candles';
import type { ProviderResult, Quote } from '@/src/lib/market-data/types';
import { loadContinuousMarketPrice } from './continuous-market';
import type { InstrumentMetadata } from './types';

const instrument: InstrumentMetadata = {
  symbol: 'BTC-USD',
  companyName: 'Bitcoin',
  exchange: null,
  assetType: 'crypto',
  currency: 'USD',
  sector: null,
  industry: null,
  websiteDomain: null,
  logoUrl: '/market-logos/btc.svg',
  metadataSource: 'overview',
  updatedAt: null,
};

const quote = (status: ProviderResult<Quote>['freshness']['status'] = 'realtime'): ProviderResult<Quote> => ({
  provider: 'yahoo-finance-chart',
  freshness: { status, asOf: '2026-08-01T06:23:00.000Z', maxAgeSeconds: 60 },
  data: {
    symbol: 'BTC-USD',
    currency: 'USD',
    price: 116_000,
    open: 114_000,
    high: 117_000,
    low: 113_000,
    previousClose: 115_000,
    regularClose: 116_000,
    previousRegularClose: 115_000,
    change: 1_000,
    changePercent: 0.869565,
    volume: 10,
    latestTradingDay: '2026-08-01',
    quoteTimestamp: '2026-08-01T06:23:00.000Z',
    session: 'regular',
    priceSource: 'yahoo-chart-meta.regularMarketPrice',
  },
});

const candles = (status: ProviderResult<NormalizedCandleResult>['freshness']['status'] = 'realtime'): ProviderResult<NormalizedCandleResult> => ({
  provider: 'yahoo-finance-chart',
  freshness: { status, asOf: '2026-08-01T06:20:00.000Z', maxAgeSeconds: 60 },
  data: {
    symbol: 'BTC-USD',
    provider: 'yahoo-finance-chart',
    attemptedProviders: ['yahoo-finance-chart'],
    requestedInterval: '5m',
    actualInterval: '5m',
    sourceInterval: '5m',
    requestedRange: '1d',
    actualStart: 1_754_026_800,
    actualEnd: 1_754_027_600,
    exchangeTimezone: 'UTC',
    currency: 'USD',
    dataStatus: status === 'stale' ? 'stale' : 'live',
    delayedByMinutes: 0,
    adjusted: false,
    aggregated: false,
    cacheStatus: status === 'stale' ? 'stale' : 'miss',
    candles: [
      { timestamp: 1_754_026_800, open: 114_000, high: 114_300, low: 113_900, close: 114_200, volume: 1 },
      { timestamp: 1_754_027_600, open: 115_700, high: 116_100, low: 115_600, close: 116_000, volume: 1 },
    ],
    warnings: [],
    fallbackReason: null,
  },
});

describe('continuous-market Overview adapter', () => {
  it('uses canonical Yahoo quote and candles without an exchange', async () => {
    const result = await loadContinuousMarketPrice({
      instrument,
      quote: Promise.resolve(quote()),
      candles: Promise.resolve(candles()),
    });
    expect(result).toMatchObject({
      symbol: 'BTC-USD',
      price: 116_000,
      change: 1_000,
      session: 'CONTINUOUS',
      sessionLabel: 'ซื้อขายตลอด 24 ชม.',
      status: 'live',
      source: 'yahoo-finance-chart · snapshot',
    });
    expect(result.sparkline).toEqual([114_200, 116_000]);
  });

  it('falls back to the latest valid canonical candle when the quote fails', async () => {
    const result = await loadContinuousMarketPrice({
      instrument,
      quote: Promise.reject(new MarketDataError('provider-unavailable', 'quote down')),
      candles: Promise.resolve(candles()),
    });
    expect(result).toMatchObject({
      price: 116_000,
      change: 1_800,
      status: 'delayed',
      source: 'yahoo-finance-chart · aggregate-fallback',
    });
    expect(result.changePercent).toBeCloseTo(1.57618, 4);
  });

  it('marks stale provider data as saved rather than live', async () => {
    const result = await loadContinuousMarketPrice({
      instrument,
      quote: Promise.resolve(quote('stale')),
      candles: Promise.resolve(candles('stale')),
    });
    expect(result.status).toBe('saved');
    expect(result.freshness?.status).toBe('stale');
  });

  it('uses the newer candle for both price and timestamp when the quote is stale', async () => {
    const oldQuote = quote('stale');
    oldQuote.data.price = 115_000;
    oldQuote.data.quoteTimestamp = '2026-08-01T06:10:00.000Z';
    oldQuote.freshness.asOf = oldQuote.data.quoteTimestamp;
    const currentCandles = candles();
    currentCandles.data.candles = [
      { timestamp: Date.parse('2026-08-01T06:15:00.000Z') / 1_000, open: 115_100, high: 115_300, low: 115_000, close: 115_200, volume: 1 },
      { timestamp: Date.parse('2026-08-01T06:20:00.000Z') / 1_000, open: 115_200, high: 116_100, low: 115_100, close: 116_000, volume: 1 },
    ];

    const result = await loadContinuousMarketPrice({
      instrument,
      quote: Promise.resolve(oldQuote),
      candles: Promise.resolve(currentCandles),
    });

    expect(result).toMatchObject({
      price: 116_000,
      asOf: '2026-08-01T06:20:00.000Z',
      source: 'yahoo-finance-chart · aggregate-fallback',
    });
  });

  it('isolates total provider failure as one unavailable card with a reason', async () => {
    const result = await loadContinuousMarketPrice({
      instrument,
      quote: Promise.reject(new MarketDataError('timeout', 'quote timeout')),
      candles: Promise.reject(new MarketDataError('rate-limited', 'candles limited')),
    });
    expect(result).toMatchObject({
      symbol: 'BTC-USD',
      price: null,
      status: 'unavailable',
      sparkline: [],
    });
    expect(result.unavailableReason).toContain('ตอบกลับช้า');
    expect(result.unavailableReason).toContain('จำกัดจำนวนคำขอ');
  });
});
