import { describe, expect, it, vi } from 'vitest';
import { ProviderHttpClient } from '../../provider-http';
import { CandleMarketDataService } from '../../candles/service';
import { YahooCandleProvider } from './candles';

vi.mock('server-only', () => ({}));

interface ChartRow {
  timestamp: number[];
  open: unknown[];
  high: unknown[];
  low: unknown[];
  close: unknown[];
  volume: unknown[];
  adjclose?: unknown[];
}

function chartPayload(meta: Record<string, unknown>, rows: ChartRow) {
  return {
    chart: {
      result: [{
        meta: {
          symbol: 'AAPL',
          currency: 'USD',
          exchangeTimezoneName: 'America/New_York',
          exchangeDataDelayedBy: 0,
          ...meta,
        },
        timestamp: rows.timestamp,
        indicators: {
          quote: [{ open: rows.open, high: rows.high, low: rows.low, close: rows.close, volume: rows.volume }],
          ...(rows.adjclose ? { adjclose: [{ adjclose: rows.adjclose }] } : {}),
        },
      }],
      error: null,
    },
  };
}

function providerFor(payload: unknown, now: string) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
  const provider = new YahooCandleProvider(
    new ProviderHttpClient({ fetcher, logger: () => undefined, sleep: async () => undefined }),
    () => new Date(now),
  );
  return { provider, fetcher };
}

const DAY = 86_400;
/** 2026-07-20 .. 2026-07-24, 13:30Z = 09:30 America/New_York. */
const MON = Date.parse('2026-07-20T13:30:00.000Z') / 1_000;

describe('Yahoo adjusted history', () => {
  it('joins the adjusted close by row position before any row is dropped', async () => {
    // Row index 1 is unusable (no open). An index-based join performed *after*
    // filtering would attach index 1's adjusted close to index 2's price row and
    // silently rescale a real bar. The join happens on the raw provider arrays,
    // so every surviving bar keeps its own adjusted close.
    const { provider } = providerFor(chartPayload({ marketState: 'CLOSED' }, {
      timestamp: [MON, MON + DAY, MON + 2 * DAY],
      open: [10, null, 30],
      high: [11, 21, 31],
      low: [9, 19, 29],
      close: [10, 20, 30],
      volume: [100, 200, 300],
      adjclose: [5, 10, 15],
    }), '2026-07-25T00:00:00.000Z');

    const result = await provider.getCandles({
      symbol: 'AAPL', interval: '1D', sourceInterval: '1D', range: '1m', adjusted: true, session: 'regular',
    });

    expect(result.warnings).toContain('Discarded 1 invalid provider candles');
    expect(result.candles.map((bar) => [bar.timestamp, bar.close, bar.adjustedClose])).toEqual([
      [MON, 5, 5],
      [MON + 2 * DAY, 15, 15],
    ]);
    // factor = adjustedClose / rawClose, applied to O/H/L, adjusted close verbatim.
    expect(result.candles[0]).toMatchObject({ open: 5, high: 5.5, low: 4.5, close: 5 });
    expect(result.candles[1]).toMatchObject({ open: 15, high: 15.5, low: 14.5, close: 15 });
    expect(result.adjusted).toBe(true);
  });

  it('never mixes raw and adjusted prices in one series', async () => {
    // The middle row has no adjusted close. An adjusted request drops it rather
    // than emitting one raw bar inside an adjusted series.
    const { provider } = providerFor(chartPayload({ marketState: 'CLOSED' }, {
      timestamp: [MON, MON + DAY, MON + 2 * DAY],
      open: [10, 20, 30],
      high: [11, 21, 31],
      low: [9, 19, 29],
      close: [10, 20, 30],
      volume: [100, 200, 300],
      adjclose: [5, null, 15],
    }), '2026-07-25T00:00:00.000Z');

    const adjusted = await provider.getCandles({
      symbol: 'AAPL', interval: '1D', sourceInterval: '1D', range: '1m', adjusted: true, session: 'regular',
    });
    expect(adjusted.candles.map((bar) => bar.timestamp)).toEqual([MON, MON + 2 * DAY]);
    expect(adjusted.candles.every((bar) => bar.close === bar.adjustedClose)).toBe(true);

    // The same payload requested raw keeps every valid row at its traded price.
    const raw = await provider.getCandles({
      symbol: 'AAPL', interval: '1D', sourceInterval: '1D', range: '1m', adjusted: false, session: 'regular',
    });
    expect(raw.candles.map((bar) => bar.close)).toEqual([10, 20, 30]);
    expect(raw.adjusted).toBe(false);
    expect(raw.warnings).toContain('Historical prices are unadjusted');
  });

  it('refuses an adjusted intraday series instead of quietly serving raw prints', async () => {
    const { provider } = providerFor(chartPayload({ marketState: 'REGULAR' }, {
      timestamp: [MON], open: [10], high: [11], low: [9], close: [10], volume: [1],
    }), '2026-07-20T14:00:00.000Z');
    await expect(provider.getCandles({
      symbol: 'AAPL', interval: '5m', sourceInterval: '5m', range: '1d', adjusted: true, session: 'regular',
    })).rejects.toThrow('Adjusted intraday candles are not available');
  });
});

