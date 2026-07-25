import { calculateFairValue } from '@/src/lib/analytics/valuation/engine';
import type {
  FairValueAvailable,
  ValuationInput,
} from '@/src/lib/analytics/valuation/types';

const CALCULATED_AT = '2026-07-25T00:00:00.000Z';

export function createDcfOnlyFairValueResult(): FairValueAvailable {
  const input: ValuationInput = {
    symbol: 'NVDA',
    currency: 'USD',
    marketPrice: 120,
    priceAsOf: '2026-07-24T20:00:00.000Z',
    marketPriceSource: 'structured-fixture',
    marketCapitalization: 3_000,
    source: 'structured-fixture',
    sourceType: 'provider-supplied',
    sector: 'Technology',
    industry: 'Semiconductors',
    periods: [{
      periodEnd: '2025-12-31',
      currency: 'USD',
      revenue: 1_000,
      operatingIncome: 300,
      netIncome: 220,
      incomeBeforeTax: 260,
      incomeTaxExpense: 42,
      depreciationAmortization: 30,
      capitalExpenditure: 50,
      changeInWorkingCapital: 10,
      operatingCashFlow: 260,
      freeCashFlow: 210,
      dividendsPaid: -5,
      interestExpense: 8,
      totalDebt: 100,
      cash: 300,
      totalAssets: 2_000,
      totalLiabilities: 500,
      dilutedShares: 100,
    }],
    historicalPrices: [],
    historySource: '',
    historyFreshness: {
      status: 'unavailable',
      asOf: null,
      maxAgeSeconds: null,
    },
    analystEstimates: [2026, 2027, 2028, 2029, 2030].map((year, index) => ({
      periodEnd: `${year}-12-31`,
      estimatedRevenue: 1_100 * (1.12 ** index),
      estimatedEps: 3 + index * 0.2,
      revenueAnalystCount: 20,
      epsAnalystCount: 20,
      provider: 'structured-fixture',
      asOf: CALCULATED_AT,
    })),
    peerObservations: [],
    waccMarketInputs: {
      beta: 1.5,
      betaAsOf: CALCULATED_AT,
      riskFreeRate: 0.04,
      riskFreeAsOf: '2026-07-24',
      equityRiskPremium: 0.05,
      equityRiskPremiumAsOf: CALCULATED_AT,
      provider: 'structured-fixture',
    },
    calculatedAt: CALCULATED_AT,
  };
  const result = calculateFairValue(input, Date.parse(CALCULATED_AT));
  if (result.status !== 'available') {
    throw new Error('DCF-only Fair Value fixture must be available');
  }
  return result;
}
