import { classifyCompany } from './classification';
import {
  calculateDeterministicDcf,
  calculateDeterministicWacc,
  calculateForwardMultiples,
} from './formulas';
import { createFairValueUnavailable } from './result';
import { DATASET_FRESHNESS_POLICY, datasetFreshness } from './freshness';
import {
  METHODOLOGY_VERSION,
  SECTOR_RULE_VERSION,
  type AnalystEstimate,
  type FairValueResult,
  type FinancialPeriod,
  type MetricProvenance,
  type ModelResult,
  type ValuationInput,
  type ValuationDiagnostic,
  type ValuationInputDisclosure,
} from './types';

const PERPETUAL_GROWTH = 0.025;
const DCF_WEIGHT = 0.6;
const MULTIPLES_WEIGHT = 0.4;
const MINIMUM_VALID_PEERS = 4;
const MAX_ESTIMATE_AGE_MS = DATASET_FRESHNESS_POLICY.forwardEstimates.freshMs;
const MAX_GROUNDED_ESTIMATE_AGE_MS = DATASET_FRESHNESS_POLICY.forwardEstimates.staleMs;
const MAX_PEER_PRICE_AGE_MS = DATASET_FRESHNESS_POLICY.marketPrice.staleMs;
const MAX_PEER_ENTERPRISE_VALUE_AGE_MS = 550 * 86_400_000;

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function dateWithinAge(value: string | null, now: number, maximumAgeMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= -86_400_000 && age <= maximumAgeMs;
}

function latestPeriod(periods: FinancialPeriod[]): FinancialPeriod | null {
  return [...periods].toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd)).at(-1) ?? null;
}

function financialPeriodIssues(
  periods: FinancialPeriod[],
  valuationCurrency: string,
): string[] {
  if (!periods.length) return [];
  const issues: string[] = [];
  const dates = periods.map((period) => period.periodEnd);
  if (new Set(dates).size !== dates.length) issues.push('duplicateFinancialPeriods');
  if (periods.some((period) => period.currency !== valuationCurrency)) {
    issues.push('financialPeriodCurrencyMismatch');
  }
  if (dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    issues.push('invalidFinancialPeriod');
  }
  return issues;
}

function unavailableReason(missingFields: string[]): string {
  if (missingFields.some((field) => /forwardEstimates|targetForward/i.test(field))) {
    return 'ยังคำนวณ Fair Value ไม่ได้ เพราะขาด Forward Estimates';
  }
  if (missingFields.some((field) => /peer/i.test(field))) {
    return 'ยังคำนวณ Fair Value ไม่ได้ เพราะมี peer ที่ผ่านเกณฑ์ไม่ถึง 4 บริษัท';
  }
  if (missingFields.some((field) => /wacc|beta|riskFree|equityRisk|taxRate|costDebt/i.test(field))) {
    return 'ยังคำนวณ Fair Value ไม่ได้ เพราะข้อมูลจริงสำหรับ WACC ไม่ครบ';
  }
  return `ยังคำนวณ Fair Value ไม่ได้ เพราะขาดข้อมูลสำคัญ: ${missingFields.join(', ')}`;
}

function unavailable(
  input: ValuationInput,
  calculatedAt: string,
  missingFields: string[],
  modelMissing: {
    dcf: string[];
    multiples: string[];
    forwardPe?: string[];
    forwardEvSales?: string[];
  } = {
    dcf: missingFields,
    multiples: missingFields,
  },
): FairValueResult {
  const fields = unique(missingFields);
  const dcfFields = unique(modelMissing.dcf);
  const multiplesFields = unique(modelMissing.multiples);
  const marketModelFailure = fields.some((field) =>
    /forward|peer|wacc|beta|riskFree|equityRisk/i.test(field));
  const provider = marketModelFailure
    ? input.waccMarketInputs?.provider
      ?? input.analystEstimates?.at(0)?.provider
      ?? input.peerObservations?.at(0)?.provider
      ?? input.source
    : input.source;
  return createFairValueUnavailable({
    failureKind: fields.some((field) => field === 'historicalFinancials')
      ? 'insufficient-periods'
      : 'missing-field',
    symbol: input.symbol,
    currency: input.currency || null,
    provider: provider || null,
    reason: unavailableReason(fields),
    missingFields: fields,
    asOf: input.priceAsOf || calculatedAt,
    calculatedAt,
    limitations: [
      'No analyst estimate, WACC input, peer, multiple, financial value, or fallback assumption is fabricated.',
    ],
    diagnostics: [
      ...(input.diagnostics ?? []),
      {
        field: 'model:fcff-dcf',
        value: null,
        period: latestPeriod(input.periods)?.periodEnd ?? null,
        provider: input.source || null,
        asOf: calculatedAt,
        status: 'rejected',
        provenance: 'validation',
        reason: `unavailable:${dcfFields.join(',')}`,
      },
      {
        field: 'model:forward-multiples',
        value: null,
        period: input.analystEstimates?.at(0)?.periodEnd ?? null,
        provider: input.peerObservations?.at(0)?.provider ?? provider ?? null,
        asOf: calculatedAt,
        status: 'rejected',
        provenance: 'validation',
        reason: `unavailable:${multiplesFields.join(',')}`,
      },
      ...(modelMissing.forwardPe ? [{
        field: 'model:forward-pe',
        value: null,
        period: input.analystEstimates?.at(0)?.periodEnd ?? null,
        provider: input.peerObservations?.at(0)?.provider ?? provider ?? null,
        asOf: calculatedAt,
        status: 'rejected' as const,
        provenance: 'validation' as const,
        reason: `unavailable:${unique(modelMissing.forwardPe).join(',')}`,
      }] : []),
      ...(modelMissing.forwardEvSales ? [{
        field: 'model:forward-ev-sales',
        value: null,
        period: input.analystEstimates?.at(0)?.periodEnd ?? null,
        provider: input.peerObservations?.at(0)?.provider ?? provider ?? null,
        asOf: calculatedAt,
        status: 'rejected' as const,
        provenance: 'validation' as const,
        reason: `unavailable:${unique(modelMissing.forwardEvSales).join(',')}`,
      }] : []),
      ...fields.map((field): ValuationDiagnostic => ({
        field,
        value: null,
        period: null,
        provider: provider || null,
        asOf: input.priceAsOf || calculatedAt,
        status: 'rejected',
        provenance: 'validation',
        reason: 'required-model-input-failed-validation',
      })),
    ],
    inputResolution: input.inputResolution,
    researchAudit: input.researchAudit,
    peerAudit: input.peerAudit,
  });
}

/** Critical-input gate for nexora-fv-v2. Historical chart rows and sector-model
 * assumptions are deliberately absent because neither belongs in the valuation. */
