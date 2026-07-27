import {
  US_EQUITY_TIMEZONE,
  classifyUsEquitySession,
  exchangeSessionDate,
} from '@/src/lib/market-data/session';
import { previousUsTradingDate } from '@/src/lib/market-data/us-market-calendar';
import type { DataFreshness, Quote } from '@/src/lib/market-data/types';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';
import type { AcceptedPriceCandidate } from './accepted-price';
import type { MarketDataLabel, MarketDataMode, MarketUpdate } from './types';

/**
 * Pure helpers that turn the single accepted price (see {@link resolveAcceptedPrice})
 * into the displayed quote resource, its freshness and its provenance label. Kept
 * transport- and React-free so the header, chart price line and S/R currentPrice
 * provably read one accepted value and one timestamp.
 */

export const AGGREGATE_FALLBACK_LABEL = 'Intraday close fallback' as const;
export const HISTORY_FALLBACK_LABEL = 'Previous trading day' as const;

/** DataFreshness for a value whose truthful mode is already known. */
export function freshnessFromMode(mode: MarketDataMode, asOf: string | null): DataFreshness {
  const status = mode === 'REAL-TIME'
    ? 'realtime' as const
    : mode === 'END-OF-DAY'
      ? 'end-of-day' as const
      : mode === 'CACHED'
        ? 'cached' as const
        : mode === 'STALE'
          ? 'stale' as const
          : mode === 'UNAVAILABLE'
            ? 'unavailable' as const
            : 'delayed' as const;
  return {
    status,
    asOf,
    maxAgeSeconds: status === 'end-of-day' ? 86_400 : status === 'unavailable' ? null : 60,
  };
}

/** Map a live {@link MarketUpdate} to a priced accepted-price candidate, or null. */
export function candidateFromUpdate(update: MarketUpdate): AcceptedPriceCandidate | null {
  if (update.price === null || !update.label.source || update.label.source === 'history-fallback') return null;
  const priceRole = update.label.source === 'snapshot'
    ? 'regular' as const
    : update.session === 'pre-market' || update.session === 'premarket'
      ? 'pre-market' as const
      : update.session === 'after-hours' || update.session === 'afterhours'
        ? 'after-hours' as const
        : update.session === 'regular'
          ? 'regular' as const
          : update.label.feed && update.label.exchangeTimestamp
            ? (() => {
                const classified = classifyUsEquitySession(update.label.exchangeTimestamp!);
                return classified === 'premarket'
                  ? 'pre-market' as const
                  : classified === 'afterhours'
                    ? 'after-hours' as const
                    : 'regular' as const;
              })()
            : 'regular' as const;
  return {
    price: update.price,
    source: update.label.source,
    priceRole,
    exchangeTimestamp: update.label.exchangeTimestamp,
    mode: update.label.mode,
    provider: update.label.provider,
    ...(update.label.realtime !== undefined ? { realtime: update.label.realtime } : {}),
    ...(update.label.feed !== undefined ? { feed: update.label.feed } : {}),
  };
}

/**
 * Resolve a real regular comparison close already present in the accepted
 * pipeline. The canonical `previousRegularClose` wins, followed by the legacy
 * `previousClose`. No open/high/low, provider change arithmetic, intraday candle,
 * cached price, or arbitrary fallback is used.
 */
export function regularComparisonClose(quote: Quote | null): number | null {
  if (!quote) return null;
  if (
    quote.previousRegularClose != null
    && Number.isFinite(quote.previousRegularClose)
    && quote.previousRegularClose > 0
  ) {
    return quote.previousRegularClose;
  }
  if (quote.previousClose != null && Number.isFinite(quote.previousClose) && quote.previousClose > 0) {
    return quote.previousClose;
  }
  return null;
}

