import { describe, expect, it } from 'vitest';
import { calculateFairValue } from './engine';
import type { ValuationInput } from './types';

const NOW = Date.parse('2026-07-25T00:00:00.000Z');

function fixture(symbol: string, overrides: Partial<ValuationInput> = {}): ValuationInput {
  const estimates = [2026, 2027, 2028, 2029, 2030].map((year, index) => ({
    periodEnd: `${year}-12-31`,
    estimatedRevenue: 1_100 * (1.1 ** index),
    estimatedEps: 3 + index * 0.2,
    revenueAnalystCount: 8,
    epsAnalystCount: 8,
    provider: 'structured-fixture',
    asOf: '2026-07-24T00:00:00.000Z',
    currency: 'USD',
  }));
  return {
    symbol,
    currency: 'USD',
    marketPrice: 20,
    priceAsOf: '2026-07-24T20:00:00.000Z',
    marketPriceSource: 'structured-fixture',
    marketCapitalization: 2_000,
    source: 'structured-fixture',
    sourceType: 'provider-supplied',
    sector: 'Technology',
    industry: 'Software',
    periods: [{
      periodEnd: '2025-12-31',
      currency: 'USD',
      revenue: 1_000,
      operatingIncome: 200,
      netIncome: 140,
      incomeBeforeTax: 180,
      incomeTaxExpense: 36,
      depreciationAmortization: 40,
      capitalExpenditure: 50,
      changeInWorkingCapital: 10,
      operatingCashFlow: 170,
      freeCashFlow: 120,
      dividendsPaid: -20,
      interestExpense: 12,
      totalDebt: 200,
      cash: 100,
      totalAssets: 1_500,
      totalLiabilities: 700,
      dilutedShares: 100,
    }],
    historicalPrices: [],
    historySource: '',
    historyFreshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
    analystEstimates: estimates,
    peerObservations: [10, 11, 12, 13].map((multiple, index) => ({
      symbol: `PEER${index + 1}`,
      sector: 'Technology',
      industry: 'Software',
      price: multiple * 3,
      priceAsOf: '2026-07-24T20:00:00.000Z',
      enterpriseValue: multiple * 100,
      enterpriseValueAsOf: '2026-06-30',
      forwardEps: 3,
      forwardRevenue: 100,
      estimatePeriod: '2026-12-31',
      estimateAsOf: '2026-07-24T00:00:00.000Z',
      provider: 'structured-fixture',
    })),
    waccMarketInputs: {
      beta: 1.2,
      betaAsOf: '2026-07-24',
      riskFreeRate: 0.04,
      riskFreeAsOf: '2026-07-24',
      equityRiskPremium: 0.05,
      equityRiskPremiumAsOf: '2026-07-24',
      provider: 'structured-fixture',
    },
    calculatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('production-shaped Fair Value reliability matrix', () => {
  it.each(['NVDA', 'AAPL', 'JPM'])(
    '%s publishes Base only when DCF and Forward Multiples both pass',
    (symbol) => {
      const result = calculateFairValue(fixture(symbol), NOW);
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;
      expect(result.fairValue.type).toBe('base');
      expect(result.fairValue.label).toBe('Base Fair Value');
      expect(result.modelResults.map((model) => model.model))
        .toEqual(['fcff-dcf', 'pe']);
    },
  );

  it('MSFT publishes standalone DCF and does not reweight it as Base', () => {
    const result = calculateFairValue(fixture('MSFT', { peerObservations: [] }), NOW);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.fairValue).toMatchObject({
      type: 'dcf',
      label: 'DCF Fair Value',
    });
    expect(result.baseStatus).toBe('unavailable');
    expect(result.modelResults).toHaveLength(1);
    expect(result.modelResults[0].normalizedWeight).toBeUndefined();
  });

  it('RKLB publishes standalone Relative Fair Value only with four real EV/Sales peers', () => {
    const base = fixture('RKLB');
    const result = calculateFairValue(fixture('RKLB', {
      periods: [{
        ...base.periods[0],
        netIncome: -50,
        freeCashFlow: -80,
      }],
      analystEstimates: base.analystEstimates?.map((estimate) => ({
        ...estimate,
        estimatedEps: -0.5,
      })),
    }), NOW);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.fairValue).toMatchObject({
      type: 'relative',
      label: 'Relative Fair Value',
    });
    expect(result.modelResults.map((model) => model.model)).toEqual(['ev-sales']);
    expect(result.baseStatus).toBe('unavailable');
  });

  it('returns Unavailable with real reasons when zero models pass', () => {
    const base = fixture('JPM');
    const result = calculateFairValue(fixture('JPM', {
      periods: [{ ...base.periods[0], freeCashFlow: -1 }],
      analystEstimates: [],
      peerObservations: [],
      waccMarketInputs: null,
    }), NOW);
    expect(result).toMatchObject({
      status: 'unavailable',
      failureKind: 'missing-field',
    });
    if (result.status === 'unavailable') {
      expect(result.missingFields).toEqual(expect.arrayContaining([
        'latestRealFreeCashFlow',
        'targetForwardEstimate',
      ]));
    }
  });
});
