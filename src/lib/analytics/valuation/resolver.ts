import type { HistoricalPrice } from '@/src/lib/market-data/types';
import type {
  AnalystEstimate,
  InputResolutionAudit,
  MetricProvenance,
  PeerObservation,
  ValuationDiagnostic,
  WaccMarketInputs,
} from './types';

const MINIMUM_BETA_SAMPLES = 60;
const MAXIMUM_ABSOLUTE_BETA = 10;

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Normalizes an explicitly labelled percentage into the decimal convention
 * used by the valuation engine. The caller must provide the source unit so an
 * ambiguous value is never silently multiplied or divided by 100.
 */
export function normalizePercentage(
  value: unknown,
  unit: 'percent' | 'decimal',
  range: { minimum?: number; maximum?: number } = {},
): number | null {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  const raw = typeof trimmed === 'string' && unit === 'percent'
    ? trimmed.replace(/%$/, '').trim()
    : trimmed;
  const numeric = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.length > 0 ? Number(raw.replaceAll(',', '')) : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  const normalized = unit === 'percent' ? numeric / 100 : numeric;
  const minimum = range.minimum ?? 0;
  const maximum = range.maximum ?? 1;
  return normalized >= minimum && normalized <= maximum ? normalized : null;
}

function hasForwardMetric(
  estimates: readonly AnalystEstimate[],
  field: 'estimatedRevenue' | 'estimatedEps',
): boolean {
  return estimates.some((estimate) => field === 'estimatedRevenue'
    ? positive(estimate[field])
    : finite(estimate[field]));
}

function validPeerCount(peers: readonly PeerObservation[]): number {
  return peers.filter((peer) =>
    (positive(peer.price) && positive(peer.forwardEps))
    || (positive(peer.enterpriseValue) && positive(peer.forwardRevenue))).length;
}

/**
 * Classifies primary-provider coverage before deterministic derivation or
 * grounded research. The four categories are deliberately disjoint.
 */
export function classifyValuationInputs(input: {
  marketPrice: number | null;
  marketCapitalization: number | null;
  sharesOutstanding: number | null;
  dilutedShares: number | null;
  analystEstimates: readonly AnalystEstimate[];
  peers: readonly PeerObservation[];
  waccMarketInputs: WaccMarketInputs | null;
}): InputResolutionAudit {
  const available: string[] = [];
  const derivable: string[] = [];
  const researchable: string[] = [];
  const missing: string[] = [];
  const shares = positive(input.sharesOutstanding)
    ? input.sharesOutstanding : positive(input.dilutedShares) ? input.dilutedShares : null;

  positive(input.marketPrice) ? available.push('marketPrice') : missing.push('marketPrice');
  if (positive(input.marketCapitalization)) {
    available.push('marketCapitalization');
  } else if (positive(input.marketPrice) && shares) {
    derivable.push('marketCapitalization');
  } else {
    researchable.push('marketCapitalization');
  }

  if (positive(input.sharesOutstanding) || positive(input.dilutedShares)) {
    available.push('shares');
  } else {
    researchable.push('shares');
  }

  if (positive(input.waccMarketInputs?.beta)) {
    available.push('beta');
  } else {
    // Historical stock/benchmark returns are attempted before external research.
    derivable.push('beta');
  }
  positive(input.waccMarketInputs?.riskFreeRate)
    ? available.push('riskFreeRate') : researchable.push('riskFreeRate');
  positive(input.waccMarketInputs?.equityRiskPremium)
    ? available.push('equityRiskPremium') : researchable.push('equityRiskPremium');

  hasForwardMetric(input.analystEstimates, 'estimatedRevenue')
    ? available.push('forwardRevenue') : researchable.push('forwardRevenue');
  hasForwardMetric(input.analystEstimates, 'estimatedEps')
    ? available.push('forwardEps') : researchable.push('forwardEps');
  validPeerCount(input.peers) >= 4
    ? available.push('peerForwardEstimates') : researchable.push('peerForwardEstimates');

  return {
    available: unique(available),
    derivable: unique(derivable),
    researchable: unique(researchable),
    missing: unique(missing),
    resolved: [],
  };
}

function returnsByDate(prices: readonly HistoricalPrice[]): Map<string, number> {
  const sorted = [...prices]
    .filter((price) => positive(price.close))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const returns = new Map<string, number>();
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const value = Math.log(current.close / previous.close);
    if (Number.isFinite(value)) returns.set(current.date, value);
  }
  return returns;
}

export interface DerivedBeta {
  value: number;
  provenance: MetricProvenance;
}

