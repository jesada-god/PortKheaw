import 'server-only';
import {
  getHistoricalMarketDataService,
  getMarketDataProvider,
} from '@/src/lib/market-data';
import { serverEnv } from '@/src/config/env/server';
import { loadResilientQuote } from '@/src/lib/market-data/quote-service';
import {
  getFundamentalsProvider,
  type FundamentalsSnapshot,
} from '../fundamentals/provider';
import { fundamentalsLkgRepositoryConfigured } from '../fundamentals/repository';
import { calculateFairValue, validFutureEstimates } from './engine';
import { datasetFreshness } from './freshness';
import {
  safeFairValueErrorCode,
  writeFairValueLog,
  writeFairValueFieldLog,
  writeFairValueResolutionAuditLog,
  writeFairValueRuntimeLog,
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
  type GroundedPeerResearchOutcome,
  type ValidatedGroundedMetric,
} from './grounded-research';
import {
  getIndependentMarketInputsResolver,
  IndependentMarketSourceError,
} from './independent-market-inputs';
import {
  classifyValuationInputs,
  resolveDeterministicInputs,
} from './resolver';
import {
  applyCachedWaccInputs,
  buildResolvedValuationLkgEntries,
  emptyValuationInputLkgSnapshot,
  excludeUnchangedLkgEntries,
  hasCompleteFreshValuationLkg,
  mergeCachedForwardEstimates,
  mergeCachedPeers,
  valuationInputLkgDiagnostics,
} from './persistent-inputs';
import {
  getValuationInputLkgService,
  valuationInputLkgRepositoryConfigured,
} from './persistent-inputs-repository';
import { createFairValueUnavailable } from './result';
import type {
  FairValueFailureKind,
  FairValueResult,
  FairValueUnavailable,
  AnalystEstimate,
  InputResolutionAudit,
  MetricProvenance,
  ModelId,
  PeerObservation,
  ValuationInput,
  ValuationDiagnostic,
  WaccMarketInputs,
} from './types';

function recordResolvedInput(
  audit: InputResolutionAudit,
  resolution: InputResolutionAudit['resolved'][number],
): void {
  const existing = audit.resolved.findIndex((item) => item.field === resolution.field);
  if (existing >= 0) audit.resolved[existing] = resolution;
  else audit.resolved.push(resolution);
}

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
    cash: null,
    totalDebt: null,
    balanceSheetAsOf: null,
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

function emptyFundamentalsSnapshot(
  symbol: string,
  asOf: string,
  reason: string,
): FundamentalsSnapshot {
  return {
    symbol: symbol.trim().toUpperCase(),
    periods: [],
    quarterlyPeriods: [],
    annualRecords: [],
    quarterlyRecords: [],
    asOf: asOf.slice(0, 10),
    fetchedAt: asOf,
    currency: '',
    dilutedEpsTtm: null,
    dilutedEpsAsOf: null,
    missingInputs: ['financialStatements'],
    datasetErrors: {
      'income-statement': reason,
      'balance-sheet': reason,
      'cash-flow': reason,
    },
    diagnostics: {
      provider: 'fundamentals-unavailable',
      capabilities: [],
      datasets: {
        'income-statement': 'unavailable',
        'balance-sheet': 'unavailable',
        'cash-flow': 'unavailable',
      },
      cache: {
        'income-statement': 'miss',
        'balance-sheet': 'miss',
        'cash-flow': 'miss',
      },
      datasetFetchedAt: {
        'income-statement': null,
        'balance-sheet': null,
        'cash-flow': null,
      },
      latencyMs: 0,
      normalizedPeriodCount: { annual: 0, quarterly: 0 },
    },
    providerUsed: 'fundamentals-unavailable',
  };
}

