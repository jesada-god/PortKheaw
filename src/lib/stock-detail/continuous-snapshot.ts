import 'server-only';

import { getCandleMarketDataService, getYahooChartProvider } from '@/src/lib/market-data/candles';
import {
  CONTINUOUS_MARKET_SESSION_LABEL,
  resolveContinuousAcceptedMarketData,
  type ContinuousAcceptedMarketData,
} from '@/src/lib/overview/continuous-market';
import type { MarketAsset } from '@/src/lib/overview/market-assets';
import type { InstrumentMetadata } from '@/src/lib/overview/types';
import type { ResolvedInstrument } from '@/src/lib/market-data/gateway/contracts';
import type {
  CompanyProfile,
  DataFreshness,
  MarketOverview,
  ProviderResult,
  Quote,
} from '@/src/lib/market-data/types';
import type { StockDetailQuoteResource, StockDetailResource } from './types';
import { buildAcceptedResource } from './market-source';

/**
 * Stock Detail for an asset that never closes.
 *
 * Bitcoin has no listing row, no opening bell and no previous *regular* close,
 * so the US-equity gateway answers for it with "symbol is not in
 * market_instruments" and the page shows a price it cannot explain. This builds
 * the same snapshot shape from the pipeline the overview's own Bitcoin card
 * already uses — the Yahoo chart quote — and states the market status honestly:
 * open, always, with no extended-hours row to show beside it.
 *
 * Deliberately alongside the equity loader rather than inside it: nothing here
 * touches the resolver, the session model or the trading-date reconciliation
 * that every US-listed instrument depends on.
 */

const unavailableFreshness: DataFreshness = {
  status: 'unavailable',
  asOf: null,
  maxAgeSeconds: null,
};

export function continuousInstrument(asset: MarketAsset): ResolvedInstrument {
  return {
    canonicalSymbol: asset.symbol,
    providerSymbol: asset.symbol,
    name: asset.name,
    assetType: 'crypto',
    exchange: null,
    mic: null,
    currency: 'USD',
    timezone: 'UTC',
    active: true,
    supported: true,
    unsupportedReason: null,
  };
}

function continuousOverviewInstrument(asset: MarketAsset): InstrumentMetadata {
  return {
    symbol: asset.symbol,
    companyName: asset.name,
    exchange: null,
    assetType: 'crypto',
    currency: 'USD',
    sector: null,
    industry: null,
    websiteDomain: null,
    logoUrl: asset.logoUrl,
    metadataSource: 'continuous-market',
    updatedAt: null,
  };
}

/** A market that is open now and stays open — not a US session with no bell. */
export function continuousMarketStatus(asOf: string): StockDetailResource<MarketOverview> {
  return {
    data: {
      markets: [{
        marketType: 'Cryptocurrency',
        region: 'Global',
        primaryExchanges: [],
        localOpen: null,
        localClose: null,
        currentStatus: 'open',
        notes: CONTINUOUS_MARKET_SESSION_LABEL,
      }],
    },
    freshness: { status: 'cached', asOf, maxAgeSeconds: 60 },
    provider: 'continuous-market',
    reason: null,
    error: null,
  };
}

export function continuousQuoteResource(
  result: ProviderResult<Quote>,
): StockDetailQuoteResource {
  return {
    data: {
      ...result.data,
      // The session a 24/7 asset is in is the only one it has.
      session: 'regular',
    },
    freshness: result.freshness,
    provider: result.provider ?? 'yahoo-finance-chart',
    reason: null,
    error: null,
    fallbackLabel: null,
  };
}

/** Builds Stock Detail from the same accepted quote/candle event as Overview. */
export function continuousAcceptedQuoteResource(
  symbol: string,
  resolved: ContinuousAcceptedMarketData,
): StockDetailQuoteResource {
  if (!resolved.accepted) return continuousQuoteUnavailable();
  if (resolved.accepted.source === 'snapshot' && resolved.quote) {
    return {
      data: { ...resolved.quote, symbol: symbol.trim().toUpperCase(), session: 'regular' },
      freshness: resolved.freshness,
      provider: resolved.provider ?? 'yahoo-finance-chart',
      reason: null,
      error: null,
      fallbackLabel: null,
    };
  }
  const resource = buildAcceptedResource({
    accepted: resolved.accepted,
    snapshotResource: null,
    baseQuote: resolved.quote,
    symbol,
    marketKind: 'continuous',
    comparisonBase: resolved.comparisonBase,
  });
  if (!resource.data) return resource;
  const day = continuousDayStatistics(resolved.candles, resolved.accepted.exchangeTimestamp);
  if (!day) return resource;
  return {
    ...resource,
    data: {
      ...resource.data,
      // A 24/7 asset's "today" is its UTC day. The last five-minute bucket's own
      // open/high/low is NOT that day's range, and presenting it as ราคาเปิด /
      // สูงสุดวันนี้ was simply the wrong number — so each field is taken from the
      // day's own bars, and `open` only from a bar that provably starts the day.
      open: day.open ?? resource.data.open,
      high: day.high ?? resource.data.high,
      low: day.low ?? resource.data.low,
      volume: day.volume ?? resource.data.volume,
    },
  };
}