function positivePrice(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/**
 * The exchange-local (ET) trading date a quote's own price belongs to.
 *
 * The instant wins over `latestTradingDay`: several providers derive that field
 * by slicing a UTC timestamp, which lands on the NEXT calendar day for any
 * after-hours print (20:30 ET is already tomorrow in UTC).
 */
function quoteTradingDate(quote: Quote): string | null {
  const fromInstant = quote.quoteTimestamp
    ? exchangeSessionDate(quote.quoteTimestamp, US_EQUITY_TIMEZONE)
    : null;
  if (fromInstant) return fromInstant;
  return quote.latestTradingDay && /^\d{4}-\d{2}-\d{2}$/.test(quote.latestTradingDay)
    ? quote.latestTradingDay
    : null;
}

/**
 * The canonical comparison base for ONE specific accepted price: the finalized
 * regular-session close of the US trading day immediately preceding that price's
 * own trading date.
 *
 * This is the fix for the production header. The accepted price and the base
 * quote routinely come from DIFFERENT sessions — an entitled live stream prints
 * today's trade while the REST snapshot is still the previous session's
 * end-of-day row. Taking `quote.previousClose` in that state compares today's
 * price against the close from *two* sessions ago, which is exactly how a
 * correct price ended up beside a wrong change and percentage.
 *
 * Three cases, and nothing is ever guessed:
 *
 *  - the quote belongs to the SAME trading date as the price → its own
 *    `previousRegularClose` / `previousClose` is by definition the previous
 *    close (see {@link regularComparisonClose});
 *  - the quote belongs to the trading date immediately BEFORE the price → that
 *    quote's own finalized regular close *is* the previous close;
 *  - anything else (a quote from the future, or one older than the immediately
 *    preceding session) → null, so the header shows the change as unavailable
 *    rather than inventing a base.
 *
 * When either trading date cannot be established the result is unavailable:
 * without both dates the pipeline cannot prove that the close is adjacent to
 * the accepted price's trading day.
 */
export function comparisonCloseForAcceptedPrice(
  quote: Quote | null,
  priceAsOf: string | null | undefined,
): number | null {
  if (!quote) return null;
  const priceDate = priceAsOf ? exchangeSessionDate(priceAsOf, US_EQUITY_TIMEZONE) : null;
  const quoteDate = quoteTradingDate(quote);
  if (!priceDate || !quoteDate) return null;
  if (priceDate === quoteDate) return regularComparisonClose(quote);
  // A base quote stamped AFTER the accepted price cannot describe it at all.
  if (priceDate < quoteDate) return null;
  if (previousUsTradingDate(priceDate) !== quoteDate) return null;
  // `regularClose` is the explicit regular-session close; `price` is it too on a
  // completed end-of-day row. An extended-hours print never reaches this field
  // because the pipeline keeps it in `regularClose`'s sibling row.
  const close = positivePrice(quote.regularClose) ? quote.regularClose : quote.price;
  return positivePrice(close) ? close : null;
}

/**
 * Build the displayed quote resource from the single accepted price. A snapshot
 * keeps its full verified quote; an aggregate/history fallback refines only the
 * price and recomputes the derived change against the known previous close — no
 * value is fabricated, interpolated or forward-filled. The returned
 * `data.price` is exactly `accepted.price` and `freshness.asOf` is exactly
 * `accepted.exchangeTimestamp`, so every consumer shares one value and timestamp.
 */
export function buildAcceptedResource(input: {
  accepted: AcceptedPriceCandidate;
  snapshotResource: StockDetailQuoteResource | null;
  baseQuote: Quote | null;
  symbol: string;
}): StockDetailQuoteResource {
  const { accepted, snapshotResource, baseQuote, symbol } = input;
  if (accepted.source === 'snapshot' && snapshotResource) return snapshotResource;

  // The comparison base must belong to the session before the ACCEPTED price,
  // not before the base quote — see `comparisonCloseForAcceptedPrice`.
  const previousClose = comparisonCloseForAcceptedPrice(baseQuote, accepted.exchangeTimestamp);
  const change = previousClose != null ? accepted.price - previousClose : null;
  const changePercent = previousClose ? (change! / previousClose) * 100 : null;
  // Only the four fields that describe the DISPLAYED price are refined.
  // `regularClose` / `previousRegularClose` keep describing the base quote's own
  // session, which is what the header's extended-hours partitioning reads.
  const data: Quote = baseQuote
    ? { ...baseQuote, price: accepted.price, previousClose, change, changePercent }
    : {
      symbol,
      currency: null,
      price: accepted.price,
      open: null,
      high: null,
      low: null,
      previousClose: null,
      change: null,
      changePercent: null,
      volume: null,
      latestTradingDay: accepted.exchangeTimestamp?.slice(0, 10) ?? null,
    };
  // A genuine live stream is not a fallback: keep its provenance truthful.
  if (accepted.realtime) {
    return {
      data,
      freshness: freshnessFromMode(accepted.mode, accepted.exchangeTimestamp),
      provider: accepted.provider,
      reason: 'Live streaming price.',
      error: null,
      fallbackLabel: null,
    };
  }
  return {
    data,
    freshness: freshnessFromMode(accepted.mode, accepted.exchangeTimestamp),
    provider: accepted.provider,
    reason: accepted.source === 'history-fallback'
      ? 'Latest displayed price derived from the newest completed history bar (fallback).'
      : 'Latest displayed price derived from the newest verified aggregate bar (fallback).',
    error: null,
    fallbackLabel: accepted.source === 'history-fallback' ? HISTORY_FALLBACK_LABEL : AGGREGATE_FALLBACK_LABEL,
  };
}

/** Provenance label for the accepted value (or the unavailable state). */
export function labelFromAccepted(accepted: AcceptedPriceCandidate | null, receivedAt: string): MarketDataLabel {
  if (!accepted) {
    return { mode: 'UNAVAILABLE', provider: null, source: null, exchangeTimestamp: null, receivedAt, delayAgeSeconds: null, fallbackNote: null };
  }
  const exchangeMs = accepted.exchangeTimestamp ? Date.parse(accepted.exchangeTimestamp) : Number.NaN;
  const receivedMs = Date.parse(receivedAt);
  const delayAgeSeconds = Number.isFinite(exchangeMs) && Number.isFinite(receivedMs)
    ? Math.max(0, Math.round((receivedMs - exchangeMs) / 1_000))
    : null;
  return {
    mode: accepted.mode,
    provider: accepted.provider,
    source: accepted.source,
    exchangeTimestamp: accepted.exchangeTimestamp,
    receivedAt,
    delayAgeSeconds,
    fallbackNote: accepted.source === 'snapshot' || accepted.realtime ? null : 'Fallback price — not a live snapshot.',
    ...(accepted.realtime !== undefined ? { realtime: accepted.realtime } : {}),
    ...(accepted.feed !== undefined ? { feed: accepted.feed } : {}),
  };
}
