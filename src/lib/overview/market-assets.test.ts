import { describe, expect, it } from 'vitest';
import {
  commodityMarketAsset,
  continuousMarketAsset,
  equityMarketSymbols,
  MARKET_ASSETS,
} from './market-assets';

describe('Overview market asset mapping', () => {
  it('quotes the index proxies as proxies and the commodities as contracts', () => {
    expect(MARKET_ASSETS).toEqual([
      expect.objectContaining({ symbol: 'SPY', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({ symbol: 'QQQ', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({ symbol: 'DIA', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({ symbol: 'IWM', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({
        symbol: 'GC-F',
        name: 'ทองคำ',
        proxyLabel: 'สัญญาล่วงหน้า',
        marketKind: 'commodity',
      }),
      expect.objectContaining({
        symbol: 'SI-F',
        name: 'เงิน',
        proxyLabel: 'สัญญาล่วงหน้า',
        marketKind: 'commodity',
      }),
      expect.objectContaining({
        symbol: 'CL-F',
        name: 'น้ำมัน WTI',
        proxyLabel: 'สัญญาล่วงหน้า',
        marketKind: 'commodity',
      }),
      expect.objectContaining({ symbol: 'REMX', name: 'แร่หายาก', proxyLabel: 'ETF อ้างอิง' }),
      expect.objectContaining({
        symbol: 'BTC-USD',
        proxyLabel: 'สินทรัพย์จริง',
        marketKind: 'continuous',
      }),
    ]);
  });

  /**
   * The regression that matters most about the commodity change: gold and silver
   * are no longer the funds that track them, and no card claims to be the real
   * asset while quoting a proxy.
   */
  it('no longer quotes gold or silver through an ETF, and never calls a proxy the real thing', () => {
    const symbols = MARKET_ASSETS.map((asset) => asset.symbol);
    expect(symbols).not.toContain('GLD');
    expect(symbols).not.toContain('SLV');
    expect(symbols).not.toContain('USO');
    for (const asset of MARKET_ASSETS) {
      if (asset.proxyLabel === 'ETF อ้างอิง') expect(asset.marketKind).toBe('us-equity');
      if (asset.marketKind === 'commodity') expect(asset.proxyLabel).toBe('สัญญาล่วงหน้า');
    }
  });

  it('keeps the non-equity symbols out of the US-equity resolver batch', () => {
    const equities = equityMarketSymbols();
    expect(equities).not.toContain('BTC-USD');
    expect(equities).not.toContain('GC-F');
    expect(equities).not.toContain('SI-F');
    expect(equities).not.toContain('CL-F');
    expect(equities).toEqual(['SPY', 'QQQ', 'DIA', 'IWM', 'REMX']);
  });

  it('canonicalizes only BTC-USD as continuous and leaves AAPL/SPY on equity paths', () => {
    expect(continuousMarketAsset(' btc-usd ')?.symbol).toBe('BTC-USD');
    expect(continuousMarketAsset('AAPL')).toBeNull();
    expect(continuousMarketAsset('SPY')).toBeNull();
    // A commodity is not continuous: it has a weekend and a daily halt.
    expect(continuousMarketAsset('GC-F')).toBeNull();
  });

  it('canonicalizes the three contracts as commodities and nothing else', () => {
    expect(commodityMarketAsset(' gc-f ')?.name).toBe('ทองคำ');
    expect(commodityMarketAsset('si-f')?.name).toBe('เงิน');
    expect(commodityMarketAsset('CL-F')?.name).toBe('น้ำมัน WTI');
    expect(commodityMarketAsset('BTC-USD')).toBeNull();
    expect(commodityMarketAsset('SPY')).toBeNull();
    expect(commodityMarketAsset('GLD')).toBeNull();
  });
});
