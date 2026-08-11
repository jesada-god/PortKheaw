import 'server-only';
import { getCompanyProfileService } from '@/src/lib/market-data';
import { MarketDataError } from '@/src/lib/market-data/errors';
import { getYahooChartProvider } from '@/src/lib/market-data/candles';
import { getMarketDataGateway } from '@/src/lib/market-data/gateway/service';
import { loadResilientQuote } from '@/src/lib/market-data/quote-service';
import { extendedQuoteMatchesRegularSession, type ExtendedHoursQuoteData } from '@/src/lib/market-data/extended-hours';
import type { NormalizedBarsResult, NormalizedMarketSession, NormalizedQuote, ResolvedInstrument } from '@/src/lib/market-data/gateway/contracts';
import type { CompanyProfile, DataFreshness, MarketDataApiError, MarketOverview, ProviderResult, Quote } from '@/src/lib/market-data/types';
import { continuousMarketAsset, type MarketAsset } from '@/src/lib/overview/market-assets';
import {
  continuousInstrument,
  continuousMarketStatus,
  continuousProfile,
  continuousAcceptedQuoteResource,
  continuousQuoteUnavailable,
  loadContinuousAcceptedMarket,
} from './continuous-snapshot';
import type { InitialHistoryResponse, StockDetailQuoteResource, StockDetailResource } from './types';

const unavailableFreshness: DataFreshness = { status: 'unavailable', asOf: null, maxAgeSeconds: null };

function failure(cause: unknown): { error: MarketDataApiError; reason: string } {
  const error = cause instanceof MarketDataError
    ? cause : new MarketDataError('upstream-unavailable', 'The requested data is temporarily unavailable');
  return { error: error.toApiError(), reason: `${error.code}: ${error.message}` };
}

function unavailable<T>(cause: unknown): StockDetailResource<T> {
  const failed = failure(cause);
  return { data: null, freshness: unavailableFreshness, provider: null, reason: failed.reason, error: failed.error };
}

function freshness(status: NormalizedQuote['status'], timestamp: number): DataFreshness {
  return {
    status: status === 'real-time' ? 'realtime' : status,
    asOf: new Date(timestamp * 1_000).toISOString(),
    maxAgeSeconds: status === 'real-time' ? 15 : 60,
  };
}

function legacyQuote(quote: NormalizedQuote): Quote {
  const quoteTimestamp = new Date(quote.timestamp * 1_000).toISOString();
  return {
    symbol: quote.symbol,
    currency: quote.currency,
    price: quote.price,
    open: quote.open ?? null,
    high: quote.high ?? null,
    low: quote.low ?? null,
    previousClose: quote.previousClose,
    regularClose: quote.regularClose ?? null,
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
  };
}

function localDate(seconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(seconds * 1_000));
}

function quoteFromBars(instrument: ResolvedInstrument, bars: NormalizedBarsResult): NormalizedQuote | null {
  const latest = bars.bars.at(-1);
  if (!latest) return null;
  /*
   * The displayed day's open/high/low/volume, not the last five-minute bucket's.
   * These bars are the regular session of a single day, so its FIRST bar is the
   * session open — taking `latest.open` here published a five-minute bucket as
   * "ราคาเปิด". Every field still comes from real bars; nothing is derived from
   * the price.
   */
  const day = bars.bars.filter((bar) => (
    localDate(bar.time, instrument.timezone) === localDate(latest.time, instrument.timezone)
  ));
  const session = day.length > 0 ? day : [latest];
  return {
    symbol: instrument.canonicalSymbol,
    price: latest.close,
    // A previous intraday bucket is not a previous regular-session close.
    previousClose: null,
    change: null,
    changePercent: null,
    timestamp: latest.time,
    provider: bars.provider,
    exchange: instrument.exchange,
    currency: instrument.currency,
    status: bars.dataStatus === 'cached' || bars.dataStatus === 'stale'
      ? bars.dataStatus : bars.dataStatus === 'end-of-day' ? 'end-of-day' : 'delayed',
    delayedByMinutes: bars.delayedByMinutes,
    open: session[0]!.open,
    high: Math.max(...session.map((bar) => bar.high)),
    low: Math.min(...session.map((bar) => bar.low)),
    volume: session.reduce((total, bar) => total + bar.volume, 0),
  };
}

function providerQuoteResource(result: ProviderResult<Quote>): StockDetailQuoteResource {
  return {
    data: result.data,
    freshness: result.freshness,
    provider: result.provider ?? null,
    reason: result.provider === 'yahoo-finance-chart'
      ? 'Primary quote entitlement unavailable; using the validated Yahoo regular-session quote.'
      : null,
    error: null,
    fallbackLabel: null,
  };
}