export function dataSufficiency(input: Partial<ValuationInput>, now = Date.now()) {
  const missingInputs: string[] = [];
  const staleInputs: string[] = [];
  if (!input.symbol) missingInputs.push('symbol');
  if (input.currency !== 'USD') missingInputs.push('valuationInputsNormalizedToUSD');
  if (!positive(input.marketPrice)) missingInputs.push('marketPrice');
  if (!input.priceAsOf) missingInputs.push('priceAsOf');
  if (!latestPeriod(input.periods ?? [])) missingInputs.push('historicalFinancials');
  if (!input.waccMarketInputs) missingInputs.push('waccMarketInputs');
  if (input.priceAsOf
    && now - Date.parse(input.priceAsOf) > DATASET_FRESHNESS_POLICY.marketPrice.freshMs) {
    staleInputs.push('marketPrice');
  }
  return { ok: missingInputs.length === 0, missingInputs: unique(missingInputs), staleInputs };
}

/** Kept as a small public utility for callers that disclose real peer coverage. */
export function verifiablePeerCount(input: Partial<ValuationInput>): number {
  if (input.peerObservations) {
    return input.peerObservations.filter((peer) =>
      positive(peer.price)
      && (positive(peer.forwardEps)
        || (positive(peer.enterpriseValue) && positive(peer.forwardRevenue)))).length;
  }
  return (input.peerMultiples ?? []).filter((peer) => positive(peer.multiple)).length;
}

/** Backward-compatible public gate; nexora-fv-v2 itself uses the stricter,
 * branch-specific four-peer validator in calculateForwardMultiples. */
export function meaningfulModelGate(
  input: Pick<ValuationInput, 'periods' | 'peerMultiples' | 'forwardRevenue'>,
  models: readonly ModelResult[],
): { ok: true } | { ok: false; reason: string; missingFields: string[] } {
  const latest = latestPeriod(input.periods);
  const soleRelative = models.length === 1 && ['relative', 'ev-sales', 'pe'].includes(models[0].model);
  const preProfit = latest ? latest.netIncome <= 0 || latest.freeCashFlow <= 0 : true;
  const peers = (input.peerMultiples ?? []).filter((peer) => positive(peer.multiple)).length;
  const forwardRevenue = positive(input.forwardRevenue?.value);
  if (!soleRelative || !preProfit || peers >= 5 || forwardRevenue) return { ok: true };
  return {
    ok: false,
    reason: 'A pre-profit relative valuation requires real peers or forward revenue.',
    missingFields: ['verifiablePeerSet>=5', 'forwardRevenueWithPeriod'],
  };
}

export function validFutureEstimates(
  estimates: AnalystEstimate[],
  actualPeriodEnd: string | null,
  now: number,
): AnalystEstimate[] {
  const boundary = actualPeriodEnd ?? new Date(now).toISOString().slice(0, 10);
  return estimates
    .filter((estimate) => {
      const grounded = estimate.revenueProvenance?.sourceType === 'gemini-grounded'
        || estimate.epsProvenance?.sourceType === 'gemini-grounded';
      const fresh = dateWithinAge(
        estimate.asOf,
        now,
        grounded ? MAX_GROUNDED_ESTIMATE_AGE_MS : MAX_ESTIMATE_AGE_MS,
      );
      const revenueAvailable = positive(estimate.estimatedRevenue)
        && (estimate.revenueAnalystCount === null || estimate.revenueAnalystCount > 0);
      const epsAvailable = finite(estimate.estimatedEps)
        && (estimate.epsAnalystCount === null || estimate.epsAnalystCount > 0);
      return estimate.periodEnd > boundary
        && fresh
        && (estimate.currency === undefined || estimate.currency === 'USD')
        && (revenueAvailable || epsAvailable);
    })
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
}

interface DcfGrowthRates {
  rates: number[];
  method: 'consensus-revenue-growth-proxy' | 'historical-revenue-cagr-proxy';
  estimateMode: 'annual-series' | 'consensus-cagr' | 'historical-cagr';
  estimates: AnalystEstimate[];
  historicalPeriods: FinancialPeriod[];
}

function annualGrowthRates(
  latestRevenue: number,
  latestPeriodEnd: string,
  estimates: AnalystEstimate[],
): DcfGrowthRates {
  const revenueEstimates = estimates
    .filter((estimate): estimate is AnalystEstimate & { estimatedRevenue: number } =>
      estimate.periodEnd > latestPeriodEnd && positive(estimate.estimatedRevenue))
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
  if (!revenueEstimates.length) throw new RangeError('forwardEstimates are required');
  if (revenueEstimates.length >= 5) {
    const selected = revenueEstimates.slice(0, 5);
    let previousRevenue = latestRevenue;
    const rates = selected.map((estimate) => {
      const rate = estimate.estimatedRevenue / previousRevenue - 1;
      previousRevenue = estimate.estimatedRevenue;
      return rate;
    });
    return {
      rates,
      method: 'consensus-revenue-growth-proxy',
      estimateMode: 'annual-series',
      estimates: selected,
      historicalPeriods: [],
    };
  }
  if (revenueEstimates.length !== 1) {
    throw new RangeError(
      'DCF requires five annual consensus estimates or one provider-derived consensus growth rate',
    );
  }
  const terminalEstimate = revenueEstimates[0];
  const actual = Date.parse(latestPeriodEnd);
  const terminal = Date.parse(terminalEstimate.periodEnd);
  const years = Math.max(1, Math.round((terminal - actual) / (365.25 * 86_400_000)));
  const cagr = (terminalEstimate.estimatedRevenue / latestRevenue) ** (1 / years) - 1;
  if (!Number.isFinite(cagr) || cagr <= -1) throw new RangeError('consensus CAGR is invalid');
  return {
    rates: [cagr],
    method: 'consensus-revenue-growth-proxy',
    estimateMode: 'consensus-cagr',
    estimates: [terminalEstimate],
    historicalPeriods: [],
  };
}

function historicalGrowthRates(periods: FinancialPeriod[]): DcfGrowthRates {
  const ordered = periods
    .filter((period) => positive(period.revenue))
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
  const earliest = ordered.at(0);
  const latest = ordered.at(-1);
  if (!earliest || !latest || earliest.periodEnd === latest.periodEnd) {
    throw new RangeError('At least two reported revenue periods are required');
  }
  const elapsedYears = (
    Date.parse(latest.periodEnd) - Date.parse(earliest.periodEnd)
  ) / (365.25 * 86_400_000);
  if (!(elapsedYears > 0)) throw new RangeError('Historical revenue period is invalid');
  const rawCagr = (latest.revenue / earliest.revenue) ** (1 / elapsedYears) - 1;
  if (!Number.isFinite(rawCagr) || rawCagr <= -1) {
    throw new RangeError('Historical revenue CAGR is invalid');
  }
  // Reuse the existing verified-history DCF growth contract from sector selection.
  const cagr = Math.max(-0.1, Math.min(0.2, rawCagr));
  return {
    rates: [cagr],
    method: 'historical-revenue-cagr-proxy',
    estimateMode: 'historical-cagr',
    estimates: [],
    historicalPeriods: [earliest, latest],
  };
}

