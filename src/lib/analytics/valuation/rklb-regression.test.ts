import { describe, expect, it } from 'vitest';
import { calculateFairValue } from './engine';
import type { FinancialPeriod, PeerObservation, ValuationInput } from './types';

const now = Date.parse('2026-07-25T00:00:00.000Z');

const latest: FinancialPeriod = {
  periodEnd: '2025-12-31',
  currency: 'USD',
  revenue: 430,
  operatingIncome: -100,
  netIncome: -110,
  incomeBeforeTax: 20,
  incomeTaxExpense: 4,
  depreciationAmortization: 15,
  capitalExpenditure: 30,
  changeInWorkingCapital: 5,
  operatingCashFlow: -60,
  freeCashFlow: -90,
  dividendsPaid: null,
  interestExpense: 12,
  totalDebt: 465,
  cash: 420,
  totalAssets: 1_100,
  totalLiabilities: 720,
  dilutedShares: 490,
  dilutedEps: -0.24,
};

const peers: PeerObservation[] = [7, 8, 9, 10, 80].map((multiple, index) => ({
  symbol: `SPACE${index + 1}`,
  sector: 'Industrials',
  industry: 'Aerospace & Defense',
  price: 10,
  priceAsOf: '2026-07-24T20:00:00.000Z',
  enterpriseValue: multiple * 500,
  enterpriseValueAsOf: '2026-06-30',
  forwardEps: -0.2,
  forwardRevenue: 500,
  estimatePeriod: '2026-12-31',
  estimateAsOf: '2026-07-25T00:00:00.000Z',
  provider: 'financial-modeling-prep',
}));

function input(overrides: Partial<ValuationInput> = {}): ValuationInput {
  return {
    symbol: 'RKLB',
    currency: 'USD',
    marketPrice: 21,
    marketPriceSource: 'polygon',
    marketCapitalization: 10_290,
    priceAsOf: '2026-07-24T20:00:00.000Z',
    source: 'financial-modeling-prep',
    sourceType: 'provider-supplied',
    sector: 'Industrials',
    industry: 'Aerospace & Defense',
    periods: [latest],
    historicalPrices: [],
    historySource: '',
    historyFreshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
    analystEstimates: [2026, 2027, 2028, 2029, 2030].map((year, index) => ({
      periodEnd: `${year}-12-31`,
      estimatedRevenue: 550 * (1.15 ** index),
      estimatedEps: -0.2 + index * 0.03,
      revenueAnalystCount: 7,
      epsAnalystCount: 6,
      provider: 'financial-modeling-prep',
      asOf: '2026-07-25T00:00:00.000Z',
    })),
    peerObservations: peers,
    waccMarketInputs: {
      beta: 1.8,
      betaAsOf: '2026-07-25T00:00:00.000Z',
      riskFreeRate: 0.043,
      riskFreeAsOf: '2026-07-24',
      equityRiskPremium: 0.052,
      equityRiskPremiumAsOf: '2026-07-25T00:00:00.000Z',
      provider: 'financial-modeling-prep',
    },
    providerStatus: 'live',
    calculatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('RKLB-style loss-making regression', () => {
  it('does not publish DCF or Base when latest reported FCF is negative', () => {
    const result = calculateFairValue(input(), now);
    expect(result).toMatchObject({
      status: 'available',
      baseStatus: 'unavailable',
      missingInputs: expect.arrayContaining(['latestRealFreeCashFlow']),
    });
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model)).toEqual(['ev-sales']);
    expect(result.fundamentalFairValue.centralEstimate).toBeNull();
    expect(result.fairValue).toMatchObject({
      type: 'relative',
      label: 'Relative Fair Value',
      confidence: 'Medium',
    });
  });

  it('uses forward EV/Sales when target forward EPS is non-positive and DCF is valid', () => {
    const result = calculateFairValue(input({
      periods: [{ ...latest, freeCashFlow: 40, operatingCashFlow: 70 }],
    }), now);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model)).toEqual(['fcff-dcf', 'ev-sales']);
    expect(result.modelResults.every((model) => Number.isFinite(model.fairValue))).toBe(true);
    expect(result.inputDetails.find((detail) => detail.field === 'Peer List')?.value)
      .not.toContain('SPACE5');
  });

  it('requires at least four valid forward peers after filtering', () => {
    const result = calculateFairValue(input({
      periods: [{ ...latest, freeCashFlow: 40 }],
      peerObservations: peers.slice(0, 3),
    }), now);
    expect(result).toMatchObject({
      status: 'available',
      baseStatus: 'unavailable',
      missingInputs: expect.arrayContaining(['validForwardPeers>=4']),
    });
  });

  it('rejects non-USD inputs instead of applying an implicit FX conversion', () => {
    const result = calculateFairValue(input({ currency: 'THB' }), now);
    expect(result).toMatchObject({
      status: 'unavailable',
      missingFields: expect.arrayContaining(['valuationInputsNormalizedToUSD']),
    });
  });
});
