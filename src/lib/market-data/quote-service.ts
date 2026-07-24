import 'server-only';
import { MarketDataError } from './errors';
import { getYahooChartProvider } from './candles';
import { getMarketDataGateway } from './gateway/service';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import type { ResolvedInstrument } from './gateway/contracts';
import type { ProviderResult, Quote } from './types';

export interface ResilientQuoteDiagnostics {
  symbol: string;
  routeStatus: number;
  provider: string;
  providerStatus: number | null;
  failureKind:
    | 'none'
    | 'upstream-entitlement'
    | 'upstream-not-found'
    | 'comparison-close-rescued'
    | 'comparison-close-unavailable';
}

export interface ResilientQuoteResult extends ProviderResult<Quote> {
  diagnostics: ResilientQuoteDiagnostics;
}

type QuoteGateway = {
  resolveInstrument(symbol: string): Promise<ResolvedInstrument>;
  getQuote(input: { instrument: ResolvedInstrument }): Promise<{
    symbol: string;
    currency: string | null;
    price: number;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    previousClose: number | null;
    change: number | null;
    changePercent: number | null;
    volume?: number | null;
    timestamp: number;
    provider: string;
    status: 'real-time' | 'delayed' | 'end-of-day' | 'cached' | 'stale';
  }>;
};

type YahooQuoteProvider = {
  getQuote(
    symbol: string,
    comparisonForTradingDay?: string,
  ): Promise<ProviderResult<Quote>>;
};

function shouldUseYahoo(cause: unknown): cause is MarketDataError {
  return cause instanceof MarketDataError
    && (cause.code === 'forbidden' || cause.code === 'not-found');
}

const yahooQuoteCache = new SharedRequestCache();

async function loadYahooQuote(
  symbol: string,
  yahoo: YahooQuoteProvider,
  comparisonForTradingDay?: string,
): Promise<ProviderResult<Quote>> {
  if (yahoo !== getYahooChartProvider()) {
    return yahoo.getQuote(symbol, comparisonForTradingDay);
  }
  const resolved = await yahooQuoteCache.resolve(
    `market-quote:yahoo:${symbol}:${comparisonForTradingDay ?? 'latest'}`,
    () => yahoo.getQuote(symbol, comparisonForTradingDay),
    { freshMs: 60_000, staleMs: 24 * 60 * 60_000, errorMs: 30_000 },
  );
  if (resolved.state === 'fresh') return resolved.value;
  return {
    ...resolved.value,
    freshness: {
      ...resolved.value.freshness,
      status: resolved.state === 'stale' ? 'stale' : 'cached',
      cachedAt: new Date(resolved.storedAt).toISOString(),
    },
  };
}

function tradingDay(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp * 1_000));
}

/**
 * Provider-first server pipeline. Only a typed entitlement/not-found outcome
 * may move to Yahoo; invalid symbols, auth/config faults, rate limits and
 * transient errors remain visible and are never silently replaced.
 */
export async function loadResilientQuote(
  symbol: string,
  gateway: QuoteGateway = getMarketDataGateway(),
  yahoo: YahooQuoteProvider = getYahooChartProvider(),
  resolvedInstrument?: ResolvedInstrument,
): Promise<ResilientQuoteResult> {
  try {
    const instrument = resolvedInstrument ?? await gateway.resolveInstrument(symbol);
    const quote = await gateway.getQuote({ instrument });
    const quoteTimestamp = new Date(quote.timestamp * 1_000).toISOString();
    const primary: ResilientQuoteResult = {
      data: {
        symbol: quote.symbol,
        currency: quote.currency,
        price: quote.price,
        open: quote.open ?? null,
        high: quote.high ?? null,
        low: quote.low ?? null,
        previousClose: quote.previousClose,
        previousRegularClose: quote.previousClose,
        change: quote.change,
        changePercent: quote.changePercent,
        volume: quote.volume == null ? null : Math.round(quote.volume),
        latestTradingDay: quoteTimestamp.slice(0, 10),
        quoteTimestamp,
        session: 'unknown',
        priceSource: `${quote.provider}.quote`,
        previousCloseSource: quote.previousClose === null
          ? null : `${quote.provider}.previousClose`,
      },
      provider: quote.provider,
      freshness: {
        status: quote.status === 'real-time' ? 'realtime' : quote.status,
        asOf: quoteTimestamp,
        maxAgeSeconds: quote.status === 'real-time' ? 15 : 60,
      },
      diagnostics: {
        symbol,
        routeStatus: 200,
        provider: quote.provider,
        providerStatus: 200,
        failureKind: 'none',
      },
    };
    if (
      quote.previousClose !== null
      && Number.isFinite(quote.previousClose)
      && quote.previousClose > 0
    ) {
      return primary;
    }
    try {
      const comparison = await loadYahooQuote(
        symbol,
        yahoo,
        tradingDay(quote.timestamp, instrument.timezone),
      );
      const previousRegularClose = comparison.data.previousRegularClose
        ?? comparison.data.previousClose;
      if (
        previousRegularClose === null
        || previousRegularClose === undefined
        || !Number.isFinite(previousRegularClose)
        || previousRegularClose <= 0
      ) {
        return {
          ...primary,
          diagnostics: {
            ...primary.diagnostics,
            provider: `${quote.provider}+${comparison.provider ?? 'yahoo-finance-chart'}`,
            failureKind: 'comparison-close-unavailable',
          },
        };
      }
      const change = quote.price - previousRegularClose;
      return {
        ...primary,
        data: {
          ...primary.data,
          previousClose: previousRegularClose,
          previousRegularClose,
          change,
          changePercent: change / previousRegularClose * 100,
          previousCloseSource: comparison.data.previousCloseSource
            ?? `${comparison.provider ?? 'yahoo-finance-chart'}.previousClose`,
        },
        diagnostics: {
          ...primary.diagnostics,
          provider: `${quote.provider}+${comparison.provider ?? 'yahoo-finance-chart'}`,
          failureKind: 'comparison-close-rescued',
        },
      };
    } catch {
      // The primary quote remains valid. The missing comparison close is made
      // explicit in diagnostics and all change fields stay null.
      return {
        ...primary,
        diagnostics: {
          ...primary.diagnostics,
          failureKind: 'comparison-close-unavailable',
        },
      };
    }
  } catch (cause) {
    if (!shouldUseYahoo(cause)) throw cause;
    const fallback = await loadYahooQuote(symbol, yahoo);
    return {
      ...fallback,
      diagnostics: {
        symbol,
        routeStatus: 200,
        provider: fallback.provider ?? 'yahoo-finance-chart',
        providerStatus: cause.status,
        failureKind: cause.code === 'forbidden'
          ? 'upstream-entitlement' : 'upstream-not-found',
      },
    };
  }
}
