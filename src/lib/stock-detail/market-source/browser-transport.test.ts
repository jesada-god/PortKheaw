import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMarketTransport } from './browser-transport';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Yahoo browser market transport', () => {
  it('maps the normalized Yahoo candle envelope to canonical time/open/high/low/close/volume bars', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: {
        symbol: 'AAPL',
        provider: 'yahoo-finance-chart',
        attemptedProviders: ['yahoo-finance-chart'],
        requestedInterval: '10m',
        actualInterval: '10m',
        sourceInterval: '5m',
        requestedRange: '1d',
        actualStart: 1_700_000_000,
        actualEnd: 1_700_000_600,
        exchangeTimezone: 'America/New_York',
        currency: 'USD',
        dataStatus: 'delayed',
        delayedByMinutes: 15,
        adjusted: false,
        aggregated: true,
        cacheStatus: 'miss',
        candles: [{
          timestamp: 1_700_000_000,
          open: 10,
          high: 13,
          low: 9,
          close: 12,
          volume: 250,
        }],
        warnings: [],
        fallbackReason: null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await createBrowserMarketTransport().fetchAggregate({
      symbol: 'AAPL',
      interval: '10m',
      range: '1d',
      adjusted: false,
      session: 'extended',
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      ok: true,
      value: {
        bars: [{
          time: 1_700_000_000,
          open: 10,
          high: 13,
          low: 9,
          close: 12,
          volume: 250,
        }],
        provider: 'yahoo-finance-chart',
        status: 'delayed',
        asOf: new Date(1_700_000_600 * 1_000).toISOString(),
      },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/market/candles?');
    expect(String(fetchMock.mock.calls[0][0])).toContain('interval=10m');
  });
});
