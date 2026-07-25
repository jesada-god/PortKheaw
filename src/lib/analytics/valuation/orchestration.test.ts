import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketDataError } from '@/src/lib/market-data/errors';
import type { AnalystEstimate, ValuationInput } from './types';
import {
  emptyValuationInputLkgSnapshot,
  type ValuationInputLkgEntry,
  type ValuationInputLkgSnapshot,
} from './persistent-inputs';

const mocks = vi.hoisted(() => ({
  getFundamentalsProvider: vi.fn(),
  getMarketDataProvider: vi.fn(),
  getHistoricalMarketDataService: vi.fn(),
  loadResilientQuote: vi.fn(),
  getFmpValuationProvider: vi.fn(),
  research: vi.fn(),
  researchPeers: vi.fn(),
  getGroundedFinancialResearchService: vi.fn(),
  resolveRiskFreeRate: vi.fn(),
  resolveEquityRiskPremium: vi.fn(),
  readValuationLkg: vi.fn(),
  writeValuationLkg: vi.fn(),
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
vi.mock('./independent-market-inputs', () => ({
  getIndependentMarketInputsResolver: () => ({
    resolveRiskFreeRate: mocks.resolveRiskFreeRate,
    resolveEquityRiskPremium: mocks.resolveEquityRiskPremium,
  }),
  IndependentMarketSourceError: class IndependentMarketSourceError extends Error {},
}));
vi.mock('./persistent-inputs-repository', () => ({
  getValuationInputLkgService: () => ({
    read: mocks.readValuationLkg,
    writeMany: mocks.writeValuationLkg,
  }),
  valuationInputLkgRepositoryConfigured: () => true,
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

function lkgEntry(
  metric: ValuationInputLkgEntry['metric'],
  data: unknown,
  overrides: Partial<ValuationInputLkgEntry> = {},
): ValuationInputLkgEntry {
  const market = metric === 'risk-free-rate' || metric === 'equity-risk-premium';
  const peers = metric === 'peer-forward-pe' || metric === 'peer-forward-ev-sales';
  return {
    scope: market ? 'market' : peers ? 'peers' : 'company',
    ownerKey: market ? 'US' : 'AAPL',
    metric,
    period: 'latest',
    data,
    source: 'persistent-test-source',
    origin: 'provider',
    asOf: '2026-07-24T00:00:00.000Z',
    fetchedAt: '2026-07-24T01:00:00.000Z',
    validatedAt: '2026-07-24T01:00:00.000Z',
    freshness: 'fresh',
    schemaVersion: 1,
    provenance: {
      provider: 'persistent-test-source',
      sourceType: 'structured-provider',
      field: metric,
      fiscalPeriod: 'latest',
      asOf: '2026-07-24T00:00:00.000Z',
      evidence: [],
      evidenceQuality: 'high',
    },
    ...overrides,
  };
}

function warmLkgSnapshot(): ValuationInputLkgSnapshot {
  const snapshot = emptyValuationInputLkgSnapshot('AAPL');
  const beta = lkgEntry('beta', { value: 1.2 });
  const riskFree = lkgEntry('risk-free-rate', { value: 0.04 });
  const erp = lkgEntry('equity-risk-premium', { value: 0.05 });
  snapshot.company.beta = { value: 1.2, state: 'fresh', entry: beta };
  snapshot.market.riskFreeRate = { value: 0.04, state: 'fresh', entry: riskFree };
  snapshot.market.equityRiskPremium = { value: 0.05, state: 'fresh', entry: erp };
  for (const year of [2026, 2027, 2028, 2029, 2030]) {
    const period = `${year}-12-31`;
    const eps = lkgEntry('forward-eps', {
      value: 2 + (year - 2026) * 0.2,
      analystCount: 8,
      currency: 'USD',
    }, { period });
    const revenue = lkgEntry('forward-revenue', {
      value: 1_080 * (1.08 ** (year - 2026)),
      analystCount: 8,
      currency: 'USD',
    }, { period });
    snapshot.company.forwardEps.push({
      value: (eps.data as { value: number }).value,
      analystCount: 8,
      currency: 'USD',
      period,
      state: 'fresh',
      entry: eps,
    });
    snapshot.company.forwardRevenue.push({
      value: (revenue.data as { value: number }).value,
      analystCount: 8,
      currency: 'USD',
      period,
      state: 'fresh',
      entry: revenue,
    });
  }
  const observations = [10, 11, 12, 13, 14].map((multiple, index) => ({
    symbol: `P${index + 1}`,
    sector: 'Technology',
    industry: 'Consumer Electronics',
    price: multiple * 2,
    priceAsOf: '2026-07-24T00:00:00.000Z',
    enterpriseValue: multiple * 100,
    enterpriseValueAsOf: '2026-07-24T00:00:00.000Z',
    forwardEps: 2,
    forwardRevenue: 100,
    estimatePeriod: '2026-12-31',
    estimateAsOf: '2026-07-24T00:00:00.000Z',
    provider: 'persistent-test-source',
    candidateSource: 'provider-peers' as const,
    currency: 'USD',
  }));
  const peerEntry = lkgEntry('peer-forward-pe', {
    metric: 'forward-pe',
    candidates: observations.map((peer) => peer.symbol),
    accepted: observations.map((peer) => peer.symbol),
    rejected: [],
    observations,
  }, { period: '2026-12-31' });
  snapshot.peers.push({
    metric: 'forward-pe',
    candidates: observations.map((peer) => peer.symbol),
    accepted: observations.map((peer) => peer.symbol),
    rejected: [],
    observations,
    state: 'fresh',
    entry: peerEntry,
  });
  return snapshot;
}

describe('Fair Value orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arrangeProviders();
    mocks.getGroundedFinancialResearchService.mockReturnValue({
      research: mocks.research,
      researchPeers: mocks.researchPeers,
    });
    mocks.research.mockResolvedValue({
      metrics: [],
      rejectedReasons: [],
      cache: 'negative',
      unavailableReason: 'no-validated-grounded-evidence',
    });
    mocks.researchPeers.mockResolvedValue({
      candidates: [],
      rejected: [],
      cache: 'negative',
      unavailableReason: 'no-validated-peer-candidates',
    });
    mocks.resolveRiskFreeRate.mockResolvedValue({
      value: 0.043,
      asOf: '2026-07-24',
      provenance: {
        provider: 'us-treasury-daily-par-yield-curve',
        sourceType: 'structured-provider',
        field: 'riskFreeRate',
        fiscalPeriod: '10Y',
        asOf: '2026-07-24',
        evidence: [],
        evidenceQuality: 'high',
      },
    });
    mocks.resolveEquityRiskPremium.mockResolvedValue({
      value: 0.0418,
      asOf: '2026-07-01',
      provenance: {
        provider: 'nyu-damodaran-implied-erp',
        sourceType: 'structured-provider',
        field: 'equityRiskPremium',
        fiscalPeriod: 'United States',
        asOf: '2026-07-01',
        evidence: [],
        evidenceQuality: 'high',
      },
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
    mocks.readValuationLkg.mockResolvedValue(emptyValuationInputLkgSnapshot('AAPL'));
    mocks.writeValuationLkg.mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('persists validated resolved inputs after a cold provider-backed calculation', async () => {
    const result = await loadFairValue('AAPL');

    expect(result.status).toBe('available');
    expect(mocks.writeValuationLkg).toHaveBeenCalledOnce();
    const entries = mocks.writeValuationLkg.mock.calls[0]?.[0] as ValuationInputLkgEntry[];
    expect(entries.map((entry) => entry.metric)).toEqual(expect.arrayContaining([
      'beta',
      'risk-free-rate',
      'equity-risk-premium',
      'forward-eps',
      'forward-revenue',
      'peer-forward-pe',
    ]));
  });

  it('evaluates from a warm persistent snapshot without FMP, Gemini, or history calls', async () => {
    const snapshot = warmLkgSnapshot();
    mocks.readValuationLkg.mockResolvedValue(snapshot);
    const valuationProvider = mocks.getFmpValuationProvider();
    valuationProvider.getValuationDataset.mockRejectedValue(
      new MarketDataError('rate-limited', 'FMP throttled'),
    );

    const result = await loadFairValue('AAPL');

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model))
      .toEqual(expect.arrayContaining(['fcff-dcf', 'pe']));
    expect(valuationProvider.getValuationDataset).not.toHaveBeenCalled();
    expect(mocks.research).not.toHaveBeenCalled();
    expect(mocks.researchPeers).not.toHaveBeenCalled();
    expect(mocks.getHistoricalMarketDataService().getHistoricalPrices).not.toHaveBeenCalled();
    expect(mocks.writeValuationLkg).not.toHaveBeenCalled();
  });

  it('uses cached Beta before provider and never fetches target or SPY history', async () => {
    const snapshot = emptyValuationInputLkgSnapshot('AAPL');
    const beta = lkgEntry('beta', { value: 1.72 });
    snapshot.company.beta = { value: 1.72, state: 'fresh', entry: beta };
    mocks.readValuationLkg.mockResolvedValue(snapshot);
    const history = mocks.getHistoricalMarketDataService();

    const result = await loadFairValue('AAPL');

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.inputs.waccMarketInputs).toMatchObject({ beta: 1.72 });
    expect(history.getHistoricalPrices).not.toHaveBeenCalled();
  });

  it('passes Forward EV/Sales from cached revenue, peers, and existing bridge inputs', async () => {
    const snapshot = warmLkgSnapshot();
    snapshot.company.forwardEps = [];
    const peerSet = snapshot.peers[0]!;
    peerSet.metric = 'forward-ev-sales';
    peerSet.entry.metric = 'peer-forward-ev-sales';
    peerSet.entry.data = {
      ...(peerSet.entry.data as Record<string, unknown>),
      metric: 'forward-ev-sales',
    };
    mocks.readValuationLkg.mockResolvedValue(snapshot);
    const valuationProvider = mocks.getFmpValuationProvider();
    valuationProvider.getValuationDataset.mockRejectedValue(
      new MarketDataError('rate-limited', 'FMP throttled'),
    );

    const result = await loadFairValue('AAPL');

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model))
      .toEqual(expect.arrayContaining(['fcff-dcf', 'ev-sales']));
    expect(result.inputs.analystEstimates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        periodEnd: '2026-12-31',
        estimatedEps: null,
        estimatedRevenue: 1_080,
      }),
    ]));
    expect(mocks.research).not.toHaveBeenCalled();
    expect(mocks.researchPeers).not.toHaveBeenCalled();
  });

  it('uses stale validated forward estimates only after FMP and Gemini are throttled', async () => {
    const snapshot = warmLkgSnapshot();
    snapshot.peers = [];
    for (const item of [...snapshot.company.forwardEps, ...snapshot.company.forwardRevenue]) {
      item.state = 'stale';
      item.entry.freshness = 'stale';
      item.entry.asOf = '2026-03-01T00:00:00.000Z';
      item.entry.origin = 'gemini-grounded';
      item.entry.provenance = {
        ...item.entry.provenance!,
        asOf: '2026-03-01T00:00:00.000Z',
        sourceType: 'gemini-grounded',
      };
    }
    mocks.readValuationLkg.mockResolvedValue(snapshot);
    const valuationProvider = mocks.getFmpValuationProvider();
    valuationProvider.getValuationDataset.mockRejectedValue(
      new MarketDataError('rate-limited', 'FMP throttled'),
    );
    mocks.research.mockResolvedValue({
      metrics: [],
      rejectedReasons: [],
      cache: 'negative',
      unavailableReason: 'gemini-rate-limited',
    });

    const result = await loadFairValue('AAPL');

    expect(valuationProvider.getValuationDataset).not.toHaveBeenCalled();
    expect(mocks.research).toHaveBeenCalled();
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model)).toContain('fcff-dcf');
    expect(result.inputs.analystEstimates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        periodEnd: '2026-12-31',
        estimatedEps: 2,
        estimatedRevenue: 1_080,
      }),
    ]));
    expect(result.dataStatus).toBe('stale');
    expect(mocks.writeValuationLkg).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent Fair Value requests for one symbol', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.readValuationLkg.mockImplementation(async () => {
      await gate;
      return emptyValuationInputLkgSnapshot('AAPL');
    });

    const first = loadFairValue('aapl');
    const second = loadFairValue('AAPL');
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(mocks.readValuationLkg).toHaveBeenCalledOnce();
  });

  it('reuses one shared US market snapshot across NVDA, AAPL, and MSFT without market-input provider calls', async () => {
    mocks.readValuationLkg.mockImplementation(async (symbol: string) => {
      const snapshot = warmLkgSnapshot();
      snapshot.symbol = symbol;
      snapshot.company.beta!.entry.ownerKey = symbol;
      for (const item of [
        ...snapshot.company.forwardEps,
        ...snapshot.company.forwardRevenue,
      ]) {
        item.entry.ownerKey = symbol;
      }
      for (const peer of snapshot.peers) peer.entry.ownerKey = symbol;
      return snapshot;
    });
    const valuationProvider = mocks.getFmpValuationProvider();

    const results = await Promise.all([
      loadFairValue('NVDA'),
      loadFairValue('AAPL'),
      loadFairValue('MSFT'),
    ]);

    expect(results.every((result) => result.status === 'available')).toBe(true);
    expect(valuationProvider.getValuationDataset).not.toHaveBeenCalled();
    expect(mocks.research).not.toHaveBeenCalled();
    expect(mocks.readValuationLkg).toHaveBeenCalledTimes(3);
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

  it('passes resolved Beta, Rf, ERP, forward EPS, and forward revenue into the engine', async () => {
    const result = await loadFairValue('AAPL');
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.inputs.waccMarketInputs).toMatchObject({
      beta: 1.2,
      riskFreeRate: 0.04,
      equityRiskPremium: 0.05,
    });
    expect(result.inputs.analystEstimates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        periodEnd: '2026-12-31',
        estimatedEps: 2,
        estimatedRevenue: 1_080,
      }),
    ]));
    expect(result.modelResults.map((model) => model.model))
      .toEqual(expect.arrayContaining(['fcff-dcf', 'pe']));
  });

  it('does not run P1 peer research after standalone DCF inputs are complete', async () => {
    const valuationProvider = mocks.getFmpValuationProvider();
    const dataset = await valuationProvider.getValuationDataset();
    valuationProvider.getValuationDataset.mockResolvedValue({
      ...dataset,
      peers: [],
      peerCandidates: [],
      peerRejections: [],
      endpointErrors: {
        ...dataset.endpointErrors,
        'stock-peers': 'rate-limited',
        'company-screener:industry': 'rate-limited',
        'company-screener:sector': 'rate-limited',
      },
    });
    const candidateSymbols = ['P1', 'P2', 'P3', 'P4', 'P5'];
    mocks.researchPeers.mockResolvedValue({
      candidates: candidateSymbols.map((peerSymbol) => ({
        symbol: peerSymbol,
        company: `${peerSymbol} Corporation`,
        sector: 'Technology',
        industry: 'Consumer Electronics',
        businessContext: `${peerSymbol} competes in consumer electronics hardware markets.`,
        asOf: '2026-07-24',
        sourceName: 'Nasdaq',
        sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${peerSymbol.toLowerCase()}`,
        evidence: [{
          url: `https://www.nasdaq.com/market-activity/stocks/${peerSymbol.toLowerCase()}`,
          publisher: 'Nasdaq',
          publishedAt: '2026-07-24',
          evidence: `${peerSymbol} operates in the consumer electronics industry.`,
          quality: 'reputable',
        }],
      })),
      rejected: [],
      cache: 'miss',
      unavailableReason: null,
    });
    const multiples = [10, 11, 12, 13, 1_000];
    const marketProvider = mocks.getMarketDataProvider();
    marketProvider.getQuote.mockImplementation(async (peerSymbol: string) => {
      const index = candidateSymbols.indexOf(peerSymbol);
      return {
        data: {
          symbol: peerSymbol,
          currency: 'USD',
          price: multiples[index] * 2,
        },
        freshness: {
          status: 'realtime',
          asOf: '2026-07-24T20:00:00.000Z',
          maxAgeSeconds: 60,
        },
        provider: 'polygon',
      };
    });
    mocks.research.mockResolvedValue({
      metrics: candidateSymbols.map((peerSymbol) => ({
        symbol: peerSymbol,
        metric: 'eps',
        field: 'eps',
        fiscalYear: 2026,
        periodEnd: '2026-12-31',
        period: '2026-12-31',
        value: 2,
        unit: 'USD/share',
        currency: 'USD',
        asOf: '2026-07-24',
        sourceName: 'Nasdaq',
        sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${peerSymbol.toLowerCase()}/earnings`,
        analystCount: 8,
        confidence: 'medium',
        provenance: {
          provider: 'gemini-grounded-research',
          sourceType: 'gemini-grounded',
          field: 'analystConsensusEps',
          fiscalPeriod: '2026-12-31',
          asOf: '2026-07-24',
          evidence: [{
            url: `https://www.nasdaq.com/market-activity/stocks/${peerSymbol.toLowerCase()}/earnings`,
            publisher: 'Nasdaq',
            publishedAt: '2026-07-24',
            evidence: `${peerSymbol} forward EPS consensus is 2.00 USD.`,
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

    expect(mocks.researchPeers).not.toHaveBeenCalled();
    expect(mocks.research).not.toHaveBeenCalled();
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.modelResults.map((model) => model.model)).toEqual(['fcff-dcf']);
    expect(result.fairValue).toMatchObject({
      type: 'dcf',
      label: 'DCF Fair Value',
    });
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
      const persisted = mocks.writeValuationLkg.mock.calls
        .flatMap(([entries]) => entries as ValuationInputLkgEntry[])
        .find((entry) => entry.metric === 'beta');
      expect(persisted).toMatchObject({
        origin: 'derived',
        provenance: expect.objectContaining({
          benchmark: 'SPY',
          frequency: 'daily',
          sampleSize: expect.any(Number),
          start: expect.any(String),
          end: expect.any(String),
        }),
      });
    }
  });

  it('rescues missing market-level WACC inputs from independent shared sources before Gemini', async () => {
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

    expect(mocks.resolveRiskFreeRate).toHaveBeenCalledTimes(1);
    expect(mocks.resolveEquityRiskPremium).toHaveBeenCalledTimes(1);
    expect(mocks.research).not.toHaveBeenCalled();
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.inputDetails).toContainEqual(expect.objectContaining({
        field: 'Risk-free Rate',
        sourceType: 'structured-provider',
        provider: 'us-treasury-daily-par-yield-curve',
      }));
      expect(result.researchAudit).toMatchObject({
        geminiUsed: false,
        requests: 0,
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

  it('does not batch-rescue optional peer estimates after DCF is ready', async () => {
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
    expect(mocks.research).not.toHaveBeenCalled();
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.modelResults.map((model) => model.model)).toEqual(['fcff-dcf']);
      expect(result.fairValue.type).toBe('dcf');
    }
  });

  it('passes P0 cold-start and restart recovery with FMP/Gemini unavailable', async () => {
    const fundamentals = mocks.getFundamentalsProvider();
    const baseSnapshot = await fundamentals.getFinancialPeriods('NVDA');
    fundamentals.getFinancialPeriods.mockResolvedValue({
      ...baseSnapshot,
      symbol: 'NVDA',
      periods: [
        { ...financialPeriod, periodEnd: '2022-12-31', revenue: 550, freeCashFlow: 55 },
        { ...financialPeriod, periodEnd: '2023-12-31', revenue: 680, freeCashFlow: 70 },
        { ...financialPeriod, periodEnd: '2024-12-31', revenue: 830, freeCashFlow: 90 },
        financialPeriod,
      ],
      providerUsed: 'alpha-vantage',
      diagnostics: {
        ...baseSnapshot.diagnostics,
        provider: 'alpha-vantage',
      },
    });
    mocks.getFundamentalsProvider.mockReturnValue({
      ...fundamentals,
      id: 'alpha-vantage',
    });
    const valuationProvider = mocks.getFmpValuationProvider();
    valuationProvider.getValuationDataset.mockRejectedValue(
      new MarketDataError('rate-limited', 'FMP 429', 120),
    );
    mocks.research.mockResolvedValue({
      metrics: [],
      rejectedReasons: ['gemini-rate-limited'],
      cache: 'negative',
      unavailableReason: 'gemini-rate-limited',
    });

    const cold = await loadFairValue('NVDA');

    expect(cold).toMatchObject({
      status: 'available',
      fairValue: { type: 'dcf', label: 'DCF Fair Value' },
      baseStatus: 'unavailable',
    });
    if (cold.status !== 'available') return;
    expect(cold.modelResults.map((model) => model.model)).toEqual(['fcff-dcf']);
    expect(cold.inputs.waccMarketInputs).toMatchObject({
      riskFreeRate: 0.043,
      equityRiskPremium: 0.0418,
      beta: expect.any(Number),
    });
    expect(mocks.resolveRiskFreeRate).toHaveBeenCalledOnce();
    expect(mocks.resolveEquityRiskPremium).toHaveBeenCalledOnce();
    expect(mocks.research).not.toHaveBeenCalled();

    const persisted = mocks.writeValuationLkg.mock.calls
      .flatMap(([entries]) => entries as ValuationInputLkgEntry[]);
    expect(persisted.map((entry) => entry.metric)).toEqual(expect.arrayContaining([
      'beta',
      'risk-free-rate',
      'equity-risk-premium',
    ]));

    const restartedLkg = emptyValuationInputLkgSnapshot('NVDA');
    for (const entry of persisted) {
      const value = (entry.data as { value?: number }).value;
      if (!value) continue;
      const cached = { value, state: entry.freshness, entry } as const;
      if (entry.metric === 'beta') restartedLkg.company.beta = cached;
      if (entry.metric === 'risk-free-rate') restartedLkg.market.riskFreeRate = cached;
      if (entry.metric === 'equity-risk-premium') {
        restartedLkg.market.equityRiskPremium = cached;
      }
    }
    mocks.readValuationLkg.mockResolvedValue(restartedLkg);
    valuationProvider.getValuationDataset.mockClear();
    mocks.resolveRiskFreeRate.mockClear();
    mocks.resolveEquityRiskPremium.mockClear();
    mocks.resolveRiskFreeRate.mockRejectedValue(new Error('Treasury unavailable'));
    mocks.resolveEquityRiskPremium.mockRejectedValue(new Error('ERP unavailable'));
    const unavailableHistory = vi.fn().mockRejectedValue(
      new Error('History unavailable'),
    );
    mocks.getHistoricalMarketDataService.mockReturnValue({
      getHistoricalPrices: unavailableHistory,
    });

    const restarted = await loadFairValue('NVDA');

    expect(restarted).toMatchObject({
      status: 'available',
      fairValue: { type: 'dcf', label: 'DCF Fair Value' },
    });
    expect(valuationProvider.getValuationDataset).toHaveBeenCalledOnce();
    expect(mocks.resolveRiskFreeRate).not.toHaveBeenCalled();
    expect(mocks.resolveEquityRiskPremium).not.toHaveBeenCalled();
    expect(unavailableHistory).toHaveBeenCalledTimes(2);
  });
});
