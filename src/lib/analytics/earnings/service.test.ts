import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { loadEarningsSchedule } from './service';

const AV_CSV = [
  'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay',
  'AAPL,APPLE INCORPORATED,2026-07-30,2026-06-30,1.88,USD,post-market',
].join('\n');

const FMP_JSON = [
  { symbol: 'AAPL', date: '2026-07-30', epsActual: null, epsEstimated: 1.88 },
];

/** 2026-07-28 12:00 UTC is 08:00 in America/New_York — still the 28th locally. */
const NOW = () => Date.UTC(2026, 6, 28, 12);

function fetcherFor(handlers: Record<'alphavantage' | 'financialmodelingprep', () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('alphavantage')) return handlers.alphavantage();
    if (url.includes('financialmodelingprep')) return handlers.financialmodelingprep();
    throw new Error(`unexpected host: ${url}`);
  }) as typeof fetch;
}

const options = () => ({
  alphaVantageApiKey: 'av',
  fmpApiKey: 'fmp',
  now: NOW,
  cache: new SharedRequestCache(),
});

describe('loadEarningsSchedule', () => {
  it('uses Alpha Vantage first and dates the report in exchange-local time', async () => {
    const result = await loadEarningsSchedule('aapl', {
      ...options(),
      fetcher: fetcherFor({
        alphavantage: () => new Response(AV_CSV, { status: 200 }),
        financialmodelingprep: () => { throw new Error('must not be called'); },
      }),
    });
    expect(result).toMatchObject({
      status: 'available',
      symbol: 'AAPL',
      reportDate: '2026-07-30',
      timeOfDay: 'post-market',
      daysToEarnings: 2,
      provider: 'alpha-vantage',
      stale: false,
    });
  });

  it('falls through to Financial Modeling Prep when Alpha Vantage refuses', async () => {
    const result = await loadEarningsSchedule('AAPL', {
      ...options(),
      fetcher: fetcherFor({
        alphavantage: () => new Response(JSON.stringify({ Information: 'This is a premium endpoint' }), { status: 200 }),
        financialmodelingprep: () => new Response(JSON.stringify(FMP_JSON), { status: 200 }),
      }),
    });
    expect(result).toMatchObject({
      status: 'available',
      reportDate: '2026-07-30',
      daysToEarnings: 2,
      provider: 'financial-modeling-prep',
    });
  });

  it('reports a typed unavailable state instead of inventing a date', async () => {
    const result = await loadEarningsSchedule('AAPL', {
      ...options(),
      fetcher: fetcherFor({
        alphavantage: () => new Response('{}', { status: 500 }),
        financialmodelingprep: () => new Response('{}', { status: 500 }),
      }),
    });
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.reason).toBe('provider-unavailable');
  });

  it('distinguishes "no scheduled report" from a provider failure', async () => {
    const result = await loadEarningsSchedule('AAPL', {
      ...options(),
      fetcher: fetcherFor({
        alphavantage: () => new Response('symbol,name,reportDate\n', { status: 200 }),
        financialmodelingprep: () => new Response('[]', { status: 200 }),
      }),
    });
    expect(result.status === 'unavailable' && result.reason).toBe('no-scheduled-report');
  });

  it('is unavailable, not silently empty, when no provider is configured', async () => {
    const result = await loadEarningsSchedule('AAPL', {
      alphaVantageApiKey: null,
      fmpApiKey: null,
      now: NOW,
      cache: new SharedRequestCache(),
      fetcher: fetcherFor({
        alphavantage: () => { throw new Error('must not be called'); },
        financialmodelingprep: () => { throw new Error('must not be called'); },
      }),
    });
    expect(result.status === 'unavailable' && result.reason).toBe('not-configured');
  });

  it('serves one upstream request for repeated loads of the same symbol', async () => {
    const shared = new SharedRequestCache();
    const alphavantage = vi.fn(() => new Response(AV_CSV, { status: 200 }));
    const request = {
      ...options(),
      cache: shared,
      fetcher: fetcherFor({ alphavantage, financialmodelingprep: () => new Response('[]', { status: 200 }) }),
    };
    await loadEarningsSchedule('AAPL', request);
    await loadEarningsSchedule('AAPL', request);
    expect(alphavantage).toHaveBeenCalledTimes(1);
  });
});
