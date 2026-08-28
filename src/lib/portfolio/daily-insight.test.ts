import { describe, expect, it } from 'vitest';
import { buildPortfolioDailyInsight } from './daily-insight';
import type { OptionPositionSummary } from './options/types';
import type { HoldingSummary, PortfolioSummary } from './types';

function holding(symbol: string, todayChange: number | null): HoldingSummary {
  return {
    symbol,
    quantity: 10,
    averageCost: 100,
    costBasis: 1_000,
    marketPrice: 110,
    marketValue: 1_100,
    realizedGain: 0,
    unrealizedGain: 100,
    allocation: 0,
    priceCached: false,
    priceStale: false,
    priceSource: null,
    priceAsOf: null,
    todayChange,
    todayChangePercent: todayChange === null ? null : 1,
    todayChangeAsOf: null,
    todayChangeSource: null,
    lots: [],
    transactions: [],
  };
}

function position(overrides: Partial<OptionPositionSummary>): OptionPositionSummary {
  return {
    key: 'SPY-P-1',
    underlyingSymbol: 'SPY',
    contractSymbol: 'SPY260220P00500000',
    marketContractSymbol: null,
    optionKind: 'put',
    side: 'long',
    strikePrice: 500,
    expirationDate: '2026-02-20',
    contracts: 1,
    multiplier: 100,
    averagePremium: 3,
    remainingCost: 300,
    realizedGain: 0,
    bid: null,
    ask: null,
    mark: null,
    estimatedClosePrice: null,
    marketValue: null,
    estimatedCloseValue: null,
    todayChange: null,
    todayChangeAsOf: null,
    todayChangeSource: null,
    unrealizedGain: null,
    unrealizedGainPercent: null,
    underlyingPrice: null,
    breakeven: 497,
    dte: 6,
    impliedVolatility: null,
    delta: null,
    theta: null,
    status: 'open',
    quoteSource: null,
    quoteAsOf: null,
    quoteFreshness: 'missing',
    transactions: [],
    ...overrides,
  };
}

function summary(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    holdings: [],
    cashBalance: 0,
    marketValue: 0,
    costBasis: 0,
    realizedGain: 0,
    unrealizedGain: 0,
    totalValue: 0,
    equityMarketValue: 0,
    optionsMarketValue: 0,
    optionRemainingCost: 0,
    netDepositedCapital: 0,
    netTransferredCapital: 0,
    totalGain: 0,
    totalGainPercent: 0,
    todayChange: null,
    todayChangePercent: null,
    todayChangeAsOf: null,
    todayChangeSource: null,
    optionPositions: [],
    hasMissingPrices: false,
    ...overrides,
  };
}

describe('portfolio daily insight', () => {
  it('names the largest helper and the largest drag from the summary already calculated', () => {
    const insight = buildPortfolioDailyInsight({
      summary: summary({
        todayChange: 1_240,
        todayChangePercent: 1.8,
        todayChangeAsOf: null,
        todayChangeSource: null,
        holdings: [holding('AAPL', 820), holding('NVDA', -310), holding('MSFT', 120)],
      }),
    });

    expect(insight.today).toEqual({ change: 1_240, changePercent: 1.8 });
    expect(insight.contributor).toEqual({ symbol: 'AAPL', change: 820 });
    expect(insight.detractor).toEqual({ symbol: 'NVDA', change: -310 });
    expect(insight.movers.map((mover) => mover.symbol)).toEqual(['AAPL', 'NVDA', 'MSFT']);
  });

  it('merges the same symbol held in two portfolios instead of letting it compete with itself', () => {
    const insight = buildPortfolioDailyInsight({
      summary: summary({
        todayChange: 300,
        todayChangeAsOf: null,
        todayChangeSource: null,
        holdings: [holding('AAPL', 100), holding('AAPL', 150), holding('NVDA', 120)],
      }),
    });

    expect(insight.contributor).toEqual({ symbol: 'AAPL', change: 250 });
    expect(insight.movers).toHaveLength(2);
  });

  it('omits every part it has no data for rather than reporting a zero', () => {
    const insight = buildPortfolioDailyInsight({
      summary: summary({ holdings: [holding('AAPL', null)] }),
    });

    expect(insight.today).toBeNull();
    expect(insight.contributor).toBeNull();
    expect(insight.detractor).toBeNull();
    expect(insight.sector).toBeNull();
    expect(insight.movers).toEqual([]);
    expect(insight.hasContent).toBe(false);
  });

  it('groups by sector only for symbols the instrument master classified', () => {
    const insight = buildPortfolioDailyInsight({
      summary: summary({
        todayChange: 700,
        todayChangeAsOf: null,
        todayChangeSource: null,
        holdings: [holding('AAPL', 400), holding('MSFT', 300), holding('XOM', 500)],
      }),
      // XOM has no classification, so it belongs to no group at all.
      sectorBySymbol: { AAPL: 'Technology', MSFT: 'Technology', XOM: null },
    });

    expect(insight.sector).toEqual({ name: 'Technology', change: 700, symbols: ['AAPL', 'MSFT'] });
  });

  it('reports only open contracts expiring inside the horizon, soonest first', () => {
    const insight = buildPortfolioDailyInsight({
      summary: summary({
        optionPositions: [
          position({ key: 'a', dte: 6 }),
          position({ key: 'b', dte: 2 }),
          position({ key: 'c', dte: 40 }),
          position({ key: 'd', dte: 1, status: 'closed' }),
        ],
      }),
    });

    expect(insight.expiries.map((expiry) => expiry.dte)).toEqual([2, 6]);
    expect(insight.hasContent).toBe(true);
  });
});
