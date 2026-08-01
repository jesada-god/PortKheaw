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

export function equityMarketSymbols() {
  return MARKET_ASSETS
    .filter((asset) => asset.marketKind === 'us-equity')
    .map((asset) => asset.symbol);
}
