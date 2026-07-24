import 'server-only';
import { getMarketDataProvider } from '@/src/lib/market-data';
import { loadResilientQuote } from '@/src/lib/market-data/quote-service';
import { getFundamentalsProvider } from '../fundamentals/provider';
import { calculateFairValue } from './engine';
import {
  safeFairValueErrorCode,
  writeFairValueLog,
  type FairValueLogger,
} from './logging';
import { getFmpValuationProvider } from './providers/financial-modeling-prep';
import {
  getGroundedFinancialResearchService,
  type ValidatedGroundedMetric,
} from './grounded-research';
import { createFairValueUnavailable } from './result';
import type {
  FairValueFailureKind,
  FairValueResult,
  FairValueUnavailable,
  AnalystEstimate,
  PeerObservation,
  ValuationInput,
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

export async function loadFairValue(symbol: string): Promise<FairValueResult> {
  const calculatedAt = new Date().toISOString();
  const fundamentals = getFundamentalsProvider();
  const valuationProvider = getFmpValuationProvider();
  if (!fundamentals) {
    return logUnavailable(unavailable(
      'provider-unavailable',
      symbol,
      calculatedAt,
      'ยังคำนวณ Fair Value ไม่ได้ เพราะไม่ได้ตั้งค่า provider งบการเงินจริง',
      ['financialStatements'],
    ));
  }
  if (!valuationProvider) {
    return logUnavailable(unavailable(
      'provider-unavailable',
      symbol,
      calculatedAt,
      'ยังคำนวณ Fair Value ไม่ได้ เพราะขาด Forward Estimates จาก FMP',
      ['forwardEstimates', 'stockPeers', 'waccMarketInputs'],
      null,
      'financial-modeling-prep',
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
    { field: 'forwardEstimates', provider: valuationProvider.id, result: valuationResult },
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
    || valuationResult.status !== 'fulfilled'
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
  const valuation = valuationResult.value;
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
  const marketCapitalization =
    profile?.data.marketCapitalization ?? valuation.marketCapitalization;
  const latestFinancialPeriod = [...financials.periods]
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .at(-1);

  let estimates = valuation.estimates;
  let peers = valuation.peers;
  const groundedResearch = getGroundedFinancialResearchService();
  const rejectedReasons: string[] = [];
  let geminiUsed = false;
  let evidenceSourceCount = 0;
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
      finite(estimate.estimatedEps)
      && (estimate.estimatedEps > 0
        || (finite(estimate.estimatedRevenue) && estimate.estimatedRevenue > 0)));
    if (!hasMultiplesTarget && !future.some((estimate) => finite(estimate.estimatedEps))) {
      missingTargetMetrics.push('eps');
    } else if (!hasMultiplesTarget && !missingTargetMetrics.includes('revenue')) {
      // A non-positive EPS can use EV/Sales only when revenue exists for the
      // same forward fiscal period; revenue from another year is not a match.
      missingTargetMetrics.push('revenue');
    }
    if (missingTargetMetrics.length) {
      const rescued = await groundedResearch.research({
        symbols: [symbol],
        metrics: missingTargetMetrics,
        fiscalYears,
      });
      geminiUsed = true;
      estimates = mergeGroundedTargetEstimates(estimates, rescued.metrics, symbol);
      rejectedReasons.push(...rescued.rejectedReasons);
      evidenceSourceCount += rescued.metrics.reduce(
        (sum, metric) => sum + metric.provenance.evidence.length,
        0,
      );
      if (rescued.unavailableReason) rejectedReasons.push(rescued.unavailableReason);
    }

    const targetEstimate = estimates
      .filter((estimate) =>
        estimate.periodEnd > latestFinancialPeriod.periodEnd
        && finite(estimate.estimatedEps)
        && (estimate.estimatedEps > 0
          || (finite(estimate.estimatedRevenue) && estimate.estimatedRevenue > 0)))
      .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
      .at(0);
    if (targetEstimate) {
      const branch = targetEstimate.estimatedEps! > 0 ? 'eps' as const : 'revenue' as const;
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
          const rescued = await groundedResearch.research({
            symbols: candidates,
            metrics: [branch],
            fiscalYears: [Number(targetEstimate.periodEnd.slice(0, 4))],
          });
          geminiUsed = true;
          peers = mergeGroundedPeerEstimates(
            peers,
            rescued.metrics,
            branch,
            targetEstimate.periodEnd,
          );
          rejectedReasons.push(...rescued.rejectedReasons);
          evidenceSourceCount += rescued.metrics.reduce(
            (sum, metric) => sum + metric.provenance.evidence.length,
            0,
          );
          if (rescued.unavailableReason) rejectedReasons.push(rescued.unavailableReason);
        }
      }
    }
  }

  return calculateFairValueSafely({
    symbol,
    currency: 'USD',
    marketPrice,
    marketPriceSource,
    marketCapitalization,
    sharesOutstanding: valuation.sharesOutstanding,
    sharesOutstandingAsOf: valuation.sharesOutstandingAsOf,
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
    historicalPrices: [],
    historySource: '',
    historyFreshness: {
      status: 'unavailable',
      asOf: null,
      maxAgeSeconds: null,
    },
    analystEstimates: estimates,
    peerObservations: peers,
    waccMarketInputs: valuation.waccMarketInputs,
    providerStatus: geminiUsed ? 'limited' : providerStatus,
    researchAudit: {
      geminiUsed,
      evidenceSourceCount,
      rejectedReasons: [...new Set(rejectedReasons)],
    },
    peerAudit: {
      candidates: valuation.peerCandidates,
      rejected: valuation.peerRejections,
    },
    displayFx: null,
    calculatedAt,
  });
}
