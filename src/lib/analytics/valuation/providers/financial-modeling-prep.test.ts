import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
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
    return [{ symbol, peersList: PEERS }];
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
  if (endpoint === 'batch-quote') {
    return (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
      .map((item) => ({ symbol: item, price: 20, timestamp: NOW / 1_000 }));
  }
  if (endpoint === 'enterprise-values') {
    return [{
      symbol,
      date: '2026-06-30',
      enterpriseValue: 1_000,
      marketCapitalization: 800,
      numberOfShares: 40,
      minusCashAndCashEquivalents: 120,
      addTotalDebt: 250,
    }];
  }
  if (endpoint === 'shares-float') {
    return [{ symbol, date: '2026-07-20', outstandingShares: 42 }];
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
  it('skips shared market endpoints when fresh persistent market inputs already exist', async () => {
    const endpoints: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      endpoints.push(url.pathname.split('/').at(-1) ?? '');
      return json(payload(url));
    });
    const provider = new FinancialModelingPrepValuationProvider(
      'secret',
      fetcher as typeof fetch,
      () => NOW,
      async () => undefined,
    );

    await provider.getValuationDataset('TARGET', { includeMarketInputs: false });

    expect(endpoints).not.toContain('treasury-rates');
    expect(endpoints).not.toContain('market-risk-premium');
    expect(endpoints).toContain('analyst-estimates');
  });

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
    expect(result.sharesOutstanding).toBe(42);
    expect(result).toMatchObject({
      cash: 120,
      totalDebt: 250,
      balanceSheetAsOf: '2026-06-30',
    });
    expect(result.peerCandidates).toEqual(PEERS);
    const peerCalls = fetcher.mock.calls.map(([input]) => new URL(String(input)))
      .filter((url) => PEERS.includes(url.searchParams.get('symbol') ?? ''));
    expect(peerCalls.some((url) => url.pathname.endsWith('/profile'))).toBe(false);
    expect(peerCalls.some((url) => url.pathname.endsWith('/quote'))).toBe(false);
    expect(peerCalls.some((url) => url.pathname.endsWith('/enterprise-values'))).toBe(false);
    expect(fetcher.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.endsWith('/batch-quote'))).toHaveLength(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      field: 'sharesOutstanding',
      value: 42,
      provider: 'financial-modeling-prep',
      status: 'available',
    }));
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

  it('bounds upstream concurrency while loading peer coverage', async () => {
    let active = 0;
    let maximum = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return json(payload(new URL(String(input))));
    });
    const provider = new FinancialModelingPrepValuationProvider(
      'secret',
      fetcher as typeof fetch,
      () => NOW,
      async () => undefined,
    );

    await provider.getValuationDataset('TARGET');

    expect(maximum).toBeLessThanOrEqual(4);
  });

  it('keeps a partial dataset after an estimate 429 and never returns fabricated estimates', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const endpoint = new URL(String(input)).pathname.split('/').at(-1);
      const symbol = new URL(String(input)).searchParams.get('symbol');
      return endpoint === 'analyst-estimates' && symbol === 'TARGET'
        ? json({ 'Error Message': 'rate limit exceeded' }, 429, { 'retry-after': '0' })
        : json(payload(new URL(String(input))));
    });
    const provider = new FinancialModelingPrepValuationProvider(
      'secret',
      fetcher as typeof fetch,
      () => NOW,
      sleep,
    );
    const result = await provider.getValuationDataset('TARGET');
    expect(result.estimates).toEqual([]);
    expect(result.endpointErrors).toMatchObject({ 'analyst-estimates': 'rate-limited' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'forwardEps',
        status: 'missing',
        reason: 'rate-limited',
      }),
      expect.objectContaining({
        field: 'forwardRevenue',
        status: 'missing',
        reason: 'rate-limited',
      }),
    ]));
    expect(result.marketPrice).toBe(20);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('marks zero peer observations missing when every candidate endpoint is rate-limited', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const endpoint = url.pathname.split('/').at(-1);
      if (endpoint === 'stock-peers' || endpoint === 'company-screener') {
        return json({ 'Error Message': 'rate limit exceeded' }, 429, {
          'retry-after': '0',
        });
      }
      return json(payload(url));
    });
    const provider = new FinancialModelingPrepValuationProvider(
      'secret',
      fetcher as typeof fetch,
      () => NOW,
      async () => undefined,
    );

    const result = await provider.getValuationDataset('TARGET');

    expect(result.peerCandidates).toEqual([]);
    expect(result.peers).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      field: 'peerObservations',
      value: 0,
      status: 'missing',
      reason: 'rate-limited',
    }));
  });

  it('expands and deduplicates industry candidates before the sector fallback', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const endpoint = url.pathname.split('/').at(-1);
      if (endpoint === 'stock-peers') return json([{ symbol: 'P1' }, { symbol: 'P2' }]);
      if (endpoint === 'company-screener' && url.searchParams.has('industry')) {
        return json(Array.from({ length: 20 }, (_, index) => ({
          symbol: index === 0 ? 'P1' : `I${index}`,
          sector: 'Technology',
          industry: 'Software',
          marketCap: 800 + index,
        })));
      }
      return json(payload(url));
    });
    const provider = new FinancialModelingPrepValuationProvider(
      'secret',
      fetcher as typeof fetch,
      () => NOW,
      async () => undefined,
    );
    const result = await provider.getValuationDataset('TARGET');
    expect(result.peerCandidates).toHaveLength(12);
    expect(new Set(result.peerCandidates).size).toBe(12);
    expect(result.peerCandidates.slice(0, 2)).toEqual(['P1', 'P2']);
    expect(result.peers.some((peer) => peer.candidateSource === 'industry')).toBe(true);
    expect(fetcher.mock.calls.some(([input]) =>
      new URL(String(input)).pathname.endsWith('/company-screener')
      && new URL(String(input)).searchParams.has('sector'))).toBe(false);
  });

  it('uses the sector fallback when industry coverage is still bounded below the candidate target', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const endpoint = url.pathname.split('/').at(-1);
      const symbol = url.searchParams.get('symbol');
      if (endpoint === 'stock-peers') return json([]);
      if (endpoint === 'company-screener' && url.searchParams.has('industry')) {
        return json([
          { symbol: 'I1', sector: 'Technology', industry: 'Software', marketCap: 810 },
          { symbol: 'I1', sector: 'Technology', industry: 'Software', marketCap: 810 },
        ]);
      }
      if (endpoint === 'company-screener' && url.searchParams.has('sector')) {
        return json(Array.from({ length: 20 }, (_, index) => ({
          symbol: index === 0 ? 'I1' : `S${index}`,
          sector: 'Technology',
          industry: 'Software',
          marketCap: 820 + index,
        })));
      }
      if (endpoint === 'analyst-estimates' && symbol === 'S1') return json([]);
      return json(payload(url));
    });
    const provider = new FinancialModelingPrepValuationProvider(
      'secret',
      fetcher as typeof fetch,
      () => NOW,
      async () => undefined,
    );

    const result = await provider.getValuationDataset('TARGET');

    expect(result.peerCandidates).toHaveLength(16);
    expect(new Set(result.peerCandidates).size).toBe(16);
    expect(result.peerCandidates[0]).toBe('I1');
    expect(result.peers.some((peer) => peer.candidateSource === 'sector')).toBe(true);
    expect(result.peerRejections).toContainEqual({
      symbol: 'S1',
      reason: 'missing-estimate',
    });
    expect(fetcher.mock.calls.some(([input]) =>
      new URL(String(input)).pathname.endsWith('/company-screener')
      && new URL(String(input)).searchParams.has('sector'))).toBe(true);
  });
});
