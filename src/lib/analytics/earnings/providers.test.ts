import { describe, expect, it, vi } from 'vitest';
import { MarketDataError } from '@/src/lib/market-data/errors';
import { loadAlphaVantageEarnings, loadFinancialModelingPrepEarnings } from './providers';

const AV_CSV = [
  'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay',
  'RKLB,ROCKET LAB CORPORATION,2026-08-10,2026-06-30,-0.07,USD,post-market',
].join('\n');

function capture(response: Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), init });
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe('loadAlphaVantageEarnings', () => {
  it('negotiates with application/json — text/csv is rejected with HTTP 406 by the live endpoint', async () => {
    const { calls, fetcher } = capture(new Response(AV_CSV, { status: 200 }));
    await loadAlphaVantageEarnings({ symbol: 'RKLB', apiKey: 'key', fetcher });
    const accept = (calls[0].init?.headers as Record<string, string>).Accept;
    expect(accept).toBe('application/json');
    expect(accept).not.toBe('text/csv');
  });

  it('requests the symbol-filtered three-month horizon', async () => {
    const { calls, fetcher } = capture(new Response(AV_CSV, { status: 200 }));
    const result = await loadAlphaVantageEarnings({ symbol: 'RKLB', apiKey: 'key', fetcher });
    expect(calls[0].url).toContain('function=EARNINGS_CALENDAR');
    expect(calls[0].url).toContain('symbol=RKLB');
    expect(calls[0].url).toContain('horizon=3month');
    expect(result.candidates).toEqual([
      { symbol: 'RKLB', reportDate: '2026-08-10', timeOfDay: 'post-market', epsEstimate: -0.07 },
    ]);
  });

  it('maps a premium refusal to a permanent entitlement failure, not a retryable quota one', async () => {
    const { fetcher } = capture(new Response(
      JSON.stringify({ Information: 'This is a premium endpoint. You may subscribe to any of the premium plans' }),
      { status: 200 },
    ));
    await expect(loadAlphaVantageEarnings({ symbol: 'RKLB', apiKey: 'key', fetcher }))
      .rejects.toMatchObject({ code: 'forbidden', retryable: false });
  });

  it('rejects the quota notice AV disguises as a CSV row instead of reporting "no report"', async () => {
    const { fetcher } = capture(new Response(
      'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\r\nI,n,f,o,r,m,a\r\n',
      { status: 200 },
    ));
    await expect(loadAlphaVantageEarnings({ symbol: 'AAPL', apiKey: 'key', fetcher }))
      .rejects.toMatchObject({ code: 'upstream-unavailable', retryable: true });
  });

  it('surfaces a non-OK status through the shared provider failure mapper', async () => {
    const { fetcher } = capture(new Response('{"detail":"Could not satisfy the request Accept header."}', { status: 406 }));
    await expect(loadAlphaVantageEarnings({ symbol: 'RKLB', apiKey: 'key', fetcher }))
      .rejects.toBeInstanceOf(MarketDataError);
  });
});

describe('loadFinancialModelingPrepEarnings', () => {
  it('parses the array payload for the requested symbol', async () => {
    const { fetcher } = capture(new Response(JSON.stringify([
      { symbol: 'AAPL', date: '2026-07-30', epsEstimated: 1.88 },
    ]), { status: 200 }));
    const result = await loadFinancialModelingPrepEarnings({ symbol: 'AAPL', apiKey: 'key', fetcher });
    expect(result.provider).toBe('financial-modeling-prep');
    expect(result.candidates).toHaveLength(1);
  });

  it('maps the live 402 subscription refusal to an entitlement failure', async () => {
    const { fetcher } = capture(new Response(
      "Premium Query Parameter: 'Special Endpoint : This value set for 'symbol' is not available under your current subscription",
      { status: 402 },
    ));
    await expect(loadFinancialModelingPrepEarnings({ symbol: 'RKLB', apiKey: 'key', fetcher }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});
