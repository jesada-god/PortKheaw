import { describe, expect, it, vi } from 'vitest';
import { YahooHistoricalProvider } from './historical';

vi.mock('server-only', () => ({}));

describe('Yahoo historical adapter', () => {
  it('reuses validated adjusted daily chart candles for the Beta history contract', async () => {
    const getCandles = vi.fn(async () => ({
      data: {
        candles: [{
          timestamp: Date.parse('2026-07-24T20:00:00.000Z') / 1_000,
          open: 100,
          high: 105,
          low: 99,
          close: 104,
          volume: 1234.4,
        }],
        provider: 'yahoo-finance-chart',
        fallbackReason: null,
        dataStatus: 'end-of-day',
        cacheStatus: 'miss',
        warnings: [],
      },
      provider: 'yahoo-finance-chart',
      freshness: {
        status: 'end-of-day',
        asOf: '2026-07-24T20:00:00.000Z',
        maxAgeSeconds: 21_600,
      },
    }));

    const result = await new YahooHistoricalProvider({ getCandles } as never)
      .getHistoricalPrices('spy', '5y');

    expect(getCandles).toHaveBeenCalledWith({
      symbol: 'SPY',
      interval: '1D',
      range: '5y',
      adjusted: true,
      session: 'regular',
    });
    expect(result).toMatchObject({
      provider: 'yahoo-finance-chart',
      data: {
        symbol: 'SPY',
        range: '5y',
        interval: '1d',
        prices: [{
          date: '2026-07-24',
          close: 104,
          volume: 1234,
        }],
      },
    });
  });
});