export function deriveHistoricalBeta(
  stockPrices: readonly HistoricalPrice[],
  benchmarkPrices: readonly HistoricalPrice[],
  input: {
    stockProvider: string;
    benchmarkProvider: string;
    benchmark?: string;
    minimumSamples?: number;
  },
): DerivedBeta | null {
  const stockReturns = returnsByDate(stockPrices);
  const benchmarkReturns = returnsByDate(benchmarkPrices);
  const observations = [...stockReturns.entries()]
    .flatMap(([date, stockReturn]) => {
      const benchmarkReturn = benchmarkReturns.get(date);
      return benchmarkReturn === undefined ? [] : [{ date, stockReturn, benchmarkReturn }];
    });
  const minimumSamples = input.minimumSamples ?? MINIMUM_BETA_SAMPLES;
  if (observations.length < minimumSamples) return null;

  const stockMean = observations.reduce((sum, item) => sum + item.stockReturn, 0)
    / observations.length;
  const benchmarkMean = observations.reduce((sum, item) => sum + item.benchmarkReturn, 0)
    / observations.length;
  let covariance = 0;
  let benchmarkVariance = 0;
  for (const observation of observations) {
    covariance += (observation.stockReturn - stockMean)
      * (observation.benchmarkReturn - benchmarkMean);
    benchmarkVariance += (observation.benchmarkReturn - benchmarkMean) ** 2;
  }
  if (!(benchmarkVariance > 0)) return null;
  const beta = covariance / benchmarkVariance;
  if (!positive(beta) || Math.abs(beta) > MAXIMUM_ABSOLUTE_BETA) return null;
  const first = observations.at(0)!.date;
  const last = observations.at(-1)!.date;
  const benchmark = input.benchmark ?? 'SPY';
  return {
    value: beta,
    provenance: {
      provider: `nexora-historical-beta:${input.stockProvider}+${input.benchmarkProvider}`,
      sourceType: 'derived',
      field: 'beta',
      fiscalPeriod: `${first}/${last}`,
      asOf: last,
      evidence: [],
      evidenceQuality: 'medium',
      methodology: 'OLS beta = covariance(daily log stock returns, benchmark returns) / variance(benchmark returns)',
      benchmark,
      sampleSize: observations.length,
      frequency: 'daily',
      start: first,
      end: last,
    },
  };
}

export interface DeterministicResolution {
  marketCapitalization: number | null;
  marketCapitalizationProvenance: MetricProvenance | null;
  beta: DerivedBeta | null;
  diagnostics: ValuationDiagnostic[];
}

export function resolveDeterministicInputs(input: {
  marketPrice: number | null;
  priceAsOf: string;
  marketPriceProvider: string;
  marketCapitalization: number | null;
  shares: number | null;
  sharesAsOf: string | null;
  sharesProvider: string;
  stockPrices?: readonly HistoricalPrice[];
  benchmarkPrices?: readonly HistoricalPrice[];
  stockHistoryProvider?: string;
  benchmarkHistoryProvider?: string;
  benchmark?: string;
}): DeterministicResolution {
  let marketCapitalization = positive(input.marketCapitalization)
    ? input.marketCapitalization : null;
  let marketCapitalizationProvenance: MetricProvenance | null = null;
  const diagnostics: ValuationDiagnostic[] = [];
  if (!marketCapitalization && positive(input.marketPrice) && positive(input.shares)) {
    marketCapitalization = input.marketPrice * input.shares;
    marketCapitalizationProvenance = {
      provider: `nexora-derived:${input.marketPriceProvider}+${input.sharesProvider}`,
      sourceType: 'derived',
      field: 'marketCapitalization',
      fiscalPeriod: input.sharesAsOf ?? input.priceAsOf,
      asOf: input.priceAsOf,
      evidence: [],
      evidenceQuality: 'high',
      methodology: 'market price multiplied by reported shares',
    };
    diagnostics.push({
      field: 'marketCapitalization',
      value: marketCapitalization,
      period: input.sharesAsOf ?? input.priceAsOf,
      provider: marketCapitalizationProvenance.provider,
      asOf: input.priceAsOf,
      status: 'available',
      provenance: 'derived',
      sourceType: 'derived',
      reason: 'derived-market-price-times-shares',
    });
  }

  const beta = input.stockPrices && input.benchmarkPrices
    && input.stockHistoryProvider && input.benchmarkHistoryProvider
    ? deriveHistoricalBeta(input.stockPrices, input.benchmarkPrices, {
        stockProvider: input.stockHistoryProvider,
        benchmarkProvider: input.benchmarkHistoryProvider,
        benchmark: input.benchmark,
      })
    : null;
  if (beta) {
    diagnostics.push({
      field: 'beta',
      value: beta.value,
      period: beta.provenance.fiscalPeriod,
      provider: beta.provenance.provider,
      asOf: beta.provenance.asOf,
      status: 'available',
      provenance: 'derived',
      sourceType: 'derived',
      reason: `derived-historical-beta:${beta.provenance.benchmark}:${beta.provenance.sampleSize}`,
    });
  }
  return {
    marketCapitalization,
    marketCapitalizationProvenance,
    beta,
    diagnostics,
  };
}
