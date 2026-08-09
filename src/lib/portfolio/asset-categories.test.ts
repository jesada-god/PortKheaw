import { describe, expect, it } from 'vitest';
import { assetCategoryForSymbol, buildAssetCategories } from './asset-categories';
import type { OptionPositionSummary } from './options/types';
import type { HoldingSummary } from './types';

function holding(overrides: Partial<HoldingSummary> = {}): HoldingSummary {
  return {
    symbol: 'AAPL', quantity: 10, averageCost: 100, costBasis: 1_000,
    marketPrice: 120, marketValue: 1_200, realizedGain: 0, unrealizedGain: 200,
    allocation: 50, priceCached: false, priceStale: false, priceSource: 'test',
    priceAsOf: null, todayChange: 15, todayChangePercent: 1.25, lots: [], transactions: [],
    ...overrides,
  };
}

function position(overrides: Partial<OptionPositionSummary> = {}): OptionPositionSummary {
  return {
    key: 'k1', underlyingSymbol: 'RKLB', contractSymbol: 'RKLB260116C00070000',
    marketContractSymbol: null, optionKind: 'call', side: 'long', strikePrice: 70,
    expirationDate: '2026-01-16', contracts: 1, multiplier: 100, averagePremium: 2,
    remainingCost: 200, realizedGain: 0, bid: 3, ask: 3.2, mark: 3.1,
    estimatedClosePrice: 3, marketValue: 310, estimatedCloseValue: 300,
    todayChange: 10, unrealizedGain: 110, unrealizedGainPercent: 55,
    underlyingPrice: 75, breakeven: 72, dte: 30, impliedVolatility: null,
    delta: null, theta: null, status: 'open', quoteSource: 'test',
    quoteAsOf: null, quoteFreshness: 'live', transactions: [],
    ...overrides,
  };
}

const entry = <T,>(value: T) => ({ portfolioId: 'p1', portfolioName: 'พอร์ตหลัก', ...value });

describe('assetCategoryForSymbol', () => {
  it('reads the instrument master, and falls back to Stock the way the master does', () => {
    expect(assetCategoryForSymbol('VOO', { VOO: 'ETF' })).toBe('etf');
    expect(assetCategoryForSymbol('VOO', { VOO: 'etf' })).toBe('etf');
    expect(assetCategoryForSymbol('AAPL', { AAPL: 'Stock' })).toBe('stock');
    // Not yet classified is not a reason to hide a holding.
    expect(assetCategoryForSymbol('NEWCO', {})).toBe('stock');
  });
});

describe('buildAssetCategories', () => {
  it('groups holdings by the master’s asset type and sums what the ledger already calculated', () => {
    const groups = buildAssetCategories({
      cash: [entry({ balance: 500 })],
      holdings: [
        entry({ holding: holding({ symbol: 'AAPL' }) }),
        entry({ holding: holding({ symbol: 'VOO', marketValue: 800, todayChange: 5, unrealizedGain: 50 }) }),
      ],
      options: [entry({ position: position() })],
      assetTypeBySymbol: { AAPL: 'Stock', VOO: 'ETF' },
    });

    expect(groups.map((group) => group.key)).toEqual(['cash', 'stock', 'etf', 'option']);
    const [cash, stock, etf, option] = groups;
    expect(cash.value).toBe(500);
    expect(stock.value).toBe(1_200);
    expect(stock.todayChange).toBe(15);
    expect(etf.value).toBe(800);
    expect(etf.unrealizedGain).toBe(50);
    expect(option.value).toBe(310);
    expect(groups.every((group) => group.count === 1)).toBe(true);
  });

  it('leaves a category out entirely rather than showing an empty one', () => {
    const groups = buildAssetCategories({
      cash: [entry({ balance: 0 })],
      holdings: [entry({ holding: holding({ symbol: 'AAPL' }) })],
      options: [],
      assetTypeBySymbol: { AAPL: 'Stock' },
    });
    expect(groups.map((group) => group.key)).toEqual(['stock']);
  });

  it('counts open contracts only — a closed position is history, not a holding', () => {
    const groups = buildAssetCategories({
      cash: [],
      holdings: [],
      options: [
        entry({ position: position({ key: 'open' }) }),
        entry({ position: position({ key: 'closed', status: 'closed', marketValue: null }) }),
      ],
      assetTypeBySymbol: {},
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(1);
    expect(groups[0].value).toBe(310);
  });

  /*
   * The rule the whole surface depends on: an asset with no verified price
   * collapses its category's total to `null`, exactly as it collapses a
   * portfolio's. A missing price is never read as zero.
   */
  it('reports an unknown total as null rather than treating a missing price as zero', () => {
    const groups = buildAssetCategories({
      cash: [],
      holdings: [
        entry({ holding: holding({ symbol: 'AAPL' }) }),
        entry({ holding: holding({ symbol: 'TSLA', marketValue: null, unrealizedGain: null, todayChange: null }) }),
      ],
      options: [],
      assetTypeBySymbol: {},
    });
    expect(groups[0].value).toBeNull();
    expect(groups[0].todayChange).toBeNull();
    expect(groups[0].unrealizedGain).toBeNull();
    expect(groups[0].hasMissingPrices).toBe(true);
    expect(groups[0].count).toBe(2);
  });

  it('sums in fixed point, so repeated cents do not drift', () => {
    const groups = buildAssetCategories({
      cash: [entry({ balance: 0.1 }), entry({ balance: 0.2 })],
      holdings: [],
      options: [],
      assetTypeBySymbol: {},
    });
    expect(groups[0].value).toBe(0.3);
  });
});