/**
 * The accepted price's own UTC-day open/high/low/volume, aggregated from the
 * canonical five-minute bars the same snapshot already loaded.
 *
 * `open` is reported only when the first bar in hand genuinely opens that UTC day
 * (the request window is 24h wide, so a day whose first bucket fell outside it
 * cannot be described). Nothing is interpolated, forward-filled or derived from
 * the current price: an unprovable open stays unavailable.
 */
function continuousDayStatistics(
  candles: ContinuousAcceptedMarketData['candles'],
  acceptedAt: string | null,
): { open: number | null; high: number | null; low: number | null; volume: number | null } | null {
  if (!acceptedAt) return null;
  const dayStartSeconds = Date.parse(`${acceptedAt.slice(0, 10)}T00:00:00.000Z`) / 1_000;
  if (!Number.isFinite(dayStartSeconds)) return null;
  const sameDay = candles.filter((candle) => (
    candle.timestamp >= dayStartSeconds && candle.timestamp < dayStartSeconds + 86_400
  ));
  const first = sameDay[0];
  if (!first) return null;
  return {
    open: first.timestamp < dayStartSeconds + 300 ? first.open : null,
    high: Math.max(...sameDay.map((candle) => candle.high)),
    low: Math.min(...sameDay.map((candle) => candle.low)),
    volume: Math.round(sameDay.reduce((total, candle) => total + candle.volume, 0)),
  };
}

export function continuousProfile(
  asset: MarketAsset,
): StockDetailResource<CompanyProfile> {
  /*
   * A currency has no filings, no employees and no sector. Saying so with the
   * name and nothing else is more truthful than an empty company card built out
   * of nulls the reader would have to interpret.
   */
  return {
    data: {
      symbol: asset.symbol,
      name: asset.name,
      description: null,
      country: null,
      employees: null,
      currency: 'USD',
      fiscalYearEnd: null,
      sector: null,
      industry: null,
      marketCapitalization: null,
      website: null,
      logoUrl: asset.logoUrl,
      exchange: null,
      latestQuarter: null,
    },
    freshness: { status: 'cached', asOf: null, maxAgeSeconds: 24 * 60 * 60 },
    provider: 'continuous-market',
    reason: null,
    error: null,
  };
}

export function continuousQuoteUnavailable(): StockDetailQuoteResource {
  return {
    data: null,
    freshness: unavailableFreshness,
    provider: null,
    reason: 'continuous-market-quote-unavailable',
    error: {
      code: 'upstream-unavailable',
      message: 'ผู้ให้บริการข้อมูลตลาดไม่พร้อมใช้งานชั่วคราว',
      retryable: true,
    },
    fallbackLabel: null,
  };
}

/** The quote a continuous asset shows, from the chart pipeline it belongs to. */
export async function loadContinuousQuote(symbol: string): Promise<ProviderResult<Quote>> {
  return getYahooChartProvider().getQuote(symbol);
}

/** Quote + current candles for a 24/7 detail snapshot, both from Yahoo Chart. */
export async function loadContinuousAcceptedMarket(
  asset: MarketAsset,
  now: Date = new Date(),
): Promise<ContinuousAcceptedMarketData> {
  const referenceSeconds = Math.floor(now.valueOf() / 1_000);
  return resolveContinuousAcceptedMarketData({
    instrument: continuousOverviewInstrument(asset),
    quote: loadContinuousQuote(asset.symbol),
    candles: getCandleMarketDataService().getCandles({
      symbol: asset.symbol,
      interval: '5m',
      range: '1d',
      period1: referenceSeconds - 86_400,
      period2: referenceSeconds + 300,
      adjusted: false,
      session: 'regular',
    }),
  });
}