describe('Yahoo daily bucket completeness by market session', () => {
  const rows: ChartRow = {
    timestamp: [MON + 3 * DAY, MON + 4 * DAY],
    open: [100, 102],
    high: [103, 105],
    low: [99, 101],
    close: [102, 104],
    volume: [500, 250],
  };

  async function dailyPartial(marketState: string, now: string): Promise<boolean | undefined> {
    const { provider } = providerFor(chartPayload({ marketState }, rows), now);
    const result = await provider.getCandles({
      symbol: 'AAPL', interval: '1D', sourceInterval: '1D', range: '1m', adjusted: false, session: 'regular',
    });
    return result.candles.at(-1)?.partial;
  }

  it('marks today unfinished during PRE and REGULAR', async () => {
    // Yahoo returns today's row with the live price as its close while the
    // session runs. Reading it as a completed bar would put the classic-pivot
    // basis, the previous-close comparison and the S/R statistics on half a day.
    expect(await dailyPartial('PRE', '2026-07-24T12:00:00.000Z')).toBe(true);
    expect(await dailyPartial('REGULAR', '2026-07-24T17:00:00.000Z')).toBe(true);
  });

  it('treats the daily bar as complete once the regular session has ended', async () => {
    // POST and CLOSED both mean the regular session is done, so the daily bucket
    // really is finished and analytics may use it.
    expect(await dailyPartial('POST', '2026-07-24T21:00:00.000Z')).toBe(false);
    expect(await dailyPartial('CLOSED', '2026-07-25T02:00:00.000Z')).toBe(false);
  });

  it('never marks a bar from an earlier session unfinished', async () => {
    // Mid-session on a later day: the newest row is not today, so it is complete.
    expect(await dailyPartial('REGULAR', '2026-07-27T17:00:00.000Z')).toBe(false);
  });
});

