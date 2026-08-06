import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getQuote: vi.fn(),
  getMarketDataGateway: vi.fn(),
  getCompanyProfile: vi.fn(),
  getExtendedQuote: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/market-data/candles', () => ({
  getYahooChartProvider: () => ({
    getQuote: mocks.getQuote,
    getExtendedQuote: mocks.getExtendedQuote,
  }),
}));
vi.mock('@/src/lib/market-data/gateway/service', () => ({
  getMarketDataGateway: mocks.getMarketDataGateway,
  marketDataGatewayConfigured: () => true,
}));
vi.mock('@/src/lib/market-data', () => ({
  getCompanyProfileService: () => ({ getCompanyProfile: mocks.getCompanyProfile }),
}));

import { loadStockDetailGatewaySnapshot } from './gateway-snapshot';
import { continuousInstrument, continuousMarketStatus } from './continuous-snapshot';
import { continuousMarketAsset } from '@/src/lib/overview/market-assets';

const asset = continuousMarketAsset('BTC-USD')!;

function yahooQuote() {
  return {
    data: {
      symbol: 'BTC-USD',
      currency: 'USD',
      price: 64_615.9,
      open: null,
      high: null,
      low: null,
      previousClose: 64_000,
      regularClose: 64_615.9,
      previousRegularClose: 64_000,
      change: 615.9,
      changePercent: 0.96,
      volume: null,
      latestTradingDay: '2026-08-05',
      quoteTimestamp: '2026-08-05T21:00:00.000Z',
      session: 'unknown' as const,
    },
    provider: 'yahoo-finance-chart',
    freshness: { status: 'cached' as const, asOf: '2026-08-05T21:00:00.000Z', maxAgeSeconds: 60 },
  };
}

beforeEach(() => {
  mocks.getQuote.mockReset();
  mocks.getMarketDataGateway.mockReset();
  mocks.getMarketDataGateway.mockImplementation(() => {
    throw new Error('the US-equity gateway must not be reached for a continuous asset');
  });
});

describe('continuous market instrument', () => {
  it('is supported, 24/7 and not an equity', () => {
    const instrument = continuousInstrument(asset);
    expect(instrument.canonicalSymbol).toBe('BTC-USD');
    expect(instrument.assetType).toBe('crypto');
    expect(instrument.supported).toBe(true);
    expect(instrument.mic).toBeNull();
    expect(instrument.timezone).toBe('UTC');
  });

  it('reports a market that is open, with no bell to quote', () => {
    const status = continuousMarketStatus('2026-08-05T21:00:00.000Z');
    const market = status.data!.markets[0]!;
    expect(market.currentStatus).toBe('open');
    expect(market.marketType).toBe('Cryptocurrency');
    expect(market.localOpen).toBeNull();
    expect(market.localClose).toBeNull();
    expect(market.notes).toContain('24');
  });
});

describe('loadStockDetailGatewaySnapshot for a continuous asset', () => {
  it('prices Bitcoin from the chart pipeline without the equity resolver', async () => {
    mocks.getQuote.mockResolvedValue(yahooQuote());

    const snapshot = await loadStockDetailGatewaySnapshot('BTC-USD');

    expect(mocks.getMarketDataGateway).not.toHaveBeenCalled();
    expect(snapshot.quote.data?.price).toBe(64_615.9);
    expect(snapshot.quote.data?.session).toBe('regular');
    expect(snapshot.quote.error).toBeNull();
    expect(snapshot.overview.data?.markets[0]?.currentStatus).toBe('open');
    expect(snapshot.profile.data?.name).toBe('Bitcoin');
    expect(snapshot.profile.data?.logoUrl).toBe('/market-logos/btc.svg');
    // A market that never closes has no extended-hours print beside its price.
    expect(snapshot.extendedQuote).toBeNull();
  });

  it('degrades to a retryable failure rather than an invalid-symbol error', async () => {
    mocks.getQuote.mockRejectedValue(new Error('yahoo unavailable'));

    const snapshot = await loadStockDetailGatewaySnapshot('BTC-USD');

    expect(snapshot.quote.data).toBeNull();
    expect(snapshot.quote.error?.retryable).toBe(true);
    expect(snapshot.quote.error?.code).not.toBe('invalid-symbol');
  });
});
