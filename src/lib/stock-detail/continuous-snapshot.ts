import 'server-only';

import { getYahooChartProvider } from '@/src/lib/market-data/candles';
import { CONTINUOUS_MARKET_SESSION_LABEL } from '@/src/lib/overview/continuous-market';
import type { MarketAsset } from '@/src/lib/overview/market-assets';
import type { ResolvedInstrument } from '@/src/lib/market-data/gateway/contracts';
import type {
  CompanyProfile,
  DataFreshness,
  MarketOverview,
  ProviderResult,
  Quote,
} from '@/src/lib/market-data/types';
import type { StockDetailQuoteResource, StockDetailResource } from './types';

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
