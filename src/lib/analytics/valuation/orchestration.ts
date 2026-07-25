import 'server-only';
import {
  getHistoricalMarketDataService,
  getMarketDataProvider,
} from '@/src/lib/market-data';
import { loadResilientQuote } from '@/src/lib/market-data/quote-service';
import { getFundamentalsProvider } from '../fundamentals/provider';
import { calculateFairValue } from './engine';
import {
  safeFairValueErrorCode,
  writeFairValueLog,
  type FairValueLogger,
} from './logging';
import {
  getFmpValuationProvider,
  type FmpValuationDataset,
} from './providers/financial-modeling-prep';
import {
  getGroundedFinancialResearchService,
  type GroundedResearchOutcome,
  type GroundedResearchRequest,
  type ValidatedGroundedMetric,
} from './grounded-research';
import {
  classifyValuationInputs,
  resolveDeterministicInputs,
} from './resolver';
import { createFairValueUnavailable } from './result';
import type {
  FairValueFailureKind,
  FairValueResult,
  FairValueUnavailable,
  AnalystEstimate,
  MetricProvenance,
  PeerObservation,
  ValuationInput,
  ValuationDiagnostic,
  WaccMarketInputs,
} from './types';

function unavailable(
  failureKind: FairValueFailureKind,
  symbol: string,
  calculatedAt: string,
  reason: string,
  missingFields: string[],
  currency: string | null = null,
  provider: string | null = null,
  asOf: string = calculatedAt,
  diagnostics: ValuationDiagnostic[] = [],
): FairValueUnavailable {
  return createFairValueUnavailable({
    failureKind,
    symbol,
    currency,
    provider,
    reason,
    missingFields,
    asOf,
    calculatedAt,
    limitations: [
      'No financial value, estimate, peer, market input, FX rate, or fair value is fabricated.',
    ],
    diagnostics,
  });
}

function logUnavailable(
  result: FairValueUnavailable,
  provider?: string,
  errorCode?: string,
  logger: FairValueLogger = writeFairValueLog,
): FairValueUnavailable {
  logger({
    event: 'fair_value_evaluation',
    status: 'unavailable',
    symbol: result.symbol,
    provider: provider ?? result.provider ?? undefined,
    failureKind: result.failureKind,
    missingInputCount: result.missingInputs.length,
    errorCode,
  });
  return result;
}

export function calculateFairValueSafely(
  input: ValuationInput,
  calculate: typeof calculateFairValue = calculateFairValue,
  logger: FairValueLogger = writeFairValueLog,
): FairValueResult {
  try {
    const result = calculate(input);
    if (result.status === 'unavailable') {
      return logUnavailable(result, input.source, undefined, logger);
    }
    logger({
      event: 'fair_value_evaluation',
      status: 'available',
      symbol: result.symbol,
      provider: input.source,
      missingInputCount: result.missingInputs.length,
    });
    return result;
  } catch (cause) {
    const errorCode = safeFairValueErrorCode(cause);
    return logUnavailable(
      unavailable(
        'calculation-error',
        input.symbol,
        input.calculatedAt ?? new Date().toISOString(),
        'เซิร์ฟเวอร์ตรวจสอบผล Fair Value ไม่สำเร็จ จึงไม่เผยแพร่ค่าประเมิน',
        ['valuationCalculation'],
        input.currency || null,
        input.source || null,
        input.priceAsOf || input.calculatedAt || new Date().toISOString(),
      ),
      input.source,
      errorCode,
      logger,
    );
  }
}

function failureKind(code: string): FairValueFailureKind {
  if (code === 'rate-limited') return 'provider-rate-limited';
  if (['RangeError', 'Error', 'internal-error', 'unknown-error'].includes(code)) {
    return 'calculation-error';
  }
  return 'provider-unavailable';
}

function providerFailureReason(code: string, missingField: string): string {
  if (code === 'rate-limited') {
    return 'ผู้ให้บริการจำกัดคำขอชั่วคราว จึงยังคำนวณ Fair Value ไม่ได้';
  }
  if (missingField === 'forwardEstimates') {
    return 'ยังคำนวณ Fair Value ไม่ได้ เพราะขาด Forward Estimates';
  }
  return 'ผู้ให้บริการส่งข้อมูลที่จำเป็นต่อ Fair Value ไม่สำเร็จ';
}

