import { describe, expect, it, vi } from 'vitest';
import { ProviderHttpClient } from '../../provider-http';
import { YahooCandleProvider } from './candles';

vi.mock('server-only', () => ({}));

describe('Yahoo Chart candle provider', () => {
  it('normalizes regular price and Yahoo meta previous close into daily change', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      chart: {
        result: [{
          meta: {
            symbol: 'NVTS',
            currency: 'USD',
            exchangeTimezoneName: 'America/New_York',
            exchangeDataDelayedBy: 0,
            marketState: 'CLOSED',
            regularMarketPrice: 10.9599,
            regularMarketTime: Date.parse('2026-07-24T20:00:00.000Z') / 1_000,
            regularMarketOpen: 11.05,
            regularMarketDayHigh: 11.2,
            regularMarketDayLow: 10.8,
            regularMarketVolume: 2_000_000,
            previousClose: 11.136,
          },
          timestamp: [
            Date.parse('2026-07-23T13:30:00.000Z') / 1_000,
            Date.parse('2026-07-24T13:30:00.000Z') / 1_000,
          ],
          indicators: {
            quote: [{
              open: [11.2, 11.05],
              high: [11.3, 11.2],
              low: [11, 10.8],
              close: [11.136, 10.9599],
              volume: [1_000_000, 2_000_000],
            }],
          },
        }],
        error: null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const provider = new YahooCandleProvider(
      new ProviderHttpClient({
        fetcher,
        logger: () => undefined,
        sleep: async () => undefined,
      }),
      () => new Date('2026-07-25T00:00:00.000Z'),
    );
    const result = await provider.getQuote('NVTS');
    expect(result.data).toMatchObject({
      price: 10.9599,
      previousClose: 11.136,
      previousRegularClose: 11.136,
      previousCloseSource: 'yahoo-chart-meta.previousClose',
      session: 'closed',
    });
    expect(result.data.change).toBeCloseTo(-0.1761);
    expect(result.data.changePercent).toBeCloseTo(-1.5814, 3);
  });

  it('uses the previous completed trading candle when Yahoo meta has no comparison close', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      chart: {
        result: [{
          meta: {
            symbol: 'AAPL',
            currency: 'USD',
            exchangeTimezoneName: 'America/New_York',
            marketState: 'REGULAR',
            regularMarketPrice: 201,
            regularMarketTime: Date.parse('2026-07-24T16:00:00.000Z') / 1_000,
          },
          timestamp: [
            Date.parse('2026-07-22T13:30:00.000Z') / 1_000,
            Date.parse('2026-07-23T13:30:00.000Z') / 1_000,
            Date.parse('2026-07-24T13:30:00.000Z') / 1_000,
          ],
          indicators: {
            quote: [{
              open: [198, 199, 200],
              high: [200, 201, 202],
              low: [197, 198, 199],
              close: [199, 200, 201],
              volume: [1, 1, 1],
            }],
          },
        }],
        error: null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const provider = new YahooCandleProvider(
      new ProviderHttpClient({
        fetcher,
        logger: () => undefined,
        sleep: async () => undefined,
      }),
      () => new Date('2026-07-24T16:00:00.000Z'),
    );
    const result = await provider.getQuote('AAPL');
    expect(result.data).toMatchObject({
      price: 201,
      previousRegularClose: 200,
      change: 1,
      changePercent: 0.5,
      previousCloseSource: 'yahoo-chart.previous-completed-daily-candle',
      session: 'regular',
    });
    const alignedToPriorSession = await provider.getQuote('AAPL', '2026-07-23');
    expect(alignedToPriorSession.data).toMatchObject({
      price: 201,
      previousRegularClose: 199,
      previousCloseSource: 'yahoo-chart.previous-completed-daily-candle',
    });
  });

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
