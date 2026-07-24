import { describe, expect, it } from 'vitest';
import { calculateFairValue, dataSufficiency } from './engine';
import type { FinancialPeriod, ValuationInput } from './types';

const latest: FinancialPeriod = {
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
  dilutedEps: 1.4,
};

const input: ValuationInput = {
  symbol: 'TEST',
  currency: 'USD',
  marketPrice: 20,
  marketPriceSource: 'polygon',
  marketCapitalization: 2_000,
  priceAsOf: '2026-07-24T20:00:00.000Z',
  source: 'financial-modeling-prep',
  sourceType: 'provider-supplied',
  sector: 'Technology',
  industry: 'Software',
  periods: [latest],
  historicalPrices: [],
  historySource: '',
  historyFreshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
  analystEstimates: [2026, 2027, 2028, 2029, 2030].map((year, index) => ({
    periodEnd: `${year}-12-31`,
    estimatedRevenue: 1_000 * (1.08 ** (index + 1)),
    estimatedEps: 2 + index * 0.2,
    revenueAnalystCount: 8,
    epsAnalystCount: 8,
    provider: 'financial-modeling-prep',
    asOf: '2026-07-25T00:00:00.000Z',
  })),
  peerObservations: [10, 11, 12, 13, 1000].map((multiple, index) => ({
    symbol: `P${index + 1}`,
    sector: 'Technology',
    industry: 'Software',
    price: multiple * 2,
    priceAsOf: '2026-07-24T20:00:00.000Z',
    enterpriseValue: multiple * 100,
    enterpriseValueAsOf: '2026-06-30',
    forwardEps: 2,
    forwardRevenue: 100,
    estimatePeriod: '2026-12-31',
    estimateAsOf: '2026-07-25T00:00:00.000Z',
    provider: 'financial-modeling-prep',
  })),
  waccMarketInputs: {
    beta: 1.2,
    betaAsOf: '2026-07-25T00:00:00.000Z',
    riskFreeRate: 0.04,
    riskFreeAsOf: '2026-07-23',
    equityRiskPremium: 0.05,
    equityRiskPremiumAsOf: '2026-07-25T00:00:00.000Z',
    provider: 'financial-modeling-prep',
  },
  dilutedSharesSource: 'diluted',
  providerStatus: 'live',
  calculatedAt: '2026-07-25T00:00:00.000Z',
};

describe('Nexora deterministic Fair Value engine', () => {
  it('requires real estimates, WACC inputs, peers, and USD', () => {
    expect(dataSufficiency(input, Date.parse('2026-07-25')).ok).toBe(true);
    expect(dataSufficiency({ ...input, analystEstimates: null }).missingInputs).toContain('forwardEstimates');
    expect(dataSufficiency({ ...input, waccMarketInputs: null }).missingInputs).toContain('waccMarketInputs');
    expect(dataSufficiency({ ...input, peerObservations: null }).missingInputs).toContain('peerObservations');
    expect(dataSufficiency({ ...input, currency: 'THB' }).missingInputs).toContain('valuationInputsNormalizedToUSD');
  });

  it('publishes Base Fair Value only after both models pass and applies explicit 60/40 weights', () => {
    const result = calculateFairValue(input, Date.parse('2026-07-25'));
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    const dcf = result.modelResults.find((model) => model.model === 'fcff-dcf')!;
    const multiples = result.modelResults.find((model) => model.model === 'pe')!;
    expect(dcf.weight).toBe(0.6);
    expect(multiples.weight).toBe(0.4);
    expect(result.fundamentalFairValue.centralEstimate).toBeCloseTo(
      dcf.fairValue * 0.6 + multiples.fairValue * 0.4,
    );
    expect(result.upsidePercent).toBeCloseTo(
      (result.fundamentalFairValue.centralEstimate - input.marketPrice) / input.marketPrice * 100,
    );
    expect(result.currency).toBe('USD');
    expect(result.inputDetails.map((detail) => detail.field)).toEqual(expect.arrayContaining([
      'Latest Real FCF',
      'WACC',
      'Peer List',
      'Peer Multiples',
      'Median Peer Multiple',
      'Diluted Shares Outstanding',
    ]));
  });

  it('uses shares outstanding only as a disclosed fallback', () => {
    const result = calculateFairValue({
      ...input,
      sharesOutstanding: 120,
      sharesOutstandingAsOf: '2026-06-30',
      periods: [{ ...latest, dilutedShares: 0 }],
    }, Date.parse('2026-07-25'));
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.inputDetails.some((detail) =>
        detail.field === 'Shares Outstanding (provider fallback)' && detail.value === 120)).toBe(true);
    }
  });

  it('returns unavailable for missing estimates, insufficient peers, WACC failure, or non-finite input', () => {
    const missingEstimates = calculateFairValue({ ...input, analystEstimates: [] }, Date.parse('2026-07-25'));
    expect(missingEstimates).toMatchObject({
      status: 'unavailable',
      missingFields: expect.arrayContaining(['forwardEstimates']),
    });
    const peers = calculateFairValue({
      ...input,
      peerObservations: input.peerObservations!.slice(0, 3),
    }, Date.parse('2026-07-25'));
    expect(peers).toMatchObject({
      status: 'unavailable',
      provider: 'financial-modeling-prep',
      missingFields: expect.arrayContaining(['validForwardPeers>=4']),
    });
    const wacc = calculateFairValue({
      ...input,
      waccMarketInputs: { ...input.waccMarketInputs!, beta: null },
    }, Date.parse('2026-07-25'));
    expect(wacc).toMatchObject({ status: 'unavailable', missingFields: expect.arrayContaining(['beta']) });
    const nonFinite = calculateFairValue({
      ...input,
      periods: [{ ...latest, freeCashFlow: Number.POSITIVE_INFINITY }],
    }, Date.parse('2026-07-25'));
    expect(nonFinite).toMatchObject({ status: 'unavailable' });
  });

  it('rejects stale peers and incomplete multi-year consensus instead of extending them', () => {
    const stalePeers = calculateFairValue({
      ...input,
      peerObservations: input.peerObservations!.map((peer) => ({
        ...peer,
        priceAsOf: '2026-06-01T00:00:00.000Z',
        estimateAsOf: '2026-06-01T00:00:00.000Z',
      })),
    }, Date.parse('2026-07-25'));
    expect(stalePeers).toMatchObject({
      status: 'unavailable',
      missingFields: expect.arrayContaining(['validForwardPeers>=4']),
    });

    const incompleteConsensus = calculateFairValue({
      ...input,
      analystEstimates: input.analystEstimates!.slice(0, 3),
    }, Date.parse('2026-07-25'));
    expect(incompleteConsensus).toMatchObject({
      status: 'unavailable',
      missingFields: expect.arrayContaining(['forwardRevenueEstimates']),
    });
  });

  it('never fabricates a numeric fallback when a critical model is unavailable', () => {
    const result = calculateFairValue({
      ...input,
      peerObservations: [],
    }, Date.parse('2026-07-25'));
    expect(result.status).toBe('unavailable');
    expect(result).not.toHaveProperty('fundamentalFairValue');
  });
});
