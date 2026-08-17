import { describe, expect, it, vi } from 'vitest';
import { ProviderHttpClient } from '../../provider-http';
import { YahooCandleProvider } from './candles';

vi.mock('server-only', () => ({}));

/**
 * The provider adapter, which is the only place the app's `GC-F` becomes Yahoo's
 * `GC=F`.
 *
 * Two properties are asserted together because either one alone would be a bug:
 * the REQUEST has to carry the provider's spelling or Yahoo returns nothing, and
 * the RESULT has to carry the app's spelling or every downstream symbol check —
 * the overview card's, the accepted-price resolver's — rejects the data as
 * belonging to a different instrument.
 */
function providerWith(payload: unknown, fetcher = vi.fn<typeof fetch>(async () => new Response(
  JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } },
))) {
  const provider = new YahooCandleProvider(
    new ProviderHttpClient({ fetcher, logger: () => undefined, sleep: async () => undefined }),
    () => new Date('2026-08-17T15:00:00.000Z'),
  );
  return { provider, fetcher };
}

const goldPayload = {
  chart: {
    result: [{
      meta: {
        symbol: 'GC=F',
        currency: 'USD',
        exchangeTimezoneName: 'America/Chicago',
        exchangeDataDelayedBy: 0,
        marketState: 'REGULAR',
        regularMarketPrice: 3_412.5,
        regularMarketTime: Date.parse('2026-08-17T14:55:00.000Z') / 1_000,
        regularMarketOpen: 3_400,
        regularMarketDayHigh: 3_420,
        regularMarketDayLow: 3_395,
        regularMarketVolume: 120_000,
        previousClose: 3_390,
      },
      timestamp: [
        Date.parse('2026-08-14T14:30:00.000Z') / 1_000,
        Date.parse('2026-08-17T14:30:00.000Z') / 1_000,
      ],
      indicators: {
        quote: [{
          open: [3_380, 3_400],
          high: [3_395, 3_420],
          low: [3_370, 3_395],
          close: [3_390, 3_412.5],
          volume: [100_000, 120_000],
        }],
      },
    }],
    error: null,
  },
};

function requestedSymbol(fetcher: ReturnType<typeof vi.fn>): string {
  const target = fetcher.mock.calls[0]?.[0];
  const url = target instanceof URL ? target : new URL(String(target));
  return decodeURIComponent(url.pathname.split('/').pop() ?? '');
}

describe('Yahoo provider commodity symbol adapter', () => {
  it('asks Yahoo for GC=F when the app asks for GC-F, and answers as GC-F', async () => {
    const { provider, fetcher } = providerWith(goldPayload);
    const result = await provider.getQuote('GC-F');
    expect(requestedSymbol(fetcher)).toBe('GC=F');
    expect(result.data.symbol).toBe('GC-F');
    expect(result.data.price).toBe(3_412.5);
  });

  it('accepts the provider echoing its own spelling rather than rejecting the payload', async () => {
    // The guard compares against what was ASKED FOR. Before the adapter it
    // compared against the app symbol, so a correct `GC=F` response would have
    // been thrown away as "symbol did not match the request".
    const { provider } = providerWith(goldPayload);
    await expect(provider.getQuote('GC-F')).resolves.toMatchObject({ data: { symbol: 'GC-F' } });
  });

  it('still rejects a payload about a genuinely different instrument', async () => {
    const { provider } = providerWith({
      ...goldPayload,
      chart: {
        ...goldPayload.chart,
        result: [{
          ...goldPayload.chart.result[0],
          meta: { ...goldPayload.chart.result[0].meta, symbol: 'SI=F' },
        }],
      },
    });
    await expect(provider.getQuote('GC-F')).rejects.toThrow(/did not match the request/);
  });

  it('requests candles under the provider spelling and returns them under the app one', async () => {
    const { provider, fetcher } = providerWith(goldPayload);
    const result = await provider.getCandles({
      symbol: 'CL-F', interval: '5m', sourceInterval: '5m', range: '1d',
      adjusted: false, session: 'regular',
    });
    expect(requestedSymbol(fetcher)).toBe('CL=F');
    expect(result.symbol).toBe('CL-F');
  });

  /** The regression that protects every non-commodity surface. */
  it('leaves an equity symbol untouched in both directions', async () => {
    const { provider, fetcher } = providerWith({
      ...goldPayload,
      chart: {
        ...goldPayload.chart,
        result: [{
          ...goldPayload.chart.result[0],
          meta: {
            ...goldPayload.chart.result[0].meta,
            symbol: 'AAPL',
            exchangeTimezoneName: 'America/New_York',
          },
        }],
      },
    });
    const result = await provider.getQuote('AAPL');
    expect(requestedSymbol(fetcher)).toBe('AAPL');
    expect(result.data.symbol).toBe('AAPL');
  });
});
