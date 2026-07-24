import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { MarketDataError } from './errors';
import { loadResilientQuote } from './quote-service';

const instrument = {
  requestedSymbol: 'NVTS',
  canonicalSymbol: 'NVTS',
  providerSymbol: 'NVTS',
  assetClass: 'stock',
  exchange: 'NASDAQ',
  mic: 'XNAS',
  currency: 'USD',
  timezone: 'America/New_York',
  active: true,
  supported: true,
  unsupportedReason: null,
} as const;

function gateway(getQuote: () => Promise<unknown>) {
  return {
    resolveInstrument: vi.fn(async () => instrument),
    getQuote: vi.fn(getQuote),
  };
}

function yahooQuote() {
  return {
    data: {
      symbol: 'NVTS',
      currency: 'USD',
      price: 10.9599,
      open: 11,
      high: 11.2,
      low: 10.8,
      previousClose: 11.136,
      previousRegularClose: 11.136,
      change: -0.1761,
      changePercent: -1.581,
      volume: 1_000_000,
      latestTradingDay: '2026-07-24',
      quoteTimestamp: '2026-07-24T20:00:00.000Z',
      session: 'closed' as const,
      priceSource: 'yahoo-chart-meta.regularMarketPrice',
      previousCloseSource: 'yahoo-chart-meta.previousClose',
    },
    provider: 'yahoo-finance-chart',
    freshness: {
      status: 'end-of-day' as const,
      asOf: '2026-07-24T20:00:00.000Z',
      maxAgeSeconds: 86_400,
    },
  };
}

describe('resilient quote service', () => {
  it('keeps the primary provider and bypasses Yahoo on success', async () => {
    const primary = gateway(async () => ({
      symbol: 'NVTS',
      currency: 'USD',
      price: 11,
      open: 10.9,
      high: 11.1,
      low: 10.8,
      previousClose: 10,
      change: 1,
      changePercent: 10,
      volume: 100,
      timestamp: Date.parse('2026-07-24T19:00:00.000Z') / 1_000,
      provider: 'polygon',
      status: 'delayed',
    }));
    const yahoo = { getQuote: vi.fn(async () => yahooQuote()) };
    const result = await loadResilientQuote('NVTS', primary as never, yahoo);
    expect(result.provider).toBe('polygon');
    expect(result.data).toMatchObject({
      previousRegularClose: 10,
      previousCloseSource: 'polygon.previousClose',
      change: 1,
      changePercent: 10,
    });
    expect(result.diagnostics.failureKind).toBe('none');
    expect(yahoo.getQuote).not.toHaveBeenCalled();
  });

  it('keeps the primary price but rescues a missing comparison close from Yahoo', async () => {
    const primary = gateway(async () => ({
      symbol: 'NVTS',
      currency: 'USD',
      price: 11,
      open: 10.9,
      high: 11.1,
      low: 10.8,
      previousClose: null,
      change: null,
      changePercent: null,
      volume: 100,
      timestamp: Date.parse('2026-07-24T19:00:00.000Z') / 1_000,
      provider: 'polygon',
      status: 'delayed',
    }));
    const yahoo = { getQuote: vi.fn(async () => yahooQuote()) };

    const result = await loadResilientQuote('NVTS', primary as never, yahoo);

    expect(result.provider).toBe('polygon');
    expect(result.data).toMatchObject({
      price: 11,
      priceSource: 'polygon.quote',
      previousRegularClose: 11.136,
      previousCloseSource: 'yahoo-chart-meta.previousClose',
    });
    expect(result.data.change).toBeCloseTo(-0.136);
    expect(result.data.changePercent).toBeCloseTo((-0.136 / 11.136) * 100);
    expect(result.diagnostics).toMatchObject({
      provider: 'polygon+yahoo-finance-chart',
      failureKind: 'comparison-close-rescued',
    });
    expect(yahoo.getQuote).toHaveBeenCalledWith('NVTS', '2026-07-24');
  });

  it('falls back to Yahoo after an upstream entitlement 403 and preserves daily change', async () => {
    const primary = gateway(async () => {
      throw new MarketDataError('forbidden', 'not entitled');
    });
    const yahoo = { getQuote: vi.fn(async () => yahooQuote()) };
    const result = await loadResilientQuote('NVTS', primary as never, yahoo);
    expect(result.provider).toBe('yahoo-finance-chart');
    expect(result.data).toMatchObject({
      price: 10.9599,
      previousRegularClose: 11.136,
      change: -0.1761,
      previousCloseSource: 'yahoo-chart-meta.previousClose',
    });
    expect(result.diagnostics).toMatchObject({
      routeStatus: 200,
      providerStatus: 403,
      failureKind: 'upstream-entitlement',
    });
    expect(yahoo.getQuote).toHaveBeenCalledTimes(1);
  });

  it('does not silently fallback for rate limits, invalid symbols, or auth/config faults', async () => {
    for (const code of ['rate-limited', 'invalid-symbol', 'provider-unauthorized', 'provider-not-configured'] as const) {
      const primary = gateway(async () => {
        throw new MarketDataError(code, code);
      });
      const yahoo = { getQuote: vi.fn(async () => yahooQuote()) };
      await expect(loadResilientQuote('NVTS', primary as never, yahoo)).rejects.toMatchObject({ code });
      expect(yahoo.getQuote).not.toHaveBeenCalled();
    }
  });
});
