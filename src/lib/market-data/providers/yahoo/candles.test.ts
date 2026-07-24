import { describe, expect, it, vi } from 'vitest';
import { ProviderHttpClient } from '../../provider-http';
import { YahooCandleProvider } from './candles';

vi.mock('server-only', () => ({}));

describe('Yahoo Chart candle provider', () => {
  it('normalizes real Yahoo JSON into ordered, deduplicated canonical OHLCV and drops bad rows', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      chart: {
        result: [{
          meta: {
            symbol: 'NVDA',
            currency: 'USD',
            exchangeTimezoneName: 'America/New_York',
            exchangeDataDelayedBy: 0,
            marketState: 'CLOSED',
          },
          timestamp: [1_700_000_300, 1_700_000_000, 1_700_000_000, 1_700_000_600],
          indicators: {
            quote: [{
              open: [11, 10, 10.5, null],
              high: [13, 12, 12.5, 15],
              low: [10, 9, 9.5, 14],
              close: [12, 11, 11.5, 14.5],
              volume: [200, 100, 150, 300],
            }],
            adjclose: [{ adjclose: [12, 11, 11.5, 14.5] }],
          },
        }],
        error: null,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const http = new ProviderHttpClient({
      fetcher: fetcher as typeof fetch,
      logger: () => undefined,
      sleep: async () => undefined,
    });
    const provider = new YahooCandleProvider(http, () => new Date('2026-07-24T12:00:00.000Z'));

    const result = await provider.getCandles({
      symbol: 'NVDA',
      interval: '5m',
      sourceInterval: '5m',
      range: '1d',
      adjusted: false,
      session: 'extended',
    });

    expect(result.provider).toBe('yahoo-finance-chart');
    expect(result.candles).toEqual([
      {
        timestamp: 1_700_000_000,
        open: 10.5,
        high: 12.5,
        low: 9.5,
        close: 11.5,
        adjustedClose: 11.5,
        volume: 150,
        session: 'regular',
      },
      {
        timestamp: 1_700_000_300,
        open: 11,
        high: 13,
        low: 10,
        close: 12,
        adjustedClose: 12,
        volume: 200,
        session: 'regular',
      },
    ]);
    expect(result.warnings).toContain('Discarded 1 invalid provider candles');

    const requested = new URL(String(fetcher.mock.calls[0][0]));
    expect(requested.hostname).toBe('query1.finance.yahoo.com');
    expect(requested.pathname).toBe('/v8/finance/chart/NVDA');
    expect(requested.searchParams.get('interval')).toBe('5m');
    expect(requested.searchParams.get('includePrePost')).toBe('true');
    expect(requested.searchParams.get('events')).toBe('div,splits');
  });
});
