/**
 * The commodity contracts this product quotes.
 *
 * ===========================================================================
 * Why a commodity is not an equity with a different name
 * ===========================================================================
 *
 * The overview used to answer "what is gold doing" with GLD, and "what is
 * silver doing" with SLV. Both are ETFs: share classes of a trust, listed on
 * NYSE Arca, priced by an equity order book, and carrying a management fee that
 * makes them drift from the metal they hold. Calling one of them "ทองคำ" is a
 * statement about a fund presented as a statement about a metal, and a reader
 * who compared the card with a gold price anywhere else would find two
 * different numbers with no way to tell which was wrong.
 *
 * These are the metal and the oil themselves — the front-month futures contract
 * that IS the reference price the world quotes:
 *
 *   * Gold and silver trade on COMEX, priced in US dollars per troy ounce.
 *   * WTI crude trades on NYMEX, priced in US dollars per barrel. WTI is one
 *     specific grade at one specific delivery point (Cushing, Oklahoma); it is
 *     NOT "oil" in general, and it is not Brent, which is why the card names it.
 *
 * Both exchanges are CME Group venues on the Globex clock, which is neither the
 * US equity session nor 24/7 — see `commodity-session.ts`.
 *
 * ===========================================================================
 * Why the app spells the symbol `GC-F` and the provider is asked for `GC=F`
 * ===========================================================================
 *
 * Yahoo names a front-month future `GC=F`. The app's symbol grammar
 * (`symbolSchema`) has always been `^INDEX` or an alphanumeric ticker with dots
 * and dashes, and it is shared by every route that takes a symbol — quote,
 * candles, options, news, Stock Detail. Widening it to admit `=` to satisfy
 * three cards would loosen the input contract of surfaces that have nothing to
 * do with commodities, so it is left exactly as it was: the app's canonical
 * spelling is `GC-F`, which the grammar already accepts, and the `=` exists
 * only inside the provider request this module builds.
 *
 * The obvious alternative spellings are all taken by real listed companies —
 * `WTI` is W&T Offshore, `GOLD` is Gold.com, `CL` is Colgate-Palmolive, `SI` is
 * Shoulder Innovations. Any of them would have made `/stock/WTI` ambiguous
 * between a commodity and an equity, so none of them is used.
 *
 * The translation is gated on this registry rather than applied as a blanket
 * `-F` → `=F` rewrite: a listed ticker really can end in `-F`, and a rule that
 * rewrote it would quietly point an equity request at a futures contract.
 */

export type CommoditySymbol = 'GC-F' | 'SI-F' | 'CL-F';

export interface CommodityContract {
  /** The app's canonical symbol — what appears in URLs, caches and the UI. */
  symbol: CommoditySymbol;
  /** What the Yahoo Chart endpoint is actually asked for. */
  providerSymbol: string;
  /** The reader-facing name. Plain Thai, no ticker and no vendor. */
  nameTh: string;
  /** The venue, for the places that state where a price came from. */
  exchange: 'COMEX' | 'NYMEX';
  /** What one unit of the price buys, spelled out for a non-professional. */
  unitTh: string;
  currency: 'USD';
}

export const COMMODITY_CONTRACTS: readonly CommodityContract[] = [
  {
    symbol: 'GC-F',
    providerSymbol: 'GC=F',
    nameTh: 'ทองคำ',
    exchange: 'COMEX',
    unitTh: 'ดอลลาร์ต่อทรอยออนซ์',
    currency: 'USD',
  },
  {
    symbol: 'SI-F',
    providerSymbol: 'SI=F',
    nameTh: 'เงิน',
    exchange: 'COMEX',
    unitTh: 'ดอลลาร์ต่อทรอยออนซ์',
    currency: 'USD',
  },
  {
    symbol: 'CL-F',
    providerSymbol: 'CL=F',
    nameTh: 'น้ำมัน WTI',
    exchange: 'NYMEX',
    unitTh: 'ดอลลาร์ต่อบาร์เรล',
    currency: 'USD',
  },
];

const BY_SYMBOL = new Map(COMMODITY_CONTRACTS.map((contract) => [contract.symbol, contract]));

/** The contract a symbol names, or null for everything that is not one. */
export function commodityContract(symbol: string): CommodityContract | null {
  return BY_SYMBOL.get(symbol.trim().toUpperCase() as CommoditySymbol) ?? null;
}

export function isCommoditySymbol(symbol: string): boolean {
  return commodityContract(symbol) !== null;
}

/**
 * The symbol a provider is asked for.
 *
 * Every other symbol is returned unchanged, which is what makes this safe to
 * call on the shared provider path: an equity, an ETF, a crypto pair and an
 * index all pass through untouched, and only a registered contract is rewritten.
 */
export function toProviderSymbol(symbol: string): string {
  return commodityContract(symbol)?.providerSymbol ?? symbol;
}
