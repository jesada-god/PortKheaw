import { describe, expect, it } from 'vitest';
import type { EarningsSchedule } from '@/src/lib/analytics/earnings/types';
import type { OptionPositionSummary } from '@/src/lib/portfolio/options/types';
import { alertDistancePercent, buildUpcomingFeed, UPCOMING_CARD_LIMIT } from './build';

function earnings(symbol: string, daysToEarnings: number): EarningsSchedule {
  return {
    status: 'available',
    symbol,
    reportDate: '2026-08-20',
    timeOfDay: 'post-market',
    epsEstimate: null,
    daysToEarnings,
    provider: 'alpha-vantage',
    asOf: '2026-08-16T00:00:00.000Z',
    stale: false,
  };
}

function position(key: string, dte: number, status: OptionPositionSummary['status'] = 'open'): OptionPositionSummary {
  return {
    key,
    underlyingSymbol: 'SPY',
    contractSymbol: `SPY${key}`,
    marketContractSymbol: null,
    optionKind: 'put',
    side: 'long',
    strikePrice: 500,
    expirationDate: '2026-08-22',
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
    unrealizedGain: null,
    unrealizedGainPercent: null,
    underlyingPrice: null,
    breakeven: 497,
    dte,
    impliedVolatility: null,
    delta: null,
    theta: null,
    status,
    quoteSource: null,
    quoteAsOf: null,
    quoteFreshness: 'missing',
    transactions: [],
  };
}

describe('alert proximity', () => {
  it('measures how far a price still has to travel', () => {
    expect(alertDistancePercent({
      id: '1', symbol: 'NVDA', condition: 'above', targetValue: 105, enabled: true, price: 100, changePercent: null,
    })).toBeCloseTo(5);
    expect(alertDistancePercent({
      id: '2', symbol: 'NVDA', condition: 'below', targetValue: 98, enabled: true, price: 100, changePercent: null,
    })).toBeCloseTo(2);
  });

  it('says nothing about an alert that is already met, disabled or unpriced', () => {
    const base = { id: '1', symbol: 'NVDA', condition: 'above' as const, targetValue: 100, changePercent: null };
    expect(alertDistancePercent({ ...base, enabled: true, price: 101 })).toBeNull();
    expect(alertDistancePercent({ ...base, enabled: false, price: 90 })).toBeNull();
    expect(alertDistancePercent({ ...base, enabled: true, price: null })).toBeNull();
  });
});

describe('upcoming feed', () => {
  it('orders dated events soonest first and keeps undated alerts after them', () => {
    const feed = buildUpcomingFeed({
      earnings: [earnings('AAPL', 4)],
      positions: [position('spy-put', 6)],
      alerts: [{
        id: 'a1', symbol: 'NVDA', condition: 'above', targetValue: 102, enabled: true, price: 100, changePercent: null,
      }],
    });

    expect(feed.events.map((event) => event.kind)).toEqual(['earnings', 'option-expiry', 'alert']);
    expect(feed.events[0]!.text).toContain('AAPL');
    expect(feed.events[0]!.text).toContain('4 วัน');
    expect(feed.events[1]!.text).toContain('6 วัน');
    expect(feed.total).toBe(3);
  });

  it('truncates to the card limit while still reporting the true total', () => {
    const feed = buildUpcomingFeed({
      earnings: [earnings('AAPL', 1), earnings('MSFT', 2)],
      positions: [position('a', 3), position('b', 4)],
      limit: UPCOMING_CARD_LIMIT,
    });

    expect(feed.events).toHaveLength(3);
    expect(feed.total).toBe(4);
  });

  it('drops events with no data behind them rather than inventing a date', () => {
    const feed = buildUpcomingFeed({
      earnings: [{
        status: 'unavailable',
        symbol: 'AAPL',
        reason: 'no-scheduled-report',
        message: 'ผู้ให้บริการยังไม่ประกาศวันประกาศงบครั้งถัดไป',
        provider: 'alpha-vantage',
        asOf: null,
      }],
      // Beyond the horizon, and a closed contract, respectively.
      positions: [position('far', 90), position('closed', 2, 'closed')],
      alerts: [{
        id: 'a1', symbol: 'NVDA', condition: 'above', targetValue: 200, enabled: true, price: 100, changePercent: null,
      }],
    });

    expect(feed.events).toEqual([]);
    expect(feed.total).toBe(0);
  });
});
