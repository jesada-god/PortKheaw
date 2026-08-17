import 'server-only';

import {
  COMMODITY_MARKET_TIMEZONE,
  resolveCommoditySession,
} from '@/src/lib/market-data/commodity-session';
import type { CommodityContract } from '@/src/lib/market-data/commodities';
import { resolveContinuousAcceptedMarketData, type ContinuousAcceptedMarketData } from '@/src/lib/overview/continuous-market';
import { getCandleMarketDataService, getYahooChartProvider } from '@/src/lib/market-data/candles';
import type { MarketAsset } from '@/src/lib/overview/market-assets';
import type { InstrumentMetadata } from '@/src/lib/overview/types';
import type { ResolvedInstrument } from '@/src/lib/market-data/gateway/contracts';
import type { CompanyProfile, MarketOverview } from '@/src/lib/market-data/types';
import type { StockDetailQuoteResource, StockDetailResource } from './types';
import { buildAcceptedResource } from './market-source';
import { continuousQuoteUnavailable } from './continuous-snapshot';

/**
 * Stock Detail for a commodity contract.
 *
 * The card on the overview is a link, so this exists for the same reason the
 * continuous snapshot does: a futures contract has no row in
 * `market_instruments`, so the US-equity gateway would answer "symbol is not
 * supported" and the page would show a price it could not explain.
 *
 * It reuses the continuous machinery for everything that is genuinely shared —
 * the accepted-price resolution, the quote/candle pair, the resource shape — and
 * differs in exactly the places a futures market differs from a crypto pair:
 *
 *   * The market status is Globex, so it can honestly say "closed" on a Saturday
 *     rather than claiming a market that never shuts.
 *   * The day's open/high/low are NOT recomputed from a UTC calendar day. A
 *     Globex day starts at 17:00 Chicago, so a UTC-day aggregate would report
 *     the wrong "ราคาเปิด" and the wrong "สูงสุดวันนี้" — the provider's own
 *     contract-day figures are used instead, which is what they already are.
 */

export function commodityInstrument(
  asset: MarketAsset,
  contract: CommodityContract,
): ResolvedInstrument {
  return {
    canonicalSymbol: asset.symbol,
    // The app's spelling both sides: the provider's `=F` form is applied inside
    // the provider and never leaks into what the page is told it is showing.
    providerSymbol: asset.symbol,
    name: asset.name,
    assetType: 'commodity',
    exchange: contract.exchange,
    mic: null,
    currency: contract.currency,
    timezone: COMMODITY_MARKET_TIMEZONE,
    active: true,
    supported: true,
    unsupportedReason: null,
  };
}

export function commodityOverviewInstrument(
  asset: MarketAsset,
  contract: CommodityContract,
): InstrumentMetadata {
  return {
    symbol: asset.symbol,
    companyName: asset.name,
    exchange: contract.exchange,
    assetType: 'commodity',
    currency: contract.currency,
    sector: null,
    industry: null,
    websiteDomain: null,
    logoUrl: asset.logoUrl,
    metadataSource: 'commodity-market',
    updatedAt: null,
  };
}

/** Globex, as a market-status row: open or closed, never "always open". */
export function commodityMarketStatus(
  contract: CommodityContract,
  now: Date,
  asOf: string,
): StockDetailResource<MarketOverview> {
  const session = resolveCommoditySession(now);
  return {
    data: {
      markets: [{
        marketType: 'Commodity Futures',
        region: contract.exchange,
        primaryExchanges: [contract.exchange],
        localOpen: null,
        localClose: null,
        currentStatus: session.state === 'open' ? 'open' : 'closed',
        notes: session.label,
      }],
    },
    freshness: { status: 'cached', asOf, maxAgeSeconds: 60 },
    provider: 'commodity-market',
    reason: null,
    error: null,
  };
}

export function commodityProfile(
  asset: MarketAsset,
  contract: CommodityContract,
): StockDetailResource<CompanyProfile> {
  /*
   * A contract has no filings, no employees, no sector and no market cap. What a
   * reader actually needs to know about it is what it is a claim on, where it
   * trades and in what unit — so that is the description, and every company
   * field stays null rather than being filled with something invented.
   */
  return {
    data: {
      symbol: asset.symbol,
      name: asset.name,
      description: `สัญญาล่วงหน้า${asset.name} ซื้อขายที่ ${contract.exchange} ราคาเป็น${contract.unitTh}`,
      country: null,
      employees: null,
      currency: contract.currency,
      fiscalYearEnd: null,
      sector: null,
      industry: null,
      marketCapitalization: null,
      website: null,
      logoUrl: asset.logoUrl,
      exchange: contract.exchange,
      latestQuarter: null,
    },
    freshness: { status: 'cached', asOf: null, maxAgeSeconds: 24 * 60 * 60 },
    provider: 'commodity-market',
    reason: null,
    error: null,
  };
}

/**
 * The displayed quote, from the same accepted price the overview card used.
 *
 * `marketKind: 'continuous'` is passed to the shared builder deliberately: it
 * means "do not apply US-equity session reconciliation", which is exactly right
 * here. It is not a claim that the market never closes — the session shown to the
 * reader comes from `commodityMarketStatus`.
 */
export function commodityAcceptedQuoteResource(
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
  return buildAcceptedResource({
    accepted: resolved.accepted,
    snapshotResource: null,
    baseQuote: resolved.quote,
    symbol,
    marketKind: 'continuous',
    comparisonBase: resolved.comparisonBase,
  });
}

/** Quote + current candles for a commodity detail snapshot, both from Yahoo Chart. */
export async function loadCommodityAcceptedMarket(
  asset: MarketAsset,
  contract: CommodityContract,
  now: Date = new Date(),
): Promise<ContinuousAcceptedMarketData> {
  const referenceSeconds = Math.floor(now.valueOf() / 1_000);
  return resolveContinuousAcceptedMarketData({
    instrument: commodityOverviewInstrument(asset, contract),
    quote: getYahooChartProvider().getQuote(asset.symbol),
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