interface ResearchCounters {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  negativeCacheHits: number;
  evidenceSourceCount: number;
  rejectedReasons: string[];
  plannedFields: string[];
  executedFields: string[];
  modelsUnlocked: ModelId[];
  budget: number;
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

function recordPeerResearch(
  outcome: GroundedPeerResearchOutcome,
  counters: ResearchCounters,
): GroundedPeerResearchOutcome {
  counters.requests += 1;
  if (outcome.cache === 'hit') counters.cacheHits += 1;
  else if (outcome.cache === 'miss') counters.cacheMisses += 1;
  else counters.negativeCacheHits += 1;
  counters.evidenceSourceCount += outcome.candidates.reduce(
    (sum, candidate) => sum + candidate.evidence.length,
    0,
  );
  counters.rejectedReasons.push(...outcome.rejected.map((item) => item.reason));
  if (outcome.unavailableReason) counters.rejectedReasons.push(outcome.unavailableReason);
  return outcome;
}

async function resolveFairValue(symbol: string): Promise<FairValueResult> {
  const calculatedAt = new Date().toISOString();
  const valuationLkgService = getValuationInputLkgService();
  const valuationLkg = await valuationLkgService.read(symbol).catch((cause) => {
    const repositoryError = cause instanceof Error
      && /^Valuation LKG read failed: [A-Za-z0-9_-]+$/.test(cause.message)
      ? cause.message
      : safeFairValueErrorCode(cause);
    console.warn(JSON.stringify({
      event: 'valuation-lkg-read-failed',
      symbol,
      errorCode: repositoryError,
      timestamp: calculatedAt,
    }));
    return emptyValuationInputLkgSnapshot(symbol);
  });
  const valuationLkgComplete = hasCompleteFreshValuationLkg(valuationLkg);
  const fundamentals = getFundamentalsProvider();
  const configuredValuationProvider = getFmpValuationProvider();
  const groundedResearch = getGroundedFinancialResearchService();
  const independentMarketInputs = getIndependentMarketInputsResolver();
  let historicalMarketDataService: ReturnType<
    typeof getHistoricalMarketDataService
  > | null = null;
  let historyProviderConfigured = false;
  try {
    historicalMarketDataService = getHistoricalMarketDataService();
    historyProviderConfigured = Boolean(historicalMarketDataService);
  } catch {
    historyProviderConfigured = false;
  }
  writeFairValueRuntimeLog({
    event: 'fair_value_runtime_configuration',
    symbol,
    secUserAgentConfigured: Boolean(serverEnv.SEC_USER_AGENT),
    geminiConfigured: Boolean(groundedResearch),
    groundingConfigured: Boolean(groundedResearch),
    fundamentalsProviderConfigured: Boolean(fundamentals),
    valuationProviderConfigured: Boolean(configuredValuationProvider),
    historyProviderConfigured,
    lkgReadConfigured: fundamentalsLkgRepositoryConfigured(),
    lkgWriteConfigured: fundamentalsLkgRepositoryConfigured(),
    valuationLkgReadConfigured: valuationInputLkgRepositoryConfigured(),
    valuationLkgWriteConfigured: valuationInputLkgRepositoryConfigured(),
  });
  const valuationProvider = configuredValuationProvider ?? {
    id: 'financial-modeling-prep' as const,
    getValuationDataset: async (
      _symbol: string,
      _options?: { includeMarketInputs?: boolean },
    ) =>
      emptyValuationDataset(calculatedAt, 'provider-not-configured'),
  };
  if (!fundamentals && !configuredValuationProvider) {
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
      fundamentals
        ? fundamentals.getFinancialPeriods(symbol).catch((cause) =>
            emptyFundamentalsSnapshot(
              symbol,
              calculatedAt,
              safeFairValueErrorCode(cause),
            ))
        : Promise.resolve(emptyFundamentalsSnapshot(
            symbol,
            calculatedAt,
            'provider-not-configured',
          )),
      valuationLkgComplete
        ? Promise.resolve(emptyValuationDataset(
            calculatedAt,
            'persistent-valuation-lkg-complete',
          ))
        : valuationProvider.getValuationDataset(symbol, {
            // Rf and ERP are resolved from shared independent sources/LKG.
            // FMP remains an optional company/relative enrichment provider.
            includeMarketInputs: false,
          }),
    ]);
  const required = [
    {
      field: 'financialStatements',
      provider: fundamentals?.id ?? 'fundamentals-unavailable',
      result: financialsResult,
    },
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
  if (
    !financials.periods.length
    && !valuation.estimates.length
    && !valuationLkg.company.forwardEps.length
    && !valuationLkg.company.forwardRevenue.length
    && !groundedResearch
  ) {
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
        financials.providerUsed ?? fundamentals?.id ?? valuation.provider,
        financials.asOf || calculatedAt,
      ),
      financials.providerUsed ?? fundamentals?.id ?? valuation.provider,
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
  if ((financials.periods.length > 0 && financialCurrency !== 'USD')
    || quoteCurrency !== 'USD') {
    return logUnavailable(unavailable(
      'currency-mismatch',
      symbol,
      calculatedAt,
      'Fair Value v2 คำนวณจากข้อมูล USD เท่านั้น และไม่แปลงสกุลเงินระหว่างคำนวณ',
      ['valuationInputsNormalizedToUSD'],
      financialCurrency || quoteCurrency || null,
      financials.providerUsed ?? fundamentals?.id ?? valuation.provider,
      financials.asOf,
    ));
  }

  const providerUsed = financials.periods.length > 0
    ? financials.providerUsed ?? fundamentals?.id ?? valuation.provider
    : valuation.provider;
  const latestFinancialPeriod = [...financials.periods]
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .at(-1);
  const providerStatus = datasetFreshness(
    'financialStatements',
    latestFinancialPeriod?.periodEnd,
  ) === 'stale'
    || valuation.cacheStatus === 'stale'
    || Object.values(financials.diagnostics.cache).includes('stale')
    ? 'stale' as const
    : valuation.cacheStatus === 'hit'
      && Object.values(financials.diagnostics.cache).every((state) => state === 'hit')
      ? 'cached' as const
      : quote?.freshness.status === 'delayed' || quote?.freshness.status === 'end-of-day'
        ? 'delayed' as const : 'live' as const;
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
  waccMarketInputs = applyCachedWaccInputs(
    waccMarketInputs,
    valuationLkg,
    'read-first',
  );
  let estimates = mergeCachedForwardEstimates(
    valuation.estimates,
    valuationLkg,
    'fresh',
  );
  const cachedPeerMerge = mergeCachedPeers(valuation.peers, valuationLkg);
  let peers = cachedPeerMerge.peers;
  const peerCandidateSymbols = [...new Set([
    ...cachedPeerMerge.candidates,
    ...(valuation.peerCandidates ?? []),
  ])];
  const peerRejections: NonNullable<ValuationInput['peerAudit']>['rejected'] =
    [
      ...cachedPeerMerge.rejected,
      ...(valuation.peerRejections ?? []).map((item) => ({
      ...item,
      metric: null,
      period: null,
      source: valuation.provider,
      asOf: valuation.asOf,
      })),
    ];
  let valuationLkgUsed = Boolean(
    valuationLkg.company.beta
    || valuationLkg.market.riskFreeRate
    || valuationLkg.market.equityRiskPremium
    || valuationLkg.company.forwardEps.some((item) => item.state === 'fresh')
    || valuationLkg.company.forwardRevenue.some((item) => item.state === 'fresh')
    || cachedPeerMerge.candidates.length,
  );
  let valuationLkgStaleUsed = cachedPeerMerge.stale
    || valuationLkg.company.beta?.state === 'stale';
  const inputResolution = classifyValuationInputs({
    marketPrice,
    marketCapitalization,
    sharesOutstanding,
    dilutedShares: latestFinancialPeriod?.dilutedShares ?? null,
    analystEstimates: estimates,
    peers,
    waccMarketInputs,
  });
  const providerFieldState = (
    field: string,
    available: boolean,
    provider: string = valuation.provider,
    asOf: string = valuation.asOf,
  ) => writeFairValueFieldLog({
    event: 'fair_value_field_resolution',
    symbol,
    field,
    state: available ? 'provider-hit' : 'provider-miss',
    provider,
    reason: available ? undefined : 'provider-field-missing',
    asOf,
  });
  providerFieldState(
    'beta',
    positive(waccMarketInputs.beta),
    waccMarketInputs.betaProvenance?.provider ?? valuation.provider,
    waccMarketInputs.betaAsOf ?? valuation.asOf,
  );
  providerFieldState(
    'riskFreeRate',
    positive(waccMarketInputs.riskFreeRate),
    waccMarketInputs.riskFreeRateProvenance?.provider ?? valuation.provider,
    waccMarketInputs.riskFreeAsOf ?? valuation.asOf,
  );
  providerFieldState(
    'equityRiskPremium',
    positive(waccMarketInputs.equityRiskPremium),
    waccMarketInputs.equityRiskPremiumProvenance?.provider ?? valuation.provider,
    waccMarketInputs.equityRiskPremiumAsOf ?? valuation.asOf,
  );
  providerFieldState(
    'targetForwardEstimate',
    estimates.some((estimate) =>
      positive(estimate.estimatedEps) || positive(estimate.estimatedRevenue)),
  );

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
    const history = historicalMarketDataService;
    if (!history) {
      writeFairValueFieldLog({
        event: 'fair_value_field_resolution',
        symbol,
        field: 'beta',
        state: 'provider-miss',
        provider: 'historical-provider',
        reason: 'provider-not-configured',
        asOf: calculatedAt,
      });
    } else {
      const [stockHistoryResult, benchmarkHistoryResult] = await Promise.allSettled([
        history.getHistoricalPrices(symbol, '5y'),
        history.getHistoricalPrices('SPY', '5y'),
      ]);
      if (stockHistoryResult.status === 'fulfilled') {
        const stockHistory = stockHistoryResult.value;
        historicalPrices = stockHistory.data.prices;
        historySource = stockHistory.provider
          ?? stockHistory.data.providerUsed
          ?? 'historical-provider';
        historyFreshness = stockHistory.freshness;
      } else {
        writeFairValueFieldLog({
          event: 'fair_value_field_resolution',
          symbol,
          field: 'beta',
          state: 'provider-miss',
          provider: 'historical-provider:target',
          reason: safeFairValueErrorCode(stockHistoryResult.reason),
          asOf: calculatedAt,
        });
      }
      if (benchmarkHistoryResult.status === 'fulfilled') {
        const benchmarkHistory = benchmarkHistoryResult.value;
        benchmarkPrices = benchmarkHistory.data.prices;
        benchmarkSource = benchmarkHistory.provider
          ?? benchmarkHistory.data.providerUsed
          ?? 'historical-provider';
      } else {
        writeFairValueFieldLog({
          event: 'fair_value_field_resolution',
          symbol,
          field: 'beta',
          state: 'provider-miss',
          provider: 'historical-provider:benchmark',
          reason: safeFairValueErrorCode(benchmarkHistoryResult.reason),
          asOf: calculatedAt,
        });
      }
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
  writeFairValueResolutionAuditLog({
    event: 'fair_value_resolution_audit',
    symbol,
    field: 'beta',
    stage: 'history',
    provider: [historySource, benchmarkSource].filter(Boolean).join('+')
      || 'historical-provider',
    available: Boolean(deterministic.beta),
    reason: deterministic.betaAudit.reason,
    asOf: deterministic.beta?.provenance.asOf ?? calculatedAt,
    targetRows: deterministic.betaAudit.targetRows,
    benchmarkRows: deterministic.betaAudit.benchmarkRows,
    alignedObservations: deterministic.betaAudit.alignedObservations,
    minimumSamples: deterministic.betaAudit.minimumSamples,
    frequency: deterministic.betaAudit.frequency,
    period: deterministic.betaAudit.period,
    value: deterministic.betaAudit.derivedBeta,
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
    recordResolvedInput(inputResolution, {
      field: 'beta',
      origin: 'derived',
      provider: deterministic.beta.provenance.provider,
      asOf: deterministic.beta.provenance.asOf,
    });
    writeFairValueFieldLog({
      event: 'fair_value_field_resolution',
      symbol,
      field: 'beta',
      state: 'derived',
      provider: deterministic.beta.provenance.provider,
      reason: `historical-beta:${deterministic.beta.provenance.benchmark}:${deterministic.beta.provenance.sampleSize}`,
      asOf: deterministic.beta.provenance.asOf,
    });
  }
  if (deterministic.marketCapitalizationProvenance) {
    recordResolvedInput(inputResolution, {
      field: 'marketCapitalization',
      origin: 'derived',
      provider: deterministic.marketCapitalizationProvenance.provider,
      asOf: deterministic.marketCapitalizationProvenance.asOf,
    });
    writeFairValueFieldLog({
      event: 'fair_value_field_resolution',
      symbol,
      field: 'marketCapitalization',
      state: 'derived',
      provider: deterministic.marketCapitalizationProvenance.provider,
      reason: 'market-price-times-shares',
      asOf: deterministic.marketCapitalizationProvenance.asOf,
    });
  }

  const independentDiagnostics: ValuationDiagnostic[] = [];
  const independentRequests = [
    ...(!positive(waccMarketInputs.riskFreeRate) ? [{
      field: 'riskFreeRate' as const,
      operation: independentMarketInputs.resolveRiskFreeRate(),
    }] : []),
    ...(!positive(waccMarketInputs.equityRiskPremium) ? [{
      field: 'equityRiskPremium' as const,
      operation: independentMarketInputs.resolveEquityRiskPremium(),
    }] : []),
  ];
  const independentResults = await Promise.allSettled(
    independentRequests.map((request) => request.operation),
  );
  independentResults.forEach((settled, index) => {
    const request = independentRequests[index]!;
    if (settled.status === 'fulfilled') {
      const resolved = settled.value;
      if (request.field === 'riskFreeRate') {
        waccMarketInputs.riskFreeRate = resolved.value;
        waccMarketInputs.riskFreeAsOf = resolved.asOf;
        waccMarketInputs.riskFreeRateProvenance = resolved.provenance;
      } else {
        waccMarketInputs.equityRiskPremium = resolved.value;
        waccMarketInputs.equityRiskPremiumAsOf = resolved.asOf;
        waccMarketInputs.equityRiskPremiumProvenance = resolved.provenance;
      }
      waccMarketInputs.provider = [
        waccMarketInputs.provider,
        resolved.provenance.provider,
      ].filter(Boolean).join('+');
      recordResolvedInput(inputResolution, {
        field: request.field,
        origin: 'provider',
        provider: resolved.provenance.provider,
        asOf: resolved.asOf,
      });
      independentDiagnostics.push({
        field: request.field,
        value: resolved.value,
        period: resolved.provenance.fiscalPeriod,
        provider: resolved.provenance.provider,
        asOf: resolved.asOf,
        status: 'available',
        provenance: 'provider',
        sourceState: 'provider-live',
        sourceType: 'structured-provider',
        sourceUrl: resolved.provenance.sourceUrl,
        evidence: resolved.provenance.evidence,
        reason: null,
      });
      writeFairValueFieldLog({
        event: 'fair_value_field_resolution',
        symbol,
        field: request.field,
        state: 'provider-hit',
        provider: resolved.provenance.provider,
        reason: 'independent-shared-market-source',
        asOf: resolved.asOf,
      });
      return;
    }
    const cause = settled.reason;
    const sourceError = cause instanceof IndependentMarketSourceError ? cause : null;
    const reason = sourceError?.code ?? safeFairValueErrorCode(cause);
    const provider = sourceError?.source ?? 'independent-market-source';
    independentDiagnostics.push({
      field: request.field,
      value: null,
      period: request.field === 'riskFreeRate' ? '10Y' : 'United States',
      provider,
      asOf: calculatedAt,
      status: 'missing',
      provenance: 'provider',
      sourceState: 'missing',
      reason,
    });
    writeFairValueFieldLog({
      event: 'fair_value_field_resolution',
      symbol,
      field: request.field,
      state: 'provider-miss',
      provider,
      reason,
      asOf: calculatedAt,
    });
    console.warn(JSON.stringify({
      event: 'fair_value_independent_market_source_failed',
      symbol,
      field: request.field,
      source: provider,
      status: sourceError?.status ?? null,
      errorCode: reason,
      timestamp: calculatedAt,
    }));
  });

  const betaBeforeStaleLkg = waccMarketInputs.beta;
  const riskFreeBeforeStaleLkg = waccMarketInputs.riskFreeRate;
  const erpBeforeStaleLkg = waccMarketInputs.equityRiskPremium;
  waccMarketInputs = applyCachedWaccInputs(
    waccMarketInputs,
    valuationLkg,
    'stale-fallback',
  );
  if (
    waccMarketInputs.beta !== betaBeforeStaleLkg
    || waccMarketInputs.riskFreeRate !== riskFreeBeforeStaleLkg
    || waccMarketInputs.equityRiskPremium !== erpBeforeStaleLkg
  ) {
    valuationLkgUsed = true;
    valuationLkgStaleUsed = true;
  }

  const researchCounters: ResearchCounters = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    negativeCacheHits: 0,
    evidenceSourceCount: 0,
    rejectedReasons: [],
    plannedFields: [],
    executedFields: [],
    modelsUnlocked: [],
    budget: 5,
  };
  const financialModelPossible = Boolean(latestFinancialPeriod);
  researchCounters.plannedFields.push(
    'forwardEps',
    'forwardRevenue',
    'peerCandidates',
    'peerForwardEstimates',
  );
  if (financialModelPossible) {
    researchCounters.plannedFields.push(
      'beta',
      'riskFreeRate',
      'equityRiskPremium',
    );
  }
  let groundedValueUsed = false;
  const groundedDiagnostics: ValuationDiagnostic[] = [];
  const research = async (request: GroundedResearchRequest) => {
    if (researchCounters.requests >= researchCounters.budget) {
      researchCounters.rejectedReasons.push('research-budget-exhausted');
      return {
        metrics: [],
        rejectedReasons: [],
        cache: 'negative' as const,
        unavailableReason: 'research-budget-exhausted',
      };
    }
    researchCounters.executedFields.push(...request.metrics);
    for (const field of request.metrics) {
      writeFairValueFieldLog({
        event: 'fair_value_field_resolution',
        symbol,
        field,
        state: 'research-started',
        provider: 'gemini-grounded-research',
        asOf: calculatedAt,
      });
    }
    const outcome = recordResearch(
      await groundedResearch!.research(request),
      researchCounters,
    );
    for (const field of request.metrics) {
      const matches = outcome.metrics.filter((metric) => metric.metric === field);
      if (matches.length) {
        writeFairValueFieldLog({
          event: 'fair_value_field_resolution',
          symbol,
          field,
          state: 'research-hit',
          provider: 'gemini-grounded-research',
          asOf: matches.map((metric) => metric.asOf).toSorted().at(-1) ?? calculatedAt,
        });
        continue;
      }
      const reason = outcome.unavailableReason
        ?? outcome.rejectedReasons.at(0)
        ?? 'no-validated-grounded-evidence';
      writeFairValueFieldLog({
        event: 'fair_value_field_resolution',
        symbol,
        field,
        state: reason.startsWith('gemini-') ? 'research-error' : 'research-rejected',
        provider: 'gemini-grounded-research',
        reason,
        asOf: calculatedAt,
      });
    }
    return outcome;
  };
  const researchPeerCandidates = async (
    request: Parameters<NonNullable<typeof groundedResearch>['researchPeers']>[0],
  ) => {
    if (researchCounters.requests >= researchCounters.budget) {
      researchCounters.rejectedReasons.push('research-budget-exhausted');
      return {
        candidates: [],
        rejected: [],
        cache: 'negative' as const,
        unavailableReason: 'research-budget-exhausted',
      };
    }
    researchCounters.executedFields.push('peerCandidates');
    writeFairValueFieldLog({
      event: 'fair_value_field_resolution',
      symbol,
      field: 'peerCandidates',
      state: 'research-started',
      provider: 'gemini-grounded-research',
      asOf: calculatedAt,
    });
    const outcome = recordPeerResearch(
      await groundedResearch!.researchPeers(request),
      researchCounters,
    );
    const reason = outcome.unavailableReason
      ?? outcome.rejected.at(0)?.reason
      ?? 'no-validated-peer-candidates';
    writeFairValueFieldLog({
      event: 'fair_value_field_resolution',
      symbol,
      field: 'peerCandidates',
      state: outcome.candidates.length
        ? 'research-hit'
        : reason.startsWith('gemini-') ? 'research-error' : 'research-rejected',
      provider: 'gemini-grounded-research',
      reason: outcome.candidates.length ? undefined : reason,
      asOf: outcome.candidates.map((candidate) => candidate.asOf)
        .toSorted()
        .at(-1) ?? calculatedAt,
    });
    return outcome;
  };

  if (groundedResearch) {
    const currentYear = Number(calculatedAt.slice(0, 4));
    const missingMarketMetrics: GroundedResearchRequest['metrics'] = [];
    if (!positive(waccMarketInputs.riskFreeRate)) missingMarketMetrics.push('riskFreeRate');
    if (!positive(waccMarketInputs.equityRiskPremium)) {
      missingMarketMetrics.push('equityRiskPremium');
    }
    if (financialModelPossible && missingMarketMetrics.length) {
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
        recordResolvedInput(inputResolution, {
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
          sourceState: 'gemini',
          sourceType: 'gemini-grounded',
          sourceUrl: metric.provenance.sourceUrl,
          evidence: metric.provenance.evidence,
          reason: null,
        });
      }
    }

    const missingCompanyMetrics: GroundedResearchRequest['metrics'] = [];
    if (financialModelPossible && !positive(waccMarketInputs.beta)) {
      missingCompanyMetrics.push('beta');
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
        recordResolvedInput(inputResolution, {
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
          sourceState: 'gemini',
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
      recordResolvedInput(inputResolution, {
        field: 'marketCapitalization',
        origin: 'derived',
        provider: afterResearch.marketCapitalizationProvenance.provider,
        asOf: afterResearch.marketCapitalizationProvenance.asOf,
      });
      writeFairValueFieldLog({
        event: 'fair_value_field_resolution',
        symbol,
        field: 'marketCapitalization',
        state: 'derived',
        provider: afterResearch.marketCapitalizationProvenance.provider,
        reason: 'market-price-times-shares',
        asOf: afterResearch.marketCapitalizationProvenance.asOf,
      });
    }
  }

  const researchBoundary = latestFinancialPeriod?.periodEnd ?? calculatedAt.slice(0, 10);
  const reportedRevenuePeriods = financials.periods.filter((period) =>
    positive(period.revenue));
  const futureRevenueCount = estimates.filter((estimate) =>
    estimate.periodEnd > researchBoundary && positive(estimate.estimatedRevenue)).length;
  const dcfGrowthReady = futureRevenueCount === 1
    || futureRevenueCount >= 5
    || reportedRevenuePeriods.length >= 2;
  const dcfCriticalInputsReady = Boolean(
    latestFinancialPeriod
    && positive(latestFinancialPeriod.freeCashFlow)
    && positive(latestFinancialPeriod.revenue)
    && positive(marketCapitalization)
    && positive(waccMarketInputs.beta)
    && positive(waccMarketInputs.riskFreeRate)
    && positive(waccMarketInputs.equityRiskPremium)
    && positive(latestFinancialPeriod.incomeBeforeTax)
    && finite(latestFinancialPeriod.incomeTaxExpense)
    && latestFinancialPeriod.incomeTaxExpense! >= 0
    && finite(latestFinancialPeriod.interestExpense)
    && latestFinancialPeriod.interestExpense >= 0
    && finite(latestFinancialPeriod.cash)
    && latestFinancialPeriod.cash >= 0
    && finite(latestFinancialPeriod.totalDebt)
    && latestFinancialPeriod.totalDebt >= 0
    && (
      positive(sharesOutstanding)
      || positive(latestFinancialPeriod.dilutedShares)
    )
    && dcfGrowthReady
  );
  if (!groundedResearch) {
    const estimateCountBeforeStaleLkg = estimates.length;
    estimates = mergeCachedForwardEstimates(estimates, valuationLkg, 'stale');
    if (
      estimates.length !== estimateCountBeforeStaleLkg
      || estimates.some((estimate) =>
        estimate.epsProvenance?.provider === valuationLkg.company.forwardEps
          .find((item) => item.state === 'stale')?.entry.source
        || estimate.revenueProvenance?.provider === valuationLkg.company.forwardRevenue
          .find((item) => item.state === 'stale')?.entry.source)
    ) {
      valuationLkgUsed = true;
      valuationLkgStaleUsed = true;
    }
  }
  if (groundedResearch && !dcfCriticalInputsReady) {
    const fiscalYears = futureFiscalYears(researchBoundary, calculatedAt);
    const future = estimates.filter((estimate) =>
      estimate.periodEnd > researchBoundary);
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
      for (const metric of rescued.metrics.filter((item) => item.symbol === symbol)) {
        const field = metric.metric === 'revenue' ? 'forwardRevenue' : 'forwardEps';
        recordResolvedInput(inputResolution, {
          field,
          origin: 'gemini-grounded',
          provider: metric.provenance.provider,
          asOf: metric.asOf,
        });
        groundedDiagnostics.push({
          field,
          value: metric.value,
          period: metric.period,
          provider: metric.provenance.provider,
          asOf: metric.asOf,
          status: 'available',
          provenance: 'gemini-grounded',
          sourceState: 'gemini',
          sourceType: 'gemini-grounded',
          sourceUrl: metric.provenance.sourceUrl,
          evidence: metric.provenance.evidence,
          reason: null,
        });
        groundedValueUsed = true;
      }
    }

    const estimateCountBeforeStaleLkg = estimates.length;
    estimates = mergeCachedForwardEstimates(estimates, valuationLkg, 'stale');
    if (
      estimates.length !== estimateCountBeforeStaleLkg
      || estimates.some((estimate) =>
        estimate.epsProvenance?.provider === valuationLkg.company.forwardEps
          .find((item) => item.state === 'stale')?.entry.source
        || estimate.revenueProvenance?.provider === valuationLkg.company.forwardRevenue
          .find((item) => item.state === 'stale')?.entry.source)
    ) {
      valuationLkgUsed = true;
      valuationLkgStaleUsed = true;
    }

    const targetEstimate = estimates
      .filter((estimate) =>
        estimate.periodEnd > researchBoundary
        && ((finite(estimate.estimatedEps) && estimate.estimatedEps > 0)
          || (finite(estimate.estimatedRevenue) && estimate.estimatedRevenue > 0)))
      .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
      .at(0);
    if (targetEstimate) {
      const branch = finite(targetEstimate.estimatedEps) && targetEstimate.estimatedEps > 0
        ? 'eps' as const : 'revenue' as const;
      if (branch === 'revenue'
        && !positive(sharesOutstanding)
        && !positive(latestFinancialPeriod?.dilutedShares)) {
        researchCounters.plannedFields.push('shares');
        const rescuedShares = await research({
          symbols: [symbol],
          metrics: ['shares'],
          fiscalYears: [Number(targetEstimate.periodEnd.slice(0, 4))],
        });
        const metric = rescuedShares.metrics.find((item) =>
          item.symbol === symbol && item.field === 'shares');
        if (metric && positive(metric.value)) {
          sharesOutstanding = metric.value;
          sharesOutstandingAsOf = metric.period;
          sharesOutstandingProvenance = metric.provenance;
          groundedValueUsed = true;
        }
      }
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
          if (rescued.metrics.length) {
            const latestMetric = rescued.metrics
              .toSorted((left, right) =>
                (left.asOf ?? left.provenance.asOf)
                  .localeCompare(right.asOf ?? right.provenance.asOf))
              .at(-1)!;
            recordResolvedInput(inputResolution, {
              field: 'peerForwardEstimates',
              origin: 'gemini-grounded',
              provider: latestMetric.provenance.provider,
              asOf: latestMetric.asOf ?? latestMetric.provenance.asOf,
            });
            groundedValueUsed = true;
          }
        }
      }
      const hydratedPeerCount = peers.filter((peer) =>
        branch === 'eps'
          ? positive(peer.price) && positive(peer.forwardEps)
          : positive(peer.enterpriseValue) && positive(peer.forwardRevenue)).length;
      if (hydratedPeerCount < 4) {
        const metric = branch === 'eps' ? 'forward-pe' as const : 'forward-ev-sales' as const;
        const discovered = await researchPeerCandidates({
          symbol,
          company: profile?.data.name ?? null,
          sector: profile?.data.sector ?? valuation.sector ?? '',
          industry: profile?.data.industry ?? valuation.industry ?? '',
          metric,
          period: targetEstimate.periodEnd,
        });
        peerRejections.push(...discovered.rejected.map((item) => ({
          symbol: item.symbol,
          reason: item.reason,
          metric,
          period: targetEstimate.periodEnd,
          source: 'gemini-grounded-research',
          asOf: calculatedAt,
        })));
        const existingSymbols = new Set([
          symbol,
          ...peers.map((peer) => peer.symbol),
        ].map((item) => item.trim().toUpperCase()));
        const candidates = discovered.candidates.filter((candidate) => {
          if (existingSymbols.has(candidate.symbol)) {
            peerRejections.push({
              symbol: candidate.symbol,
              reason: 'duplicate-peer',
              metric,
              period: targetEstimate.periodEnd,
              source: candidate.sourceName,
              asOf: candidate.asOf,
            });
            return false;
          }
          existingSymbols.add(candidate.symbol);
          if (!peerCandidateSymbols.includes(candidate.symbol)) {
            peerCandidateSymbols.push(candidate.symbol);
          }
          return true;
        });

        if (branch === 'eps' && candidates.length) {
          const [quotes, rescued] = await Promise.all([
            Promise.allSettled(candidates.map((candidate) =>
              market
                ? market.getQuote(candidate.symbol)
                : Promise.reject(new Error('market-provider-unavailable')))),
            research({
              symbols: candidates.map((candidate) => candidate.symbol),
              metrics: ['eps'],
              fiscalYears: [Number(targetEstimate.periodEnd.slice(0, 4))],
            }),
          ]);
          const metricsBySymbol = new Map(rescued.metrics
            .filter((item) => item.metric === 'eps')
            .map((item) => [item.symbol, item]));
          candidates.forEach((candidate, index) => {
            const quoteResult = quotes[index];
            const forwardEps = metricsBySymbol.get(candidate.symbol);
            const reasons: string[] = [];
            const quote = quoteResult?.status === 'fulfilled' ? quoteResult.value : null;
            if (!quote || !positive(quote.data.price)) reasons.push('missing-price');
            if (quote?.data.currency !== 'USD') reasons.push('currency-mismatch');
            if (!forwardEps || !positive(forwardEps.value)) reasons.push('missing-forward-eps');
            if (forwardEps && forwardEps.periodEnd !== targetEstimate.periodEnd) {
              reasons.push('forward-period-mismatch');
            }
            if (reasons.length) {
              peerRejections.push({
                symbol: candidate.symbol,
                reason: [...new Set(reasons)].join(','),
                metric,
                period: forwardEps?.periodEnd ?? targetEstimate.periodEnd,
                source: forwardEps?.sourceName ?? candidate.sourceName,
                asOf: forwardEps?.asOf ?? candidate.asOf,
              });
              return;
            }
            peers.push({
              symbol: candidate.symbol,
              company: candidate.company,
              businessContext: candidate.businessContext,
              sector: candidate.sector,
              industry: candidate.industry,
              price: quote!.data.price,
              priceAsOf: quote!.freshness.asOf,
              enterpriseValue: null,
              enterpriseValueAsOf: null,
              forwardEps: forwardEps!.value,
              forwardRevenue: null,
              estimatePeriod: forwardEps!.periodEnd,
              estimateAsOf: forwardEps!.asOf,
              provider: `${quote!.provider ?? market!.id}+gemini-grounded-research`,
              estimateProvenance: forwardEps!.provenance,
              candidateProvenance: {
                provider: 'gemini-grounded-research',
                sourceType: 'gemini-grounded',
                field: 'peerCandidate',
                fiscalPeriod: targetEstimate.periodEnd,
                asOf: candidate.asOf,
                sourceUrl: candidate.sourceUrl,
                evidence: candidate.evidence,
                evidenceQuality: candidate.evidence.some((item) => item.quality === 'primary')
                  ? 'high' : 'medium',
              },
              candidateSource: 'gemini-grounded',
              currency: quote!.data.currency,
            });
          });
          if (peers.some((peer) => peer.candidateSource === 'gemini-grounded')) {
            const latestCandidate = candidates
              .toSorted((left, right) => left.asOf.localeCompare(right.asOf))
              .at(-1)!;
            recordResolvedInput(inputResolution, {
              field: 'peerForwardEstimates',
              origin: 'gemini-grounded',
              provider: 'gemini-grounded-research',
              asOf: latestCandidate.asOf,
            });
            groundedValueUsed = true;
          }
        } else if (branch === 'revenue') {
          peerRejections.push(...candidates.map((candidate) => ({
            symbol: candidate.symbol,
            reason: 'enterprise-value-source-unavailable',
            metric,
            period: targetEstimate.periodEnd,
            source: candidate.sourceName,
            asOf: candidate.asOf,
          })));
        }
      }
    }
  }

