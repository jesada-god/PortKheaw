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

export type PriceMarketKind = 'us-equity' | 'continuous';

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

/**
 * The semantic domain a priced update belongs to — the decision that keeps an
 * extended-hours print out of the main price row.
 *
 * Two kinds of value arrive here and they must NOT be judged the same way:
 *
 *  - **An executed print** (a stream trade, or an aggregate bar close). Its
 *    meaning is defined by WHEN it traded, so its own exchange timestamp is the
 *    authority. A stream that declares no session at all — Alpaca states none —
 *    previously fell through to a `regular` default, which is how every
 *    after-hours tick entered the regular domain and overwrote the official close.
 *  - **A provider quote snapshot.** Its `price` field's meaning is defined by the
 *    provider CONTRACT, not by the response's timestamp: Yahoo's
 *    `regularMarketPrice` stays the regular close while it reports POST, stamped
 *    at 16:00:01 ET. Classifying that by timestamp would file the official close
 *    as an after-hours print — the mirror image of the same bug — so a snapshot
 *    price that equals the quote's own `regularClose` is `regular` by definition,
 *    and only a snapshot price that DIFFERS from it is judged by its timestamp.
 *
 * `null` means the domain could not be established (a print stamped outside all
 * three windows, on a weekend, or with no timestamp at all). The caller drops it:
 * an unclassifiable value is not a regular price, and admitting it as one is
 * exactly how a stale tick reached the main row.
 */
function priceRoleOfUpdate(
  update: MarketUpdate,
  marketKind: PriceMarketKind,
): AcceptedPriceCandidate['priceRole'] | null {
  // A continuously traded asset has one semantic price domain. Its weekend and
  // overnight prints are ordinary prices, not unclassifiable US-equity ticks.
  if (marketKind === 'continuous') return 'regular';
  if (
    update.label.source === 'snapshot'
    && positivePrice(update.quote?.regularClose)
    && update.price === update.quote!.regularClose
  ) {
    return 'regular';
  }
  const classified = update.label.exchangeTimestamp
    ? classifyUsEquitySession(update.label.exchangeTimestamp)
    : null;
  if (classified === 'premarket') return 'pre-market';
  if (classified === 'afterhours') return 'after-hours';
  if (classified === 'regular') return 'regular';
  // No timestamp at all: fall back to a session the stream states explicitly.
  if (!update.label.exchangeTimestamp) {
    if (update.session === 'pre-market') return 'pre-market';
    if (update.session === 'after-hours') return 'after-hours';
    if (update.session === 'regular') return 'regular';
  }
  return null;
}

/**
 * Map a live {@link MarketUpdate} to a priced accepted-price candidate, or null.
 *
 * Returns null when the price's semantic domain cannot be established, so an
 * unclassifiable print is dropped rather than admitted as a regular price.
 */
export function candidateFromUpdate(
  update: MarketUpdate,
  marketKind: PriceMarketKind = 'us-equity',
): AcceptedPriceCandidate | null {
  if (update.price === null || !update.label.source || update.label.source === 'history-fallback') return null;
  const priceRole = priceRoleOfUpdate(update, marketKind);
  if (!priceRole) return null;
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
 * The semantic domain of a completed history/aggregate bar the chart displays.
 *
 * A date-only stamp (`YYYY-MM-DD`) is a Daily/Week/Month bar, whose close IS the
 * regular-session close by definition. An intraday bucket is classified by its own
 * exchange timestamp, so a bar from the chart's `extended` session selection is
 * never reported to the header as a regular price.
 */
export function historyBarPriceRole(
  exchangeTimestamp: string | null,
  marketKind: PriceMarketKind = 'us-equity',
): AcceptedPriceCandidate['priceRole'] | null {
  if (!exchangeTimestamp) return null;
  if (marketKind === 'continuous') return 'regular';
  if (/^\d{4}-\d{2}-\d{2}$/.test(exchangeTimestamp)) return 'regular';
  switch (classifyUsEquitySession(exchangeTimestamp)) {
    case 'premarket': return 'pre-market';
    case 'afterhours': return 'after-hours';
    case 'regular': return 'regular';
    default: return null;
  }
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

function utcDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function previousUtcDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Comparison close for a 24/7 asset. Calendar days are UTC provider days, not
 * US trading sessions: the same-day quote carries its explicit previous close;
 * a quote from the immediately preceding UTC day contributes its own close.
 */
export function continuousComparisonClose(
  quote: Quote | null,
  priceAsOf: string | null | undefined,
): number | null {
  if (!quote) return null;
  const priceDate = utcDate(priceAsOf);
  const quoteDate = utcDate(quote.quoteTimestamp) ?? quote.latestTradingDay ?? null;
  if (!priceDate || !quoteDate) return null;
  if (priceDate === quoteDate) return regularComparisonClose(quote);
  if (previousUtcDate(priceDate) !== quoteDate) return null;
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
  marketKind?: PriceMarketKind;
  comparisonBase?: number | null;
}): StockDetailQuoteResource {
  const {
    accepted,
    snapshotResource,
    baseQuote,
    symbol,
    marketKind = 'us-equity',
  } = input;
  if (accepted.source === 'snapshot' && snapshotResource) return snapshotResource;

  // The comparison base must belong to the session before the ACCEPTED price,
  // not before the base quote — see `comparisonCloseForAcceptedPrice`.
  const previousClose = input.comparisonBase !== undefined
    ? input.comparisonBase
    : marketKind === 'continuous'
      ? continuousComparisonClose(baseQuote, accepted.exchangeTimestamp)
      : comparisonCloseForAcceptedPrice(baseQuote, accepted.exchangeTimestamp);
  const change = previousClose != null ? accepted.price - previousClose : null;
  const changePercent = previousClose ? (change! / previousClose) * 100 : null;
  // Only the four fields that describe the DISPLAYED price are refined.
  // `regularClose` / `previousRegularClose` keep describing the base quote's own
  // session, which is what the header's extended-hours partitioning reads.
  const acceptedTradingDay = utcDate(accepted.exchangeTimestamp);
  const data: Quote = baseQuote
    ? {
        ...baseQuote,
        price: accepted.price,
        previousClose,
        change,
        changePercent,
        ...(marketKind === 'continuous' ? {
          symbol: symbol.trim().toUpperCase(),
          regularClose: accepted.price,
          previousRegularClose: previousClose,
          latestTradingDay: acceptedTradingDay,
          quoteTimestamp: accepted.exchangeTimestamp,
          session: 'regular' as const,
          priceSource: `${accepted.provider ?? 'unknown-provider'}.candle`,
        } : {}),
      }
    : {
      symbol: symbol.trim().toUpperCase(),
      currency: null,
      price: accepted.price,
      open: null,
      high: null,
      low: null,
      previousClose: null,
      change: null,
      changePercent: null,
      volume: null,
      latestTradingDay: acceptedTradingDay,
      ...(marketKind === 'continuous' ? {
        regularClose: accepted.price,
        previousRegularClose: previousClose,
        quoteTimestamp: accepted.exchangeTimestamp,
        session: 'regular' as const,
        priceSource: `${accepted.provider ?? 'unknown-provider'}.candle`,
      } : {}),
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