function quoteResource(quote: NormalizedQuote, fallback: boolean): StockDetailQuoteResource {
  return {
    data: legacyQuote(quote),
    freshness: freshness(quote.status, quote.timestamp),
    provider: quote.provider,
    reason: fallback ? 'Primary quote unavailable; using the latest Polygon chart bar' : null,
    error: null,
    fallbackLabel: fallback ? 'Intraday close fallback' : null,
  };
}

function overviewResource(session: NormalizedMarketSession): StockDetailResource<MarketOverview> {
  return {
    data: { markets: [{
      marketType: 'Equity',
      region: 'United States',
      primaryExchanges: session.exchange ? [session.exchange] : [],
      localOpen: session.nextOpen ? new Date(session.nextOpen * 1_000).toISOString() : null,
      localClose: session.nextClose ? new Date(session.nextClose * 1_000).toISOString() : null,
      currentStatus: session.status,
      notes: session.reason,
    }] },
    freshness: {
      status: session.stale ? 'stale' : 'cached',
      asOf: new Date(session.asOf * 1_000).toISOString(),
      maxAgeSeconds: 30,
    },
    provider: session.provider,
    reason: session.reason,
    error: null,
  };
}

export interface StockDetailGatewaySnapshot {
  instrument: ResolvedInstrument;
  quote: StockDetailQuoteResource;
  profile: StockDetailResource<CompanyProfile>;
  overview: StockDetailResource<MarketOverview>;
  history: InitialHistoryResponse;
  /**
   * Pre-market / after-hours print for the header's secondary row, resolved on
   * the server from the Yahoo chart pipeline that is already part of this app.
   * Rendering it here rather than fetching it in the browser is deliberate: the
   * extended row costs the client zero additional requests and zero polling.
   * Null whenever there is no valid extended print for the latest session.
   */
  extendedQuote: ExtendedHoursQuoteData | null;
}

async function continuousSnapshot(asset: MarketAsset): Promise<StockDetailGatewaySnapshot> {
  const quote = await loadContinuousAcceptedMarket(asset)
    .then((resolved) => continuousAcceptedQuoteResource(asset.symbol, resolved))
    .catch(() => continuousQuoteUnavailable());
  return {
    instrument: continuousInstrument(asset),
    quote,
    profile: continuousProfile(asset),
    overview: continuousMarketStatus(quote.freshness.asOf ?? new Date().toISOString()),
    // A market with no close has no pre-market and no after-hours print.
    extendedQuote: null,
    history: {
      data: null,
      meta: { provider: null, timestamp: new Date().toISOString(), freshness: unavailableFreshness },
    },
  };
}

export async function loadStockDetailGatewaySnapshot(symbol: string): Promise<StockDetailGatewaySnapshot> {
  const continuous = continuousMarketAsset(symbol);
  if (continuous) return continuousSnapshot(continuous);
  const gateway = getMarketDataGateway();
  const instrument = await gateway.resolveInstrument(symbol);
  const quotePromise = (async () => {
    try {
      return providerQuoteResource(await loadResilientQuote(
        symbol,
        gateway,
        getYahooChartProvider(),
        instrument,
      ));
    }
    catch (quoteCause) {
      try {
        const bars = await gateway.getBars({ instrument, interval: '5m', range: '1d', adjusted: false, session: 'regular' });
        const fallback = quoteFromBars(instrument, bars);
        return fallback ? quoteResource(fallback, true) : { ...unavailable<Quote>(quoteCause), fallbackLabel: null };
      } catch { return { ...unavailable<Quote>(quoteCause), fallbackLabel: null }; }
    }
  })();
  const extendedPromise = getYahooChartProvider()
    .getExtendedQuote(symbol)
    .catch(() => null);
  const sessionPromise = gateway.getSession({ instrument }).then(overviewResource).catch(unavailable<MarketOverview>);
  const profilePromise = getCompanyProfileService().getCompanyProfile(symbol).then((result): StockDetailResource<CompanyProfile> => ({
    data: result.data,
    freshness: result.freshness,
    provider: result.provider ?? null,
    reason: null,
    error: null,
    fallbackUsed: result.fallbackUsed,
    retryAfterSeconds: result.retryAfterSeconds,
    reasonCode: result.reasonCode,
  })).catch(unavailable<CompanyProfile>);
  const [quote, overview, profile, extended] = await Promise.all([
    quotePromise, sessionPromise, profilePromise, extendedPromise,
  ]);
  // An extended print is only shown next to the regular price it actually
  // belongs to; one left over from an older session is dropped here.
  const extendedQuote = extendedQuoteMatchesRegularSession(extended, quote.freshness.asOf)
    ? extended
    : null;
  return {
    instrument,
    quote,
    overview,
    profile,
    extendedQuote,
    history: {
      data: null,
      meta: { provider: null, timestamp: new Date().toISOString(), freshness: unavailableFreshness },
    },
  };
}
