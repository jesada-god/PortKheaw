export const MARKET_ASSETS = [
  { symbol: 'SPY', name: 'S&P 500', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/spy.svg', marketKind: 'us-equity' },
  { symbol: 'QQQ', name: 'NASDAQ 100', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/qqq.svg', marketKind: 'us-equity' },
  { symbol: 'DIA', name: 'Dow Jones', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/dia.svg', marketKind: 'us-equity' },
  { symbol: 'IWM', name: 'Russell 2000', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/iwm.svg', marketKind: 'us-equity' },
  { symbol: 'GLD', name: 'ทองคำ', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/gld.svg', marketKind: 'us-equity' },
  { symbol: 'SLV', name: 'เงิน', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/slv.svg', marketKind: 'us-equity' },
  { symbol: 'REMX', name: 'แร่หายาก', proxyLabel: 'ETF อ้างอิง', logoUrl: '/market-logos/remx.svg', marketKind: 'us-equity' },
  { symbol: 'BTC-USD', name: 'Bitcoin', proxyLabel: 'สินทรัพย์จริง', logoUrl: '/market-logos/btc.svg', marketKind: 'continuous' },
] as const;

/**
 * The bundled mark for an overview proxy, if it is one.
 *
 * These eight are the only instruments the product ships artwork for, and they
 * are the ones a provider logo suits worst — "S&P 500" is not a company. Reading
 * it here as well as on the overview card is what keeps SPY looking the same on
 * the card the reader taps and on the page it opens.
 */
export function marketAssetLogoUrl(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  return MARKET_ASSETS.find((asset) => asset.symbol === normalized)?.logoUrl ?? null;
}

export type MarketAsset = (typeof MARKET_ASSETS)[number];

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

export function equityMarketSymbols() {
  return MARKET_ASSETS
    .filter((asset) => asset.marketKind === 'us-equity')
    .map((asset) => asset.symbol);
}