describe('Yahoo previous regular close priority', () => {
  it('falls back to chartPreviousClose only when neither meta nor a completed candle exists', async () => {
    const { provider } = providerFor({
      chart: {
        result: [{
          meta: {
            symbol: 'AAPL',
            currency: 'USD',
            exchangeTimezoneName: 'America/New_York',
            marketState: 'REGULAR',
            regularMarketPrice: 210,
            regularMarketTime: Date.parse('2026-07-24T16:00:00.000Z') / 1_000,
            chartPreviousClose: 200,
          },
          // The only row IS today, so there is no completed earlier candle.
          timestamp: [Date.parse('2026-07-24T13:30:00.000Z') / 1_000],
          indicators: { quote: [{ open: [205], high: [212], low: [204], close: [210], volume: [10] }] },
        }],
        error: null,
      },
    }, '2026-07-24T16:00:00.000Z');

    const result = await provider.getQuote('AAPL');
    expect(result.data).toMatchObject({
      price: 210,
      previousRegularClose: 200,
      previousCloseSource: 'yahoo-chart-meta.chartPreviousClose',
      session: 'regular',
    });
    expect(result.data.change).toBeCloseTo(10);
  });

  it('classifies PRE, REGULAR, POST and CLOSED from the provider session, never local time', async () => {
    const sessions: Array<[string, string]> = [
      ['PRE', 'pre-market'],
      ['REGULAR', 'regular'],
      ['POST', 'after-hours'],
      ['CLOSED', 'closed'],
    ];
    for (const [marketState, expected] of sessions) {
      const { provider } = providerFor({
        chart: {
          result: [{
            meta: {
              symbol: 'AAPL', currency: 'USD', exchangeTimezoneName: 'America/New_York',
              marketState,
              regularMarketPrice: 210,
              regularMarketTime: Date.parse('2026-07-24T20:00:00.000Z') / 1_000,
              previousClose: 200,
            },
            timestamp: [Date.parse('2026-07-23T13:30:00.000Z') / 1_000],
            indicators: { quote: [{ open: [199], high: [201], low: [198], close: [200], volume: [10] }] },
          }],
          error: null,
        },
      }, '2026-07-24T21:00:00.000Z');
      const result = await provider.getQuote('AAPL');
      expect(result.data.session, marketState).toBe(expected);
      // The main price is always the regular-session price, so a pre/post quote
      // can never replace the regular row.
      expect(result.data.priceSource).toBe('yahoo-chart-meta.regularMarketPrice');
    }
  });
});

