import { describe, expect, it } from 'vitest';
import {
  aggregatePortfolioSummaries,
  calculateGoalProgress,
  portfolioValuationCoverage,
} from './aggregate';
import { calculatePortfolio } from './calculations';
import type { PortfolioTransaction, PortfolioTransactionType } from './types';

let sequence = 0;
function tx(portfolioId: string, type: PortfolioTransactionType, amount: string): PortfolioTransaction {
  sequence += 1;
  return {
    id: String(sequence),
    portfolioId,
    type,
    symbol: null,
    quantity: null,
    price: null,
    amount,
    normalizedAmountUsd: amount,
    occurredAt: '2026-01-01',
    occurredAtTime: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}Z`,
    note: null,
    createdAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}Z`,
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('portfolio aggregation and goals', () => {
  it('sums isolated sub-portfolios once and excludes paired transfers from aggregate deposits and P&L', () => {
    const stock = calculatePortfolio([
      tx('stock', 'deposit', '1000'),
      tx('stock', 'transfer_out', '250'),
    ]);
    const option = calculatePortfolio([
      tx('option', 'deposit', '500'),
      tx('option', 'transfer_in', '250'),
    ]);
    const aggregate = aggregatePortfolioSummaries([stock, option]);

    expect(stock).toMatchObject({ cashBalance: 750, netDepositedCapital: 1000, netTransferredCapital: -250, totalGain: 0 });
    expect(option).toMatchObject({ cashBalance: 750, netDepositedCapital: 500, netTransferredCapital: 250, totalGain: 0 });
    expect(aggregate).toMatchObject({
      cashBalance: 1500,
      totalValue: 1500,
      netDepositedCapital: 1500,
      netTransferredCapital: 0,
      totalGain: 0,
      totalGainPercent: 0,
    });
  });

  it('propagates unavailable valuation instead of substituting zero', () => {
    const available = calculatePortfolio([tx('cash', 'deposit', '100')]);
    const missing = { ...available, totalValue: null, totalGain: null, unrealizedGain: null, hasMissingPrices: true };
    const aggregate = aggregatePortfolioSummaries([available, missing]);
    expect(aggregate.totalValue).toBeNull();
    expect(aggregate.totalGain).toBeNull();
    expect(aggregate.unrealizedGain).toBeNull();
    expect(aggregate.hasMissingPrices).toBe(true);
  });

  it('keeps goal progress separate from P&L, allows over 100%, and clamps negative current value to 0%', () => {
    expect(calculateGoalProgress(125, { targetValueUsd: 100, targetDate: null })).toMatchObject({
      progressPercent: 125,
      remainingAmount: 0,
      status: 'reached',
    });
    expect(calculateGoalProgress(-25, { targetValueUsd: 100, targetDate: null })).toEqual({
      progressPercent: 0,
      remainingAmount: 125,
      status: 'negative',
      reason: 'มูลค่าพอร์ตติดลบ',
    });
    expect(calculateGoalProgress(null, { targetValueUsd: 100, targetDate: null }).reason).toContain('ไม่มีราคาปัจจุบัน');
  });

  it('reports a verified subtotal and coverage without treating a deposit as profit', () => {
    const summary = calculatePortfolio([
      tx('cash', 'deposit', '1000'),
    ]);
    expect(summary).toMatchObject({
      totalValue: 1000,
      totalGain: 0,
      netDepositedCapital: 1000,
    });
    expect(portfolioValuationCoverage(summary)).toEqual({
      pricedAssets: 0,
      totalAssets: 0,
      verifiedValueUsd: 1000,
    });
  });
});
