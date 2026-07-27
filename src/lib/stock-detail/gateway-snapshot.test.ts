import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketDataError } from '@/src/lib/market-data/errors';
import type {
  NormalizedBarsResult,
  NormalizedMarketSession,
  NormalizedQuote,
  ResolvedInstrument,
} from '@/src/lib/market-data/gateway/contracts';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  resolveInstrument: vi.fn(),
  getQuote: vi.fn(),
  getSession: vi.fn(),
  getBars: vi.fn(),
  getCompanyProfile: vi.fn(),
  getYahooQuote: vi.fn(),
  getExtendedQuote: vi.fn(),
}));

vi.mock('@/src/lib/market-data/gateway/service', () => ({
  getMarketDataGateway: () => ({
    resolveInstrument: mocks.resolveInstrument,
    getQuote: mocks.getQuote,
    getSession: mocks.getSession,
    getBars: mocks.getBars,
  }),
}));

vi.mock('@/src/lib/market-data', () => ({
  getCompanyProfileService: () => ({ getCompanyProfile: mocks.getCompanyProfile }),
}));

vi.mock('@/src/lib/market-data/candles', () => ({
  getYahooChartProvider: () => ({
    getQuote: mocks.getYahooQuote,
    getExtendedQuote: mocks.getExtendedQuote,
  }),
}));

import { loadStockDetailGatewaySnapshot } from './gateway-snapshot';

const instrument: ResolvedInstrument = {
  canonicalSymbol: 'AAPL',
  providerSymbol: 'AAPL',
  name: 'Apple Inc.',
  assetType: 'stock',
  exchange: 'NASDAQ',
  mic: 'XNAS',
  currency: 'USD',
  timezone: 'America/New_York',
  active: true,
  supported: true,
  unsupportedReason: null,
};

const quote: NormalizedQuote = {
  symbol: 'AAPL',
  price: 190.5,
  previousClose: 188,
  change: 2.5,
  changePercent: 1.33,
  timestamp: 1_700_000_000,
  provider: 'polygon',
  exchange: 'NASDAQ',
  currency: 'USD',
  status: 'real-time',
  delayedByMinutes: null,
  open: 189,
  high: 191,
  low: 188.2,
  volume: 12_345_678,
};

const session: NormalizedMarketSession = {
  status: 'open',
  exchange: 'NASDAQ',
  timezone: 'America/New_York',
  sessionDate: '2023-11-14',
  nextOpen: null,
  nextClose: 1_700_020_000,
  reason: null,
  stale: false,
  asOf: 1_700_000_000,
  provider: 'polygon',
  source: 'polygon-market-status',
};

const bars: NormalizedBarsResult = {
  symbol: 'AAPL',
  provider: 'polygon',
  interval: '5m',
  range: '1d',
  adjusted: false,
  session: 'regular',
  currency: 'USD',
  timezone: 'America/New_York',
  dataStatus: 'delayed',
  delayedByMinutes: 15,
  asOf: 1_700_000_000,
  firstTimestamp: 1_699_990_000,
  lastTimestamp: 1_700_000_000,
  warnings: [],
  bars: [
    { time: 1_699_990_000, open: 187, high: 188, low: 186.5, close: 187.5, volume: 1_000, partial: false },
    { time: 1_700_000_000, open: 187.5, high: 189, low: 187, close: 188.9, volume: 2_000, partial: false },
  ],
};

const profileResult = {
  data: null,
  freshness: { status: 'unavailable' as const, asOf: null, maxAgeSeconds: null },
  provider: null,
  fallbackUsed: false,
  retryAfterSeconds: 0,
  reasonCode: null,
};

function reset() {
  mocks.resolveInstrument.mockReset().mockResolvedValue(instrument);
  mocks.getSession.mockReset().mockResolvedValue(session);
  mocks.getBars.mockReset();
  mocks.getQuote.mockReset();
  mocks.getCompanyProfile.mockReset().mockResolvedValue(profileResult);
  mocks.getYahooQuote.mockReset();
  mocks.getExtendedQuote.mockReset().mockResolvedValue(null);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(quote.timestamp * 1_000 + 1_000));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadStockDetailGatewaySnapshot quote/chart capability separation', () => {
  it('serves the quote header even when the intraday chart provider fails', async () => {
    reset();
    mocks.getQuote.mockResolvedValue(quote);
    mocks.getBars.mockRejectedValue(new MarketDataError('provider-unavailable', 'chart down'));

    const snapshot = await loadStockDetailGatewaySnapshot('AAPL');

    expect(snapshot.quote.data?.price).toBe(190.5);
    expect(snapshot.quote.error).toBeNull();
    expect(snapshot.quote.fallbackLabel).toBeNull();
    // The quote path never touches getBars when the primary quote succeeds.
    expect(mocks.getBars).not.toHaveBeenCalled();
  });

  it('falls back to the latest verified bar only when the primary quote is unavailable', async () => {
    reset();
    mocks.getQuote.mockRejectedValue(new MarketDataError('provider-unavailable', 'quote down'));
    mocks.getBars.mockResolvedValue(bars);

    const snapshot = await loadStockDetailGatewaySnapshot('AAPL');

    expect(snapshot.quote.data?.price).toBe(188.9);
    expect(snapshot.quote.data?.previousClose).toBeNull();
    expect(snapshot.quote.data?.change).toBeNull();
    expect(snapshot.quote.fallbackLabel).toBe('Intraday close fallback');
  });

  it('reports the quote as unavailable without throwing when both quote and bars fail', async () => {
    reset();
    mocks.getQuote.mockRejectedValue(new MarketDataError('provider-unavailable', 'quote down'));
    mocks.getBars.mockRejectedValue(new MarketDataError('provider-unavailable', 'chart down'));

    const snapshot = await loadStockDetailGatewaySnapshot('AAPL');

    expect(snapshot.quote.data).toBeNull();
    expect(snapshot.quote.error?.code).toBe('provider-unavailable');
  });
});
