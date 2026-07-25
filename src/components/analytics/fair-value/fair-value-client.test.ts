import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearFairValueClientCacheForTests, requestFairValue } from './fair-value-client';

const unavailable = {
  status: 'unavailable' as const,
  failureKind: 'missing-field' as const,
  symbol: 'RKLB',
  currency: 'USD',
  provider: 'alpha-vantage',
  reason: 'insufficient real data',
  missingFields: ['forwardEstimate'],
  missingInputs: ['forwardEstimate'],
  staleInputs: [],
  asOf: '2026-01-01T00:00:00.000Z',
  calculatedAt: '2026-01-01T00:00:00.000Z',
  methodologyVersion: 'nexora-fv-v2' as const,
  limitations: [],
  diagnostics: [],
};

afterEach(() => {
  clearFairValueClientCacheForTests();
  vi.unstubAllGlobals();
});

describe('Fair Value request coordinator', () => {
  it('deduplicates concurrent Strict Mode requests by symbol', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: unavailable }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const first = new AbortController();
    const second = new AbortController();
    const [a, b] = await Promise.all([requestFairValue('rklb', first.signal), requestFairValue('RKLB', second.signal)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('lets an unmounted subscriber abort without cancelling a newer subscriber', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const oldSymbolView = new AbortController();
    const currentView = new AbortController();
    const oldRequest = requestFairValue('RKLB', oldSymbolView.signal);
    const currentRequest = requestFairValue('RKLB', currentView.signal);
    oldSymbolView.abort();
    finish(new Response(JSON.stringify({ data: unavailable }), { status: 200 }));
    await expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
    await expect(currentRequest).resolves.toMatchObject({ status: 'unavailable', symbol: 'RKLB' });
  });

  it('aborts the shared browser request after every consumer unmounts', async () => {
    let browserSignal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => {
      browserSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    }));
    const consumer = new AbortController();
    const request = requestFairValue('RKLB', consumer.signal);
    consumer.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(browserSignal.aborted).toBe(true);
  });

  it('preserves a structured rate-limited response instead of replacing it with a generic error', async () => {
    const rateLimited = {
      ...unavailable,
      failureKind: 'provider-rate-limited' as const,
      provider: null,
      missingFields: [],
      missingInputs: [],
      reason: 'try later',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ data: rateLimited }),
      { status: 429 },
    )));

    await expect(requestFairValue('RKLB', new AbortController().signal)).resolves.toMatchObject({
      status: 'unavailable',
      failureKind: 'provider-rate-limited',
      missingFields: [],
    });
  });
});
