import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketDataError } from '@/src/lib/market-data/errors';
import type { AnalystEstimate, ValuationInput } from './types';

const mocks = vi.hoisted(() => ({
  getFundamentalsProvider: vi.fn(),
  getMarketDataProvider: vi.fn(),
  getHistoricalMarketDataService: vi.fn(),
  loadResilientQuote: vi.fn(),
  getFmpValuationProvider: vi.fn(),
  research: vi.fn(),
  getGroundedFinancialResearchService: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/market-data', () => ({
  getMarketDataProvider: mocks.getMarketDataProvider,
  getHistoricalMarketDataService: mocks.getHistoricalMarketDataService,
}));
vi.mock('@/src/lib/market-data/quote-service', () => ({
  loadResilientQuote: mocks.loadResilientQuote,
}));
vi.mock('../fundamentals/provider', () => ({
  getFundamentalsProvider: mocks.getFundamentalsProvider,
}));
vi.mock('./providers/financial-modeling-prep', () => ({
  getFmpValuationProvider: mocks.getFmpValuationProvider,
}));
vi.mock('./grounded-research', () => ({
  getGroundedFinancialResearchService: mocks.getGroundedFinancialResearchService,
}));

import { calculateFairValueSafely, loadFairValue } from './orchestration';

const financialPeriod = {
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

function priceHistory(multiplier: number) {
  let close = 100;
  return Array.from({ length: 90 }, (_, index) => {
    close *= Math.exp((((index % 7) - 3) / 1_000) * multiplier);
    return {
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000,
    };
  });
}

function arrangeProviders() {
  const quote = {
      data: { symbol: 'AAPL', currency: 'USD', price: 20 },
      freshness: {
        status: 'realtime',
        asOf: '2026-07-24T20:00:00.000Z',
        maxAgeSeconds: 60,
      },
      provider: 'polygon',
    };
  mocks.loadResilientQuote.mockResolvedValue(quote);
  mocks.getMarketDataProvider.mockReturnValue({
    id: 'polygon',
    getQuote: vi.fn().mockResolvedValue(quote),
    getCompanyProfile: vi.fn().mockResolvedValue({
      data: {
        symbol: 'AAPL',
        currency: 'USD',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        marketCapitalization: 2_000,
      },
      freshness: {
        status: 'cached',
        asOf: '2026-07-24T00:00:00.000Z',
        maxAgeSeconds: 86_400,
      },
      provider: 'polygon',
    }),
  });
  mocks.getFundamentalsProvider.mockReturnValue({
    id: 'financial-modeling-prep',
    getFinancialPeriods: vi.fn().mockResolvedValue({
      symbol: 'AAPL',
      periods: [financialPeriod],
      quarterlyPeriods: [],
      annualRecords: [],
      quarterlyRecords: [],
      asOf: '2025-12-31',
      fetchedAt: '2026-07-24T00:00:00.000Z',
      currency: 'USD',
      dilutedEpsTtm: null,
      dilutedEpsAsOf: null,
      missingInputs: [],
      datasetErrors: {},
      diagnostics: {
        provider: 'financial-modeling-prep',
        capabilities: [],
        datasets: {},
        cache: { income: 'miss', balance: 'miss', cashFlow: 'miss' },
        datasetFetchedAt: {},
        latencyMs: 1,
        normalizedPeriodCount: { annual: 1, quarterly: 0 },
      },
    }),
  });
  mocks.getFmpValuationProvider.mockReturnValue({
    id: 'financial-modeling-prep',
    getValuationDataset: vi.fn().mockResolvedValue({
      provider: 'financial-modeling-prep',
      marketPrice: 20,
      marketPriceAsOf: '2026-07-24T20:00:00.000Z',
      currency: 'USD',
      estimates: [2026, 2027, 2028, 2029, 2030].map((year, index) => ({
        periodEnd: `${year}-12-31`,
        estimatedRevenue: 1_000 * (1.08 ** (index + 1)),
        estimatedEps: 2 + index * 0.2,
        revenueAnalystCount: 8,
        epsAnalystCount: 8,
        provider: 'financial-modeling-prep',
        asOf: '2026-07-25T00:00:00.000Z',
      })),
      peers: [10, 11, 12, 13, 1000].map((multiple, index) => ({
        symbol: `P${index + 1}`,
        sector: 'Technology',
        industry: 'Consumer Electronics',
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
        riskFreeAsOf: '2026-07-24',
        equityRiskPremium: 0.05,
        equityRiskPremiumAsOf: '2026-07-25T00:00:00.000Z',
        provider: 'financial-modeling-prep',
      },
      marketCapitalization: 2_000,
      sharesOutstanding: 100,
      sharesOutstandingAsOf: '2026-06-30',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      asOf: '2026-07-25T00:00:00.000Z',
      cacheStatus: 'miss',
    }),
  });
}

describe('Fair Value orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arrangeProviders();
    mocks.getGroundedFinancialResearchService.mockReturnValue({ research: mocks.research });
    mocks.research.mockResolvedValue({
      metrics: [],
      rejectedReasons: [],
      cache: 'negative',
      unavailableReason: 'no-validated-grounded-evidence',
    });
    mocks.getHistoricalMarketDataService.mockReturnValue({
      getHistoricalPrices: vi.fn(async (symbol: string) => ({
        data: {
          symbol,
          range: '5y',
          interval: '1d',
          prices: priceHistory(symbol === 'SPY' ? 1 : 1.4),
          providerUsed: 'historical-provider',
        },
        freshness: {
          status: 'cached',
          asOf: '2026-03-31T00:00:00.000Z',
          maxAgeSeconds: 86_400,
        },
        provider: 'historical-provider',
      })),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('combines independently sourced market, financial, estimate, peer, and WACC inputs', async () => {
    const result = await loadFairValue('AAPL');
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model)).toEqual(['fcff-dcf', 'pe']);
    expect(result.marketPrice.source).toBe('polygon');
    expect(result.sources.map((source) => source.name))
      .toEqual(expect.arrayContaining(['financial-modeling-prep']));
    expect(result.currency).toBe('USD');
    expect(result.displayFx).toBeNull();
    expect(mocks.research).not.toHaveBeenCalled();
  });

  it('continues through bounded research after valuation-provider throttling', async () => {
    mocks.getFmpValuationProvider.mockReturnValue({
      id: 'financial-modeling-prep',
      getValuationDataset: vi.fn().mockRejectedValue(
        new MarketDataError('rate-limited', 'provider throttled'),
      ),
    });
    const result = await loadFairValue('AAPL');
    expect(result).toMatchObject({
      status: 'unavailable',
      provider: expect.stringContaining('financial-modeling-prep'),
      missingFields: expect.arrayContaining(['targetForwardEstimate']),
    });
    expect(mocks.research).toHaveBeenCalled();
    expect(result.inputResolution?.researchable)
      .toEqual(expect.arrayContaining(['forwardRevenue', 'riskFreeRate']));
  });

  it('does not let dual fundamentals throttling kill an independently valid Forward P/E', async () => {
    mocks.getFundamentalsProvider.mockReturnValue({
      id: 'alpha-vantage',
      getFinancialPeriods: vi.fn().mockResolvedValue({
        symbol: 'AAPL',
        periods: [],
        quarterlyPeriods: [],
        annualRecords: [],
        quarterlyRecords: [],
        asOf: '2026-07-25',
        fetchedAt: '2026-07-25T00:00:00.000Z',
        currency: '',
        dilutedEpsTtm: null,
        dilutedEpsAsOf: null,
        missingInputs: ['financialStatements'],
        datasetErrors: {
          'income-statement': 'rate-limited',
          'balance-sheet': 'rate-limited',
          'cash-flow': 'rate-limited',
        },
        diagnostics: {
          provider: 'alpha-vantage',
          capabilities: [],
          datasets: {},
          cache: { income: 'miss', balance: 'miss', cashFlow: 'miss' },
          datasetFetchedAt: {},
          latencyMs: 1,
          normalizedPeriodCount: { annual: 0, quarterly: 0 },
        },
        primaryProvider: 'alpha-vantage',
        providerUsed: 'alpha-vantage',
        fallbackReason: 'PRIMARY_RATE_LIMITED; SECONDARY_RATE_LIMITED',
      }),
    });
    const result = await loadFairValue('AAPL');
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model)).toEqual(['pe']);
    expect(result.fairValue.label).toBe('Relative Fair Value');
    expect(result.excludedModels).toContainEqual(expect.objectContaining({
      model: 'fcff-dcf',
      reason: expect.stringContaining('historicalFinancials'),
    }));
    expect(mocks.research).not.toHaveBeenCalled();
  });

  it('caps model-aware research instead of searching every missing field', async () => {
    mocks.getFundamentalsProvider.mockReturnValue({
      id: 'alpha-vantage',
      getFinancialPeriods: vi.fn().mockRejectedValue(
        new MarketDataError('rate-limited', 'fundamentals throttled'),
      ),
    });
    mocks.getFmpValuationProvider.mockReturnValue({
      id: 'financial-modeling-prep',
      getValuationDataset: vi.fn().mockRejectedValue(
        new MarketDataError('rate-limited', 'valuation throttled'),
      ),
    });
    const result = await loadFairValue('AAPL');
    expect(result.status).toBe('unavailable');
    expect(mocks.research.mock.calls.length).toBeLessThanOrEqual(3);
    expect(mocks.research.mock.calls.flatMap(([request]) => request.metrics))
      .not.toEqual(expect.arrayContaining(['riskFreeRate', 'equityRiskPremium', 'beta']));
  });

  it('uses the traceable FMP quote when the primary market quote is throttled', async () => {
    mocks.loadResilientQuote.mockRejectedValue(
      new MarketDataError('rate-limited', 'primary throttled'),
    );
    const result = await loadFairValue('AAPL');
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.marketPrice).toMatchObject({
      value: 20,
      source: 'financial-modeling-prep',
    });
    expect(result.inputDetails).toContainEqual(expect.objectContaining({
      field: 'Current Price',
      provider: 'financial-modeling-prep',
    }));
  });

  it('uses the resolver and grounded-research path when FMP is not configured', async () => {
    mocks.getFmpValuationProvider.mockReturnValue(null);
    const result = await loadFairValue('AAPL');
    expect(result).toMatchObject({
      status: 'unavailable',
      missingFields: expect.arrayContaining(['targetForwardEstimate']),
    });
    expect(mocks.getMarketDataProvider).toHaveBeenCalled();
    expect(mocks.research).toHaveBeenCalled();
  });

  it('redacts calculation exceptions and exposes no numeric fallback', () => {
    const logger = vi.fn();
    const input = {
      symbol: 'AAPL',
      currency: 'USD',
      source: 'financial-modeling-prep',
      calculatedAt: '2026-07-25T00:00:00.000Z',
    } as ValuationInput;
    const result = calculateFairValueSafely(input, () => {
      throw Object.assign(new Error('apikey=must-not-appear'), {
        code: 'internal-error',
        apiKey: 'must-not-appear',
      });
    }, logger);
    expect(result).toMatchObject({
      status: 'unavailable',
      failureKind: 'calculation-error',
      missingFields: ['valuationCalculation'],
    });
    expect(result).not.toHaveProperty('fundamentalFairValue');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('must-not-appear');
  });

  it('derives a missing beta from stock and benchmark history without Gemini', async () => {
    const valuationProvider = mocks.getFmpValuationProvider();
    const dataset = await valuationProvider.getValuationDataset();
    valuationProvider.getValuationDataset.mockResolvedValue({
      ...dataset,
      waccMarketInputs: {
        ...dataset.waccMarketInputs,
        beta: null,
        betaAsOf: null,
      },
    });

    const result = await loadFairValue('AAPL');

    expect(mocks.getHistoricalMarketDataService).toHaveBeenCalledTimes(1);
    expect(mocks.research).not.toHaveBeenCalled();
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.inputDetails).toContainEqual(expect.objectContaining({
        field: 'Beta',
        sourceType: 'derived',
        origin: 'derived',
      }));
      expect(result.inputResolution?.resolved).toContainEqual(expect.objectContaining({
        field: 'beta',
        origin: 'derived',
      }));
    }
  });

  it('rescues missing market-level WACC inputs in one shared-scope research request', async () => {
    const valuationProvider = mocks.getFmpValuationProvider();
    const dataset = await valuationProvider.getValuationDataset();
    valuationProvider.getValuationDataset.mockResolvedValue({
      ...dataset,
      waccMarketInputs: {
        ...dataset.waccMarketInputs,
        riskFreeRate: null,
        riskFreeAsOf: null,
        equityRiskPremium: null,
        equityRiskPremiumAsOf: null,
      },
    });
    mocks.research.mockResolvedValue({
      metrics: [
        {
          symbol: null,
          metric: 'riskFreeRate',
          field: 'riskFreeRate',
          fiscalYear: 2026,
          periodEnd: '2026-07-24',
          period: '2026-07-24',
          value: 0.043,
          unit: 'decimal',
          currency: 'USD',
          asOf: '2026-07-24',
          analystCount: null,
          confidence: 'high',
          provenance: {
            provider: 'gemini-grounded-research',
            sourceType: 'gemini-grounded',
            field: 'riskFreeRate',
            fiscalPeriod: '2026-07-24',
            asOf: '2026-07-24',
            evidence: [{
              url: 'https://home.treasury.gov/rates',
              publisher: 'U.S. Treasury',
              publishedAt: '2026-07-24',
              evidence: 'The published 10-year rate was 4.3 percent.',
              quality: 'primary',
            }],
            evidenceQuality: 'high',
          },
        },
        {
          symbol: null,
          metric: 'equityRiskPremium',
          field: 'equityRiskPremium',
          fiscalYear: 2026,
          periodEnd: '2026-07-24',
          period: '2026-07-24',
          value: 0.05,
          unit: 'decimal',
          currency: 'USD',
          asOf: '2026-07-24',
          analystCount: null,
          confidence: 'high',
          provenance: {
            provider: 'gemini-grounded-research',
            sourceType: 'gemini-grounded',
            field: 'equityRiskPremium',
            fiscalPeriod: '2026-07-24',
            asOf: '2026-07-24',
            evidence: [{
              url: 'https://pages.stern.nyu.edu/~adamodar/',
              publisher: 'NYU Stern',
              publishedAt: '2026-07-24',
              evidence: 'The published U.S. equity risk premium was 5.0 percent.',
              quality: 'primary',
            }],
            evidenceQuality: 'high',
          },
        },
      ],
      rejectedReasons: [],
      cache: 'miss',
      unavailableReason: null,
    });

    const result = await loadFairValue('AAPL');

    expect(mocks.research).toHaveBeenCalledTimes(1);
    expect(mocks.research).toHaveBeenCalledWith({
      symbols: [],
      metrics: ['riskFreeRate', 'equityRiskPremium'],
      fiscalYears: [2026],
    });
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.dataQualityLabel).toBe('Medium');
      expect(result.inputDetails).toContainEqual(expect.objectContaining({
        field: 'Risk-free Rate',
        sourceType: 'gemini-grounded',
      }));
      expect(result.researchAudit).toMatchObject({
        geminiUsed: true,
        requests: 1,
        cacheMisses: 1,
      });
    }
  });

  it('uses provider forward revenue without researching or fabricating missing EPS', async () => {
    const valuationProvider = mocks.getFmpValuationProvider();
    const dataset = await valuationProvider.getValuationDataset();
    valuationProvider.getValuationDataset.mockResolvedValue({
      ...dataset,
      estimates: dataset.estimates.map((estimate: { estimatedEps: number }) => ({
        ...estimate,
        estimatedEps: null,
        epsAnalystCount: null,
      })),
    });
    mocks.research.mockResolvedValue({
      metrics: dataset.estimates.map((estimate: { periodEnd: string }, index: number) => ({
        symbol: 'AAPL',
        metric: 'eps',
        fiscalYear: Number(estimate.periodEnd.slice(0, 4)),
        periodEnd: estimate.periodEnd,
        value: 2 + index * 0.2,
        analystCount: 8,
        provenance: {
          provider: 'gemini-grounded-research',
          sourceType: 'gemini-grounded',
          field: 'analystConsensusEps',
          fiscalPeriod: estimate.periodEnd,
          asOf: '2026-07-24',
          evidence: [{
            url: 'https://www.nasdaq.com/market-activity/stocks/aapl/earnings',
            publisher: 'Nasdaq',
            publishedAt: '2026-07-24',
            evidence: 'AAPL forward EPS consensus.',
            quality: 'reputable',
          }],
          evidenceQuality: 'medium',
        },
      })),
      rejectedReasons: [],
      cache: 'miss',
      unavailableReason: null,
    });

    const result = await loadFairValue('AAPL');
    expect(mocks.research).not.toHaveBeenCalled();
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model)).toContain('ev-sales');
    expect(result.inputDetails.find((detail) => detail.field.startsWith('Consensus Revenue')))
      .toMatchObject({ sourceType: 'structured-provider' });
    expect(result.inputDetails.find((detail) => detail.field === 'Target Forward Revenue'))
      .toMatchObject({ sourceType: 'structured-provider' });
  });

  it('rescues revenue for the same fiscal period when non-positive EPS must use EV/Sales', async () => {
    const valuationProvider = mocks.getFmpValuationProvider();
    const dataset = await valuationProvider.getValuationDataset();
    valuationProvider.getValuationDataset.mockResolvedValue({
      ...dataset,
      estimates: dataset.estimates.map((estimate: AnalystEstimate, index: number) => ({
        ...estimate,
        estimatedRevenue: index === 0 ? null : estimate.estimatedRevenue,
        estimatedEps: index === 0 ? -0.5 : null,
        revenueAnalystCount: index === 0 ? null : estimate.revenueAnalystCount,
        epsAnalystCount: index === 0 ? 8 : null,
      })),
    });
    mocks.research.mockResolvedValue({
      metrics: [{
        symbol: 'AAPL',
        metric: 'revenue',
        fiscalYear: 2026,
        periodEnd: '2026-12-31',
        value: 1_080,
        analystCount: 8,
        provenance: {
          provider: 'gemini-grounded-research',
          sourceType: 'gemini-grounded',
          field: 'analystConsensusRevenue',
          fiscalPeriod: '2026-12-31',
          asOf: '2026-07-24',
          evidence: [{
            url: 'https://www.nasdaq.com/market-activity/stocks/aapl/earnings',
            publisher: 'Nasdaq',
            publishedAt: '2026-07-24',
            evidence: 'AAPL FY2026 forward revenue consensus is 1080 USD.',
            quality: 'reputable',
          }],
          evidenceQuality: 'medium',
        },
      }],
      rejectedReasons: [],
      cache: 'miss',
      unavailableReason: null,
    });

    const result = await loadFairValue('AAPL');

    expect(mocks.research).toHaveBeenCalledTimes(1);
    expect(mocks.research).toHaveBeenCalledWith(expect.objectContaining({
      symbols: ['AAPL'],
      metrics: ['revenue'],
    }));
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.modelResults.map((model) => model.model)).toContain('ev-sales');
      expect(result.inputResolution?.resolved).toContainEqual(expect.objectContaining({
        field: 'forwardRevenue',
        origin: 'gemini-grounded',
      }));
      expect(result.inputs.analystEstimates).toContainEqual(expect.objectContaining({
        periodEnd: '2026-12-31',
        estimatedRevenue: 1_080,
      }));
    }
  });

  it('batch-rescues missing peer estimates without one request per peer', async () => {
    const valuationProvider = mocks.getFmpValuationProvider();
    const dataset = await valuationProvider.getValuationDataset();
    valuationProvider.getValuationDataset.mockResolvedValue({
      ...dataset,
      peers: dataset.peers.map((peer: { symbol: string }) => ({
        ...peer,
        forwardEps: null,
        estimatePeriod: null,
        estimateAsOf: null,
      })),
    });
    mocks.research.mockImplementation(async (request: { symbols: string[] }) => ({
      metrics: request.symbols.map((symbol) => ({
        symbol,
        metric: 'eps',
        fiscalYear: 2026,
        periodEnd: '2026-12-31',
        value: 2,
        analystCount: 6,
        provenance: {
          provider: 'gemini-grounded-research',
          sourceType: 'gemini-grounded',
          field: 'analystConsensusEps',
          fiscalPeriod: '2026-12-31',
          asOf: '2026-07-24',
          evidence: [{
            url: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/earnings`,
            publisher: 'Nasdaq',
            publishedAt: '2026-07-24',
            evidence: `${symbol} forward EPS consensus.`,
            quality: 'reputable',
          }],
          evidenceQuality: 'medium',
        },
      })),
      rejectedReasons: [],
      cache: 'miss',
      unavailableReason: null,
    }));

    const result = await loadFairValue('AAPL');
    expect(mocks.research).toHaveBeenCalledTimes(1);
    expect(mocks.research.mock.calls[0][0].symbols).toHaveLength(5);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.modelResults.map((model) => model.model)).toContain('pe');
      expect(result.dataQualityLabel).toBe('Medium');
      expect(result.inputResolution?.resolved).toContainEqual(expect.objectContaining({
        field: 'peerForwardEstimates',
        origin: 'gemini-grounded',
      }));
      expect(result.inputs.peerObservations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          forwardEps: 2,
          estimateProvenance: expect.objectContaining({
            sourceType: 'gemini-grounded',
          }),
        }),
      ]));
    }
  });
});
