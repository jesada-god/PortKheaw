import 'server-only';
import { z, ZodError } from 'zod';
import { MarketDataError } from '../../errors';
import { ProviderHttpClient } from '../../provider-http';
import { YAHOO_CANDLE_CAPABILITIES } from '../../candles/capabilities';
import { applyAdjustment, normalizeCandles, validatedCandle } from '../../candles/normalize';
import { candleRangeBounds } from '../../candles/range';
import type { ProviderResult, Quote } from '../../types';
import type { CandleInterval, CandleRequest, NormalizedCandleResult, NormalizedMarketDataProvider } from '../../candles/contracts';

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const MAX_CANDLES = 20_000;
const INTERVALS: Partial<Record<CandleInterval, string>> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m',
  '1D': '1d', Week: '1wk', Month: '1mo',
};

const chartSchema = z.object({
  chart: z.object({
    result: z.array(z.object({
      meta: z.object({
        symbol: z.string().optional(),
        currency: z.string().nullable().optional(),
        exchangeTimezoneName: z.string().optional(),
        exchangeDataDelayedBy: z.number().int().nonnegative().optional(),
        marketState: z.string().optional(),
        regularMarketPrice: z.number().finite().positive().optional(),
        regularMarketTime: z.number().int().positive().optional(),
        regularMarketOpen: z.number().finite().positive().optional(),
        regularMarketDayHigh: z.number().finite().positive().optional(),
        regularMarketDayLow: z.number().finite().positive().optional(),
        regularMarketVolume: z.number().finite().nonnegative().optional(),
        previousClose: z.number().finite().positive().optional(),
        chartPreviousClose: z.number().finite().positive().optional(),
      }).passthrough(),
      timestamp: z.array(z.number().int()),
      indicators: z.object({
        quote: z.array(z.object({
          open: z.array(z.unknown()).optional(),
          high: z.array(z.unknown()).optional(),
          low: z.array(z.unknown()).optional(),
          close: z.array(z.unknown()).optional(),
          volume: z.array(z.unknown()).optional(),
        }).passthrough()).min(1),
        adjclose: z.array(z.object({ adjclose: z.array(z.unknown()).optional() }).passthrough()).optional(),
      }).passthrough(),
    }).passthrough()).nullable(),
    error: z.object({ code: z.string().nullable(), description: z.string().nullable() }).nullable(),
  }),
});

function intervalSeconds(interval: CandleInterval): number {
  if (interval === '1m') return 60;
  if (interval === '5m') return 300;
  if (interval === '15m') return 900;
  if (interval === '30m') return 1_800;
  if (interval === '1h') return 3_600;
  return 86_400;
}

function marketSession(value: string | undefined): Quote['session'] {
  switch (value?.trim().toUpperCase()) {
    case 'PRE':
    case 'PREPRE':
      return 'pre-market';
    case 'REGULAR':
      return 'regular';
    case 'POST':
    case 'POSTPOST':
      return 'after-hours';
    case 'CLOSED':
      return 'closed';
    default:
      return 'unknown';
  }
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function quoteDate(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp * 1_000));
}

export interface YahooQuoteResult extends ProviderResult<Quote> {
  diagnostics: {
    providerStatus: number;
    failureKind: 'upstream-entitlement-fallback';
    previousCloseSource: string | null;
  };
}

function exchangePeriodKey(timestamp: number, timeZone: string, interval: '1D' | 'Week' | 'Month'): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp * 1_000));
  if (interval === '1D') return date;
  if (interval === 'Month') return date.slice(0, 7);
  const parsed = new Date(`${date}T12:00:00.000Z`);
  const day = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(parsed.getUTCFullYear(), 0, 1));
  return `${parsed.getUTCFullYear()}-${Math.ceil((((parsed.valueOf() - yearStart.valueOf()) / 86_400_000) + 1) / 7)}`;
}

export class YahooCandleProvider implements NormalizedMarketDataProvider {
  readonly id = 'yahoo-finance-chart';