  const finalTargetEstimate = validFutureEstimates(
    estimates,
    latestFinancialPeriod?.periodEnd ?? null,
    Date.parse(calculatedAt),
  ).find((estimate) =>
    positive(estimate.estimatedEps) || positive(estimate.estimatedRevenue));
  const nearestRawEstimate = estimates
    .filter((estimate) => estimate.periodEnd > researchBoundary)
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .at(0);
  writeFairValueResolutionAuditLog({
    event: 'fair_value_resolution_audit',
    symbol,
    field: 'targetForwardEstimate',
    stage: 'future-estimate-validation',
    provider: finalTargetEstimate?.provider
      ?? nearestRawEstimate?.provider
      ?? valuation.provider,
    available: Boolean(finalTargetEstimate),
    reason: finalTargetEstimate
      ? undefined
      : nearestRawEstimate
        ? 'engine-future-estimate-contract-rejected'
        : 'no-future-estimate-candidate',
    asOf: finalTargetEstimate?.asOf ?? nearestRawEstimate?.asOf ?? calculatedAt,
    period: finalTargetEstimate?.periodEnd ?? nearestRawEstimate?.periodEnd ?? null,
    value: finalTargetEstimate
      ? positive(finalTargetEstimate.estimatedEps)
        ? finalTargetEstimate.estimatedEps
        : finalTargetEstimate.estimatedRevenue
      : null,
    currency: finalTargetEstimate?.currency ?? nearestRawEstimate?.currency ?? null,
    schemaPassed: Boolean(nearestRawEstimate),
    validFutureEstimatePassed: Boolean(finalTargetEstimate),
  });
  if (finalTargetEstimate) {
    const branch = positive(finalTargetEstimate.estimatedEps) ? 'pe' : 'ev-sales';
    const validPeers = peers.filter((peer) =>
      peer.estimatePeriod === finalTargetEstimate.periodEnd
      && (peer.currency == null || peer.currency === 'USD')
      && (branch === 'pe'
        ? positive(peer.price) && positive(peer.forwardEps)
        : positive(peer.enterpriseValue) && positive(peer.forwardRevenue)));
    if (validPeers.length >= 4
      && (branch === 'pe'
        || (positive(sharesOutstanding ?? latestFinancialPeriod?.dilutedShares)
          && positive(valuation.cash)
          && positive(valuation.totalDebt)))) {
      researchCounters.modelsUnlocked.push(branch);
    }
  }
  const finalFieldStates = [
    {
      field: 'beta',
      available: positive(waccMarketInputs.beta),
      provider: waccMarketInputs.betaProvenance?.provider ?? waccMarketInputs.provider,
      asOf: waccMarketInputs.betaAsOf ?? calculatedAt,
    },
    {
      field: 'riskFreeRate',
      available: positive(waccMarketInputs.riskFreeRate),
      provider: waccMarketInputs.riskFreeRateProvenance?.provider ?? waccMarketInputs.provider,
      asOf: waccMarketInputs.riskFreeAsOf ?? calculatedAt,
    },
    {
      field: 'equityRiskPremium',
      available: positive(waccMarketInputs.equityRiskPremium),
      provider: waccMarketInputs.equityRiskPremiumProvenance?.provider
        ?? waccMarketInputs.provider,
      asOf: waccMarketInputs.equityRiskPremiumAsOf ?? calculatedAt,
    },
    {
      field: 'targetForwardEstimate',
      available: Boolean(finalTargetEstimate),
      provider: finalTargetEstimate?.provider ?? valuation.provider,
      asOf: finalTargetEstimate?.asOf ?? calculatedAt,
    },
    {
      field: 'peerObservations',
      available: peers.length > 0,
      provider: peers.at(0)?.provider ?? valuation.provider,
      asOf: peers.map((peer) => peer.estimateAsOf ?? '')
        .filter(Boolean)
        .toSorted()
        .at(-1) ?? calculatedAt,
    },
  ];
  for (const field of finalFieldStates) {
    writeFairValueFieldLog({
      event: 'fair_value_field_resolution',
      symbol,
      field: field.field,
      state: field.available ? 'merged' : 'final-missing',
      provider: field.provider,
      reason: field.available ? undefined : 'no-validated-canonical-value',
      asOf: field.asOf,
    });
  }
  for (const field of [
    {
      name: 'riskFreeRate' as const,
      value: waccMarketInputs.riskFreeRate,
      provider: waccMarketInputs.riskFreeRateProvenance?.provider
        ?? waccMarketInputs.provider,
      asOf: waccMarketInputs.riskFreeAsOf ?? calculatedAt,
    },
    {
      name: 'equityRiskPremium' as const,
      value: waccMarketInputs.equityRiskPremium,
      provider: waccMarketInputs.equityRiskPremiumProvenance?.provider
        ?? waccMarketInputs.provider,
      asOf: waccMarketInputs.equityRiskPremiumAsOf ?? calculatedAt,
    },
  ]) {
    writeFairValueResolutionAuditLog({
      event: 'fair_value_resolution_audit',
      symbol,
      field: field.name,
      stage: 'normalization',
      provider: field.provider,
      available: positive(field.value),
      reason: positive(field.value) ? undefined : 'no-normalized-canonical-value',
      asOf: field.asOf,
      value: field.value,
    });
  }

