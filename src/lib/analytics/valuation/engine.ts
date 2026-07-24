import { classifyCompany } from './classification';
import {
  calculateDeterministicDcf,
  calculateDeterministicWacc,
  calculateForwardMultiples,
} from './formulas';
import { createFairValueUnavailable } from './result';
import {
  METHODOLOGY_VERSION,
  SECTOR_RULE_VERSION,
  type AnalystEstimate,
  type FairValueResult,
  type FinancialPeriod,
  type ModelResult,
  type ValuationInput,
  type ValuationInputDisclosure,
} from './types';

const PERPETUAL_GROWTH = 0.025;
const DCF_WEIGHT = 0.6;
const MULTIPLES_WEIGHT = 0.4;
const MINIMUM_VALID_PEERS = 4;
const MAX_ESTIMATE_AGE_MS = 7 * 86_400_000;
const MAX_GROUNDED_ESTIMATE_AGE_MS = 180 * 86_400_000;
const MAX_PEER_PRICE_AGE_MS = 7 * 86_400_000;
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

function unavailable(input: ValuationInput, calculatedAt: string, missingFields: string[]): FairValueResult {
  const fields = unique(missingFields);
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
  if (!input.analystEstimates?.length) missingInputs.push('forwardEstimates');
  if (!input.waccMarketInputs) missingInputs.push('waccMarketInputs');
  if (!input.peerObservations?.length) missingInputs.push('peerObservations');
  if (input.priceAsOf && now - Date.parse(input.priceAsOf) > 7 * 86_400_000) {
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

function validFutureEstimates(
  estimates: AnalystEstimate[],
  actualPeriodEnd: string,
  now: number,
): AnalystEstimate[] {
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
      return estimate.periodEnd > actualPeriodEnd
        && fresh
        && (estimate.currency === undefined || estimate.currency === 'USD')
        && (revenueAvailable || epsAvailable);
    })
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
}

function annualGrowthRates(
  latestRevenue: number,
  latestPeriodEnd: string,
  estimates: AnalystEstimate[],
): {
  rates: number[];
  method: 'consensus-revenue-growth-proxy';
  estimateMode: 'annual-series' | 'consensus-cagr';
  estimates: AnalystEstimate[];
} {
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
  return {
    field: input.field,
    value: input.value,
    currency: input.currency ?? null,
    period: input.period,
    provider: input.provider,
    asOf: input.asOf,
    status: input.status ?? 'available',
    origin: input.origin ?? 'provider',
    sourceType: input.sourceType ?? (input.origin === 'derived' ? 'derived' : 'structured-provider'),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.evidence ? {
      evidence: input.evidence,
      evidenceCount: input.evidence.length,
    } : {}),
  };
}

