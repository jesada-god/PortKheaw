import { describe, expect, it } from 'vitest';
import {
  isContinuousAssetType,
  resolveContinuousMarketSession,
  resolveContinuousMarketSnapshot,
} from './continuous-client';

describe('continuous Stock Detail semantics', () => {
  it('classifies crypto explicitly without changing stock or ETF types', () => {
    expect(isContinuousAssetType('crypto')).toBe(true);
    expect(isContinuousAssetType('Stock')).toBe(false);
    expect(isContinuousAssetType('ETF')).toBe(false);
  });

  it('stays open 24/7 on a weekend without the US-equity calendar', () => {
    const session = resolveContinuousMarketSession('2026-08-09T03:00:00.000Z');
    expect(session).toMatchObject({ session: 'REGULAR', phase: 'REGULAR', closeReason: null });
    expect(session.provider).toMatchObject({ accepted: true, status: 'open' });
  });

  it('projects the accepted BTC quote directly into the canonical header snapshot', () => {
    const snapshot = resolveContinuousMarketSnapshot({
      symbol: 'btc-usd',
      evaluatedAt: '2026-08-09T03:01:00.000Z',
      quote: {
        data: {
          symbol: 'BTC-USD', currency: 'USD', price: 118_250, open: 117_000,
          high: 119_000, low: 116_500, previousClose: 117_500,
          previousRegularClose: 117_500, regularClose: 118_250,
          change: 750, changePercent: 0.6383, volume: 10,
          latestTradingDay: '2026-08-09', quoteTimestamp: '2026-08-09T03:00:00.000Z',
          session: 'regular', priceSource: 'yahoo-finance-chart.quote',
        },
        freshness: { status: 'delayed', asOf: '2026-08-09T03:00:00.000Z', maxAgeSeconds: 60 },
        provider: 'yahoo-finance-chart', reason: null, error: null, fallbackLabel: null,
      },
    });
    expect(snapshot).toMatchObject({
      symbol: 'BTC-USD',
      session: 'REGULAR',
      mainPrice: 118_250,
      mainPriceTimestamp: '2026-08-09T03:00:00.000Z',
      comparisonBase: 117_500,
      flags: [],
    });
  });
});