  const diagnostics: ValuationDiagnostic[] = [
    ...valuationInputLkgDiagnostics(valuationLkg),
    ...(valuation.diagnostics ?? []),
    ...deterministic.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      sourceState: 'derived' as const,
    })),
    ...independentDiagnostics,
    ...groundedDiagnostics,
    {
      field: 'financialStatements',
      value: financials.periods.length,
      period: latestFinancialPeriod?.periodEnd ?? null,
      provider: financials.providerUsed ?? financials.diagnostics.provider,
      asOf: financials.asOf || calculatedAt,
      status: financials.periods.length === 0
        ? 'missing'
        : financials.dataState === 'provider-stale' ? 'stale' : 'available',
      provenance: 'provider',
      sourceState: financials.periods.length === 0
        ? 'missing'
        : financials.dataState === 'provider-cached'
          ? 'provider-cached'
          : financials.dataState === 'provider-stale'
            ? 'provider-stale'
            : 'provider-live',
      reason: financials.periods.length === 0
        ? Object.values(financials.datasetErrors).join(',') || 'provider-field-missing'
        : null,
    },
    {
      field: 'marketPrice',
      value: marketPrice,
      period: marketPriceAsOf,
      provider: marketPriceSource,
      asOf: marketPriceAsOf,
      status: providerStatus === 'stale' ? 'stale' : 'available',
      provenance: 'provider',
      sourceState: providerStatus === 'stale'
        ? 'provider-stale'
        : providerStatus === 'cached' ? 'provider-cached' : 'provider-live',
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
      sourceState: marketCapitalizationProvenance?.sourceType === 'derived'
        ? 'derived' : 'provider-live',
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

  const calculationInput: ValuationInput = {
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
    betaAudit: {
      targetSource: historySource || 'persistent-or-provider-beta',
      benchmarkSource: benchmarkSource || 'persistent-or-provider-beta',
      targetRows: deterministic.betaAudit.targetRows,
      benchmarkRows: deterministic.betaAudit.benchmarkRows,
      alignedRows: deterministic.betaAudit.alignedObservations,
      sampleSize: deterministic.beta?.provenance.sampleSize
        ?? waccMarketInputs.betaProvenance?.sampleSize
        ?? 0,
      period: deterministic.betaAudit.period
        ?? waccMarketInputs.betaProvenance?.fiscalPeriod
        ?? null,
      derivedBeta: deterministic.betaAudit.derivedBeta,
    },
    providerStatus: groundedValueUsed
      ? 'limited'
      : valuationLkgStaleUsed
        ? 'stale'
        : valuationLkgUsed ? 'cached' : providerStatus,
    researchAudit: {
      geminiUsed: groundedValueUsed,
      evidenceSourceCount: researchCounters.evidenceSourceCount,
      rejectedReasons: [...new Set(researchCounters.rejectedReasons)],
      requests: researchCounters.requests,
      cacheHits: researchCounters.cacheHits,
      cacheMisses: researchCounters.cacheMisses,
      negativeCacheHits: researchCounters.negativeCacheHits,
      plannedFields: [...new Set(researchCounters.plannedFields)],
      executedFields: [...new Set(researchCounters.executedFields)],
      modelsUnlocked: [...new Set(researchCounters.modelsUnlocked)],
      budget: researchCounters.budget,
    },
    inputResolution,
    peerAudit: {
      candidates: peerCandidateSymbols,
      rejected: peerRejections,
    },
    diagnostics,
    balanceSheetBridge: valuation.balanceSheetAsOf
      ? {
          cash: valuation.cash,
          debt: valuation.totalDebt,
          currency: valuation.currency ?? 'USD',
          asOf: valuation.balanceSheetAsOf,
          provider: valuation.provider,
        }
      : null,
    displayFx: null,
    calculatedAt,
  };
  const result = calculateFairValueSafely(calculationInput);
  const resolvedEntries = excludeUnchangedLkgEntries(
    buildResolvedValuationLkgEntries({
      symbol,
      waccMarketInputs,
      estimates: validFutureEstimates(
        estimates,
        latestFinancialPeriod?.periodEnd ?? null,
        Date.parse(calculatedAt),
      ),
      peers,
      peerAudit: result.peerAudit ?? calculationInput.peerAudit,
      calculatedAt,
    }),
    valuationLkg,
  );
  if (resolvedEntries.length) {
    await valuationLkgService.writeMany(resolvedEntries).catch((cause) => {
      const repositoryError = cause instanceof Error
        && /^Valuation LKG write failed: [A-Za-z0-9_-]+$/.test(cause.message)
        ? cause.message
        : safeFairValueErrorCode(cause);
      console.warn(JSON.stringify({
        event: 'valuation-lkg-write-failed',
        symbol,
        errorCode: repositoryError,
        timestamp: calculatedAt,
      }));
    });
  }
  return result;
}

const fairValueInflight = new Map<string, Promise<FairValueResult>>();

export function loadFairValue(rawSymbol: string): Promise<FairValueResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const active = fairValueInflight.get(symbol);
  if (active) return active;
  const operation = resolveFairValue(symbol)
    .finally(() => fairValueInflight.delete(symbol));
  fairValueInflight.set(symbol, operation);
  return operation;
}
