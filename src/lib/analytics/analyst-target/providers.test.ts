import { describe, expect, it, vi } from 'vitest';
import {
  loadAlphaVantagePriceTarget,
  loadFinnhubPriceTarget,
  requestProviderJson,
} from './providers';

function response(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('Finnhub Price Target', () => {
  it('maps the live response fields and keeps the token out of the URL', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.finnhub.io/api/v1/stock/price-target?symbol=AAPL');
      expect(String(input)).not.toContain('secret');
      expect(new Headers(init?.headers).get('X-Finnhub-Token')).toBe('secret');
      return response({
        symbol: 'AAPL',
        targetMean: 250.5,
        targetMedian: 245,
        targetHigh: 300,
        targetLow: 190,
        numberAnalysts: 42,
        lastUpdated: '2026-07-25',
      });
    });
    await expect(loadFinnhubPriceTarget('AAPL', 'secret', {
      fetchImpl: fetchImpl as typeof fetch,
      retries: 0,
    })).resolves.toEqual({
      symbol: 'AAPL',
      targetPrice: 250.5,
      medianTarget: 245,
      highTarget: 300,
      lowTarget: 190,
      analystCount: 42,
      provider: 'finnhub',
      providerLabel: 'Finnhub',
      currency: null,
      lastUpdated: '2026-07-25',
    });
  });

  it('does not invent optional detail fields', async () => {
    const fetchImpl = vi.fn(async () => response({ symbol: 'AAPL', targetMean: 250 }));
    await expect(loadFinnhubPriceTarget('AAPL', 'secret', {
      fetchImpl: fetchImpl as typeof fetch,
      retries: 0,
    })).resolves.toMatchObject({
      targetPrice: 250,
      medianTarget: null,
      highTarget: null,
      lowTarget: null,
      analystCount: null,
      lastUpdated: null,
    });
  });

  it.each([
    [{ symbol: 'AAPL' }],
    [{ symbol: 'AAPL', targetMean: 0 }],
    [{ symbol: 'AAPL', targetMean: -1 }],
    [{ symbol: 'AAPL', targetMean: 'None' }],
    [{ symbol: 'MSFT', targetMean: 250 }],
  ])('rejects missing or invalid primary fields: %o', async (payload) => {
    const fetchImpl = vi.fn(async () => response(payload));
    await expect(loadFinnhubPriceTarget('AAPL', 'secret', {
      fetchImpl: fetchImpl as typeof fetch,
      retries: 0,
    })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it.each([401, 403])('maps %i to not-entitled without retrying', async (status) => {
    const fetchImpl = vi.fn(async () => response({}, status));
    await expect(loadFinnhubPriceTarget('AAPL', 'secret', {
      fetchImpl: fetchImpl as typeof fetch,
      retries: 2,
    })).rejects.toMatchObject({ kind: 'not-entitled', status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps premium restriction payloads to not-entitled', async () => {
    const fetchImpl = vi.fn(async () => response({ error: "You don't have access to this resource." }));
    await expect(loadFinnhubPriceTarget('AAPL', 'secret', {
      fetchImpl: fetchImpl as typeof fetch,
      retries: 0,
    })).rejects.toMatchObject({ kind: 'not-entitled' });
  });
});

describe('provider request safety', () => {
  it('respects Retry-After on 429 without a retry loop', async () => {
    const fetchImpl = vi.fn(async () => response({}, 429, { 'retry-after': '17' }));
    await expect(requestProviderJson(
      'finnhub',
      'stock/price-target',
      new URL('https://example.test'),
      {},
      { fetchImpl: fetchImpl as typeof fetch, retries: 2 },
    )).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 17 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 once and then returns the valid response', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({ ok: true }));
    await expect(requestProviderJson(
      'finnhub',
      'stock/price-target',
      new URL('https://example.test'),
      {},
      {
        fetchImpl: fetchImpl as typeof fetch,
        retries: 1,
        sleep: async () => undefined,
      },
    )).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('turns timeout into a bounded provider error', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')));
      }));
    await expect(requestProviderJson(
      'finnhub',
      'stock/price-target',
      new URL('https://example.test'),
      {},
      { fetchImpl: fetchImpl as typeof fetch, retries: 0, timeoutMs: 1 },
    )).rejects.toMatchObject({ kind: 'provider-error' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON without exposing the response body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(requestProviderJson(
      'finnhub',
      'stock/price-target',
      new URL('https://example.test'),
      {},
      { fetchImpl: fetchImpl as typeof fetch, retries: 0 },
    )).rejects.toMatchObject({ kind: 'provider-error' });
  });
});

describe('Alpha Vantage fallback', () => {
  it('uses only OVERVIEW.AnalystTargetPrice', async () => {
    const fetchImpl = vi.fn(async () => response({
      Symbol: 'AAPL',
      Currency: 'USD',
      AnalystTargetPrice: '318.81',
      LatestQuarter: '2026-03-31',
    }));
    await expect(loadAlphaVantagePriceTarget('AAPL', 'secret', {
      fetchImpl: fetchImpl as typeof fetch,
      retries: 0,
    })).resolves.toEqual({
      symbol: 'AAPL',
      targetPrice: 318.81,
      medianTarget: null,
      highTarget: null,
      lowTarget: null,
      analystCount: null,
      provider: 'alpha-vantage',
      providerLabel: 'Alpha Vantage',
      currency: 'USD',
      lastUpdated: null,
    });
  });

  it.each([
    [{ Symbol: 'AAPL', AnalystTargetPrice: '' }, 'unavailable'],
    [{ Symbol: 'AAPL', AnalystTargetPrice: 'None' }, 'unavailable'],
    [{ Note: 'API call frequency limit reached' }, 'rate-limited'],
    [{ Information: 'Invalid API key' }, 'invalid-key'],
  ])('classifies invalid Alpha payload %o', async (payload, kind) => {
    const fetchImpl = vi.fn(async () => response(payload));
    await expect(loadAlphaVantagePriceTarget('AAPL', 'secret', {
      fetchImpl: fetchImpl as typeof fetch,
      retries: 0,
    })).rejects.toMatchObject({ kind });
  });
});
