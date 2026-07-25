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
  it('keeps forward estimates and peers out of the global critical-input gate', () => {
    expect(dataSufficiency(input, Date.parse('2026-07-25')).ok).toBe(true);
    expect(dataSufficiency({ ...input, analystEstimates: null }).missingInputs)
      .not.toContain('forwardEstimates');
    expect(dataSufficiency({ ...input, waccMarketInputs: null }).missingInputs).toContain('waccMarketInputs');
    expect(dataSufficiency({ ...input, peerObservations: null }).missingInputs)
      .not.toContain('peerObservations');
    expect(dataSufficiency({ ...input, currency: 'THB' }).missingInputs).toContain('valuationInputsNormalizedToUSD');
  });

  it('publishes Base Fair Value only after both models pass and applies explicit 60/40 weights', () => {
    const result = calculateFairValue(input, Date.parse('2026-07-25'));
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    const dcf = result.modelResults.find((model) => model.model === 'fcff-dcf')!;
    const multiples = result.modelResults.find((model) => model.model === 'pe')!;
    expect(result.baseStatus).toBe('available');
    expect(result.fairValue).toMatchObject({
      type: 'base',
      label: 'Base Fair Value',
      confidence: 'High',
    });
    expect(dcf.weight).toBe(0.6);
    expect(multiples.weight).toBe(0.4);
    const centralEstimate = result.fundamentalFairValue.centralEstimate;
    expect(centralEstimate).not.toBeNull();
    if (centralEstimate === null) return;
    expect(centralEstimate).toBeCloseTo(
      dcf.fairValue * 0.6 + multiples.fairValue * 0.4,
    );
    expect(result.upsidePercent).toBeCloseTo(
      (centralEstimate - input.marketPrice) / input.marketPrice * 100,
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

  it('returns unavailable only when neither model passes, and exposes valid partial models', () => {
    const missingEstimates = calculateFairValue({ ...input, analystEstimates: [] }, Date.parse('2026-07-25'));
    expect(missingEstimates).toMatchObject({
      status: 'unavailable',
      missingFields: expect.arrayContaining([
        'forwardRevenueEstimatesOrHistoricalRevenueGrowth',
        'targetForwardEstimate',
      ]),
    });
    if (missingEstimates.status === 'unavailable') {
      const dcfDiagnostic = missingEstimates.diagnostics.find((item) =>
        item.field === 'model:fcff-dcf');
      const multiplesDiagnostic = missingEstimates.diagnostics.find((item) =>
        item.field === 'model:forward-multiples');
      const peDiagnostic = missingEstimates.diagnostics.find((item) =>
        item.field === 'model:forward-pe');
      const evSalesDiagnostic = missingEstimates.diagnostics.find((item) =>
        item.field === 'model:forward-ev-sales');
      expect(dcfDiagnostic?.reason)
        .toBe('unavailable:forwardRevenueEstimatesOrHistoricalRevenueGrowth');
      expect(multiplesDiagnostic?.reason).toBe('unavailable:targetForwardEstimate');
      expect(multiplesDiagnostic?.reason).not.toMatch(/beta|riskFreeRate|equityRiskPremium/);
      expect(peDiagnostic?.reason).toBe(
        'unavailable:targetForwardEps,validForwardPePeers>=4',
      );
      expect(evSalesDiagnostic?.reason).toBe(
        'unavailable:targetForwardRevenue,validForwardEvSalesPeers>=4',
      );
      expect(peDiagnostic?.reason).not.toMatch(/beta|riskFreeRate|equityRiskPremium/);
      expect(evSalesDiagnostic?.reason).not.toMatch(/beta|riskFreeRate|equityRiskPremium/);
    }
    const peers = calculateFairValue({
      ...input,
      peerObservations: input.peerObservations!.slice(0, 3),
    }, Date.parse('2026-07-25'));
    expect(peers).toMatchObject({
      status: 'available',
      baseStatus: 'unavailable',
      missingInputs: expect.arrayContaining(['validForwardPeers>=4']),
    });
    if (peers.status === 'available') {
      expect(peers.modelResults.map((model) => model.model)).toEqual(['fcff-dcf']);
      expect(peers.fundamentalFairValue.centralEstimate).toBeNull();
      expect(peers.fairValue).toMatchObject({
        type: 'dcf',
        label: 'DCF Fair Value',
        value: peers.modelResults[0].fairValue,
      });
      expect(peers.upsidePercent).not.toBeNull();
    }
    const wacc = calculateFairValue({
      ...input,
      waccMarketInputs: { ...input.waccMarketInputs!, beta: null },
    }, Date.parse('2026-07-25'));
    expect(wacc).toMatchObject({
      status: 'available',
      baseStatus: 'unavailable',
      missingInputs: expect.arrayContaining(['beta']),
    });
    if (wacc.status === 'available') {
      expect(wacc.modelResults.map((model) => model.model)).toEqual(['pe']);
      expect(wacc.fairValue).toMatchObject({
        type: 'relative',
        label: 'Relative Fair Value',
        value: wacc.modelResults[0].fairValue,
      });
    }
    const nonFinite = calculateFairValue({
      ...input,
      periods: [{ ...latest, freeCashFlow: Number.POSITIVE_INFINITY }],
    }, Date.parse('2026-07-25'));
    expect(nonFinite).toMatchObject({
      status: 'available',
      baseStatus: 'unavailable',
      missingInputs: expect.arrayContaining(['latestRealFreeCashFlow']),
    });
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
      status: 'available',
      baseStatus: 'unavailable',
      missingInputs: expect.arrayContaining(['validForwardPeers>=4']),
    });

    const incompleteConsensus = calculateFairValue({
      ...input,
      analystEstimates: input.analystEstimates!.slice(0, 3),
    }, Date.parse('2026-07-25'));
    expect(incompleteConsensus).toMatchObject({
      status: 'available',
      baseStatus: 'unavailable',
      missingInputs: expect.arrayContaining([
        'forwardRevenueEstimatesOrHistoricalRevenueGrowth',
      ]),
    });
  });

  it('publishes standalone DCF from verified historical growth when relative inputs are absent', () => {
    const periods = [
      { ...latest, periodEnd: '2022-12-31', revenue: 650, freeCashFlow: 60 },
      { ...latest, periodEnd: '2023-12-31', revenue: 760, freeCashFlow: 75 },
      { ...latest, periodEnd: '2024-12-31', revenue: 880, freeCashFlow: 95 },
      latest,
    ];
    const result = calculateFairValue({
      ...input,
      periods,
      analystEstimates: [],
      peerObservations: [],
    }, Date.parse('2026-07-25'));

    expect(result).toMatchObject({
      status: 'available',
      baseStatus: 'unavailable',
      fairValue: {
        type: 'dcf',
        label: 'DCF Fair Value',
      },
    });
    if (result.status === 'available') {
      expect(result.modelResults.map((model) => model.model)).toEqual(['fcff-dcf']);
      expect(result.modelResults[0].inputs).toMatchObject({
        growthMethod: 'historical-revenue-cagr-proxy',
      });
      expect(result.missingInputs).toContain('targetForwardEstimate');
    }
  });

  it('never fabricates or reweights Base Fair Value when one model is unavailable', () => {
    const result = calculateFairValue({
      ...input,
      peerObservations: [],
    }, Date.parse('2026-07-25'));
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.baseStatus).toBe('unavailable');
    expect(result.fundamentalFairValue.centralEstimate).toBeNull();
    expect(result.modelResults).toHaveLength(1);
    expect(result.modelResults[0].model).toBe('fcff-dcf');
    expect(result.modelResults[0].normalizedWeight).toBeUndefined();
    expect(result.fairValue.type).toBe('dcf');
    expect(result.fairValue.label).not.toMatch(/Base|Blended/);
  });

  it('uses real forward revenue for Relative Fair Value when provider EPS is absent', () => {
    const revenueOnly = calculateFairValue({
      ...input,
      waccMarketInputs: null,
      analystEstimates: input.analystEstimates!.map((estimate) => ({
        ...estimate,
        estimatedEps: null,
        epsAnalystCount: null,
      })),
    }, Date.parse('2026-07-25'));
    expect(revenueOnly.status).toBe('available');
    if (revenueOnly.status !== 'available') return;
    expect(revenueOnly.modelResults.map((model) => model.model)).toEqual(['ev-sales']);
    expect(revenueOnly.fairValue).toMatchObject({
      type: 'relative',
      label: 'Relative Fair Value',
      confidence: 'Medium',
    });
    expect(revenueOnly.inputDetails).toContainEqual(expect.objectContaining({
      field: 'Target Forward Revenue',
      value: input.analystEstimates![0].estimatedRevenue,
    }));
  });

  it('does not fabricate missing provider values when no model passes', () => {
    const result = calculateFairValue({
      ...input,
      analystEstimates: [],
      peerObservations: [],
      waccMarketInputs: null,
    }, Date.parse('2026-07-25'));
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result).not.toHaveProperty('fairValue');
    expect(result).not.toHaveProperty('modelResults');
    expect(result.diagnostics.filter((item) => item.status === 'rejected')
      .every((item) => item.value === null)).toBe(true);
  });

  it('publishes Forward P/E without financial statements, cash, debt, or shares', () => {
    const result = calculateFairValue({
      ...input,
      periods: [],
      marketCapitalization: null,
      sharesOutstanding: null,
      waccMarketInputs: null,
    }, Date.parse('2026-07-25'));
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model)).toEqual(['pe']);
    expect(result.fairValue).toMatchObject({
      type: 'relative',
      label: 'Relative Fair Value',
    });
    expect(result.missingInputs).toContain('historicalFinancials');
    expect(result.inputDetails.map((detail) => detail.field)).not.toContain('Cash');
    expect(result.inputDetails.map((detail) => detail.field))
      .not.toContain('Shares Outstanding (provider fallback)');
  });

  it('publishes Forward EV/Sales without statements only with a dated USD bridge', () => {
    const result = calculateFairValue({
      ...input,
      periods: [],
      waccMarketInputs: null,
      sharesOutstanding: 100,
      sharesOutstandingAsOf: '2026-06-30',
      balanceSheetBridge: {
        cash: 100,
        debt: 200,
        currency: 'USD',
        asOf: '2026-06-30',
        provider: 'financial-modeling-prep',
      },
      analystEstimates: input.analystEstimates!.map((estimate) => ({
        ...estimate,
        estimatedEps: null,
        epsAnalystCount: null,
      })),
    }, Date.parse('2026-07-25'));
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model)).toEqual(['ev-sales']);
    expect(result.inputDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'Cash', period: '2026-06-30' }),
      expect.objectContaining({ field: 'Total Debt', period: '2026-06-30' }),
    ]));
  });

  it('does not count duplicate, mismatched-period, wrong-currency, or irrelevant peers', () => {
    const invalidPeers = [
      ...input.peerObservations!.slice(0, 2),
      { ...input.peerObservations![2], estimatePeriod: '2027-12-31' },
      { ...input.peerObservations![3], currency: 'EUR' },
      { ...input.peerObservations![4], sector: 'Healthcare', industry: 'Biotech' },
      { ...input.peerObservations![0] },
    ];
    const result = calculateFairValue({
      ...input,
      periods: [],
      waccMarketInputs: null,
      peerObservations: invalidPeers,
    }, Date.parse('2026-07-25'));
    expect(result).toMatchObject({
      status: 'unavailable',
      missingFields: expect.arrayContaining(['validForwardPeers>=4']),
    });
  });

  it('rejects mismatched or duplicate financial periods before any model calculation', () => {
    expect(calculateFairValue({
      ...input,
      periods: [{ ...latest, currency: 'EUR' }],
    }, Date.parse('2026-07-25'))).toMatchObject({
      status: 'unavailable',
      missingFields: ['financialPeriodCurrencyMismatch'],
    });
    expect(calculateFairValue({
      ...input,
      periods: [latest, { ...latest }],
    }, Date.parse('2026-07-25'))).toMatchObject({
      status: 'unavailable',
      missingFields: ['duplicateFinancialPeriods'],
    });
  });

  it('deterministically caps quality at Medium and discloses grounded evidence', () => {
    const source = {
      url: 'https://www.nasdaq.com/market-activity/stocks/test/earnings',
      publisher: 'Nasdaq',
      publishedAt: '2026-07-24',
      evidence: 'TEST FY2026 revenue consensus is 1080 USD.',
      quality: 'reputable' as const,
    };
    const estimates = input.analystEstimates!.map((estimate, index) => index === 0
      ? {
          ...estimate,
          revenueProvenance: {
            provider: 'gemini-grounded-research',
            sourceType: 'gemini-grounded' as const,
            field: 'analystConsensusRevenue',
            fiscalPeriod: estimate.periodEnd,
            asOf: estimate.asOf,
            sourceUrl: source.url,
            evidence: [source],
            evidenceQuality: 'medium' as const,
          },
        }
      : estimate);
    const result = calculateFairValue({ ...input, analystEstimates: estimates }, Date.parse('2026-07-25'));
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.dataQualityLabel).toBe('Medium');
    expect(result.inputDetails).toContainEqual(expect.objectContaining({
      field: 'Consensus Revenue 2026-12-31',
      sourceType: 'gemini-grounded',
      sourceUrl: source.url,
      evidenceCount: 1,
    }));
  });
});
