import { describe, expect, it } from 'vitest';
import { aggregatePortfolioSummaries } from './aggregate';
import { calculatePortfolio } from './calculations';
import {
  buildPortfolioGoalCardModel,
  portfolioTodayMood,
  portfolioTodayState,
} from './goal-card';
import type { MarketPriceInput, PortfolioSummary, PortfolioTransaction } from './types';

function transaction(overrides: Partial<PortfolioTransaction> = {}): PortfolioTransaction {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    portfolioId: overrides.portfolioId ?? 'portfolio-1',
    type: overrides.type ?? 'deposit',
    symbol: overrides.symbol ?? null,
    quantity: overrides.quantity ?? null,
    price: overrides.price ?? null,
    amount: overrides.amount ?? null,
    normalizedAmountUsd: overrides.normalizedAmountUsd ?? overrides.amount ?? null,
    normalizedPriceUsd: overrides.normalizedPriceUsd ?? overrides.price ?? null,
    occurredAt: overrides.occurredAt ?? '2026-07-31',
    occurredAtTime: overrides.occurredAtTime ?? '2026-07-31T14:30:00.000Z',
    note: overrides.note ?? null,
    createdAt: overrides.createdAt ?? '2026-07-31T14:30:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-07-31T14:30:00.000Z',
  };
}

function stockSummary(quote: MarketPriceInput): PortfolioSummary {
  return calculatePortfolio([
    transaction({ id: 'deposit', type: 'deposit', amount: '1000' }),
    transaction({
      id: 'buy',
      type: 'acquisition',
      symbol: 'KHEAW',
      quantity: '1',
      price: '100',
      normalizedPriceUsd: '100',
      occurredAtTime: '2026-07-31T14:31:00.000Z',
      createdAt: '2026-07-31T14:31:00.000Z',
    }),
  ], { KHEAW: quote });
}

function readySummary(percent: number, amount = 10): PortfolioSummary {
  return {
    ...stockSummary({
      price: 110,
      previousClose: 100,
      asOf: '2026-08-01T03:15:00.000Z',
    }),
    todayChange: amount,
    todayChangePercent: percent,
  };
}

describe('portfolio goal card model', () => {
  it('keeps the true progress above 100% while clamping only the bar, and rejects target 0', () => {
    const reached = buildPortfolioGoalCardModel({
      scope: 'selected',
      summary: { ...readySummary(1), totalValue: 125 },
      goal: { targetValueUsd: 100, targetDate: null },
      activePortfolios: 1,
      totalPortfolios: 1,
    });
    expect(reached.progress.progressPercent).toBe(125);
    expect(reached.progressBarPercent).toBe(100);

    const invalid = buildPortfolioGoalCardModel({
      scope: 'selected',
      summary: readySummary(1),
      goal: { targetValueUsd: 0, targetDate: null },
      activePortfolios: 1,
      totalPortfolios: 1,
    });
    expect(invalid.progress).toMatchObject({ progressPercent: null, status: 'unavailable' });
    expect(invalid.progressBarPercent).toBe(0);
  });

  it.each([
    [3.01, 'strong-gain'],
    [3, 'gain'],
    [0.51, 'gain'],
    [0.5, 'flat'],
    [-0.5, 'flat'],
    [-0.51, 'loss'],
    [-3, 'loss'],
    [-3.01, 'strong-loss'],
    [-8, 'strong-loss'],
    [-8.01, 'severe-loss'],
  ] as const)('maps Today P/L % boundary %s to %s', (value, expected) => {
    expect(portfolioTodayMood(value)).toBe(expected);
  });

  it('uses all six exact encouragement messages', () => {
    const cases = [
      [4, 'เย้! วันนี้พอร์ตยิ้มแล้ว~ 💚'],
      [1, 'ดีเลย! เก็บกำไรทีละนิดก็เก่งมากแล้ว'],
      [0, 'วันนี้เงียบ ๆ ก่อน รอดูโอกาสนะ'],
      [-1, 'ไม่เป็นไรน้า แค่ย่อตัวเอง'],
      [-4, 'สู้ไปด้วยกันนะ อย่าเพิ่งหมดกำลังใจ'],
      [-9, 'กอด ๆ ก่อน แล้วค่อยวางแผนใหม่ ❤️'],
    ] as const;
    for (const [value, message] of cases) {
      expect(portfolioTodayState(readySummary(value))).toMatchObject({ kind: 'ready', message });
    }
  });

  it('never falls back to Total P/L when Today P/L is unavailable', () => {
    const state = portfolioTodayState({
      ...stockSummary({ price: 110, previousClose: null }),
      totalGain: 999,
      totalGainPercent: 123,
      todayChange: null,
      todayChangePercent: null,
    });
    expect(state).toEqual({
      kind: 'unavailable',
      mood: 'unavailable',
      title: 'วันนี้ยังไม่มีข้อมูล',
      message: 'ยังไม่มีราคาปิดวันก่อนสำหรับบางสินทรัพย์',
    });
    expect(state).not.toHaveProperty('amount');
    expect(state).not.toHaveProperty('percent');
  });

  it('distinguishes no-holdings empty state from assets with unavailable Today P/L', () => {
    const empty = calculatePortfolio([
      transaction({ id: 'cash', type: 'deposit', amount: '1000' }),
    ]);
    expect(portfolioTodayState(empty)).toEqual({
      kind: 'empty',
      mood: 'unavailable',
      title: 'ยังไม่มีสถานะพอร์ต',
      message: 'ลองเพิ่มสถานะพอร์ตและหุ้นหรือออปชันที่ถืออยู่สิ',
    });

    expect(portfolioTodayState(stockSummary({ price: 110, previousClose: null }))).toMatchObject({
      kind: 'unavailable',
      title: 'วันนี้ยังไม่มีข้อมูล',
    });
  });

  it('preserves selected and aggregate scopes without mixing their values or goals', () => {
    const selected = { ...readySummary(1), totalValue: 400 };
    const other = { ...readySummary(-1), totalValue: 600 };
    const aggregate = aggregatePortfolioSummaries([selected, other]);
    const selectedModel = buildPortfolioGoalCardModel({
      scope: 'selected',
      summary: selected,
      goal: { targetValueUsd: 800, targetDate: null },
      activePortfolios: 2,
      totalPortfolios: 3,
    });
    const aggregateModel = buildPortfolioGoalCardModel({
      scope: 'aggregate',
      summary: aggregate,
      goal: { targetValueUsd: 2000, targetDate: null },
      activePortfolios: 2,
      totalPortfolios: 3,
    });

    expect(selectedModel).toMatchObject({
      scope: 'selected',
      currentValue: 400,
      assetCount: 1,
      activePortfolios: 2,
      totalPortfolios: 3,
    });
    expect(selectedModel.goal.targetValueUsd).toBe(800);
    expect(aggregateModel).toMatchObject({
      scope: 'aggregate',
      currentValue: 1000,
      assetCount: 2,
      activePortfolios: 2,
      totalPortfolios: 3,
    });
    expect(aggregateModel.goal.targetValueUsd).toBe(2000);
  });
});
