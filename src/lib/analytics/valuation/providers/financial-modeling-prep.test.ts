import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { MarketDataError } from '@/src/lib/market-data/errors';
import { FinancialModelingPrepValuationProvider } from './financial-modeling-prep';

const NOW = Date.parse('2026-07-25T00:00:00.000Z');
const PEERS = ['P1', 'P2', 'P3', 'P4'];

function json(payload: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function payload(url: URL) {
  const endpoint = url.pathname.split('/').at(-1);
  const symbol = url.searchParams.get('symbol') ?? '';
  if (endpoint === 'analyst-estimates') {
    return [
      {
        symbol,
        date: '2027-12-31',
        revenueAvg: symbol === 'TARGET' ? 1_200 : 100,
        epsAvg: symbol === 'TARGET' ? 2 : 1,
        numAnalystsRevenue: 5,
        numAnalystsEps: 5,
      },
    ];
  }
  if (endpoint === 'stock-peers') {
    return PEERS.map((peer) => ({ symbol: peer, companyName: peer, price: 10, mktCap: 100 }));
  }
  if (endpoint === 'profile') {
    return [{
      symbol,
      sector: 'Technology',
      industry: symbol === 'P4' ? 'Hardware' : 'Software',
      currency: 'USD',
      beta: 1.2,
      marketCap: 800,
    }];
  }
  if (endpoint === 'quote') {
    return [{ symbol, price: 20, timestamp: NOW / 1_000 }];
  }
  if (endpoint === 'enterprise-values') {
    return [{
      symbol,
      date: '2026-06-30',
      enterpriseValue: 1_000,
      marketCapitalization: 800,
      numberOfShares: 40,
    }];
  }
  if (endpoint === 'treasury-rates') {
    return [{ date: '2026-07-23', year10: 4.71 }];
  }
  if (endpoint === 'market-risk-premium') {
    return [{ country: 'United States', totalEquityRiskPremium: 4.46 }];
  }
  return [];
}

describe('FMP deterministic valuation data provider', () => {
  it('normalizes documented fields, uses dynamic peers, and keeps the API key server-side', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe('secret');
      expect(String(input)).not.toContain('secret');
      return json(payload(new URL(String(input))));
    });
    const provider = new FinancialModelingPrepValuationProvider(
      'secret',
      fetcher as typeof fetch,
      () => NOW,
      async () => undefined,
    );
    const result = await provider.getValuationDataset('target');
    expect(result.estimates[0]).toMatchObject({
      estimatedRevenue: 1_200,
      estimatedEps: 2,
      provider: 'financial-modeling-prep',
    });
    expect(result.peers.map((peer) => peer.symbol)).toEqual(PEERS);
    expect(result.waccMarketInputs).toMatchObject({
      beta: 1.2,
      riskFreeRate: 0.0471,
      equityRiskPremium: 0.0446,
    });
    expect(result).toMatchObject({
      marketPrice: 20,
      marketPriceAsOf: '2026-07-25T00:00:00.000Z',
      currency: 'USD',
    });
    expect(result.sharesOutstanding).toBe(40);
  });

  it('deduplicates concurrent loads and reuses the cache', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      json(payload(new URL(String(input)))));
    const provider = new FinancialModelingPrepValuationProvider(
      'secret',
      fetcher as typeof fetch,
      () => NOW,
      async () => undefined,
    );
    const [first, second] = await Promise.all([
      provider.getValuationDataset('TARGET'),
      provider.getValuationDataset('TARGET'),
    ]);
    const afterConcurrent = fetcher.mock.calls.length;
    expect(first.peers).toEqual(second.peers);
    expect(afterConcurrent).toBeGreaterThan(0);
    const cached = await provider.getValuationDataset('TARGET');
    expect(fetcher).toHaveBeenCalledTimes(afterConcurrent);
    expect(cached.cacheStatus).toBe('hit');
  });

  it('maps a 429 after the bounded retry budget and never returns fabricated data', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const endpoint = new URL(String(input)).pathname.split('/').at(-1);
      return endpoint === 'analyst-estimates'
        ? json({ 'Error Message': 'rate limit exceeded' }, 429, { 'retry-after': '0' })
        : json(payload(new URL(String(input))));
    });
    const provider = new FinancialModelingPrepValuationProvider(
      'secret',
      fetcher as typeof fetch,
      () => NOW,
      sleep,
    );
    await expect(provider.getValuationDataset('TARGET')).rejects.toMatchObject({
      code: 'rate-limited',
    } satisfies Partial<MarketDataError>);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
