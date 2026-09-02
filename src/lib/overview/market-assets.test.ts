import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKET_STATUS_INPUTS } from '@/src/config/market-status';
import { buildMarketSummary } from './market-summary';
import type { MarketIndexCard } from './types';
import {
  assetsOutsideMarketStatus,
  commodityMarketAsset,
  continuousMarketAsset,
  equityMarketSymbols,
  marketAssetLogoUrl,
  proxyDisclosureTh,
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

  /**
   * A logo provider answers for a listed company, and no company issues a
   * futures contract — so without a bundled mark all three cards fall back to a
   * monogram of an exchange code (`GCF`, `SIF`, `CLF`) that means nothing to the
   * reader. The file has to exist as well as be named: a 404 here is silent, and
   * the card degrades to exactly the monogram this is meant to replace.
   */
  it('ships a mark for every card the logo providers cannot answer for', () => {
    for (const asset of MARKET_ASSETS) {
      expect(asset.logoUrl, `${asset.symbol} has no bundled mark`).toBeTruthy();
      expect(existsSync(join(process.cwd(), 'public', asset.logoUrl!)), `${asset.logoUrl} is missing`).toBe(true);
      expect(marketAssetLogoUrl(asset.symbol.toLowerCase())).toBe(asset.logoUrl);
    }
  });

  /** A commodity mark is drawn for the thing, never borrowed from the fund. */
  it('never dresses a contract in the mark of the ETF it replaced', () => {
    for (const asset of MARKET_ASSETS) {
      if (asset.marketKind !== 'commodity') continue;
      expect(asset.logoUrl).not.toContain('gld');
      expect(asset.logoUrl).not.toContain('slv');
    }
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

describe('the asset band under the six-instrument snapshot', () => {
  /*
    The overview draws two bands. Three of the catalogue's rows are the same
    three markets the band above already states, through the funds that track
    them, and the page was printing the S&P twice at two different magnitudes.
  */
  it('drops exactly the rows the six-instrument band already states', () => {
    const kept = assetsOutsideMarketStatus(MARKET_ASSETS).map((asset) => asset.symbol);
    expect(kept).toEqual(['IWM', 'GC-F', 'SI-F', 'CL-F', 'REMX', 'BTC-USD']);
  });

  /*
    The pairing is a statement about MEANING: `SPX` quotes `^GSPC` and covers
    `SPY`, which comparing symbols would never find. That is what makes a typo
    in it silent — the filter would simply stop removing a row — so every
    pairing is checked against the catalogue it names.
  */
  it('pairs every covering input with a row that exists', () => {
    for (const input of MARKET_STATUS_INPUTS) {
      if (input.overviewAssetSymbol === null) continue;
      expect(
        MARKET_ASSETS.some((asset) => asset.symbol === input.overviewAssetSymbol),
        `${input.key} covers ${input.overviewAssetSymbol}, which is not in MARKET_ASSETS`,
      ).toBe(true);
    }
  });

  it('claims to cover nothing through an input that is not an equity index', () => {
    for (const input of MARKET_STATUS_INPUTS) {
      if (input.group === 'risk') expect(input.overviewAssetSymbol, input.key).toBeNull();
    }
  });

  /*
    THE FILTER IS PRESENTATION ONLY. `MARKET_ASSETS` is also what the flag-off
    page draws — all nine cards, and a summary line that reads SPY and QQQ off
    this very array. Removing the three at the catalogue instead would have
    broken the page that is live today to tidy the one behind a flag.
  */
  it('leaves the catalogue whole, so the V1 page and its summary line still work', () => {
    expect(MARKET_ASSETS).toHaveLength(9);
    const cards = MARKET_ASSETS.map((asset) => ({
      symbol: asset.symbol,
      changePercent: 1.2,
    })) as MarketIndexCard[];
    expect(buildMarketSummary(cards)).not.toBeNull();
    // And the summary is genuinely reading the two rows the filter removes.
    expect(buildMarketSummary(assetsOutsideMarketStatus(cards))).toBeNull();
  });
});

describe('proxy disclosure', () => {
  it('qualifies a stand-in and stays silent about the thing itself', () => {
    expect(proxyDisclosureTh('ETF อ้างอิง')).toBe('ETF อ้างอิง');
    expect(proxyDisclosureTh('สัญญาล่วงหน้า')).toBe('สัญญาล่วงหน้า');
    // Not a disclosure but a boast; its absence is the statement.
    expect(proxyDisclosureTh('สินทรัพย์จริง')).toBeNull();
  });
});
