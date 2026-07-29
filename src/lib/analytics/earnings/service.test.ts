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

describe('loadEarningsSchedule — typed failure reasons and stale-if-error', () => {
  /** The live Alpha Vantage quota response: HTTP 200, real header, notice rendered one char per field. */
  const AV_QUOTA_NOTICE = 'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\r\nI,n,f,o,r,m,a';

  it('treats the HTTP 200 quota notice as a provider fault and falls through to FMP', async () => {
    const result = await loadEarningsSchedule('AAPL', {
      ...options(),
      fetcher: fetcherFor({
        alphavantage: () => new Response(AV_QUOTA_NOTICE, { status: 200 }),
        financialmodelingprep: () => new Response(JSON.stringify(FMP_JSON), { status: 200 }),
      }),
    });
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    // Never "no scheduled report" — and the fallback names itself.
    expect(result.provider).toBe('financial-modeling-prep');
    expect(result.reportDate).toBe('2026-07-30');
  });

  it('separates an unreadable payload from a plain outage', async () => {
    const result = await loadEarningsSchedule('AAPL', {
      ...options(),
      fetcher: fetcherFor({
        alphavantage: () => new Response('not,a,calendar', { status: 200 }),
        financialmodelingprep: () => new Response('"a bare string"', { status: 200 }),
      }),
    });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('invalid-response');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('reports a paid-plan refusal as an entitlement fault, not as "no report"', async () => {
    const result = await loadEarningsSchedule('RKLB', {
      ...options(),
      fetcher: fetcherFor({
        alphavantage: () => new Response(AV_QUOTA_NOTICE, { status: 200 }),
        // The real FMP response for a symbol outside the plan.
        financialmodelingprep: () => new Response(
          JSON.stringify({ 'Premium Query Parameter': "Special Endpoint : This value set for 'symbol' is not available under your current subscription" }),
          { status: 402 },
        ),
      }),
    });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).not.toBe('no-scheduled-report');
    expect(['entitlement-unavailable', 'provider-unavailable']).toContain(result.reason);
    expect(result.provider).toBe('financial-modeling-prep');
  });

  it('serves the last good date as STALE when the provider later fails', async () => {
    // The shared cache ages on the real clock, so Date must advance for the
    // fresh window to expire and the stale-if-error branch to be reached.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(NOW());
      const cache = new SharedRequestCache();
      let failing = false;
      const fetcher = fetcherFor({
        alphavantage: () => (failing
          ? new Response('{"Information":"rate limited"}', { status: 200 })
          : new Response(AV_CSV, { status: 200 })),
        financialmodelingprep: () => new Response('{"Error":"nope"}', { status: 402 }),
      });

      const fresh = await loadEarningsSchedule('AAPL', { ...options(), cache, fetcher });
      expect(fresh.status).toBe('available');
      if (fresh.status !== 'available') return;
      expect(fresh.stale).toBe(false);

      // Past the 12h fresh window, with the provider now refusing.
      const laterMs = NOW() + 13 * 60 * 60_000;
      vi.setSystemTime(laterMs);
      failing = true;
      const later = await loadEarningsSchedule('AAPL', {
        ...options(), cache, fetcher, now: () => laterMs,
      });
      expect(later.status).toBe('available');
      if (later.status !== 'available') return;
      expect(later.stale).toBe(true);
      expect(later.provider).toBe('alpha-vantage');
      expect(later.reportDate).toBe('2026-07-30');
      // asOf still points at the ORIGINAL successful fetch, never at "now".
      expect(Date.parse(later.asOf)).toBe(NOW());
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports no-scheduled-report only when the provider really returned no future date', async () => {
    const result = await loadEarningsSchedule('AAPL', {
      ...options(),
      fetcher: fetcherFor({
        alphavantage: () => new Response([
          'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay',
          'AAPL,APPLE INCORPORATED,2020-01-28,2019-12-31,4.99,USD,post-market',
        ].join('\n'), { status: 200 }),
        financialmodelingprep: () => new Response(JSON.stringify([
          { symbol: 'AAPL', date: '2020-01-28', epsEstimated: 4.99 },
        ]), { status: 200 }),
      }),
    });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('no-scheduled-report');
  });
});