function inputDetail(input: {
  field: string;
  value: number | string;
  currency?: string | null;
  period: string;
  provider: string;
  asOf: string;
  origin?: ValuationInputDisclosure['origin'];
  status?: ValuationInputDisclosure['status'];
  sourceType?: ValuationInputDisclosure['sourceType'];
  sourceUrl?: string;
  evidence?: ValuationInputDisclosure['evidence'];
}): ValuationInputDisclosure {
  const sourceType = input.sourceType
    ?? (input.origin === 'derived' ? 'derived' : 'structured-provider');
  const origin = input.origin
    ?? (sourceType === 'gemini-grounded' ? 'gemini-grounded' : 'provider');
  return {
    field: input.field,
    value: input.value,
    currency: input.currency ?? null,
    period: input.period,
    provider: input.provider,
    asOf: input.asOf,
    status: input.status ?? 'available',
    origin,
    sourceType,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.evidence ? {
      evidence: input.evidence,
      evidenceCount: input.evidence.length,
    } : {}),
  };
}

function metricSourceScore(provenance: MetricProvenance | null | undefined): number {
  if (!provenance || provenance.sourceType === 'structured-provider') return 100;
  if (provenance.sourceType === 'derived') return 85;
  return provenance.evidenceQuality === 'high' ? 70 : 55;
}

function provenanceDisclosure(
  provenance: MetricProvenance | null | undefined,
  fallbackProvider: string,
) {
  const sourceType = provenance?.sourceType ?? 'structured-provider';
  return {
    provider: provenance?.provider ?? fallbackProvider,
    sourceType,
    origin: sourceType === 'derived'
      ? 'derived' as const
      : sourceType === 'gemini-grounded' ? 'gemini-grounded' as const : 'provider' as const,
    sourceUrl: provenance?.sourceUrl,
    evidence: provenance?.evidence,
    status: sourceType === 'gemini-grounded' ? 'limited' as const : 'available' as const,
  };
}

function valuationQuality(input: {
  completeModels: boolean;
  dcfAvailable: boolean;
  multiplesAvailable: boolean;
  estimateMode: 'annual-series' | 'consensus-cagr' | 'historical-cagr' | null;
  targetEstimateAvailable: boolean;
  peerCount: number;
  stale: boolean;
  providerStatus: ValuationInput['providerStatus'];
  provenances: Array<MetricProvenance | null | undefined>;
}): {
  score: number;
  label: 'High' | 'Medium' | 'Low';
  confidence: 'High' | 'Medium' | 'Low';
  components: Record<string, number>;
} {
  const modelCoverage = input.completeModels ? 100
    : input.dcfAvailable || input.multiplesAvailable ? 60 : 0;
  const estimateCoverage = input.estimateMode === 'annual-series' ? 100
    : input.estimateMode === 'consensus-cagr' ? 78
      : input.estimateMode === 'historical-cagr' ? 72
      : input.targetEstimateAvailable ? 65 : 0;
  // Peer coverage is optional for a valid standalone DCF. Model coverage
  // already reflects that Forward Multiples was excluded.
  const peerCoverage = input.multiplesAvailable
    ? Math.min(100, input.peerCount / MINIMUM_VALID_PEERS * 100)
    : input.dcfAvailable ? 100 : 0;
  const freshness = input.stale ? 35
    : input.providerStatus === 'cached' ? 80
      : input.providerStatus === 'delayed' ? 75
        : input.providerStatus === 'limited' ? 70 : 100;
  const relevant = input.provenances.filter(
    (item): item is MetricProvenance => item !== null && item !== undefined,
  );
  const sourceQuality = relevant.length
    ? relevant.reduce((sum, item) => sum + metricSourceScore(item), 0) / relevant.length
    : 100;
  const grounded = relevant.filter((item) => item.sourceType === 'gemini-grounded');
  const evidenceQuality = grounded.length
    ? grounded.reduce(
        (sum, item) => sum + (item.evidenceQuality === 'high' ? 80 : 65),
        0,
      ) / grounded.length
    : 100;
  const components = {
    modelCoverage,
    sourceQuality,
    freshness,
    estimateCoverage,
    peerCoverage,
    evidenceQuality,
  };
  const score = modelCoverage * 0.25
    + sourceQuality * 0.2
    + freshness * 0.15
    + estimateCoverage * 0.15
    + peerCoverage * 0.15
    + evidenceQuality * 0.1;
  const label = score >= 93 ? 'High' as const
    : score >= 65 ? 'Medium' as const : 'Low' as const;
  const confidence = input.completeModels && score >= 93
    ? 'High' as const
    : score >= 65 ? 'Medium' as const : 'Low' as const;
  return { score, label, confidence, components };
}

