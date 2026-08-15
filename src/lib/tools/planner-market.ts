import 'server-only';

/**
 * The Planner's one and only source of price — a consumer, never a pipeline.
 *
 * The requirement this module exists to satisfy is a parity one: the price the
 * Planner puts in its read-only "ราคาปัจจุบัน" box must be the *same number* the
 * reader just saw on the Stock Detail header for that symbol. Not "a recent
 * price", not "a fresh quote" — the same number, resolved the same way.
 *
 * So nothing here fetches anything. It composes the two pieces Stock Detail
 * itself composes, in the same order:
 *
 *   1. {@link loadStockDetailGatewaySnapshot} — the exact server loader the Stock
 *      Detail page calls, which is what makes the instrument, the quote and the
 *      extended print identical rather than merely similar;
 *   2. {@link resolveCanonicalMarketSnapshot} — THE canonical resolver, the one
 *      the header renders from and holds no second opinion about.
 *
 * The final selection below is copied in meaning, not by coincidence, from
 * `StockDetailClient`'s `analyticalSpotPrice`: inside REGULAR the live regular
 * price, and otherwise a real extended print in preference to the close, because
 * during PRE/POST that IS the most recent traded price for a marking purpose. A
 * plan's baseline is a marking purpose.
 *
 * What this module structurally cannot do, because it never had the means:
 * call Yahoo/Finnhub/Alpha Vantage itself, open a websocket, start a poll, or
 * normalise a price of its own.
 */

import { resolveCurrentMarketSession } from '@/src/lib/market-data/current-session';
import { resolveCanonicalMarketSnapshot } from '@/src/lib/market-data/market-snapshot';
import { loadStockDetailGatewaySnapshot } from '@/src/lib/stock-detail/gateway-snapshot';
import { plannerAcceptsAsset, type PlannerAssetType } from './planner-asset-scope';

export interface PlannerPrice {
  symbol: string;
  name: string | null;
  assetType: PlannerAssetType;
  exchange: string | null;
  currency: string;
  /** The canonical accepted price — the Stock Detail header's own number. */
  acceptedPrice: number | null;
  /** Which session the price belongs to, so the UI can label it truthfully. */
  session: string;
  /** When the price printed, when the provider states it. */
  asOf: string | null;
  /** Refusal text when the planner does not plan this instrument. */
  unsupported: string | null;
}

export async function loadPlannerPrice(symbol: string, now: Date = new Date()): Promise<PlannerPrice> {
  const snapshot = await loadStockDetailGatewaySnapshot(symbol);
  const instrument = snapshot.instrument;

  /*
    The scope decision is taken from the resolved instrument, before any price is
    reported. A refused instrument still returns its identity so the UI can name
    what it refused, but never a baseline — a price the planner will not plan with
    is a price it should not display as one.
  */
  const decision = plannerAcceptsAsset(instrument.assetType);
  const currency = instrument.currency ?? snapshot.quote.data?.currency ?? 'USD';
  if (!decision.supported) {
    return {
      symbol: instrument.canonicalSymbol,
      name: instrument.name,
      assetType: instrument.assetType,
      exchange: instrument.exchange,
      currency,
      acceptedPrice: null,
      session: 'UNKNOWN',
      asOf: null,
      unsupported: decision.message,
    };
  }

  const session = resolveCurrentMarketSession({ now });
  const extended = snapshot.extendedQuote;
  const canonical = resolveCanonicalMarketSnapshot({
    symbol: instrument.canonicalSymbol,
    session,
    quote: {
      data: snapshot.quote.data,
      freshness: snapshot.quote.freshness,
      provider: snapshot.quote.provider,
    },
    extended: extended && Number.isFinite(extended.price) && extended.price > 0
      ? {
        session: extended.session,
        price: extended.price,
        asOf: extended.asOf,
        tradingDate: extended.tradingDate ?? null,
        provider: extended.provider ?? null,
        freshness: extended.freshness,
      }
      : null,
    now,
  });

  // The Stock Detail header's own selection, restated. See the module note.
  const acceptedPrice = canonical.session === 'REGULAR'
    ? canonical.mainPrice
    : canonical.extendedPrice ?? canonical.mainPrice;

  return {
    symbol: instrument.canonicalSymbol,
    name: instrument.name,
    assetType: instrument.assetType,
    exchange: instrument.exchange,
    currency,
    acceptedPrice: Number.isFinite(acceptedPrice) && (acceptedPrice ?? 0) > 0 ? acceptedPrice : null,
    session: canonical.session,
    asOf: canonical.session === 'REGULAR'
      ? canonical.mainPriceTimestamp
      : canonical.extendedPriceTimestamp ?? canonical.mainPriceTimestamp,
    unsupported: null,
  };
}
