import { describe, expect, it } from 'vitest';
import type { EarningsSchedule } from '@/src/lib/analytics/earnings/types';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import { buildStockSummary } from './summary';

function signal(nearestSupport: number | null, nearestResistance: number | null): MarketSignalResult {
  return {
    symbol: 'AAPL',
    timeframe: '1D',
    calculatedAt: '2026-08-16T00:00:00.000Z',
    latestCandleAt: null,
    source: 'test',
    freshness: { status: 'delayed', asOf: null, maxAgeSeconds: null },
    dataPoints: { received: 300, finalized: 299 },
    scoreBreakdown: {} as MarketSignalResult['scoreBreakdown'],
    reasons: [],
    warnings: [],
    flags: [],
    metrics: { nearestSupport, nearestResistance } as MarketSignalResult['metrics'],
    confidenceBreakdown: {} as MarketSignalResult['confidenceBreakdown'],
    status: 'available',
    state: 'BULLISH',
    bias: 'bullish',
    score: 60,
    confidence: 70,
    confidenceLabel: 'Medium',
    evidenceAgreement: 70,
    evidenceAgreementLabel: 'Medium',
  };
}

const earnings: EarningsSchedule = {
  status: 'available',
  symbol: 'AAPL',
  reportDate: '2026-08-28',
  timeOfDay: 'post-market',
  epsEstimate: null,
  daysToEarnings: 12,
  provider: 'alpha-vantage',
  asOf: '2026-08-16T00:00:00.000Z',
  stale: false,
};

describe('stock detail summary', () => {
  it('restates the canonical levels and report date, each pointing at an existing tab', () => {
    const items = buildStockSummary({
      price: 195,
      currency: 'USD',
      marketSignal: signal(185, 205),
      earnings,
    });

    expect(items.map((item) => item.id)).toEqual(['support', 'resistance', 'earnings']);
    expect(items[0]!.text).toContain('แนวรับใกล้ที่สุด $185.00');
    expect(items[0]!.target).toBe('Chart');
    expect(items[1]!.text).toContain('แนวต้านใกล้ที่สุด $205.00');
    expect(items[2]!.text).toContain('อีก 12 วัน');
    expect(items[2]!.target).toBe('Financials');
  });

  it('states the distance from the price the header is already showing', () => {
    const items = buildStockSummary({
      price: 200, currency: 'USD', marketSignal: signal(180, null), earnings: null,
    });
    expect(items[0]!.text).toContain('ห่างจากราคาปัจจุบัน 10.0%');
  });

  it('omits a level that would be printed on the wrong side of the price', () => {
    const items = buildStockSummary({
      price: 195, currency: 'USD', marketSignal: signal(210, 190), earnings: null,
    });
    expect(items).toEqual([]);
  });

  it('produces nothing at all when no canonical source answered', () => {
    expect(buildStockSummary({
      price: 195, currency: 'USD', marketSignal: null, earnings: null,
    })).toEqual([]);
    expect(buildStockSummary({
      price: 195,
      currency: 'USD',
      marketSignal: null,
      earnings: {
        status: 'unavailable',
        symbol: 'AAPL',
        reason: 'not-configured',
        message: 'ยังไม่ได้ตั้งค่าผู้ให้บริการปฏิทินงบการเงินบนเซิร์ฟเวอร์',
        provider: null,
        asOf: null,
      },
    })).toEqual([]);
  });
});
