import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';

vi.mock('server-only', () => ({}));

import { loadAnalystConsensus } from './service';

const NOW = Date.parse('2026-07-26T00:00:00.000Z');

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function finnhubPayload() {
  return {
    symbol: 'AAPL',
    targetMean: 150,
    targetMedian: 145,
    targetHigh: 180,
    targetLow: 120,
    numberAnalysts: 30,
    lastUpdated: '2026-07-25',
  };
}

function alphaPayload() {
  return {
    Symbol: 'AAPL',
    Currency: 'USD',
    AnalystTargetPrice: '140',
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loadAnalystConsensus', () => {
  it('uses Finnhub mean as primary and never calls Alpha unnecessarily', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('finnhub.io');
      return response(finnhubPayload());
    });
    const result = await loadAnalystConsensus('aapl', {
      finnhubApiKey: 'finnhub',
      alphaVantageApiKey: 'alpha',
      listingCurrency: 'USD',
      currentPrice: 100,
      currentPriceAsOf: '2026-07-25T20:00:00.000Z',
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
      cache: new SharedRequestCache(),
      retries: 0,
    });
    expect(result).toMatchObject({
      status: 'available',
      symbol: 'AAPL',
      targetPrice: 150,
      medianTarget: 145,
      highTarget: 180,
      lowTarget: 120,
      analystCount: 30,
      currentPrice: 100,
      upsideDownsidePct: 50,
      provider: 'finnhub',
      providerLabel: 'Finnhub',
      stale: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to Alpha after Finnhub is not entitled without averaging providers', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('finnhub.io')
        ? response({}, 403)
        : response(alphaPayload()));
    const result = await loadAnalystConsensus('AAPL', {
      finnhubApiKey: 'finnhub',
      alphaVantageApiKey: 'alpha',
      listingCurrency: 'USD',
      currentPrice: 100,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
      cache: new SharedRequestCache(),
      retries: 0,
    });
    expect(result).toMatchObject({
      status: 'fallback',
      targetPrice: 140,
      medianTarget: null,
      highTarget: null,
      lowTarget: null,
      analystCount: null,
      provider: 'alpha-vantage',
      upsideDownsidePct: 40,
    });
    expect(result.coverage).toEqual([
      expect.objectContaining({ provider: 'finnhub', status: 'not-entitled' }),
      expect.objectContaining({ provider: 'alpha-vantage', status: 'available' }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports both providers truthfully when neither is available', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('finnhub.io')
        ? response({}, 403)
        : response({ Symbol: 'AAPL', AnalystTargetPrice: 'None' }));
    const result = await loadAnalystConsensus('AAPL', {
      finnhubApiKey: 'finnhub',
      alphaVantageApiKey: 'alpha',
      listingCurrency: 'USD',
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
      cache: new SharedRequestCache(),
      retries: 0,
    });
    expect(result.status).toBe('not-entitled');
    expect(result.targetPrice).toBeNull();
    expect(result.coverage).toEqual([
      expect.objectContaining({ provider: 'finnhub', status: 'not-entitled' }),
      expect.objectContaining({ provider: 'alpha-vantage', status: 'unavailable' }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Morgan Stanley|Goldman Sachs|JPMorgan/);
  });

  it('does not call either provider while the 24-hour target cache is fresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cache = new SharedRequestCache();
    const fetchImpl = vi.fn(async () => response(finnhubPayload()));
    const base = {
      finnhubApiKey: 'finnhub',
      alphaVantageApiKey: 'alpha',
      listingCurrency: 'USD',
      fetchImpl: fetchImpl as typeof fetch,
      now: () => Date.now(),
      cache,
      retries: 0,
    };
    await loadAnalystConsensus('AAPL', { ...base, currentPrice: 100 });
    vi.advanceTimersByTime(23 * 60 * 60_000);
    const cached = await loadAnalystConsensus('AAPL', { ...base, currentPrice: 120 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cached.currentPrice).toBe(120);
    expect(cached.upsideDownsidePct).toBe(25);
    expect(cached.stale).toBe(false);
  });

  it('serves valid stale target data after provider failure until 48 hours total', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const cache = new SharedRequestCache();
    const fetchImpl = vi.fn(async () => response(finnhubPayload()));
    const base = {
      finnhubApiKey: 'finnhub',
      alphaVantageApiKey: null,
      listingCurrency: 'USD',
      fetchImpl: fetchImpl as typeof fetch,
      now: () => Date.now(),
      cache,
      retries: 0,
    };
    await loadAnalystConsensus('AAPL', { ...base, currentPrice: 100 });
    vi.advanceTimersByTime(25 * 60 * 60_000);
    fetchImpl.mockImplementation(async () => response({}, 500));
    const stale = await loadAnalystConsensus('AAPL', { ...base, currentPrice: 120 });
    expect(stale).toMatchObject({
      status: 'stale',
      stale: true,
      targetPrice: 150,
      currentPrice: 120,
      upsideDownsidePct: 25,
    });
    expect(stale.cachedAt).not.toBeNull();
    expect(stale.coverage[0]).toMatchObject({ status: 'provider-error' });

    vi.advanceTimersByTime(24 * 60 * 60_000);
    const expired = await loadAnalystConsensus('AAPL', { ...base, currentPrice: 120 });
    expect(expired.targetPrice).toBeNull();
    expect(expired.stale).toBe(false);
  });

  it.each([0, null])('guards invalid current price %s', async (currentPrice) => {
    const result = await loadAnalystConsensus('AAPL', {
      finnhubApiKey: 'finnhub',
      alphaVantageApiKey: null,
      currentPrice,
      fetchImpl: vi.fn(async () => response(finnhubPayload())) as unknown as typeof fetch,
      now: () => NOW,
      cache: new SharedRequestCache(),
      retries: 0,
    });
    expect(result.currentPrice).toBeNull();
    expect(result.upsideDownsidePct).toBeNull();
  });
});
