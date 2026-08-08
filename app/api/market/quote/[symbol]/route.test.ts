import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The quote route is public. Polygon entitlement failures are upstream 403s,
 * never Nexora auth/middleware decisions; the resilient service is responsible
 * for converting that typed failure into a cited Yahoo fallback quote.
 */
const mocks = vi.hoisted(() => ({
  loadResilientQuote: vi.fn(),
  loadContinuousQuote: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/market-data/quote-service', () => ({
  loadResilientQuote: mocks.loadResilientQuote,
}));
vi.mock('@/src/lib/stock-detail/continuous-snapshot', () => ({
  loadContinuousQuote: mocks.loadContinuousQuote,
}));

import { GET } from './route';

function request(symbol = 'RKLB', headers?: Record<string, string>) {
  return GET(
    new Request(`https://example.test/api/market/quote/${symbol}`, { headers }) as unknown as NextRequest,
    { params: Promise.resolve({ symbol }) },
  );
}

function result(options: { yahoo?: boolean } = {}) {
  const yahoo = Boolean(options.yahoo);
  return {
    data: {
      symbol: 'RKLB',
      currency: 'USD',
      price: 24.5,
      open: yahoo ? null : 24,
      high: yahoo ? null : 25,
      low: yahoo ? null : 23.8,
      previousClose: 24,
      previousRegularClose: 24,
      change: 0.5,
      changePercent: 2.0833,
      volume: yahoo ? null : 1_000_000,
      latestTradingDay: '2026-07-24',
      quoteTimestamp: '2026-07-24T20:00:00.000Z',
      session: 'closed',
      priceSource: yahoo ? 'yahoo-chart-meta.regularMarketPrice' : 'polygon.quote',
      previousCloseSource: yahoo
        ? 'yahoo-chart-meta.previousClose' : 'polygon.previousClose',
    },
    provider: yahoo ? 'yahoo-finance-chart' : 'polygon',
    freshness: {
      status: yahoo ? 'end-of-day' : 'delayed',
      asOf: '2026-07-24T20:00:00.000Z',
      maxAgeSeconds: yahoo ? 86_400 : 60,
    },
    diagnostics: {
      symbol: 'RKLB',
      routeStatus: 200,
      provider: yahoo ? 'yahoo-finance-chart' : 'polygon',
      providerStatus: yahoo ? 403 : 200,
      failureKind: yahoo ? 'upstream-entitlement' : 'none',
    },
  };
}

describe('GET /api/market/quote/[symbol]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('serves a same-origin request with no auth guard', async () => {
    mocks.loadResilientQuote.mockResolvedValue(result());
    const response = await request('RKLB');
    expect(response.status).toBe(200);
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
    const body = await response.json();
    expect(body.data).toMatchObject({
      symbol: 'RKLB',
      price: 24.5,
      previousRegularClose: 24,
      change: 0.5,
    });
  });

  it('returns Yahoo daily change after the upstream entitlement 403', async () => {
    mocks.loadResilientQuote.mockResolvedValue(result({ yahoo: true }));
    const response = await request('RKLB');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      price: 24.5,
      previousRegularClose: 24,
      change: 0.5,
      previousCloseSource: 'yahoo-chart-meta.previousClose',
    });
    expect(response.headers.get('X-Market-Data-Provenance')).toBe('yahoo-finance-chart');
    expect(response.headers.get('X-Market-Quote-Provider')).toBe('yahoo-finance-chart');
    expect(response.headers.get('X-Market-Provider-Status')).toBe('403');
    expect(response.headers.get('X-Market-Failure-Kind')).toBe('upstream-entitlement');
  });

  it('canonicalizes BTC-USD and routes it directly to the Yahoo crypto source', async () => {
    mocks.loadContinuousQuote.mockResolvedValue({
      data: {
        symbol: 'BTC-USD', currency: 'USD', price: 118_250, open: 117_000,
        high: 119_000, low: 116_500, previousClose: 117_500,
        previousRegularClose: 117_500, regularClose: 118_250,
        change: 750, changePercent: 0.6383, volume: 10,
        latestTradingDay: '2026-08-09', quoteTimestamp: '2026-08-09T03:00:00.000Z',
        session: 'regular', priceSource: 'yahoo-chart-meta.regularMarketPrice',
      },
      provider: 'yahoo-finance-chart',
      freshness: { status: 'delayed', asOf: '2026-08-09T03:00:00.000Z', maxAgeSeconds: 60 },
    });

    const response = await request('btc-usd');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ symbol: 'BTC-USD', price: 118_250 });
    expect(mocks.loadContinuousQuote).toHaveBeenCalledWith('BTC-USD');
    expect(mocks.loadResilientQuote).not.toHaveBeenCalled();
    expect(response.headers.get('X-Market-Quote-Provider')).toBe('yahoo-finance-chart');
  });

  it('rejects an invalid symbol at the schema before calling providers', async () => {
    const response = await request('not a symbol!!');
    expect(response.status).toBe(400);
    expect(mocks.loadResilientQuote).not.toHaveBeenCalled();
  });
});
