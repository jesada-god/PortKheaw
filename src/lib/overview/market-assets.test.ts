import { describe, expect, it } from 'vitest';
import { equityMarketSymbols, MARKET_ASSETS } from './market-assets';

describe('Overview market asset mapping', () => {
  it('maps all eight cards to entitled ETF proxies or the actual Bitcoin asset', () => {
    expect(MARKET_ASSETS).toEqual([
      expect.objectContaining({ symbol: 'SPY', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({ symbol: 'QQQ', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({ symbol: 'DIA', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({ symbol: 'IWM', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({ symbol: 'GLD', name: 'ทองคำ', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({ symbol: 'SLV', name: 'เงิน', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({ symbol: 'REMX', name: 'แร่หายาก', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({
        symbol: 'BTC-USD',
        proxyLabel: 'สินทรัพย์จริง',
        marketKind: 'continuous',
      }),
    ]);
  });

  it('keeps the canonical Bitcoin symbol out of the US-equity resolver batch', () => {
    expect(equityMarketSymbols()).not.toContain('BTC-USD');
    expect(equityMarketSymbols()).toHaveLength(7);
  });
});