export function calculateFairValue(input: ValuationInput, now = Date.now()): FairValueResult {
  const calculatedAt = input.calculatedAt ?? new Date(now).toISOString();
  const gate = dataSufficiency(input, now);
  const structuralMissing = gate.missingInputs.filter((field) =>
    !['historicalFinancials', 'forwardEstimates', 'waccMarketInputs', 'peerObservations']
      .includes(field));
  if (structuralMissing.length) return unavailable(input, calculatedAt, structuralMissing);
  const periodIssues = financialPeriodIssues(input.periods, input.currency);
  if (periodIssues.length) return unavailable(input, calculatedAt, periodIssues);
  const latest = latestPeriod(input.periods);
  const futureEstimates = validFutureEstimates(
    input.analystEstimates ?? [],
    latest?.periodEnd ?? null,
    now,
  );
  const targetEstimate = futureEstimates.find((estimate) =>
    positive(estimate.estimatedEps) || positive(estimate.estimatedRevenue)) ?? null;
  const marketWacc = input.waccMarketInputs;
  const dilutedShares = positive(latest?.dilutedShares) ? latest.dilutedShares : null;
  const fallbackShares = positive(input.sharesOutstanding) ? input.sharesOutstanding : null;
  const shares = dilutedShares ?? fallbackShares;
  const bridge = input.balanceSheetBridge?.currency === 'USD'
    ? input.balanceSheetBridge : null;
  const bridgeCash = latest && finite(latest.cash) && latest.cash >= 0
    ? latest.cash : bridge?.cash ?? null;
  const bridgeDebt = latest && finite(latest.totalDebt) && latest.totalDebt >= 0
    ? latest.totalDebt : bridge?.debt ?? null;
  const dcfMissing: string[] = [];
  if (!latest) dcfMissing.push('historicalFinancials');
  if (!positive(latest?.freeCashFlow)) dcfMissing.push('latestRealFreeCashFlow');
  if (!positive(latest?.revenue)) dcfMissing.push('latestRealRevenue');
  if (!positive(input.marketCapitalization)) dcfMissing.push('marketCapitalization');
  if (!marketWacc || !positive(marketWacc.beta)) dcfMissing.push('beta');
  if (!marketWacc || !positive(marketWacc.riskFreeRate)) dcfMissing.push('riskFreeRate');
  if (!marketWacc || !positive(marketWacc.equityRiskPremium)) dcfMissing.push('equityRiskPremium');
  if (marketWacc && positive(marketWacc.beta)
    && !['fresh', 'stale'].includes(datasetFreshness('beta', marketWacc.betaAsOf, now))) {
    dcfMissing.push('betaFreshness');
  }
  if (marketWacc && positive(marketWacc.riskFreeRate)
    && !['fresh', 'stale'].includes(
      datasetFreshness('riskFreeRate', marketWacc.riskFreeAsOf, now),
    )) {
    dcfMissing.push('riskFreeRateFreshness');
  }
  if (marketWacc && positive(marketWacc.equityRiskPremium)
    && !['fresh', 'stale'].includes(
      datasetFreshness(
        'equityRiskPremium',
        marketWacc.equityRiskPremiumAsOf,
        now,
      ),
    )) {
    dcfMissing.push('equityRiskPremiumFreshness');
  }
  if (!finite(latest?.incomeBeforeTax) || latest.incomeBeforeTax <= 0) dcfMissing.push('incomeBeforeTax');
  if (!finite(latest?.incomeTaxExpense) || latest.incomeTaxExpense < 0) dcfMissing.push('incomeTaxExpense');
  if (!finite(latest?.interestExpense) || latest.interestExpense < 0) dcfMissing.push('interestExpense');
  if (!finite(latest?.cash) || latest.cash < 0) dcfMissing.push('cash');
  if (!finite(latest?.totalDebt) || latest.totalDebt < 0) dcfMissing.push('totalDebt');
  if (!shares) dcfMissing.push('dilutedSharesOrSharesOutstanding');

  let growth: DcfGrowthRates | null = null;
  let taxRate: number | null = null;
  let costDebt: number | null = null;
  let wacc: ReturnType<typeof calculateDeterministicWacc> | null = null;
  let dcf: ReturnType<typeof calculateDeterministicDcf> | null = null;
  if (!dcfMissing.length && latest) {
    try {
      growth = annualGrowthRates(latest.revenue, latest.periodEnd, futureEstimates);
    } catch {
      try {
        growth = historicalGrowthRates(input.periods);
      } catch {
        dcfMissing.push('forwardRevenueEstimatesOrHistoricalRevenueGrowth');
      }
    }
  }
  if (!dcfMissing.length && growth && latest) {
    taxRate = latest.incomeTaxExpense! / latest.incomeBeforeTax!;
    costDebt = latest.totalDebt === 0 ? 0 : Math.abs(latest.interestExpense) / latest.totalDebt;
    try {
      wacc = calculateDeterministicWacc({
        riskFreeRate: marketWacc!.riskFreeRate!,
        beta: marketWacc!.beta!,
        equityRiskPremium: marketWacc!.equityRiskPremium!,
        costDebt,
        taxRate,
        equityValue: input.marketCapitalization!,
        debt: latest.totalDebt,
      });
      if (!(wacc.wacc > PERPETUAL_GROWTH)) throw new RangeError('WACC must exceed perpetual growth');
      dcf = calculateDeterministicDcf({
        latestFreeCashFlow: latest.freeCashFlow,
        growthRates: growth.rates,
        cash: latest.cash,
        debt: latest.totalDebt,
        shares: shares!,
        wacc: wacc.wacc,
        perpetualGrowth: PERPETUAL_GROWTH,
      });
    } catch {
      dcfMissing.push('validWaccAndDcfCalculation');
      wacc = null;
      dcf = null;
    }
  }

  const multiplesMissing: string[] = [];
  if (!targetEstimate) multiplesMissing.push('targetForwardEstimate');
  const positiveTargetEps = positive(targetEstimate?.estimatedEps);
  const peerCountForBranch = (branch: 'pe' | 'ev-sales'): number => {
    if (!targetEstimate) return 0;
    const seen = new Set<string>();
    const normalizedSector = input.sector.trim().toLowerCase();
    const normalizedIndustry = input.industry.trim().toLowerCase();
    return (input.peerObservations ?? []).filter((peer) => {
      const peerSymbol = peer.symbol.trim().toUpperCase();
      const relevant = Boolean(
        normalizedIndustry && peer.industry?.trim().toLowerCase() === normalizedIndustry,
      ) || Boolean(
        normalizedSector && peer.sector?.trim().toLowerCase() === normalizedSector,
      );
      const branchInputsValid = branch === 'pe'
        ? positive(peer.price)
          && positive(peer.forwardEps)
          && dateWithinAge(peer.priceAsOf, now, MAX_PEER_PRICE_AGE_MS)
        : positive(peer.enterpriseValue)
          && positive(peer.forwardRevenue)
          && dateWithinAge(
            peer.enterpriseValueAsOf,
            now,
            MAX_PEER_ENTERPRISE_VALUE_AGE_MS,
          );
      const valid = peerSymbol !== input.symbol.trim().toUpperCase()
        && !seen.has(peerSymbol)
        && relevant
        && (peer.currency == null || peer.currency === 'USD')
        && peer.estimatePeriod === targetEstimate.periodEnd
        && dateWithinAge(
          peer.estimateAsOf,
          now,
          peer.estimateProvenance?.sourceType === 'gemini-grounded'
            ? MAX_GROUNDED_ESTIMATE_AGE_MS : MAX_ESTIMATE_AGE_MS,
        )
        && branchInputsValid;
      if (valid) seen.add(peerSymbol);
      return valid;
    }).length;
  };
  const forwardPeMissing: string[] = [];
  if (!positive(targetEstimate?.estimatedEps)) forwardPeMissing.push('targetForwardEps');
  if (peerCountForBranch('pe') < MINIMUM_VALID_PEERS) {
    forwardPeMissing.push('validForwardPePeers>=4');
  }
  const forwardEvSalesMissing: string[] = [];
  if (!positive(targetEstimate?.estimatedRevenue)) {
    forwardEvSalesMissing.push('targetForwardRevenue');
  }
  if (peerCountForBranch('ev-sales') < MINIMUM_VALID_PEERS) {
    forwardEvSalesMissing.push('validForwardEvSalesPeers>=4');
  }
  if (!shares) forwardEvSalesMissing.push('dilutedSharesOrSharesOutstanding');
  if (!finite(bridgeCash) || bridgeCash < 0) forwardEvSalesMissing.push('cash');
  if (!finite(bridgeDebt) || bridgeDebt < 0) forwardEvSalesMissing.push('totalDebt');
  if (targetEstimate && !positiveTargetEps) {
    if (!shares) multiplesMissing.push('dilutedSharesOrSharesOutstanding');
    if (!finite(bridgeCash) || bridgeCash < 0) multiplesMissing.push('cash');
    if (!finite(bridgeDebt) || bridgeDebt < 0) multiplesMissing.push('totalDebt');
  }
  let multiples: ReturnType<typeof calculateForwardMultiples> | null = null;
  let currentPeers = [] as NonNullable<ValuationInput['peerObservations']>;
  if (!multiplesMissing.length && targetEstimate) {
    const seen = new Set<string>();
    const normalizedSector = input.sector.trim().toLowerCase();
    const normalizedIndustry = input.industry.trim().toLowerCase();
    currentPeers = (input.peerObservations ?? []).filter((peer) => {
      const peerSymbol = peer.symbol.trim().toUpperCase();
      const relevant = Boolean(
        normalizedIndustry && peer.industry?.trim().toLowerCase() === normalizedIndustry,
      ) || Boolean(
        normalizedSector && peer.sector?.trim().toLowerCase() === normalizedSector,
      );
      const valid = peerSymbol !== input.symbol.trim().toUpperCase()
      && !seen.has(peerSymbol)
      && relevant
      && (peer.currency == null || peer.currency === 'USD')
      && peer.estimatePeriod === targetEstimate.periodEnd
      && dateWithinAge(
        peer.estimateAsOf,
        now,
        peer.estimateProvenance?.sourceType === 'gemini-grounded'
          ? MAX_GROUNDED_ESTIMATE_AGE_MS : MAX_ESTIMATE_AGE_MS,
      )
      && (
        positiveTargetEps
          ? dateWithinAge(peer.priceAsOf, now, MAX_PEER_PRICE_AGE_MS)
          : dateWithinAge(peer.enterpriseValueAsOf, now, MAX_PEER_ENTERPRISE_VALUE_AGE_MS)
      );
      if (valid) seen.add(peerSymbol);
      return valid;
    });
    try {
      multiples = calculateForwardMultiples({
        targetForwardEps: targetEstimate.estimatedEps,
        targetForwardRevenue: targetEstimate.estimatedRevenue,
        cash: positiveTargetEps ? null : bridgeCash,
        debt: positiveTargetEps ? null : bridgeDebt,
        shares: positiveTargetEps ? null : shares,
        peers: currentPeers.map((peer) => ({
          symbol: peer.symbol,
          price: peer.price,
          forwardEps: peer.forwardEps,
          enterpriseValue: peer.enterpriseValue,
          forwardRevenue: peer.forwardRevenue,
        })),
        minimumPeers: MINIMUM_VALID_PEERS,
      });
    } catch {
      multiplesMissing.push('validForwardPeers>=4');
      multiples = null;
    }
  }

  if (!dcf && !multiples) {
    return unavailable(
      input,
      calculatedAt,
      unique([...dcfMissing, ...multiplesMissing]),
      {
        dcf: dcfMissing,
        multiples: multiplesMissing,
        forwardPe: forwardPeMissing,
        forwardEvSales: forwardEvSalesMissing,
      },
    );
  }

  const modelResults: Array<ModelResult & { weight: number }> = [];
  if (dcf && growth && wacc && latest) {
    modelResults.push({
      model: 'fcff-dcf',
      fairValue: dcf.fairValue,
      weight: DCF_WEIGHT,
      configuredWeight: DCF_WEIGHT,
      normalizedWeight: DCF_WEIGHT,
      methodology: growth.method === 'consensus-revenue-growth-proxy'
        ? 'Five-year FCFF DCF from latest reported FCF and provider-derived consensus revenue growth; Gordon terminal value.'
        : 'Five-year FCFF DCF from latest reported FCF and verified historical revenue CAGR; Gordon terminal value.',
      inputs: {
        latestFreeCashFlow: latest.freeCashFlow,
        growthRates: growth.rates.join(','),
        growthMethod: growth.method,
        estimateMode: growth.estimateMode,
        forecastFreeCashFlows: dcf.forecastFreeCashFlows.join(','),
        presentValueFreeCashFlows: dcf.presentValueFreeCashFlows,
        terminalValue: dcf.terminalValue,
        presentValueTerminalValue: dcf.presentValueTerminalValue,
        enterpriseValue: dcf.enterpriseValue,
        cash: latest.cash,
        debt: latest.totalDebt,
        equityValue: dcf.equityValue,
        shares: shares!,
      },
      assumptions: {
        perpetualGrowth: PERPETUAL_GROWTH,
        wacc: wacc.wacc,
      },
      limitations: [
        `DCF is sensitive to ${
          growth.method === 'consensus-revenue-growth-proxy'
            ? 'provider consensus' : 'historically derived'
        } growth and WACC inputs.`,
        growth.method === 'consensus-revenue-growth-proxy'
          ? 'Consensus revenue growth is explicitly used as an FCF growth proxy; it is not FCF consensus.'
          : 'Historical revenue CAGR is explicitly used as an FCF growth proxy and is bounded by the existing verified-history DCF growth contract.',
      ],
    });
  }
  if (multiples && targetEstimate) {
    modelResults.push({
      model: multiples.method === 'forward-pe' ? 'pe' : 'ev-sales',
      fairValue: multiples.fairValue,
      weight: MULTIPLES_WEIGHT,
      configuredWeight: MULTIPLES_WEIGHT,
      normalizedWeight: MULTIPLES_WEIGHT,
      methodology: multiples.method === 'forward-pe'
        ? 'Target forward EPS × median valid peer forward P/E.'
        : 'Target forward revenue × median valid peer forward EV/Sales, then EV-to-equity bridge.',
      inputs: {
        targetForwardEps: targetEstimate.estimatedEps ?? 'not-provided',
        targetForwardRevenue: targetEstimate.estimatedRevenue ?? 'not-provided',
        estimatePeriod: targetEstimate.periodEnd,
        peers: multiples.peers.map((peer) => peer.symbol).join(','),
        peerMultiples: multiples.peers.map((peer) => `${peer.symbol}:${peer.multiple}`).join(','),
        medianMultiple: multiples.medianMultiple,
        targetEnterpriseValue: multiples.targetEnterpriseValue ?? 'not-applicable',
        targetEquityValue: multiples.targetEquityValue ?? 'not-applicable',
        shares: multiples.method === 'forward-pe' ? 'not-required' : shares!,
      },
      assumptions: {},
      limitations: ['Only positive, finite multiples with current forward estimates are retained.'],
    });
  }

  const groundedCritical = [
    ...(growth?.estimates ?? []).flatMap((estimate) => [
      estimate.revenueProvenance?.sourceType,
      estimate.epsProvenance?.sourceType,
    ]),
    targetEstimate?.revenueProvenance?.sourceType,
    targetEstimate?.epsProvenance?.sourceType,
    ...currentPeers.map((peer) => peer.estimateProvenance?.sourceType),
    marketWacc?.betaProvenance?.sourceType,
    marketWacc?.riskFreeRateProvenance?.sourceType,
    marketWacc?.equityRiskPremiumProvenance?.sourceType,
    input.marketCapitalizationProvenance?.sourceType,
    input.sharesOutstandingProvenance?.sourceType,
  ].includes('gemini-grounded');
  const stale = gate.staleInputs.length > 0
    || input.providerStatus === 'stale'
    || [
      datasetFreshness('beta', marketWacc?.betaAsOf, now),
      datasetFreshness('riskFreeRate', marketWacc?.riskFreeAsOf, now),
      datasetFreshness('equityRiskPremium', marketWacc?.equityRiskPremiumAsOf, now),
    ].includes('stale');
  const completeModels = Boolean(dcf && multiples);
  const quality = valuationQuality({
    completeModels,
    dcfAvailable: Boolean(dcf),
    multiplesAvailable: Boolean(multiples),
    estimateMode: growth?.estimateMode ?? null,
    targetEstimateAvailable: Boolean(targetEstimate),
    peerCount: multiples?.peers.length ?? 0,
    stale,
    providerStatus: input.providerStatus,
    provenances: [
      ...(growth?.estimates ?? []).map((estimate) => estimate.revenueProvenance),
      positive(targetEstimate?.estimatedEps)
        ? targetEstimate?.epsProvenance : targetEstimate?.revenueProvenance,
      ...currentPeers.map((peer) => peer.estimateProvenance),
      marketWacc?.betaProvenance,
      marketWacc?.riskFreeRateProvenance,
      marketWacc?.equityRiskPremiumProvenance,
      input.marketCapitalizationProvenance,
      input.sharesOutstandingProvenance,
    ],
  });
  const dataQualityLabel = quality.label;
  const qualityScore = quality.score;
  const baseAvailable = completeModels;
  if (!baseAvailable) {
    for (const model of modelResults) delete model.normalizedWeight;
  }
  const centralEstimate = baseAvailable
    ? dcf!.fairValue * DCF_WEIGHT + multiples!.fairValue * MULTIPLES_WEIGHT
    : null;
  const dispersion = centralEstimate
    ? Math.sqrt(
        DCF_WEIGHT * ((dcf!.fairValue - centralEstimate) ** 2)
        + MULTIPLES_WEIGHT * ((multiples!.fairValue - centralEstimate) ** 2),
      ) / centralEstimate
    : null;
  if (centralEstimate !== null && (!positive(centralEstimate) || !finite(dispersion))) {
    return unavailable(input, calculatedAt, ['finiteCombinedFairValue']);
  }
  const publishableValue = centralEstimate ?? dcf?.fairValue ?? multiples?.fairValue ?? null;
  if (!positive(publishableValue)) {
    return unavailable(input, calculatedAt, ['finitePublishableFairValue']);
  }
  const fairValueType = baseAvailable ? 'base' as const
    : dcf ? 'dcf' as const : 'relative' as const;
  const confidence = quality.confidence;
  const lowerModel = baseAvailable ? Math.min(dcf!.fairValue, multiples!.fairValue) : null;
  const upperModel = baseAvailable ? Math.max(dcf!.fairValue, multiples!.fairValue) : null;
  const modelReliability = {
    level: confidence === 'High' ? 'High' as const
      : confidence === 'Medium' ? 'Moderate' as const : 'Low' as const,
    score: qualityScore,
    components: quality.components,
    explanation: 'Data Quality measures input coverage and traceability, not the probability of an investment return.',
  };
  const classification = classifyCompany(input.sector, input.industry, input.periods);
  const estimateProvider = targetEstimate?.provider
    ?? growth?.estimates.at(0)?.provider
    ?? input.source;
  const peerProvider = currentPeers.at(0)?.provider ?? estimateProvider;
  const sharesSource = dilutedShares
    ? input.dilutedSharesSource === 'shares-outstanding-fallback'
      ? 'Shares Outstanding (financial-statement fallback)'
      : 'Diluted Shares Outstanding'
    : 'Shares Outstanding (provider fallback)';
  const sharesAsOf = dilutedShares
    ? latest?.periodEnd ?? calculatedAt
    : input.sharesOutstandingAsOf ?? bridge?.asOf ?? calculatedAt;
  const inputDetails: ValuationInputDisclosure[] = [
    inputDetail({ field: 'Current Price', value: input.marketPrice, currency: 'USD', period: input.priceAsOf, provider: input.marketPriceSource ?? input.source, asOf: input.priceAsOf }),
  ];
  if (dcf && growth && wacc && latest && taxRate !== null && costDebt !== null) {
    inputDetails.push(
      inputDetail({ field: 'Latest Real FCF', value: latest.freeCashFlow, currency: 'USD', period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd }),
      ...growth.estimates.map((estimate) => inputDetail({
      field: `Consensus Revenue ${estimate.periodEnd}`,
      value: estimate.estimatedRevenue!,
      currency: 'USD',
      period: estimate.periodEnd,
      provider: estimate.provider,
      asOf: estimate.asOf,
      sourceType: estimate.revenueProvenance?.sourceType ?? 'structured-provider',
      sourceUrl: estimate.revenueProvenance?.sourceUrl,
      evidence: estimate.revenueProvenance?.evidence,
      status: estimate.revenueProvenance?.sourceType === 'gemini-grounded' ? 'limited' : 'available',
    })),
      ...growth.historicalPeriods.map((period) => inputDetail({
        field: `Historical Revenue ${period.periodEnd}`,
        value: period.revenue,
        currency: 'USD',
        period: period.periodEnd,
        provider: input.source,
        asOf: period.periodEnd,
      })),
      inputDetail({
        field: growth.method === 'consensus-revenue-growth-proxy'
          ? 'Consensus Growth Rates' : 'Historical Revenue CAGR',
        value: growth.rates.join(','),
        period: growth.method,
        provider: growth.method === 'consensus-revenue-growth-proxy'
          ? estimateProvider : input.source,
        asOf: growth.estimates.at(-1)?.asOf
          ?? growth.historicalPeriods.at(-1)?.periodEnd
          ?? calculatedAt,
        origin: 'derived',
      }),
    inputDetail({
      field: 'Risk-free Rate',
      value: marketWacc!.riskFreeRate!,
      period: marketWacc!.riskFreeRateProvenance?.fiscalPeriod ?? '10Y Treasury',
      asOf: marketWacc!.riskFreeAsOf ?? calculatedAt,
      ...provenanceDisclosure(marketWacc!.riskFreeRateProvenance, marketWacc!.provider),
    }),
    inputDetail({
      field: 'Beta',
      value: marketWacc!.beta!,
      period: marketWacc!.betaProvenance?.fiscalPeriod ?? 'latest profile',
      asOf: marketWacc!.betaAsOf ?? calculatedAt,
      ...provenanceDisclosure(marketWacc!.betaProvenance, marketWacc!.provider),
    }),
    inputDetail({
      field: 'Equity Risk Premium',
      value: marketWacc!.equityRiskPremium!,
      period: marketWacc!.equityRiskPremiumProvenance?.fiscalPeriod ?? 'United States',
      asOf: marketWacc!.equityRiskPremiumAsOf ?? calculatedAt,
      ...provenanceDisclosure(
        marketWacc!.equityRiskPremiumProvenance,
        marketWacc!.provider,
      ),
    }),
    inputDetail({ field: 'Cost of Debt', value: costDebt, period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd, origin: 'derived' }),
    inputDetail({ field: 'Tax Rate', value: taxRate, period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd, origin: 'derived' }),
    inputDetail({ field: 'WACC', value: wacc.wacc, period: 'current capital structure', provider: `${marketWacc!.provider}+${input.source}`, asOf: calculatedAt, origin: 'derived' }),
    inputDetail({
      field: 'Market Capitalization',
      value: input.marketCapitalization!,
      currency: 'USD',
      period: input.marketCapitalizationProvenance?.fiscalPeriod ?? input.priceAsOf,
      asOf: input.marketCapitalizationProvenance?.asOf ?? input.priceAsOf,
      ...provenanceDisclosure(input.marketCapitalizationProvenance, input.marketPriceSource ?? input.source),
    }),
    inputDetail({ field: 'Cash', value: latest.cash, currency: 'USD', period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd }),
    inputDetail({ field: 'Total Debt', value: latest.totalDebt, currency: 'USD', period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd }),
    inputDetail({
      field: sharesSource,
      value: shares!,
      period: sharesAsOf,
      asOf: sharesAsOf,
      ...provenanceDisclosure(
        dilutedShares ? null : input.sharesOutstandingProvenance,
        dilutedShares ? input.source : estimateProvider,
      ),
    }),
    );
  }
  if (multiples && targetEstimate) {
    const targetProvenance = positive(targetEstimate.estimatedEps)
      ? targetEstimate.epsProvenance : targetEstimate.revenueProvenance;
    const peerEvidence = currentPeers.flatMap((peer) =>
      peer.estimateProvenance?.evidence ?? []);
    inputDetails.push(
      inputDetail({
        field: positive(targetEstimate.estimatedEps) ? 'Target Forward EPS' : 'Target Forward Revenue',
        value: positive(targetEstimate.estimatedEps)
          ? targetEstimate.estimatedEps : targetEstimate.estimatedRevenue!,
        currency: 'USD',
        period: targetEstimate.periodEnd,
        provider: targetEstimate.provider,
        asOf: targetEstimate.asOf,
        sourceType: targetProvenance?.sourceType ?? 'structured-provider',
        sourceUrl: targetProvenance?.sourceUrl,
        evidence: targetProvenance?.evidence,
        status: targetProvenance?.sourceType === 'gemini-grounded' ? 'limited' : 'available',
      }),
      inputDetail({ field: 'Peer List', value: multiples.peers.map((peer) => peer.symbol).join(','), period: targetEstimate.periodEnd, provider: peerProvider, asOf: targetEstimate.asOf, sourceType: groundedCritical ? 'gemini-grounded' : 'structured-provider', evidence: peerEvidence, status: groundedCritical ? 'limited' : 'available' }),
    inputDetail({ field: 'Peer Multiples', value: multiples.peers.map((peer) => `${peer.symbol}:${peer.multiple}`).join(','), period: multiples.method, provider: peerProvider, asOf: targetEstimate!.asOf, origin: 'derived' }),
    inputDetail({ field: 'Median Peer Multiple', value: multiples.medianMultiple, period: multiples.method, provider: peerProvider, asOf: targetEstimate!.asOf, origin: 'derived' }),
    );
    if (multiples.method === 'forward-ev-sales') {
      inputDetails.push(
        inputDetail({
          field: sharesSource,
          value: shares!,
          period: sharesAsOf,
          asOf: sharesAsOf,
          ...provenanceDisclosure(
            dilutedShares ? null : input.sharesOutstandingProvenance,
            dilutedShares ? input.source : estimateProvider,
          ),
        }),
        inputDetail({
          field: 'Cash',
          value: bridgeCash!,
          currency: 'USD',
          period: latest?.periodEnd ?? bridge!.asOf,
          provider: latest ? input.source : bridge!.provider,
          asOf: latest?.periodEnd ?? bridge!.asOf,
        }),
        inputDetail({
          field: 'Total Debt',
          value: bridgeDebt!,
          currency: 'USD',
          period: latest?.periodEnd ?? bridge!.asOf,
          provider: latest ? input.source : bridge!.provider,
          asOf: latest?.periodEnd ?? bridge!.asOf,
        }),
      );
    }
  }
  const upsideAmount = publishableValue - input.marketPrice;
  const upsidePercent = upsideAmount / input.marketPrice * 100;
  const dataStatus = gate.staleInputs.length || input.providerStatus === 'stale'
    ? 'stale' as const
    : input.providerStatus === 'cached'
      ? 'cached' as const
      : input.providerStatus === 'limited'
        ? 'limited' as const
        : input.providerStatus === 'delayed' ? 'delayed' as const : 'live' as const;
  const latestDataAt = [
    input.priceAsOf,
    latest?.periodEnd ?? '',
    targetEstimate?.asOf ?? '',
    growth?.estimates.at(-1)?.asOf ?? '',
    marketWacc?.riskFreeAsOf ?? '',
  ].filter(Boolean).toSorted().at(-1)!;
  const excludedModels = [
    ...(!dcf ? [{ model: 'fcff-dcf' as const, reason: unique(dcfMissing).join(', ') }] : []),
    ...(!multiples ? [{
      model: !positive(targetEstimate?.estimatedEps)
        ? 'ev-sales' as const : 'pe' as const,
      reason: unique(multiplesMissing).join(', '),
    }] : []),
  ];
  const diagnostics: ValuationDiagnostic[] = [
    ...(input.diagnostics ?? []),
    {
      field: 'model:fcff-dcf',
      value: dcf?.fairValue ?? null,
      period: latest?.periodEnd ?? null,
      provider: input.source,
      asOf: calculatedAt,
      status: dcf ? 'available' : 'rejected',
      provenance: 'validation',
      reason: dcf ? null : unique(dcfMissing).join(', '),
    },
    {
      field: 'model:forward-multiples',
      value: multiples?.fairValue ?? null,
      period: targetEstimate?.periodEnd ?? null,
      provider: peerProvider,
      asOf: targetEstimate?.asOf ?? calculatedAt,
      status: multiples ? 'available' : 'rejected',
      provenance: 'validation',
      reason: multiples ? null : unique(multiplesMissing).join(', '),
    },
  ];
  const acceptedPeerSymbols = new Set(multiples?.peers.map((peer) => peer.symbol) ?? []);
  const peerQualityAudit = {
    candidates: input.peerAudit?.candidates
      ?? (input.peerObservations ?? []).map((peer) => peer.symbol),
    accepted: (multiples?.peers ?? []).map((peer) => {
      const observation = currentPeers.find((item) => item.symbol === peer.symbol);
      return {
        symbol: peer.symbol,
        metric: multiples!.method,
        period: observation?.estimatePeriod ?? targetEstimate?.periodEnd ?? calculatedAt.slice(0, 10),
        source: observation?.provider ?? peerProvider,
        asOf: observation?.estimateAsOf ?? targetEstimate?.asOf ?? calculatedAt,
      };
    }),
    rejected: [
      ...(input.peerAudit?.rejected ?? []),
      ...(input.peerObservations ?? [])
        .filter((peer) => !acceptedPeerSymbols.has(peer.symbol))
        .map((peer) => ({
          symbol: peer.symbol,
          reason: 'engine-quality-gate-or-outlier',
          metric: positiveTargetEps ? 'forward-pe' as const : 'forward-ev-sales' as const,
          period: peer.estimatePeriod,
          source: peer.provider,
          asOf: peer.estimateAsOf,
        })),
    ],
  };

  return {
    status: 'available',
    symbol: input.symbol,
    currency: 'USD',
    marketPrice: {
      value: input.marketPrice,
      asOf: input.priceAsOf,
      source: input.marketPriceSource ?? input.source,
      sourceType: input.sourceType,
    },
    fairValue: {
      type: fairValueType,
      label: fairValueType === 'base'
        ? 'Base Fair Value'
        : fairValueType === 'dcf' ? 'DCF Fair Value' : 'Relative Fair Value',
      value: publishableValue,
      confidence,
    },
    companyClassification: {
      ...classification,
      eligibleModels: modelResults.map((model) => model.model),
      excludedModels,
      evidence: [
        ...classification.evidence,
        'Individual validated models may be shown, but Base Fair Value requires both DCF and Forward Multiples.',
      ],
    },
    modelResults,
    excludedModels,
    fundamentalFairValue: {
      conservative: { low: lowerModel, high: lowerModel },
      base: { low: centralEstimate, high: centralEstimate },
      optimistic: { low: upperModel, high: upperModel },
      centralEstimate,
      dispersion,
    },
    baseStatus: baseAvailable ? 'available' : 'unavailable',
    technicalContext: {
      status: 'unavailable',
      reason: 'Technical indicators are intentionally excluded from Fair Value.',
    },
    fundamentalQuality: {
      score: qualityScore,
      categories: [],
      limitation: 'Quality reflects provider coverage and traceability only.',
    },
    dataQuality: {
      score: qualityScore,
      completeness: qualityScore,
      freshness: dataStatus === 'stale' ? 35 : dataStatus === 'cached' ? 75 : 100,
      periodConsistency: 100,
      currencyConsistency: 100,
    },
    modelReliability,
    dataQualityLabel,
    reliabilityReasons: [
      growth?.method === 'historical-revenue-cagr-proxy'
        ? `${growth.historicalPeriods.length} reported revenue periods support the historical DCF growth proxy.`
        : `${growth?.estimates.length ?? 0} consensus revenue estimate period(s) support DCF growth.`,
      `${multiples?.peers.length ?? 0} peers passed finite-positive and outlier gates.`,
      `Shares basis: ${sharesSource}.`,
      baseAvailable
        ? 'Both DCF and Forward Multiples passed validation before Base Fair Value was published.'
        : `${dcf ? 'DCF' : 'Forward Multiples'} is the only model that passed validation; no Base or blended value was created.`,
      ...(groundedCritical
        ? ['Validated Gemini-grounded evidence was used; Data Quality is capped at Medium.']
        : []),
    ],
    missingInputs: unique([
      ...(!dcf ? dcfMissing : []),
      ...(!multiples ? multiplesMissing : []),
    ]),
    dataStatus,
    selectedModel: baseAvailable ? 'blended' : modelResults[0].model,
    upsideAmount,
    upsidePercent,
    sector: input.sector,
    industry: input.industry,
    sectorRuleId: 'deterministic-dcf-forward-multiples',
    sectorRuleVersion: SECTOR_RULE_VERSION,
    inputDetails,
    diagnostics,
    assumptionDetails: [
      { field: 'Perpetual Growth', value: PERPETUAL_GROWTH, source: 'model-assumption', ruleVersion: SECTOR_RULE_VERSION },
      { field: 'DCF Weight', value: DCF_WEIGHT, source: 'model-assumption', ruleVersion: SECTOR_RULE_VERSION },
      { field: 'Forward Multiples Weight', value: MULTIPLES_WEIGHT, source: 'model-assumption', ruleVersion: SECTOR_RULE_VERSION },
    ],
    displayFx: input.displayFx ?? null,
    inputs: {
      latestPeriod: latest,
      analystEstimates: input.analystEstimates,
      peerObservations: input.peerObservations,
      waccMarketInputs: input.waccMarketInputs,
      betaAudit: input.betaAudit ?? null,
      peerAudit: peerQualityAudit,
    },
    assumptions: {
      perpetualGrowth: PERPETUAL_GROWTH,
      weights: { dcf: DCF_WEIGHT, forwardMultiples: MULTIPLES_WEIGHT },
    },
    sources: [
      ...(latest
        ? [{ name: input.source, asOf: latest.periodEnd, sourceType: input.sourceType }]
        : []),
      { name: estimateProvider, asOf: targetEstimate?.asOf ?? calculatedAt, sourceType: 'provider-supplied' },
    ],
    researchAudit: input.researchAudit,
    peerAudit: peerQualityAudit,
    inputResolution: input.inputResolution,
    latestDataAt,
    calculatedAt,
    methodologyVersion: METHODOLOGY_VERSION,
    limitations: [
      'Fair Value is a deterministic model output, not a market quote or investment recommendation.',
      'USD is the calculation source of truth.',
      'No unavailable model is reweighted and no missing input receives a numeric fallback.',
      ...(baseAvailable ? [] : [
        `${fairValueType === 'dcf' ? 'DCF Fair Value' : 'Relative Fair Value'} is a standalone validated model result, not Base or Blended Fair Value.`,
      ]),
    ],
  };
}
