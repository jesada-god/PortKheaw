import { describe, expect, it } from 'vitest';
import type {
  PortfolioRecord,
  PortfolioTransaction,
  PortfolioTransactionType,
} from '@/src/lib/portfolio/types';
import { buildOverviewPortfolio } from './portfolio-summary';

let sequence = 0;
function transaction(
  portfolioId: string,
  type: PortfolioTransactionType,
  amount: string,
): PortfolioTransaction {
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
    occurredAt: '2026-07-31',
    occurredAtTime: `2026-07-31T12:00:${String(sequence).padStart(2, '0')}Z`,
    note: null,
    createdAt: `2026-07-31T12:00:${String(sequence).padStart(2, '0')}Z`,
    updatedAt: '2026-07-31T12:00:00Z',
  };
}

function portfolio(id: string, transactions: PortfolioTransaction[]): PortfolioRecord {
  return {
    id,
    name: id,
    type: 'STOCK',
    isLegacy: false,
    archivedAt: null,
    targetValueUsd: null,
    targetDate: null,
    baseCurrency: 'USD',
    transactions,
  };
}

describe('Overview portfolio summary', () => {
  it('matches the aggregate Portfolio scope and does not count deposits as profit', () => {
    const first = portfolio('first', [transaction('first', 'deposit', '1000')]);
    const second = portfolio('second', [transaction('second', 'deposit', '500')]);
    const result = buildOverviewPortfolio({
      authenticated: true,
      portfolios: [first, second],
      aggregateGoal: { targetValueUsd: null, targetDate: null },
      marketPrices: {},
      optionQuotes: {},
      evaluatedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(result.summary).toMatchObject({
      totalValue: 1500,
      totalGain: 0,
      netDepositedCapital: 1500,
    });
    expect(result.portfolioName).toBe('รวมทุกพอร์ต');
    expect(result.portfolios.map((item) => item.summary.totalValue)).toEqual([1000, 500]);
  });

  it('shows a single portfolio value even when no goal has been configured', () => {
    const only = portfolio('only', [transaction('only', 'deposit', '250')]);
    const result = buildOverviewPortfolio({
      authenticated: true,
      portfolios: [only],
      aggregateGoal: { targetValueUsd: null, targetDate: null },
      marketPrices: {},
      optionQuotes: {},
      evaluatedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(result.summary?.totalValue).toBe(250);
    expect(result.targetValueUsd).toBeNull();
    expect(result.portfolios[0]?.summary.totalValue).toBe(250);
  });
});