function futureFiscalYears(latestPeriodEnd: string, calculatedAt: string): number[] {
  const latestYear = Number(latestPeriodEnd.slice(0, 4));
  const currentYear = Number(calculatedAt.slice(0, 4));
  const first = Math.max(latestYear + 1, currentYear);
  return Array.from({ length: 5 }, (_, index) => first + index);
}

function mergeGroundedTargetEstimates(
  estimates: AnalystEstimate[],
  metrics: ValidatedGroundedMetric[],
  symbol: string,
): AnalystEstimate[] {
  const byYear = new Map<number, AnalystEstimate>();
  for (const estimate of estimates) {
    byYear.set(Number(estimate.periodEnd.slice(0, 4)), estimate);
  }
  for (const metric of metrics.filter((item) => item.symbol === symbol)) {
    const existing = byYear.get(metric.fiscalYear);
    const base: AnalystEstimate = existing ?? {
      periodEnd: metric.periodEnd,
      estimatedRevenue: null,
      estimatedEps: null,
      revenueAnalystCount: null,
      epsAnalystCount: null,
      provider: 'gemini-grounded-research',
      asOf: metric.provenance.asOf,
      currency: 'USD',
      revenueProvenance: null,
      epsProvenance: null,
    };
    if (metric.metric === 'revenue' && base.estimatedRevenue === null) {
      byYear.set(metric.fiscalYear, {
        ...base,
        estimatedRevenue: metric.value,
        revenueAnalystCount: metric.analystCount,
        revenueProvenance: metric.provenance,
        provider: existing ? `${existing.provider}+gemini-grounded-research` : 'gemini-grounded-research',
        asOf: [base.asOf, metric.provenance.asOf].toSorted().at(-1)!,
      });
    } else if (metric.metric === 'eps' && base.estimatedEps === null) {
      byYear.set(metric.fiscalYear, {
        ...base,
        estimatedEps: metric.value,
        epsAnalystCount: metric.analystCount,
        epsProvenance: metric.provenance,
        provider: existing ? `${existing.provider}+gemini-grounded-research` : 'gemini-grounded-research',
        asOf: [base.asOf, metric.provenance.asOf].toSorted().at(-1)!,
      });
    }
  }
  return [...byYear.values()].toSorted((left, right) =>
    left.periodEnd.localeCompare(right.periodEnd));
}