export function calculateFairValue(input: ValuationInput, now = Date.now()): FairValueResult {
  const calculatedAt = input.calculatedAt ?? new Date(now).toISOString();
  const gate = dataSufficiency(input, now);
  const structuralMissing = gate.missingInputs.filter((field) =>
    !['forwardEstimates', 'waccMarketInputs', 'peerObservations'].includes(field));
  if (structuralMissing.length) return unavailable(input, calculatedAt, structuralMissing);
  const latest = latestPeriod(input.periods);
  if (!latest) return unavailable(input, calculatedAt, ['historicalFinancials']);
  const futureEstimates = validFutureEstimates(input.analystEstimates ?? [], latest.periodEnd, now);
  const targetEstimate = futureEstimates.find((estimate) =>
    finite(estimate.estimatedEps)
    && (estimate.estimatedEps! > 0 || positive(estimate.estimatedRevenue))) ?? null;
  const marketWacc = input.waccMarketInputs;
  const dilutedShares = positive(latest.dilutedShares) ? latest.dilutedShares : null;
  const fallbackShares = positive(input.sharesOutstanding) ? input.sharesOutstanding : null;
  const shares = dilutedShares ?? fallbackShares;
  const dcfMissing: string[] = [];
  if (!positive(latest.freeCashFlow)) dcfMissing.push('latestRealFreeCashFlow');
  if (!positive(latest.revenue)) dcfMissing.push('latestRealRevenue');
  if (!positive(input.marketCapitalization)) dcfMissing.push('marketCapitalization');
  if (!marketWacc || !positive(marketWacc.beta)) dcfMissing.push('beta');
  if (!marketWacc || !positive(marketWacc.riskFreeRate)) dcfMissing.push('riskFreeRate');
  if (!marketWacc || !positive(marketWacc.equityRiskPremium)) dcfMissing.push('equityRiskPremium');
  if (!finite(latest.incomeBeforeTax) || latest.incomeBeforeTax <= 0) dcfMissing.push('incomeBeforeTax');
  if (!finite(latest.incomeTaxExpense) || latest.incomeTaxExpense < 0) dcfMissing.push('incomeTaxExpense');
  if (!finite(latest.interestExpense) || latest.interestExpense < 0) dcfMissing.push('interestExpense');
  if (!finite(latest.cash) || latest.cash < 0) dcfMissing.push('cash');
  if (!finite(latest.totalDebt) || latest.totalDebt < 0) dcfMissing.push('totalDebt');
  if (!shares) dcfMissing.push('dilutedSharesOrSharesOutstanding');

  let growth: ReturnType<typeof annualGrowthRates> | null = null;
  let taxRate: number | null = null;
  let costDebt: number | null = null;
  let wacc: ReturnType<typeof calculateDeterministicWacc> | null = null;
  let dcf: ReturnType<typeof calculateDeterministicDcf> | null = null;
  if (!dcfMissing.length) {
    try {
      growth = annualGrowthRates(latest.revenue, latest.periodEnd, futureEstimates);
    } catch {
      dcfMissing.push('forwardRevenueEstimates');
    }
  }
  if (!dcfMissing.length && growth) {
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
  if (!shares) multiplesMissing.push('dilutedSharesOrSharesOutstanding');
  if (!finite(latest.cash) || latest.cash < 0) multiplesMissing.push('cash');
  if (!finite(latest.totalDebt) || latest.totalDebt < 0) multiplesMissing.push('totalDebt');
  let multiples: ReturnType<typeof calculateForwardMultiples> | null = null;
  let currentPeers = [] as NonNullable<ValuationInput['peerObservations']>;
  if (!multiplesMissing.length && targetEstimate) {
    const positiveTargetEps = targetEstimate.estimatedEps! > 0;
    currentPeers = (input.peerObservations ?? []).filter((peer) =>
      peer.estimatePeriod !== null
      && peer.estimatePeriod > latest.periodEnd
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
      ));
    try {
      multiples = calculateForwardMultiples({
        targetForwardEps: targetEstimate.estimatedEps,
        targetForwardRevenue: targetEstimate.estimatedRevenue,
        cash: latest.cash,
        debt: latest.totalDebt,
        shares: shares!,
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
    return unavailable(input, calculatedAt, unique([...dcfMissing, ...multiplesMissing]));
  }

  const modelResults: Array<ModelResult & { weight: number }> = [];
  if (dcf && growth && wacc) {
    modelResults.push({
      model: 'fcff-dcf',
      fairValue: dcf.fairValue,
      weight: DCF_WEIGHT,
      configuredWeight: DCF_WEIGHT,
      normalizedWeight: DCF_WEIGHT,
      methodology: 'Five-year FCFF DCF from latest reported FCF and provider-derived consensus revenue growth; Gordon terminal value.',
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
        'DCF is sensitive to provider consensus growth and WACC inputs.',
        'Consensus revenue growth is explicitly used as an FCF growth proxy; it is not FCF consensus.',
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
        targetForwardEps: targetEstimate!.estimatedEps!,
        targetForwardRevenue: targetEstimate!.estimatedRevenue!,
        estimatePeriod: targetEstimate!.periodEnd,
        peers: multiples.peers.map((peer) => peer.symbol).join(','),
        peerMultiples: multiples.peers.map((peer) => `${peer.symbol}:${peer.multiple}`).join(','),
        medianMultiple: multiples.medianMultiple,
        targetEnterpriseValue: multiples.targetEnterpriseValue ?? 'not-applicable',
        targetEquityValue: multiples.targetEquityValue ?? 'not-applicable',
        shares: shares!,
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
  ].includes('gemini-grounded');
  const stale = gate.staleInputs.length > 0 || input.providerStatus === 'stale';
  const completeModels = Boolean(dcf && multiples);
  const dataQualityLabel = stale ? 'Low' as const
    : groundedCritical || !completeModels ? 'Medium' as const : 'High' as const;
  const qualityScore = dataQualityLabel === 'High' ? 95
    : dataQualityLabel === 'Medium' ? (completeModels ? 82 : 74) : 55;
  const baseAvailable = completeModels && dataQualityLabel !== 'Low';
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
  const lowerModel = baseAvailable ? Math.min(dcf!.fairValue, multiples!.fairValue) : null;
  const upperModel = baseAvailable ? Math.max(dcf!.fairValue, multiples!.fairValue) : null;
  const estimateCoverage = growth
    ? growth.estimateMode === 'annual-series' ? 30 : 22
    : targetEstimate ? 16 : 0;
  const peerCoverage = multiples ? (multiples.peers.length >= 5 ? 30 : 24) : 0;
  const shareCoverage = dilutedShares ? 15 : 10;
  const modelReliability = {
    level: dataQualityLabel === 'High' ? 'High' as const
      : dataQualityLabel === 'Medium' ? 'Moderate' as const : 'Low' as const,
    score: qualityScore,
    components: {
      estimateCoverage,
      peerCoverage,
      waccTraceability: dcf ? 25 : 0,
      shareCoverage,
    },
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
  const sharesAsOf = dilutedShares ? latest.periodEnd : input.sharesOutstandingAsOf ?? latest.periodEnd;
  const inputDetails: ValuationInputDisclosure[] = [
    inputDetail({ field: 'Current Price', value: input.marketPrice, currency: 'USD', period: input.priceAsOf, provider: input.marketPriceSource ?? input.source, asOf: input.priceAsOf }),
  ];
  if (dcf && growth && wacc && taxRate !== null && costDebt !== null) {
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
      inputDetail({ field: 'Consensus Growth Rates', value: growth.rates.join(','), period: growth.method, provider: estimateProvider, asOf: growth.estimates.at(-1)?.asOf ?? calculatedAt, origin: 'derived' }),
    inputDetail({ field: 'Risk-free Rate', value: marketWacc!.riskFreeRate!, period: '10Y Treasury', provider: marketWacc!.provider, asOf: marketWacc!.riskFreeAsOf ?? calculatedAt }),
    inputDetail({ field: 'Beta', value: marketWacc!.beta!, period: 'latest profile', provider: marketWacc!.provider, asOf: marketWacc!.betaAsOf ?? calculatedAt }),
    inputDetail({ field: 'Equity Risk Premium', value: marketWacc!.equityRiskPremium!, period: 'United States', provider: marketWacc!.provider, asOf: marketWacc!.equityRiskPremiumAsOf ?? calculatedAt }),
    inputDetail({ field: 'Cost of Debt', value: costDebt, period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd, origin: 'derived' }),
    inputDetail({ field: 'Tax Rate', value: taxRate, period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd, origin: 'derived' }),
    inputDetail({ field: 'WACC', value: wacc.wacc, period: 'current capital structure', provider: `${marketWacc!.provider}+${input.source}`, asOf: calculatedAt, origin: 'derived' }),
    inputDetail({ field: 'Cash', value: latest.cash, currency: 'USD', period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd }),
    inputDetail({ field: 'Total Debt', value: latest.totalDebt, currency: 'USD', period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd }),
    inputDetail({ field: sharesSource, value: shares!, period: sharesAsOf, provider: dilutedShares ? input.source : estimateProvider, asOf: sharesAsOf }),
    );
  }
  if (multiples && targetEstimate) {
    const targetProvenance = targetEstimate.estimatedEps! > 0
      ? targetEstimate.epsProvenance : targetEstimate.revenueProvenance;
    const peerEvidence = currentPeers.flatMap((peer) =>
      peer.estimateProvenance?.evidence ?? []);
    inputDetails.push(
      inputDetail({
        field: targetEstimate.estimatedEps! > 0 ? 'Target Forward EPS' : 'Target Forward Revenue',
        value: targetEstimate.estimatedEps! > 0
          ? targetEstimate.estimatedEps! : targetEstimate.estimatedRevenue!,
        currency: 'USD',
        period: targetEstimate.periodEnd,
        provider: targetEstimate.provider,
        asOf: targetEstimate.asOf,
        sourceType: targetProvenance?.sourceType ?? 'structured-provider',
        sourceUrl: targetProvenance?.sourceUrl,
        evidence: targetProvenance?.evidence,
        status: targetProvenance?.sourceType === 'gemini-grounded' ? 'limited' : 'available',
      }),
      inputDetail({ field: sharesSource, value: shares!, period: sharesAsOf, provider: dilutedShares ? input.source : estimateProvider, asOf: sharesAsOf }),
      inputDetail({ field: 'Cash', value: latest.cash, currency: 'USD', period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd }),
      inputDetail({ field: 'Total Debt', value: latest.totalDebt, currency: 'USD', period: latest.periodEnd, provider: input.source, asOf: latest.periodEnd }),
      inputDetail({ field: 'Peer List', value: multiples.peers.map((peer) => peer.symbol).join(','), period: targetEstimate.periodEnd, provider: peerProvider, asOf: targetEstimate.asOf, sourceType: groundedCritical ? 'gemini-grounded' : 'structured-provider', evidence: peerEvidence, status: groundedCritical ? 'limited' : 'available' }),
    inputDetail({ field: 'Peer Multiples', value: multiples.peers.map((peer) => `${peer.symbol}:${peer.multiple}`).join(','), period: multiples.method, provider: peerProvider, asOf: targetEstimate!.asOf, origin: 'derived' }),
    inputDetail({ field: 'Median Peer Multiple', value: multiples.medianMultiple, period: multiples.method, provider: peerProvider, asOf: targetEstimate!.asOf, origin: 'derived' }),
    );
  }
  const upsideAmount = centralEstimate === null ? null : centralEstimate - input.marketPrice;
  const upsidePercent = upsideAmount === null ? null : upsideAmount / input.marketPrice * 100;
  const dataStatus = gate.staleInputs.length || input.providerStatus === 'stale'
    ? 'stale' as const
    : input.providerStatus === 'cached'
      ? 'cached' as const
      : input.providerStatus === 'limited'
        ? 'limited' as const
        : input.providerStatus === 'delayed' ? 'delayed' as const : 'live' as const;
  const latestDataAt = [
    input.priceAsOf,
    latest.periodEnd,
    targetEstimate?.asOf ?? '',
    growth?.estimates.at(-1)?.asOf ?? '',
    marketWacc?.riskFreeAsOf ?? '',
  ].filter(Boolean).toSorted().at(-1)!;
  const excludedModels = [
    ...(!dcf ? [{ model: 'fcff-dcf' as const, reason: unique(dcfMissing).join(', ') }] : []),
    ...(!multiples ? [{
      model: targetEstimate?.estimatedEps !== null && (targetEstimate?.estimatedEps ?? 0) <= 0
        ? 'ev-sales' as const : 'pe' as const,
      reason: unique(multiplesMissing).join(', '),
    }] : []),
  ];

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
      `${growth?.estimates.length ?? 0} consensus revenue estimate period(s) support DCF growth.`,
      `${multiples?.peers.length ?? 0} peers passed finite-positive and outlier gates.`,
      `Shares basis: ${sharesSource}.`,
      baseAvailable
        ? 'Both DCF and Forward Multiples passed validation before Base Fair Value was published.'
        : 'Base Fair Value is unavailable because both validated models and the minimum quality gate are required.',
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
      peerAudit: input.peerAudit,
    },
    assumptions: {
      perpetualGrowth: PERPETUAL_GROWTH,
      weights: { dcf: DCF_WEIGHT, forwardMultiples: MULTIPLES_WEIGHT },
    },
    sources: [
      { name: input.source, asOf: latest.periodEnd, sourceType: input.sourceType },
      { name: estimateProvider, asOf: targetEstimate?.asOf ?? calculatedAt, sourceType: 'provider-supplied' },
    ],
    researchAudit: input.researchAudit,
    latestDataAt,
    calculatedAt,
    methodologyVersion: METHODOLOGY_VERSION,
    limitations: [
      'Fair Value is a deterministic model output, not a market quote or investment recommendation.',
      'USD is the calculation source of truth.',
      'No unavailable model is reweighted and no missing input receives a numeric fallback.',
      ...(baseAvailable ? [] : ['Base Fair Value remains unavailable when only one model passes.']),
    ],
  };
}
