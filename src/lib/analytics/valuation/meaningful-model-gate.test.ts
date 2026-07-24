import { describe, expect, it } from 'vitest';
import { meaningfulModelGate, verifiablePeerCount } from './engine';
import type { FinancialPeriod, ModelResult } from './types';

const period = (overrides: Partial<FinancialPeriod> = {}): FinancialPeriod => ({
  periodEnd: '2025-12-31',
  currency: 'USD',
  revenue: 500,
  operatingIncome: -20,
  netIncome: -30,
  depreciationAmortization: 10,
  capitalExpenditure: 20,
  changeInWorkingCapital: 5,
  operatingCashFlow: -10,
  freeCashFlow: -30,
  dividendsPaid: null,
  interestExpense: 5,
  totalDebt: 100,
  cash: 50,
  totalAssets: 800,
  totalLiabilities: 400,
  dilutedShares: 100,
  ...overrides,
});

const evSales: ModelResult = {
  model: 'ev-sales',
  fairValue: 10,
  methodology: 'fixture',
  inputs: {},
  assumptions: {},
  limitations: [],
};

describe('legacy meaningful-model disclosure helpers', () => {
  it('counts only positive finite provider peer multiples', () => {
    expect(verifiablePeerCount({ peerMultiples: [] })).toBe(0);
    expect(verifiablePeerCount({
      peerMultiples: [
        { symbol: 'A', multiple: 5 },
        { symbol: 'B', multiple: 0 },
        { symbol: 'C', multiple: -1 },
        { symbol: 'D', multiple: Number.NaN },
      ],
    })).toBe(1);
  });

  it('blocks a sole pre-profit assumption multiple without peers or forward revenue', () => {
    const gate = meaningfulModelGate({
      periods: [period()],
      peerMultiples: null,
      forwardRevenue: null,
    }, [evSales]);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.missingFields).toEqual(['verifiablePeerSet>=5', 'forwardRevenueWithPeriod']);
    }
  });

  it('lifts the disclosure gate only with real peers or provider forward revenue', () => {
    const peers = Array.from({ length: 5 }, (_, index) => ({ symbol: `P${index}`, multiple: 8 }));
    expect(meaningfulModelGate({
      periods: [period()],
      peerMultiples: peers,
      forwardRevenue: null,
    }, [evSales]).ok).toBe(true);
    expect(meaningfulModelGate({
      periods: [period()],
      peerMultiples: null,
      forwardRevenue: { value: 700, period: 'NTM', provider: 'fmp', asOf: '2026-07-25' },
    }, [evSales]).ok).toBe(true);
  });
});
