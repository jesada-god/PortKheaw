import { resolveCommoditySession } from '@/src/lib/market-data/commodity-session';
import type { CurrentMarketSessionResult } from '@/src/lib/market-data/current-session';
import type { CanonicalMarketSnapshot } from '@/src/lib/market-data/market-snapshot';
import type { StockDetailQuoteResource } from './types';

function utcDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function positive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

export function isContinuousAssetType(assetType: string | null | undefined): boolean {
  return assetType?.trim().toLowerCase() === 'crypto';
}

export function isCommodityAssetType(assetType: string | null | undefined): boolean {
  return assetType?.trim().toLowerCase() === 'commodity';
}

/**
 * The Globex session, for a commodity page.
 *
 * Reads the SAME schedule the server used — `isCommodityMarketOpen` — rather
 * than a second copy of the rule or the market-status row's cached verdict, so
 * the pill cannot disagree with the card the reader tapped to get here. It is not
 * the equity resolver: there is no opening bell to reconcile against and no
 * pre/post window to fall into.
 */
export function resolveCommodityMarketSession(now: Date | string): CurrentMarketSessionResult {
  const parsed = now instanceof Date ? now : new Date(now);
  const valid = !Number.isNaN(parsed.valueOf());
  const evaluatedAt = valid ? parsed.toISOString() : '1970-01-01T00:00:00.000Z';
  const session = valid
    ? resolveCommoditySession(parsed)
    : { state: 'closed' as const, closeReason: 'NORMAL' as const };
  const open = session.state === 'open';
  return {
    session: open ? 'REGULAR' : 'CLOSED',
    phase: open ? 'REGULAR' : 'CLOSED',
    closeReason: session.closeReason,
    evaluatedAt,
    source: 'market-status-provider',
    exchangeDate: evaluatedAt.slice(0, 10),
    provider: {
      accepted: true,
      status: open ? 'open' : 'closed',
      asOf: evaluatedAt,
      source: 'commodity-market-globex',
      rejection: null,
    },
  };
}

/** A 24/7 market is regular/active at every valid instant, including weekends. */
export function resolveContinuousMarketSession(now: Date | string): CurrentMarketSessionResult {
  const parsed = now instanceof Date ? now : new Date(now);
  const evaluatedAt = Number.isNaN(parsed.valueOf())
    ? '1970-01-01T00:00:00.000Z'
    : parsed.toISOString();
  return {
    session: 'REGULAR',
    phase: 'REGULAR',
    closeReason: null,
    evaluatedAt,
    source: 'market-status-provider',
    exchangeDate: evaluatedAt.slice(0, 10),
    provider: {
      accepted: true,
      status: 'open',
      asOf: evaluatedAt,
      source: 'continuous-market-24/7',
      rejection: null,
    },
  };
}

/**
 * Canonical header projection for a continuously traded asset. It deliberately
 * does not call the US-equity snapshot resolver, whose session windows and
 * previous-trading-day calendar do not apply to crypto.
 */
export function resolveContinuousMarketSnapshot(input: {
  symbol: string;
  quote: StockDetailQuoteResource;
  evaluatedAt: Date | string;
}): CanonicalMarketSnapshot {
  const quote = input.quote.data;
  const evaluatedAt = input.evaluatedAt instanceof Date
    ? input.evaluatedAt.toISOString()
    : new Date(input.evaluatedAt).toISOString();
  const asOf = input.quote.freshness.asOf ?? quote?.quoteTimestamp ?? null;
  const price = positive(quote?.price) ? quote.price : null;
  const previousClose = positive(quote?.previousRegularClose)
    ? quote.previousRegularClose
    : positive(quote?.previousClose) ? quote.previousClose : null;
  const flags: CanonicalMarketSnapshot['flags'] = [];
  if (price === null) flags.push('regular-close-unavailable');
  if (previousClose === null) flags.push('previous-close-unavailable');
  return {
    symbol: input.symbol.trim().toUpperCase(),
    session: 'REGULAR',
    closeReason: null,
    sessionLabel: 'REGULAR',
    sessionSource: 'continuous-market-24/7',
    evaluatedAt,
    tradingDate: utcDate(asOf) ?? quote?.latestTradingDay ?? null,
    mainPrice: price,
    mainPriceRole: price === null ? null : 'regular',
    mainPriceTimestamp: asOf,
    mainPriceSource: quote?.priceSource ?? input.quote.provider,
    mainPriceFreshness: input.quote.freshness,
    mainPriceProvider: input.quote.provider,
    comparisonBase: previousClose,
    comparisonBaseKind: previousClose === null ? null : 'previous-regular-close',
    regularClose: price,
    regularCloseTimestamp: asOf,
    regularCloseSource: quote?.priceSource ?? input.quote.provider,
    previousRegularClose: previousClose,
    previousRegularCloseSource: quote?.previousCloseSource ?? input.quote.provider,
    extendedPrice: null,
    extendedSession: null,
    extendedPriceTimestamp: null,
    extendedPriceTradingDate: null,
    extendedPriceSource: null,
    extendedPriceProvider: null,
    extendedPriceFreshness: null,
    flags,
  };
}