function mergeGroundedPeerEstimates(
  peers: PeerObservation[],
  metrics: ValidatedGroundedMetric[],
  branch: 'eps' | 'revenue',
  targetPeriod: string,
): PeerObservation[] {
  const bySymbol = new Map(metrics
    .filter((metric) => metric.metric === branch)
    .map((metric) => [metric.symbol, metric]));
  return peers.map((peer) => {
    const grounded = bySymbol.get(peer.symbol);
    if (!grounded) return peer;
    if (branch === 'eps' && peer.forwardEps === null) {
      return {
        ...peer,
        forwardEps: grounded.value,
        estimatePeriod: grounded.periodEnd || targetPeriod,
        estimateAsOf: grounded.provenance.asOf,
        estimateProvenance: grounded.provenance,
        provider: `${peer.provider}+gemini-grounded-research`,
      };
    }
    if (branch === 'revenue' && peer.forwardRevenue === null) {
      return {
        ...peer,
        forwardRevenue: grounded.value,
        estimatePeriod: grounded.periodEnd || targetPeriod,
        estimateAsOf: grounded.provenance.asOf,
        estimateProvenance: grounded.provenance,
        provider: `${peer.provider}+gemini-grounded-research`,
      };
    }
    return peer;
  });
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

function emptyValuationDataset(
  asOf: string,
  reason: string,
): FmpValuationDataset {
  return {
    provider: 'financial-modeling-prep',
    marketPrice: null,
    marketPriceAsOf: null,
    currency: null,
    estimates: [],
    peers: [],
    waccMarketInputs: {
      beta: null,
      betaAsOf: null,
      riskFreeRate: null,
      riskFreeAsOf: null,
      equityRiskPremium: null,
      equityRiskPremiumAsOf: null,
      provider: 'financial-modeling-prep',
    },
    marketCapitalization: null,
    sharesOutstanding: null,
    sharesOutstandingAsOf: null,
    sector: null,
    industry: null,
    asOf,
    cacheStatus: 'miss',
    peerCandidates: [],
    peerRejections: [],
    endpointErrors: { valuationDataset: reason },
    diagnostics: [],
  };
}

interface ResearchCounters {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  negativeCacheHits: number;
  evidenceSourceCount: number;
  rejectedReasons: string[];
}

function recordResearch(
  outcome: GroundedResearchOutcome,
  counters: ResearchCounters,
): GroundedResearchOutcome {
  counters.requests += 1;
  if (outcome.cache === 'hit') counters.cacheHits += 1;
  else if (outcome.cache === 'miss') counters.cacheMisses += 1;
  else counters.negativeCacheHits += 1;
  counters.evidenceSourceCount += outcome.metrics.reduce(
    (sum, metric) => sum + metric.provenance.evidence.length,
    0,
  );
  counters.rejectedReasons.push(...outcome.rejectedReasons);
  if (outcome.unavailableReason) counters.rejectedReasons.push(outcome.unavailableReason);
  return outcome;
}

export async function loadFairValue(symbol: string): Promise<FairValueResult> {
  const calculatedAt = new Date().toISOString();
  const fundamentals = getFundamentalsProvider();
  const configuredValuationProvider = getFmpValuationProvider();
  const valuationProvider = configuredValuationProvider ?? {
    id: 'financial-modeling-prep' as const,
    getValuationDataset: async () =>
      emptyValuationDataset(calculatedAt, 'provider-not-configured'),
  };
  if (!fundamentals) {
    return logUnavailable(unavailable(
      'provider-unavailable',
      symbol,
      calculatedAt,
      'ยังคำนวณ Fair Value ไม่ได้ เพราะไม่ได้ตั้งค่า provider งบการเงินจริง',
      ['financialStatements'],
      null,
      null,
      calculatedAt,
      [{
        field: 'financialStatements',
        value: null,
        period: null,
        provider: null,
        asOf: calculatedAt,
        status: 'missing',
        provenance: 'provider',
        reason: 'provider-not-configured',
      }],
    ));
  }
  let market: ReturnType<typeof getMarketDataProvider> | null = null;
  let marketProviderCause: unknown = new Error('Market provider is unavailable');
  try {
    market = getMarketDataProvider();
  } catch (cause) {
    marketProviderCause = cause;
  }

  const [quoteResult, profileResult, financialsResult, valuationResult] =
    await Promise.allSettled([
      loadResilientQuote(symbol),
      market ? market.getCompanyProfile(symbol) : Promise.reject(marketProviderCause),
      fundamentals.getFinancialPeriods(symbol),
      valuationProvider.getValuationDataset(symbol),
    ]);
  const required = [
    { field: 'financialStatements', provider: fundamentals.id, result: financialsResult },
  ];
  const failed = required.find((item) => item.result.status === 'rejected');
  if (failed?.result.status === 'rejected') {
    const code = safeFairValueErrorCode(failed.result.reason);
    return logUnavailable(
      unavailable(
        failureKind(code),
        symbol,
        calculatedAt,
        providerFailureReason(code, failed.field),
        [failed.field],
        null,
        failed.provider,
      ),
      failed.provider,
      code,
    );
  }
  if (
    financialsResult.status !== 'fulfilled'
  ) {
    return logUnavailable(unavailable(
      'calculation-error',
      symbol,
      calculatedAt,
      'เซิร์ฟเวอร์ไม่สามารถยืนยันผลจาก provider ได้อย่างปลอดภัย',
      ['providerResult'],
    ));
  }

  const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
  const financials = financialsResult.value;
  const valuation = valuationResult.status === 'fulfilled'
    ? valuationResult.value
    : emptyValuationDataset(
        calculatedAt,
        safeFairValueErrorCode(valuationResult.reason),
      );
  const marketPrice = quote && Number.isFinite(quote.data.price) && quote.data.price > 0
    ? quote.data.price
    : valuation.marketPrice;
  const marketPriceSource = quote && Number.isFinite(quote.data.price) && quote.data.price > 0
    ? quote.provider ?? market?.id ?? 'market-provider'
    : valuation.provider;
  const marketPriceAsOf = quote && Number.isFinite(quote.data.price) && quote.data.price > 0
    ? quote.freshness.asOf ?? calculatedAt
    : valuation.marketPriceAsOf ?? calculatedAt;
  if (!Number.isFinite(marketPrice) || marketPrice === null || marketPrice <= 0) {
    const marketFailure = quoteResult.status === 'rejected'
      ? safeFairValueErrorCode(quoteResult.reason)
      : 'missing-field';
    return logUnavailable(
      unavailable(
        failureKind(marketFailure),
        symbol,
        calculatedAt,
        providerFailureReason(marketFailure, 'marketPrice'),
        ['marketPrice'],
        profile?.data.currency ?? valuation.currency,
        market?.id ?? valuation.provider,
        marketPriceAsOf,
      ),
      market?.id ?? valuation.provider,
      marketFailure,
    );
  }
  if (!financials.periods.length) {
    const errorCodes = Object.values(financials.datasetErrors ?? {});
    const rateLimited = errorCodes.includes('rate-limited');
    return logUnavailable(
      unavailable(
        rateLimited ? 'provider-rate-limited' : 'missing-field',
        symbol,
        calculatedAt,
        rateLimited
          ? 'ผู้ให้บริการงบการเงินจำกัดคำขอชั่วคราว จึงยังคำนวณ Fair Value ไม่ได้'
          : 'ยังคำนวณ Fair Value ไม่ได้ เพราะขาดงบการเงินจริง',
        [...financials.missingInputs, 'financialStatements'],
        financials.currency || null,
        financials.providerUsed ?? fundamentals.id,
        financials.asOf || calculatedAt,
      ),
      financials.providerUsed ?? fundamentals.id,
      rateLimited ? 'rate-limited' : undefined,
    );
  }

  const financialCurrency = financials.currency.toUpperCase();
  const quoteCurrency = (
    profile?.data.currency
    ?? quote?.data.currency
    ?? valuation.currency
    ?? ''
  ).toUpperCase();
  if (financialCurrency !== 'USD' || quoteCurrency !== 'USD') {
    return logUnavailable(unavailable(
      'currency-mismatch',
      symbol,
      calculatedAt,
      'Fair Value v2 คำนวณจากข้อมูล USD เท่านั้น และไม่แปลงสกุลเงินระหว่างคำนวณ',
      ['valuationInputsNormalizedToUSD'],
      financialCurrency || quoteCurrency || null,
      financials.providerUsed ?? fundamentals.id,
      financials.asOf,
    ));
  }

  const providerUsed = financials.providerUsed ?? fundamentals.id;
  const providerStatus = valuation.cacheStatus === 'stale'
    || Object.values(financials.diagnostics.cache).includes('stale')
    ? 'stale' as const
    : valuation.cacheStatus === 'hit'
      && Object.values(financials.diagnostics.cache).every((state) => state === 'hit')
      ? 'cached' as const
      : quote?.freshness.status === 'delayed' || quote?.freshness.status === 'end-of-day'
        ? 'delayed' as const : 'live' as const;
  const latestFinancialPeriod = [...financials.periods]
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .at(-1);
  let marketCapitalization =
    profile?.data.marketCapitalization ?? valuation.marketCapitalization;
  let marketCapitalizationProvenance: MetricProvenance | null =
    valuation.marketCapitalization === marketCapitalization
    && marketCapitalization !== null
    ? {
        provider: valuation.provider,
        sourceType: 'structured-provider' as const,
        field: 'marketCapitalization',
        fiscalPeriod: 'latest',
        asOf: valuation.asOf,
        evidence: [],
        evidenceQuality: 'high' as const,
      }
    : null;
  let sharesOutstanding = valuation.sharesOutstanding;
  let sharesOutstandingAsOf = valuation.sharesOutstandingAsOf;
  let sharesOutstandingProvenance: MetricProvenance | null = positive(sharesOutstanding)
    ? {
        provider: valuation.provider,
        sourceType: 'structured-provider' as const,
        field: 'shares',
        fiscalPeriod: sharesOutstandingAsOf ?? valuation.asOf,
        asOf: valuation.asOf,
        evidence: [],
        evidenceQuality: 'high' as const,
      }
    : null;
  let waccMarketInputs: WaccMarketInputs = {
    ...valuation.waccMarketInputs,
  };
  let estimates = valuation.estimates;
  let peers = valuation.peers;
  const inputResolution = classifyValuationInputs({
    marketPrice,
    marketCapitalization,
    sharesOutstanding,
    dilutedShares: latestFinancialPeriod?.dilutedShares ?? null,
    analystEstimates: estimates,
    peers,
    waccMarketInputs,
  });

  let historicalPrices: ValuationInput['historicalPrices'] = [];
  let historySource = '';
  let historyFreshness: ValuationInput['historyFreshness'] = {
    status: 'unavailable',
    asOf: null,
    maxAgeSeconds: null,
  };
  let benchmarkPrices: ValuationInput['historicalPrices'] = [];
  let benchmarkSource = '';
  if (!positive(waccMarketInputs.beta)) {
    try {
      const history = getHistoricalMarketDataService();
      const [stockHistory, benchmarkHistory] = await Promise.all([
        history.getHistoricalPrices(symbol, '5y'),
        history.getHistoricalPrices('SPY', '5y'),
      ]);
      historicalPrices = stockHistory.data.prices;
      historySource = stockHistory.provider ?? stockHistory.data.providerUsed ?? 'historical-provider';
      historyFreshness = stockHistory.freshness;
      benchmarkPrices = benchmarkHistory.data.prices;
      benchmarkSource = benchmarkHistory.provider
        ?? benchmarkHistory.data.providerUsed
        ?? 'historical-provider';
    } catch {
      // Beta remains researchable; a history failure must not fail the request.
    }
  }
  const deterministic = resolveDeterministicInputs({
    marketPrice,
    priceAsOf: marketPriceAsOf,
    marketPriceProvider: marketPriceSource,
    marketCapitalization,
    shares: positive(sharesOutstanding)
      ? sharesOutstanding : latestFinancialPeriod?.dilutedShares ?? null,
    sharesAsOf: sharesOutstandingAsOf ?? latestFinancialPeriod?.periodEnd ?? null,
    sharesProvider: positive(sharesOutstanding) ? valuation.provider : providerUsed,
    stockPrices: historicalPrices,
    benchmarkPrices,
    stockHistoryProvider: historySource || undefined,
    benchmarkHistoryProvider: benchmarkSource || undefined,
    benchmark: 'SPY',
  });
  marketCapitalization = deterministic.marketCapitalization;
  marketCapitalizationProvenance =
    deterministic.marketCapitalizationProvenance ?? marketCapitalizationProvenance;
  if (!positive(waccMarketInputs.beta) && deterministic.beta) {
    waccMarketInputs = {
      ...waccMarketInputs,
      beta: deterministic.beta.value,
      betaAsOf: deterministic.beta.provenance.asOf,
      betaProvenance: deterministic.beta.provenance,
      provider: `${waccMarketInputs.provider}+${deterministic.beta.provenance.provider}`,
    };
    inputResolution.resolved.push({
      field: 'beta',
      origin: 'derived',
      provider: deterministic.beta.provenance.provider,
      asOf: deterministic.beta.provenance.asOf,
    });
  }
  if (deterministic.marketCapitalizationProvenance) {
    inputResolution.resolved.push({
      field: 'marketCapitalization',
      origin: 'derived',
      provider: deterministic.marketCapitalizationProvenance.provider,
      asOf: deterministic.marketCapitalizationProvenance.asOf,
    });
  }

  const groundedResearch = getGroundedFinancialResearchService();
  const researchCounters: ResearchCounters = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    negativeCacheHits: 0,
    evidenceSourceCount: 0,
    rejectedReasons: [],
  };
  let groundedValueUsed = false;
  const groundedDiagnostics: ValuationDiagnostic[] = [];
  const research = async (request: GroundedResearchRequest) =>
    recordResearch(await groundedResearch!.research(request), researchCounters);

  if (groundedResearch) {
    const currentYear = Number(calculatedAt.slice(0, 4));
    const missingMarketMetrics: GroundedResearchRequest['metrics'] = [];
    if (!positive(waccMarketInputs.riskFreeRate)) missingMarketMetrics.push('riskFreeRate');
    if (!positive(waccMarketInputs.equityRiskPremium)) {
      missingMarketMetrics.push('equityRiskPremium');
    }
    if (missingMarketMetrics.length) {
      const rescued = await research({
        symbols: [],
        metrics: missingMarketMetrics,
        fiscalYears: [currentYear],
      });
      for (const metric of rescued.metrics) {
        if (metric.field === 'riskFreeRate' && !positive(waccMarketInputs.riskFreeRate)) {
          waccMarketInputs.riskFreeRate = metric.value;
          waccMarketInputs.riskFreeAsOf = metric.asOf;
          waccMarketInputs.riskFreeRateProvenance = metric.provenance;
        } else if (
          metric.field === 'equityRiskPremium'
          && !positive(waccMarketInputs.equityRiskPremium)
        ) {
          waccMarketInputs.equityRiskPremium = metric.value;
          waccMarketInputs.equityRiskPremiumAsOf = metric.asOf;
          waccMarketInputs.equityRiskPremiumProvenance = metric.provenance;
        } else {
          continue;
        }
        groundedValueUsed = true;
        inputResolution.resolved.push({
          field: metric.field,
          origin: 'gemini-grounded',
          provider: metric.provenance.provider,
          asOf: metric.asOf,
        });
        groundedDiagnostics.push({
          field: metric.field,
          value: metric.value,
          period: metric.period,
          provider: metric.provenance.provider,
          asOf: metric.asOf,
          status: 'available',
          provenance: 'gemini-grounded',
          sourceType: 'gemini-grounded',
          sourceUrl: metric.provenance.sourceUrl,
          evidence: metric.provenance.evidence,
          reason: null,
        });
      }
    }

    const missingCompanyMetrics: GroundedResearchRequest['metrics'] = [];
    if (!positive(waccMarketInputs.beta)) missingCompanyMetrics.push('beta');
    if (!positive(sharesOutstanding) && !positive(latestFinancialPeriod?.dilutedShares)) {
      missingCompanyMetrics.push('shares');
    }
    if (missingCompanyMetrics.length) {
      const rescued = await research({
        symbols: [symbol],
        metrics: missingCompanyMetrics,
        fiscalYears: [currentYear],
      });
      for (const metric of rescued.metrics.filter((item) => item.symbol === symbol)) {
        if (metric.field === 'beta' && !positive(waccMarketInputs.beta)) {
          waccMarketInputs.beta = metric.value;
          waccMarketInputs.betaAsOf = metric.asOf;
          waccMarketInputs.betaProvenance = metric.provenance;
        } else if (metric.field === 'shares' && !positive(sharesOutstanding)) {
          sharesOutstanding = metric.value;
          sharesOutstandingAsOf = metric.period;
          sharesOutstandingProvenance = metric.provenance;
        } else {
          continue;
        }
        groundedValueUsed = true;
        inputResolution.resolved.push({
          field: metric.field,
          origin: 'gemini-grounded',
          provider: metric.provenance.provider,
          asOf: metric.asOf,
        });
        groundedDiagnostics.push({
          field: metric.field,
          value: metric.value,
          period: metric.period,
          provider: metric.provenance.provider,
          asOf: metric.asOf,
          status: 'available',
          provenance: 'gemini-grounded',
          sourceType: 'gemini-grounded',
          sourceUrl: metric.provenance.sourceUrl,
          evidence: metric.provenance.evidence,
          reason: null,
        });
      }
    }
  }

  if (!positive(marketCapitalization) && positive(sharesOutstanding)) {
    const afterResearch = resolveDeterministicInputs({
      marketPrice,
      priceAsOf: marketPriceAsOf,
      marketPriceProvider: marketPriceSource,
      marketCapitalization,
      shares: sharesOutstanding,
      sharesAsOf: sharesOutstandingAsOf,
      sharesProvider: sharesOutstandingProvenance?.provider ?? valuation.provider,
    });
    marketCapitalization = afterResearch.marketCapitalization;
    marketCapitalizationProvenance = afterResearch.marketCapitalizationProvenance;
    deterministic.diagnostics.push(...afterResearch.diagnostics);
    if (afterResearch.marketCapitalizationProvenance) {
      inputResolution.resolved.push({
        field: 'marketCapitalization',
        origin: 'derived',
        provider: afterResearch.marketCapitalizationProvenance.provider,
        asOf: afterResearch.marketCapitalizationProvenance.asOf,
      });
    }
  }

  if (latestFinancialPeriod && groundedResearch) {
    const fiscalYears = futureFiscalYears(latestFinancialPeriod.periodEnd, calculatedAt);
    const future = estimates.filter((estimate) =>
      estimate.periodEnd > latestFinancialPeriod.periodEnd);
    const missingTargetMetrics: Array<'revenue' | 'eps'> = [];
    const futureRevenueCount = future.filter((estimate) =>
      finite(estimate.estimatedRevenue) && estimate.estimatedRevenue > 0).length;
    // DCF accepts either one explicit consensus CAGR endpoint or a complete
    // five-year annual series. A partial 2-4 year series is still missing data.
    if (futureRevenueCount === 0 || (futureRevenueCount > 1 && futureRevenueCount < 5)) {
      missingTargetMetrics.push('revenue');
    }
    const hasMultiplesTarget = future.some((estimate) =>
      (finite(estimate.estimatedEps) && estimate.estimatedEps > 0)
      || (finite(estimate.estimatedRevenue) && estimate.estimatedRevenue > 0));
    if (!hasMultiplesTarget) {
      if (!future.some((estimate) => finite(estimate.estimatedEps))) {
        missingTargetMetrics.push('eps');
      }
      if (!future.some((estimate) =>
        finite(estimate.estimatedRevenue) && estimate.estimatedRevenue > 0)
        && !missingTargetMetrics.includes('revenue')) {
        missingTargetMetrics.push('revenue');
      }
    }
    if (missingTargetMetrics.length) {
      const rescued = await research({
        symbols: [symbol],
        metrics: missingTargetMetrics,
        fiscalYears,
      });
      estimates = mergeGroundedTargetEstimates(estimates, rescued.metrics, symbol);
      if (rescued.metrics.length) groundedValueUsed = true;
    }

    const targetEstimate = estimates
      .filter((estimate) =>
        estimate.periodEnd > latestFinancialPeriod.periodEnd
        && ((finite(estimate.estimatedEps) && estimate.estimatedEps > 0)
          || (finite(estimate.estimatedRevenue) && estimate.estimatedRevenue > 0)))
      .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
      .at(0);
    if (targetEstimate) {
      const branch = finite(targetEstimate.estimatedEps) && targetEstimate.estimatedEps > 0
        ? 'eps' as const : 'revenue' as const;
      const validPeerCount = peers.filter((peer) =>
        branch === 'eps'
          ? finite(peer.price) && peer.price > 0 && finite(peer.forwardEps) && peer.forwardEps > 0
          : finite(peer.enterpriseValue) && peer.enterpriseValue > 0
            && finite(peer.forwardRevenue) && peer.forwardRevenue > 0).length;
      if (validPeerCount < 4) {
        const candidates = peers
          .filter((peer) => branch === 'eps'
            ? finite(peer.price) && peer.price > 0 && !finite(peer.forwardEps)
            : finite(peer.enterpriseValue) && peer.enterpriseValue > 0
              && !finite(peer.forwardRevenue))
          .map((peer) => peer.symbol)
          .slice(0, 12);
        if (candidates.length) {
          const rescued = await research({
            symbols: candidates,
            metrics: [branch],
            fiscalYears: [Number(targetEstimate.periodEnd.slice(0, 4))],
          });
          peers = mergeGroundedPeerEstimates(
            peers,
            rescued.metrics,
            branch,
            targetEstimate.periodEnd,
          );
          if (rescued.metrics.length) groundedValueUsed = true;
        }
      }
    }
  }

  const diagnostics: ValuationDiagnostic[] = [
    ...(valuation.diagnostics ?? []),
    ...deterministic.diagnostics,
    ...groundedDiagnostics,
    {
      field: 'marketPrice',
      value: marketPrice,
      period: marketPriceAsOf,
      provider: marketPriceSource,
      asOf: marketPriceAsOf,
      status: providerStatus === 'stale' ? 'stale' : 'available',
      provenance: 'provider',
      reason: providerStatus === 'stale' ? 'stale-provider-cache' : null,
    },
    {
      field: 'marketCapitalization',
      value: marketCapitalization ?? null,
      period: 'latest',
      provider: marketCapitalizationProvenance?.provider
        ?? profile?.provider
        ?? valuation.provider,
      asOf: marketCapitalizationProvenance?.asOf
        ?? profile?.freshness.asOf
        ?? valuation.asOf,
      status: marketCapitalization == null ? 'missing' : 'available',
      provenance: marketCapitalizationProvenance?.sourceType === 'derived'
        ? 'derived' : 'provider',
      sourceType: marketCapitalizationProvenance?.sourceType ?? 'structured-provider',
      reason: marketCapitalization == null ? 'provider-field-missing' : null,
    },
    ...(latestFinancialPeriod ? [
      {
        field: 'freeCashFlow',
        value: latestFinancialPeriod.freeCashFlow,
        period: latestFinancialPeriod.periodEnd,
        provider: providerUsed,
        asOf: financials.fetchedAt,
        status: 'available' as const,
        provenance: 'provider' as const,
        reason: null,
      },
      {
        field: 'cash',
        value: latestFinancialPeriod.cash,
        period: latestFinancialPeriod.periodEnd,
        provider: providerUsed,
        asOf: financials.fetchedAt,
        status: 'available' as const,
        provenance: 'provider' as const,
        reason: null,
      },
      {
        field: 'totalDebt',
        value: latestFinancialPeriod.totalDebt,
        period: latestFinancialPeriod.periodEnd,
        provider: providerUsed,
        asOf: financials.fetchedAt,
        status: 'available' as const,
        provenance: 'provider' as const,
        reason: null,
      },
      {
        field: 'dilutedShares',
        value: latestFinancialPeriod.dilutedShares,
        period: latestFinancialPeriod.periodEnd,
        provider: providerUsed,
        asOf: financials.fetchedAt,
        status: latestFinancialPeriod.dilutedShares > 0 ? 'available' as const : 'missing' as const,
        provenance: 'provider' as const,
        reason: latestFinancialPeriod.dilutedShares > 0 ? null : 'provider-field-missing',
      },
    ] : []),
  ];

  return calculateFairValueSafely({
    symbol,
    currency: 'USD',
    marketPrice,
    marketPriceSource,
    marketCapitalization,
    marketCapitalizationProvenance,
    sharesOutstanding,
    sharesOutstandingAsOf,
    sharesOutstandingProvenance,
    dilutedSharesSource: latestFinancialPeriod
      && Number.isFinite(latestFinancialPeriod.dilutedShares)
      && latestFinancialPeriod.dilutedShares > 0
      ? 'diluted'
      : 'shares-outstanding-fallback',
    priceAsOf: marketPriceAsOf,
    source: providerUsed,
    sourceType: 'provider-supplied',
    sector: profile?.data.sector ?? valuation.sector ?? '',
    industry: profile?.data.industry ?? valuation.industry ?? '',
    periods: financials.periods,
    historicalPrices,
    historySource,
    historyFreshness,
    analystEstimates: estimates,
    peerObservations: peers,
    waccMarketInputs,
    providerStatus: groundedValueUsed ? 'limited' : providerStatus,
    researchAudit: {
      geminiUsed: groundedValueUsed,
      evidenceSourceCount: researchCounters.evidenceSourceCount,
      rejectedReasons: [...new Set(researchCounters.rejectedReasons)],
      requests: researchCounters.requests,
      cacheHits: researchCounters.cacheHits,
      cacheMisses: researchCounters.cacheMisses,
      negativeCacheHits: researchCounters.negativeCacheHits,
    },
    inputResolution,
    peerAudit: {
      candidates: valuation.peerCandidates,
      rejected: valuation.peerRejections,
    },
    diagnostics,
    displayFx: null,
    calculatedAt,
  });
}