  constructor(
    private readonly http = new ProviderHttpClient(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  getCapabilities() { return YAHOO_CANDLE_CAPABILITIES; }

  /**
   * Server-side regular-session quote fallback built from the same validated
   * Yahoo Chart JSON pipeline as candles. The main price is always
   * `regularMarketPrice` (including PRE/POST), so an extended quote can never
   * replace the regular-session header row.
   */
  async getQuote(
    symbol: string,
    comparisonForTradingDay?: string,
  ): Promise<YahooQuoteResult> {
    const bounds = candleRangeBounds('1m', this.now());
    const url = new URL(`${BASE_URL}/${encodeURIComponent(symbol)}`);
    url.searchParams.set('interval', '1d');
    url.searchParams.set('period1', String(bounds.period1));
    url.searchParams.set('period2', String(bounds.period2));
    url.searchParams.set('includePrePost', 'false');
    url.searchParams.set('events', 'div,splits');
    const payload = await this.http.json({
      provider: this.id,
      operation: 'quote-fallback',
      route: '/api/market/quote/[symbol]',
      symbol,
      url,
      init: { cache: 'no-store' },
      timeoutMs: 10_000,
      maxAttempts: 2,
    });
    try {
      const parsed = chartSchema.parse(payload);
      const result = parsed.chart.result?.[0];
      if (!result || parsed.chart.error) {
        throw new MarketDataError('not-found', `No Yahoo quote was returned for ${symbol}`);
      }
      const canonical = result.meta.symbol?.trim().toUpperCase();
      if (canonical && canonical !== symbol.trim().toUpperCase()) {
        throw new MarketDataError('invalid-provider-response', 'Yahoo quote symbol did not match the request');
      }
      const price = positiveNumber(result.meta.regularMarketPrice);
      const timestamp = result.meta.regularMarketTime;
      if (!price || !timestamp) {
        throw new MarketDataError('insufficient-data', 'Yahoo quote did not include a regular market price and timestamp');
      }

      const normalizedRows = normalizeCandles(result.timestamp.map((time, index) => {
        const quote = result.indicators.quote[0];
        return validatedCandle({
          timestamp: time,
          open: quote.open?.[index],
          high: quote.high?.[index],
          low: quote.low?.[index],
          close: quote.close?.[index],
          volume: quote.volume?.[index],
          session: 'regular',
        });
      })).candles;
      const priceDate = quoteDate(timestamp, result.meta.exchangeTimezoneName ?? 'UTC');
      const comparisonDate = comparisonForTradingDay ?? priceDate;
      const completedBeforePrice = normalizedRows.filter((row) =>
        quoteDate(row.timestamp, result.meta.exchangeTimezoneName ?? 'UTC') < comparisonDate);
      const candlePreviousClose = completedBeforePrice.at(-1)?.close ?? null;
      const comparisonMatchesYahooPrice = comparisonDate === priceDate;
      const providerPreviousClose = comparisonMatchesYahooPrice
        ? positiveNumber(result.meta.previousClose) : null;
      const completedCandleClose = positiveNumber(candlePreviousClose);
      const chartPreviousClose = comparisonMatchesYahooPrice
        ? positiveNumber(result.meta.chartPreviousClose) : null;
      // `chartPreviousClose` can represent the close before the requested chart
      // range rather than the immediately previous session. Prefer the verified
      // completed daily candle whenever the explicit `previousClose` is absent.
      const previousRegularClose = providerPreviousClose
        ?? completedCandleClose
        ?? chartPreviousClose;
      const previousCloseSource = providerPreviousClose !== null
        ? 'yahoo-chart-meta.previousClose'
        : completedCandleClose !== null
          ? 'yahoo-chart.previous-completed-daily-candle'
          : chartPreviousClose !== null ? 'yahoo-chart-meta.chartPreviousClose' : null;
      const change = previousRegularClose === null ? null : price - previousRegularClose;
      const changePercent = previousRegularClose === null
        ? null
        : (change! / previousRegularClose) * 100;
      const delayedByMinutes = result.meta.exchangeDataDelayedBy ?? null;
      const session = marketSession(result.meta.marketState);
      const status = session === 'closed'
        ? 'end-of-day' as const
        : delayedByMinutes === 0 ? 'delayed' as const : 'delayed' as const;
      const quote: Quote = {
        symbol: symbol.trim().toUpperCase(),
        currency: result.meta.currency ?? null,
        price,
        open: positiveNumber(result.meta.regularMarketOpen),
        high: positiveNumber(result.meta.regularMarketDayHigh),
        low: positiveNumber(result.meta.regularMarketDayLow),
        previousClose: previousRegularClose,
        previousRegularClose,
        change,
        changePercent,
        volume: result.meta.regularMarketVolume == null
          ? null : Math.round(result.meta.regularMarketVolume),
        latestTradingDay: priceDate,
        quoteTimestamp: new Date(timestamp * 1_000).toISOString(),
        session,
        priceSource: 'yahoo-chart-meta.regularMarketPrice',
        previousCloseSource,
      };
      return {
        data: quote,
        provider: this.id,
        freshness: {
          status,
          asOf: quote.quoteTimestamp ?? null,
          maxAgeSeconds: status === 'end-of-day' ? 86_400 : 60,
        },
        diagnostics: {
          providerStatus: 403,
          failureKind: 'upstream-entitlement-fallback',
          previousCloseSource,
        },
      };
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof ZodError) {
        throw new MarketDataError('invalid-provider-response', 'Yahoo quote response did not match its validated schema');
      }
      throw cause;
    }
  }

  async getCandles(input: CandleRequest & { sourceInterval: CandleInterval }): Promise<NormalizedCandleResult> {
    const providerInterval = INTERVALS[input.sourceInterval];
    if (!providerInterval) throw new MarketDataError('unsupported', `Yahoo does not expose ${input.sourceInterval} as a source interval`);
    if (input.adjusted && !['1D', 'Week', 'Month'].includes(input.sourceInterval)) {
      throw new MarketDataError('unsupported', 'Adjusted intraday candles are not available from Yahoo Chart');
    }
    const bounds = input.period1 && input.period2
      ? { period1: input.period1, period2: input.period2 }
      : candleRangeBounds(input.range, this.now());
    const url = new URL(`${BASE_URL}/${encodeURIComponent(input.symbol)}`);
    url.searchParams.set('interval', providerInterval);
    url.searchParams.set('period1', String(bounds.period1));
    url.searchParams.set('period2', String(bounds.period2));
    url.searchParams.set('includePrePost', input.session === 'extended' ? 'true' : 'false');
    url.searchParams.set('events', 'div,splits');
    const payload = await this.http.json({
      provider: this.id,
      operation: `candles-${input.sourceInterval}`,
      route: '/api/market/candles',
      symbol: input.symbol,
      url,
      init: { cache: 'no-store' },
      timeoutMs: 10_000,
      maxAttempts: 2,
    });
    try {
      const parsed = chartSchema.parse(payload);
      const result = parsed.chart.result?.[0];
      if (!result || parsed.chart.error) throw new MarketDataError('not-found', `No Yahoo candles were returned for ${input.symbol}`);
      if (result.timestamp.length > MAX_CANDLES) throw new MarketDataError('invalid-provider-response', 'Yahoo candle response exceeded the safe row limit');
      const quote = result.indicators.quote[0];
      const adjusted = result.indicators.adjclose?.[0]?.adjclose ?? [];
      const rows = result.timestamp.map((timestamp, index) => {
        const candle = validatedCandle({
          timestamp,
          open: quote.open?.[index], high: quote.high?.[index], low: quote.low?.[index], close: quote.close?.[index],
          adjustedClose: adjusted[index], volume: quote.volume?.[index],
          session: 'regular',
        });
        return input.adjusted && candle?.adjustedClose === undefined ? null : candle;
      });
      const normalized = normalizeCandles(rows);
      const candles = input.adjusted ? normalized.candles.map(applyAdjustment) : normalized.candles;
      if (!candles.length) throw new MarketDataError('insufficient-data', `No valid ${input.sourceInterval} candles were returned for ${input.symbol}`);
      const delayedByMinutes = result.meta.exchangeDataDelayedBy ?? null;
      const marketState = result.meta.marketState?.toUpperCase();
      const last = candles.at(-1)!;
      const isCurrent = Math.floor(this.now().valueOf() / 1_000) - last.timestamp <= intervalSeconds(input.sourceInterval) * 3;
      const dataStatus = ['1D', 'Week', 'Month'].includes(input.sourceInterval)
        ? 'end-of-day' as const
        : delayedByMinutes === 0 && isCurrent && ['REGULAR', 'PRE', 'POST'].includes(marketState ?? '')
          ? 'live' as const : 'delayed' as const;
      if (dataStatus === 'live') last.partial = true;
      if (input.sourceInterval === 'Week' || input.sourceInterval === 'Month') {
        const timeZone = result.meta.exchangeTimezoneName ?? 'UTC';
        last.partial = exchangePeriodKey(last.timestamp, timeZone, input.sourceInterval)
          === exchangePeriodKey(Math.floor(this.now().valueOf() / 1_000), timeZone, input.sourceInterval);
      }
      if (input.sourceInterval === '1D') {
        // Yahoo returns today's row while the session is still running, with the
        // live price as its close. That bucket is NOT a completed daily bar, and
        // marking it truthfully is what keeps the classic-pivot basis, the
        // "previous completed regular daily candle" comparison close and the S/R
        // touch/hold/break statistics off an unfinished day. PRE has no traded
        // regular session yet; POST/CLOSED means the regular session is done, so
        // the daily bar is complete.
        const timeZone = result.meta.exchangeTimezoneName ?? 'UTC';
        const stillForming = ['PRE', 'PREPRE', 'REGULAR'].includes(marketState ?? '')
          && exchangePeriodKey(last.timestamp, timeZone, '1D')
            === exchangePeriodKey(Math.floor(this.now().valueOf() / 1_000), timeZone, '1D');
        last.partial = stillForming;
      }
      const warnings = [
        ...(normalized.invalidCount ? [`Discarded ${normalized.invalidCount} invalid provider candles`] : []),
        ...(!input.adjusted && ['1D', 'Week', 'Month'].includes(input.sourceInterval) ? ['Historical prices are unadjusted'] : []),
      ];
      return {
        symbol: input.symbol,
        provider: this.id,
        attemptedProviders: [this.id],
        requestedInterval: input.interval,
        actualInterval: input.sourceInterval,
        sourceInterval: input.sourceInterval,
        requestedRange: input.range,
        actualStart: candles[0]?.timestamp ?? null,
        actualEnd: last.timestamp,
        exchangeTimezone: result.meta.exchangeTimezoneName ?? 'UTC',
        currency: result.meta.currency ?? null,
        dataStatus,
        delayedByMinutes,
        adjusted: Boolean(input.adjusted),
        aggregated: false,
        cacheStatus: 'miss',
        candles,
        warnings,
        fallbackReason: null,
      };
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof ZodError) throw new MarketDataError('invalid-provider-response', 'Yahoo Chart response did not match its validated schema');
      throw cause;
    }
  }
}
