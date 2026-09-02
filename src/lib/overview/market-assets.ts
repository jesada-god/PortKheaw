export const MARKET_ASSETS = [
  { symbol: 'SPY', name: 'S&P 500', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/spy.svg', marketKind: 'us-equity' },
  { symbol: 'QQQ', name: 'NASDAQ 100', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/qqq.svg', marketKind: 'us-equity' },
  { symbol: 'DIA', name: 'Dow Jones', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/dia.svg', marketKind: 'us-equity' },
  { symbol: 'IWM', name: 'Russell 2000', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/iwm.svg', marketKind: 'us-equity' },
  /*
   * The metal and the oil, not funds that hold them.
   *
   * These three were GLD and SLV — ETFs, priced by an equity order book and
   * carrying a fee that drifts from the thing they track — and there was no oil
   * card at all. They are now the COMEX and NYMEX front-month contracts that ARE
   * the world's reference price, on the Globex clock, through the same Yahoo
   * chart pipeline every other card uses. `proxyLabel` says which is which, so
   * "สินทรัพย์จริง" is never printed over a proxy.
   *
   * Their marks are bundled here for the same reason SPY's and BTC's are: a logo
   * provider answers for a LISTED COMPANY, and there is no company behind a
   * futures contract to answer for — the resolver would find nothing and every
   * one of the three would fall back to a monogram of an exchange code
   * (`GCF`, `SIF`, `CLF`) that means nothing to the reader this card is for.
   * They are deliberately NOT `gld.svg`/`slv.svg`: those are the marks of the two
   * funds this change removed, and putting one on a commodity card would restate
   * the exact confusion it replaced. Each is drawn for the thing itself — an
   * ingot for the metals, a drop for the crude.
   */
  { symbol: 'GC-F', name: 'ทองคำ', proxyLabel: 'สัญญาล่วงหน้า', logoUrl: '/market-logos/gc-f.svg', marketKind: 'commodity' },
  { symbol: 'SI-F', name: 'เงิน', proxyLabel: 'สัญญาล่วงหน้า', logoUrl: '/market-logos/si-f.svg', marketKind: 'commodity' },
  { symbol: 'CL-F', name: 'น้ำมัน WTI', proxyLabel: 'สัญญาล่วงหน้า', logoUrl: '/market-logos/cl-f.svg', marketKind: 'commodity' },
  { symbol: 'REMX', name: 'แร่หายาก', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/remx.svg', marketKind: 'us-equity' },
  { symbol: 'BTC-USD', name: 'Bitcoin', proxyLabel: 'สินทรัพย์จริง', logoUrl: '/market-logos/btc.svg', marketKind: 'continuous' },
] as const;

/**
 * The bundled mark for an overview proxy, if it is one.
 *
 * These are the only instruments the product ships artwork for, and they are the
 * ones a provider logo suits worst — "S&P 500" is not a company, and neither is
 * a barrel of crude. Reading it here as well as on the overview card is what
 * keeps SPY and ทองคำ looking the same on the card the reader taps and on the
 * page it opens. Everything else resolves to null and is answered by the
 * instrument master's own logo pipeline.
 */
export function marketAssetLogoUrl(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  return MARKET_ASSETS.find((asset) => asset.symbol === normalized)?.logoUrl ?? null;
}

export type MarketAsset = (typeof MARKET_ASSETS)[number];

/**
 * The line that admits a card is not quoting the thing it names, or null.
 *
 * Three `proxyLabel` values, two meanings. 'ETF อ้างอิง' and 'สัญญาล่วงหน้า' both
 * say the price on screen belongs to something OTHER than the name above it —
 * a fund tracking an index, a front-month contract standing for a commodity —
 * and a reader who checks either figure elsewhere will find a different number
 * unless the card said so. 'สินทรัพย์จริง' says the opposite, and printing it is
 * not a disclosure but a boast; its absence is the statement, exactly as a null
 * `proxyLabelTh` is on the six-instrument band above.
 *
 * One predicate, because the two bands sit ten pixels apart and cannot be
 * allowed to answer "is this the real thing" differently.
 */
export function proxyDisclosureTh(proxyLabel: string): string | null {
  return proxyLabel === 'สินทรัพย์จริง' ? null : proxyLabel;
}

/**
 * The overview proxy for a symbol, when that symbol trades continuously.
 *
 * A 24/7 asset has no opening bell, no previous *regular* close and no row in
 * `market_instruments` — that table lists US-listed securities. Every surface
 * that would otherwise put it through the US-equity resolver asks here first.
 */
export function continuousMarketAsset(symbol: string): MarketAsset | null {
  const normalized = symbol.trim().toUpperCase();
  return MARKET_ASSETS.find(
    (asset) => asset.symbol === normalized && asset.marketKind === 'continuous',
  ) ?? null;
}

/**
 * The overview proxy for a symbol, when that symbol is a commodity contract.
 *
 * The same shape as `continuousMarketAsset` and for the same reason: a futures
 * contract has no row in `market_instruments` — that table lists US-listed
 * securities — so every surface that would otherwise put it through the
 * US-equity resolver asks here first.
 */
export function commodityMarketAsset(symbol: string): MarketAsset | null {
  const normalized = symbol.trim().toUpperCase();
  return MARKET_ASSETS.find(
    (asset) => asset.symbol === normalized && asset.marketKind === 'commodity',
  ) ?? null;
}

export function equityMarketSymbols() {
  return MARKET_ASSETS
    .filter((asset) => asset.marketKind === 'us-equity')
    .map((asset) => asset.symbol);
}