describe('Stock Detail chart historical service', () => {
  it('resolves 12 เดือน and 5Y through Yahoo with no other provider attempted', async () => {
    for (const range of ['1y', '5y'] as const) {
      const { provider, fetcher } = providerFor(chartPayload({ marketState: 'CLOSED' }, {
        timestamp: [MON, MON + DAY],
        open: [10, 11], high: [12, 13], low: [9, 10], close: [11, 12], volume: [100, 200],
        adjclose: [11, 12],
      }), '2026-07-25T00:00:00.000Z');
      const service = new CandleMarketDataService([provider]);

      const result = await service.getCandles({
        symbol: 'AAPL', interval: '1D', range, adjusted: true, session: 'regular',
      });

      expect(result.provider).toBe('yahoo-finance-chart');
      expect(result.data.attemptedProviders).toEqual(['yahoo-finance-chart']);
      expect(result.data.requestedRange).toBe(range);
      expect(result.data.aggregated).toBe(false);
      expect(new URL(String(fetcher.mock.calls[0][0])).hostname).toBe('query1.finance.yahoo.com');
      // Exactly one upstream call per range: no Polygon, no second provider.
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('aggregates an unsupported interval from real Yahoo source candles only', async () => {
    // 45m is not a Yahoo resolution: it is built from 15m source bars with
    // O=first, H=max, L=min, C=last, V=sum and no invented buckets.
    const quarterHours = [0, 1, 2, 3].map((step) => MON + step * 900);
    const { provider, fetcher } = providerFor(chartPayload({ marketState: 'CLOSED' }, {
      timestamp: quarterHours,
      open: [10, 11, 12, 13],
      high: [11, 12, 13, 14],
      low: [9, 10, 11, 12],
      close: [11, 12, 13, 14],
      volume: [10, 20, 30, 40],
    }), '2026-07-21T00:00:00.000Z');
    const service = new CandleMarketDataService([provider]);

    const result = await service.getCandles({
      symbol: 'AAPL', interval: '45m', range: '5d', adjusted: false, session: 'regular',
    });

    expect(result.data.sourceInterval).toBe('15m');
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('interval')).toBe('15m');
    expect(result.data.aggregated).toBe(true);
    expect(result.data.candles).toHaveLength(2);
    expect(result.data.candles[0]).toMatchObject({
      timestamp: quarterHours[0], open: 10, high: 13, low: 9, close: 13, volume: 60,
    });
    // The trailing bucket has only one of three source bars, so it is unfinished.
    expect(result.data.candles[1]).toMatchObject({ timestamp: quarterHours[3], volume: 40, partial: true });
    // Strictly ascending, no duplicate timestamps.
    const times = result.data.candles.map((bar) => bar.timestamp);
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(new Set(times).size).toBe(times.length);
  });
});

describe('Yahoo empty-window handling (production 502 regression)', () => {
  /**
   * A window with no trading — a weekend, a market holiday, or before the open —
   * comes back from Yahoo as HTTP 200 with `chart.error: null`, a fully populated
   * `meta`, an EMPTY `indicators.quote[0]` and **no `timestamp` key at all**.
   * Requiring that key classified this truthful "nothing traded here" as
   * `invalid-provider-response`, which the route surfaced as HTTP 502 and the
   * chart rendered as a validation failure. It must be a no-data state instead.
   */
  const emptyWindow = {
    chart: {
      result: [{
        meta: {
          symbol: 'AAPL', currency: 'USD', exchangeTimezoneName: 'America/New_York',
          exchangeDataDelayedBy: 0, regularMarketPrice: 210,
          regularMarketTime: Date.parse('2026-07-24T20:00:00.000Z') / 1_000,
          previousClose: 208,
        },
        // No `timestamp` key, and an empty quote object — exactly the real payload.
        indicators: { quote: [{}] },
      }],
      error: null,
    },
  };

  it('reports an empty window as insufficient data, never as a malformed response', async () => {
    const { provider } = providerFor(emptyWindow, '2026-07-26T06:30:00.000Z');
    await expect(provider.getCandles({
      symbol: 'AAPL', interval: '1m', sourceInterval: '1m', range: '1d', adjusted: false, session: 'regular',
    })).rejects.toMatchObject({ code: 'insufficient-data' });
  });

  it('tolerates a missing indicators.quote entry as well', async () => {
    const { provider } = providerFor({
      chart: { result: [{ ...emptyWindow.chart.result[0], indicators: {} }], error: null },
    }, '2026-07-26T06:30:00.000Z');
    await expect(provider.getCandles({
      symbol: 'AAPL', interval: '1m', sourceInterval: '1m', range: '1d', adjusted: false, session: 'regular',
    })).rejects.toMatchObject({ code: 'insufficient-data' });
  });

  it('still rejects a genuinely malformed payload', async () => {
    const { provider } = providerFor({ chart: { result: [{ meta: {} }], error: null } }, '2026-07-26T06:30:00.000Z');
    await expect(provider.getCandles({
      symbol: 'AAPL', interval: '1m', sourceInterval: '1m', range: '1d', adjusted: false, session: 'regular',
    })).rejects.toMatchObject({ code: 'invalid-provider-response' });
  });

  it('marks todays daily bar unfinished from the verified session when marketState is absent', async () => {
    // Yahoo does not always send `marketState`. The fallback is the app's
    // exchange-session classifier, never the reader's local clock.
    const rows: ChartRow = {
      timestamp: [Date.parse('2026-07-23T13:30:00.000Z') / 1_000, Date.parse('2026-07-24T13:30:00.000Z') / 1_000],
      open: [100, 102], high: [103, 105], low: [99, 101], close: [102, 104], volume: [500, 250],
    };
    // 2026-07-24 16:00Z = 12:00 America/New_York → inside the regular session.
    const during = providerFor(chartPayload({}, rows), '2026-07-24T16:00:00.000Z');
    const mid = await during.provider.getCandles({
      symbol: 'AAPL', interval: '1D', sourceInterval: '1D', range: '1m', adjusted: false, session: 'regular',
    });
    expect(mid.candles.at(-1)?.partial).toBe(true);

    // The following Sunday: no session is running, so the bar is complete.
    const closed = providerFor(chartPayload({}, rows), '2026-07-26T06:30:00.000Z');
    const weekend = await closed.provider.getCandles({
      symbol: 'AAPL', interval: '1D', sourceInterval: '1D', range: '1m', adjusted: false, session: 'regular',
    });
    expect(weekend.candles.at(-1)?.partial).toBe(false);
  });
});
