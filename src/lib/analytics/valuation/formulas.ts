import type { DcfAssumptions, ModelResult } from './types';

function assertFinite(values: Record<string, number>) { for (const [name, value] of Object.entries(values)) if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`); }
function positive(value: number, name: string) { if (!(value > 0)) throw new RangeError(`${name} must be greater than zero`); }
function assertOrderedScenario(values: { conservative: number; base: number; optimistic: number }) {
  assertFinite(values);
  if (!(values.conservative <= values.base && values.base <= values.optimistic)) throw new RangeError('Scenario values must satisfy conservative <= base <= optimistic');
}

export function normalizeCapitalExpenditure(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('capitalExpenditure must be finite');
  return Math.abs(value);
}

export function enterpriseMultipleValuation(input: {
  model: 'ev-sales' | 'ev-ebitda';
  metric: number;
  totalDebt: number;
  cash: number;
  dilutedShares: number;
  multiples: { conservative: number; base: number; optimistic: number };
}): ModelResult {
  assertFinite({ metric: input.metric, totalDebt: input.totalDebt, cash: input.cash, dilutedShares: input.dilutedShares, ...input.multiples });
  positive(input.metric, input.model === 'ev-sales' ? 'revenue' : 'ebitda');
  positive(input.dilutedShares, 'dilutedShares');
  if (input.totalDebt < 0 || input.cash < 0) throw new RangeError('Debt and cash must be non-negative');
  assertOrderedScenario(input.multiples);
  const value = (multiple: number) => (input.metric * multiple + input.cash - input.totalDebt) / input.dilutedShares;
  const scenarios = {
    conservative: value(input.multiples.conservative),
    base: value(input.multiples.base),
    optimistic: value(input.multiples.optimistic),
  };
  assertOrderedScenario(scenarios);
  if (Object.values(scenarios).some((result) => result <= 0)) throw new RangeError(`${input.model} produced a non-positive per-share value`);
  return {
    model: input.model,
    fairValue: scenarios.base,
    scenarios,
    methodology: `Enterprise value = ${input.model === 'ev-sales' ? 'Revenue' : 'EBITDA'} × target multiple; equity value = enterprise value + cash - debt`,
    inputs: { metric: input.metric, totalDebt: input.totalDebt, cash: input.cash, dilutedShares: input.dilutedShares },
    assumptions: { conservativeMultiple: input.multiples.conservative, baseMultiple: input.multiples.base, optimisticMultiple: input.multiples.optimistic, assumptionSource: 'nexora-sector-valuation-v1 model assumption' },
    limitations: ['Target multiples are versioned model assumptions, not provider observations or a fabricated peer average.'],
  };
}

export function priceMultipleValuation(input: {
  model: 'pe' | 'pb';
  metricPerShare: number;
  multiples: { conservative: number; base: number; optimistic: number };
}): ModelResult {
  assertFinite({ metricPerShare: input.metricPerShare, ...input.multiples });
  positive(input.metricPerShare, input.model === 'pe' ? 'eps' : 'bookValuePerShare');
  assertOrderedScenario(input.multiples);
  const scenarios = {
    conservative: input.metricPerShare * input.multiples.conservative,
    base: input.metricPerShare * input.multiples.base,
    optimistic: input.metricPerShare * input.multiples.optimistic,
  };
  assertOrderedScenario(scenarios);
  return {
    model: input.model,
    fairValue: scenarios.base,
    scenarios,
    methodology: `${input.model === 'pe' ? 'EPS' : 'Book value per share'} × target multiple`,
    inputs: { metricPerShare: input.metricPerShare },
    assumptions: { conservativeMultiple: input.multiples.conservative, baseMultiple: input.multiples.base, optimisticMultiple: input.multiples.optimistic, assumptionSource: 'nexora-sector-valuation-v1 model assumption' },
    limitations: ['Target multiples are versioned model assumptions and are disclosed separately from provider data.'],
  };
}

export function pegValuation(input: {
  eps: number;
  forwardGrowthDecimal: number;
  targetPeg: { conservative: number; base: number; optimistic: number };
}): ModelResult {
  assertFinite({ eps: input.eps, forwardGrowthDecimal: input.forwardGrowthDecimal, ...input.targetPeg });
  positive(input.eps, 'eps'); positive(input.forwardGrowthDecimal, 'forwardGrowthDecimal');
  assertOrderedScenario(input.targetPeg);
  const growthPercentPoints = input.forwardGrowthDecimal * 100;
  const value = (targetPeg: number) => input.eps * targetPeg * growthPercentPoints;
  const scenarios = { conservative: value(input.targetPeg.conservative), base: value(input.targetPeg.base), optimistic: value(input.targetPeg.optimistic) };
  assertOrderedScenario(scenarios);
  return {
    model: 'peg',
    fairValue: scenarios.base,
    scenarios,
    methodology: 'Target P/E = target PEG × forward EPS growth in percentage points; fair value = EPS × target P/E',
    inputs: { eps: input.eps, forwardGrowthDecimal: input.forwardGrowthDecimal, growthPercentPoints },
    assumptions: { conservativeTargetPeg: input.targetPeg.conservative, baseTargetPeg: input.targetPeg.base, optimisticTargetPeg: input.targetPeg.optimistic, growthUnit: 'decimal input converted once to percentage points' },
    limitations: ['PEG is used only when a real provider forward-growth estimate is present.'],
  };
}

export interface DcfInput { revenue: number; netDebt: number; dilutedShares: number; assumptions: DcfAssumptions; }
export function fcffDcf(input: DcfInput): ModelResult {
  const a = input.assumptions;
  assertFinite({ revenue: input.revenue, netDebt: input.netDebt, dilutedShares: input.dilutedShares, ...a });
  positive(input.revenue, 'revenue'); positive(input.dilutedShares, 'dilutedShares');
  if (!Number.isInteger(a.forecastHorizon) || a.forecastHorizon < 1 || a.forecastHorizon > 10) throw new RangeError('forecastHorizon must be an integer from 1 to 10');
  if (a.wacc <= a.terminalGrowth) throw new RangeError('WACC must be greater than terminal growth');
  if (a.wacc <= 0 || a.wacc > 0.5 || a.terminalGrowth < -0.1 || a.terminalGrowth > 0.1 || a.taxRate < 0 || a.taxRate > 0.6 || a.operatingMargin < -1 || a.operatingMargin > 1) throw new RangeError('DCF assumptions are outside supported bounds');
  let revenue = input.revenue; let pvFcff = 0; let finalFcff = 0;
  for (let year = 1; year <= a.forecastHorizon; year += 1) {
    revenue *= 1 + a.revenueGrowth;
    const nopat = revenue * a.operatingMargin * (1 - a.taxRate);
    finalFcff = nopat + revenue * a.depreciationPercentRevenue - revenue * a.capexPercentRevenue - revenue * a.workingCapitalPercentRevenue;
    pvFcff += finalFcff / ((1 + a.wacc) ** year);
  }
  const terminalValue = finalFcff * (1 + a.terminalGrowth) / (a.wacc - a.terminalGrowth);
  const enterpriseValue = pvFcff + terminalValue / ((1 + a.wacc) ** a.forecastHorizon);
  const shares = input.dilutedShares * ((1 + a.dilutionRate) ** a.forecastHorizon);
  const fairValue = (enterpriseValue - input.netDebt) / shares;
  if (!Number.isFinite(fairValue)) throw new RangeError('DCF result is not finite');
  return { model: 'fcff-dcf', fairValue, methodology: 'Forecast FCFF = NOPAT + D&A - CapEx - change in working capital; discount at WACC; Gordon terminal value', inputs: { revenue: input.revenue, netDebt: input.netDebt, dilutedShares: input.dilutedShares, pvFcff, terminalValue, enterpriseValue }, assumptions: { ...a }, limitations: ['Constant forecast growth and margin within each scenario', 'Terminal value can be highly sensitive to WACC and terminal growth'] };
}

export function fcfeValuation(input: { currentFcfe: number; costOfEquity: number; growth: number; dilutedShares: number }): ModelResult {
  assertFinite(input); positive(input.dilutedShares, 'dilutedShares');
  if (input.costOfEquity <= input.growth) throw new RangeError('Cost of equity must be greater than growth');
  const equityValue = input.currentFcfe * (1 + input.growth) / (input.costOfEquity - input.growth);
  return { model: 'fcfe', fairValue: equityValue / input.dilutedShares, methodology: 'Single-stage FCFE discounted at cost of equity', inputs: { currentFcfe: input.currentFcfe, dilutedShares: input.dilutedShares }, assumptions: { costOfEquity: input.costOfEquity, growth: input.growth }, limitations: ['Requires stable equity cash flow and financing policy'] };
}

export function dividendDiscount(input: { dividendPerShare: number; costOfEquity: number; growth: number }): ModelResult {
  assertFinite(input);
  if (input.dividendPerShare <= 0) throw new RangeError('Dividend history is required');
  if (input.costOfEquity <= input.growth) throw new RangeError('Cost of equity must be greater than growth');
  return { model: 'ddm', fairValue: input.dividendPerShare * (1 + input.growth) / (input.costOfEquity - input.growth), methodology: 'Gordon growth dividend discount model', inputs: { dividendPerShare: input.dividendPerShare }, assumptions: { costOfEquity: input.costOfEquity, growth: input.growth }, limitations: ['Applicable only to stable dividend policies'] };
}

export function median(values: readonly number[]): number { const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b); if (!sorted.length) throw new RangeError('At least one finite value is required'); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
export function relativeValuation(input: { metricPerShare: number; peerMultiples: Array<{ symbol: string; multiple: number }>; outlierIqrFactor?: number }): ModelResult {
  assertFinite({ metricPerShare: input.metricPerShare });
  const clean = input.peerMultiples.filter((peer) => Number.isFinite(peer.multiple) && peer.multiple > 0);
  if (clean.length < 3) throw new RangeError('At least three valid peers are required');
  const initialMedian = median(clean.map((peer) => peer.multiple));
  const extremeFiltered = clean.filter((peer) => peer.multiple >= initialMedian / 5 && peer.multiple <= initialMedian * 5);
  const sorted = extremeFiltered.map((peer) => peer.multiple).toSorted((a, b) => a - b); const q1 = median(sorted.slice(0, Math.floor(sorted.length / 2))); const q3 = median(sorted.slice(Math.ceil(sorted.length / 2))); const factor = input.outlierIqrFactor ?? 1.5; const iqr = q3 - q1;
  const retained = extremeFiltered.filter((peer) => peer.multiple >= q1 - factor * iqr && peer.multiple <= q3 + factor * iqr); const baseline = median(retained.map((peer) => peer.multiple));
  return { model: 'relative', fairValue: input.metricPerShare * baseline, methodology: 'Median peer multiple after transparent extreme-ratio guard and IQR outlier filtering', inputs: { metricPerShare: input.metricPerShare, peerCount: clean.length, retainedPeerCount: retained.length, peers: retained.map((peer) => peer.symbol).join(',') }, assumptions: { medianMultiple: baseline, extremeRatioLimit: 5, outlierIqrFactor: factor }, limitations: ['Peer comparability and market pricing affect the result'] };
}

export function assetBasedValuation(input: { totalAssets: number; totalLiabilities: number; dilutedShares: number; adjustment: number }): ModelResult {
  assertFinite(input); positive(input.dilutedShares, 'dilutedShares');
  return { model: 'asset-based', fairValue: (input.totalAssets * input.adjustment - input.totalLiabilities) / input.dilutedShares, methodology: 'Adjusted net asset value / diluted shares', inputs: { totalAssets: input.totalAssets, totalLiabilities: input.totalLiabilities, dilutedShares: input.dilutedShares }, assumptions: { assetAdjustment: input.adjustment }, limitations: ['Book values may not equal realizable values'] };
}

export function compositeValuation(models: readonly ModelResult[], rawWeights: Record<string, number>) {
  const weighted = models.map((model) => ({ ...model, rawWeight: rawWeights[model.model] ?? 0 })).filter((model) => Number.isFinite(model.fairValue) && Number.isFinite(model.rawWeight) && model.rawWeight > 0);
  const total = weighted.reduce((sum, model) => sum + model.rawWeight, 0); if (!total) throw new RangeError('At least one validated model weight is required');
  const normalized = weighted.map(({ rawWeight, ...model }) => ({ ...model, configuredWeight: rawWeight, normalizedWeight: rawWeight / total, weight: rawWeight / total }));
  const centralEstimate = normalized.reduce((sum, model) => sum + model.fairValue * model.weight, 0); const dispersion = Math.sqrt(normalized.reduce((sum, model) => sum + model.weight * ((model.fairValue - centralEstimate) ** 2), 0)) / Math.max(Math.abs(centralEstimate), Number.EPSILON);
  return { centralEstimate, dispersion, models: normalized };
}

export function dcfSensitivity(input: DcfInput, waccValues: readonly number[], terminalGrowthValues: readonly number[]) {
  if (!waccValues.length || !terminalGrowthValues.length || waccValues.length > 9 || terminalGrowthValues.length > 9) throw new RangeError('Sensitivity axes must contain 1 to 9 values');
  return waccValues.map((wacc) => terminalGrowthValues.map((terminalGrowth) => {
    try { return { wacc, terminalGrowth, status: 'available' as const, fairValue: fcffDcf({ ...input, assumptions: { ...input.assumptions, wacc, terminalGrowth } }).fairValue }; }
    catch (cause) { return { wacc, terminalGrowth, status: 'unavailable' as const, reason: cause instanceof Error ? cause.message : 'Invalid sensitivity input' }; }
  }));
}

export function capitalStructureSensitivity(input: DcfInput, netDebtValues: readonly number[], dilutionRates: readonly number[]) {
  if (netDebtValues.length * dilutionRates.length > 81) throw new RangeError('Sensitivity workload exceeds 81 cells');
  return netDebtValues.map((netDebt) => dilutionRates.map((dilutionRate) => ({ netDebt, dilutionRate, fairValue: fcffDcf({ ...input, netDebt, assumptions: { ...input.assumptions, dilutionRate } }).fairValue })));
}

export interface DeterministicWaccInput {
  riskFreeRate: number;
  beta: number;
  equityRiskPremium: number;
  costDebt: number;
  taxRate: number;
  equityValue: number;
  debt: number;
}

export interface DeterministicWaccResult {
  costOfEquity: number;
  afterTaxCostOfDebt: number;
  equityWeight: number;
  debtWeight: number;
  wacc: number;
}

/** CAPM + after-tax debt WACC. Every input is supplied by the caller; no default
 * rate, beta, premium, capital weight, or tax assumption exists in this function. */
export function calculateDeterministicWacc(input: DeterministicWaccInput): DeterministicWaccResult {
  assertFinite({
    riskFreeRate: input.riskFreeRate,
    beta: input.beta,
    equityRiskPremium: input.equityRiskPremium,
    costDebt: input.costDebt,
    taxRate: input.taxRate,
    equityValue: input.equityValue,
    debt: input.debt,
  });
  positive(input.riskFreeRate, 'riskFreeRate');
  positive(input.beta, 'beta');
  positive(input.equityRiskPremium, 'equityRiskPremium');
  positive(input.equityValue, 'equityValue');
  if (input.debt < 0) throw new RangeError('debt must be non-negative');
  if (input.costDebt < 0) throw new RangeError('costDebt must be non-negative');
  if (input.taxRate < 0 || input.taxRate > 1) throw new RangeError('taxRate must be between zero and one');
  const capital = input.equityValue + input.debt;
  positive(capital, 'totalCapital');
  const costOfEquity = input.riskFreeRate + input.beta * input.equityRiskPremium;
  const afterTaxCostOfDebt = input.costDebt * (1 - input.taxRate);
  const equityWeight = input.equityValue / capital;
  const debtWeight = input.debt / capital;
  const wacc = equityWeight * costOfEquity + debtWeight * afterTaxCostOfDebt;
  assertFinite({ costOfEquity, afterTaxCostOfDebt, equityWeight, debtWeight, wacc });
  positive(wacc, 'wacc');
  return { costOfEquity, afterTaxCostOfDebt, equityWeight, debtWeight, wacc };
}

export interface DeterministicDcfInput {
  latestFreeCashFlow: number;
  /** Exactly one provider-derived compound rate, or five provider-derived annual rates. */
  growthRates: readonly number[];
  cash: number;
  debt: number;
  shares: number;
  wacc: number;
  perpetualGrowth: number;
}

export interface DeterministicDcfResult {
  fairValue: number;
  forecastFreeCashFlows: number[];
  presentValueFreeCashFlows: number;
  terminalValue: number;
  presentValueTerminalValue: number;
  enterpriseValue: number;
  equityValue: number;
}

/** Five-year FCFF DCF required by nexora-fv-v2. Growth is never generated here:
 * callers must provide either five annual consensus rates or one consensus CAGR. */
export function calculateDeterministicDcf(input: DeterministicDcfInput): DeterministicDcfResult {
  assertFinite({
    latestFreeCashFlow: input.latestFreeCashFlow,
    cash: input.cash,
    debt: input.debt,
    shares: input.shares,
    wacc: input.wacc,
    perpetualGrowth: input.perpetualGrowth,
  });
  positive(input.latestFreeCashFlow, 'latestFreeCashFlow');
  positive(input.shares, 'shares');
  if (input.cash < 0 || input.debt < 0) throw new RangeError('cash and debt must be non-negative');
  if (input.growthRates.length !== 1 && input.growthRates.length !== 5) {
    throw new RangeError('growthRates must contain one consensus CAGR or five annual consensus rates');
  }
  if (input.growthRates.some((rate) => !Number.isFinite(rate) || rate <= -1)) {
    throw new RangeError('growthRates must be finite and greater than -100%');
  }
  if (!(input.wacc > input.perpetualGrowth)) {
    throw new RangeError('WACC must be greater than perpetual growth');
  }
  const rates = input.growthRates.length === 1
    ? Array<number>(5).fill(input.growthRates[0])
    : [...input.growthRates];
  const forecastFreeCashFlows: number[] = [];
  let freeCashFlow = input.latestFreeCashFlow;
  let presentValueFreeCashFlows = 0;
  for (let year = 1; year <= 5; year += 1) {
    freeCashFlow *= 1 + rates[year - 1];
    if (!Number.isFinite(freeCashFlow) || freeCashFlow <= 0) {
      throw new RangeError(`forecastFreeCashFlowYear${year} must be finite and positive`);
    }
    forecastFreeCashFlows.push(freeCashFlow);
    presentValueFreeCashFlows += freeCashFlow / ((1 + input.wacc) ** year);
  }
  const terminalValue = forecastFreeCashFlows[4] * (1 + input.perpetualGrowth)
    / (input.wacc - input.perpetualGrowth);
  const presentValueTerminalValue = terminalValue / ((1 + input.wacc) ** 5);
  const enterpriseValue = presentValueFreeCashFlows + presentValueTerminalValue;
  const equityValue = enterpriseValue + input.cash - input.debt;
  const fairValue = equityValue / input.shares;
  assertFinite({
    presentValueFreeCashFlows,
    terminalValue,
    presentValueTerminalValue,
    enterpriseValue,
    equityValue,
    fairValue,
  });
  positive(fairValue, 'fairValue');
  return {
    fairValue,
    forecastFreeCashFlows,
    presentValueFreeCashFlows,
    terminalValue,
    presentValueTerminalValue,
    enterpriseValue,
    equityValue,
  };
}

export interface ForwardMultiplePeer {
  symbol: string;
  price: number | null;
  forwardEps: number | null;
  enterpriseValue: number | null;
  forwardRevenue: number | null;
}

export interface ForwardMultiplesResult {
  method: 'forward-pe' | 'forward-ev-sales';
  fairValue: number;
  medianMultiple: number;
  peers: Array<{ symbol: string; multiple: number }>;
  targetEnterpriseValue: number | null;
  targetEquityValue: number | null;
}

function retainedPeerMultiples(peers: Array<{ symbol: string; multiple: number }>, minimumPeers: number) {
  const valid = peers.filter((peer) => Number.isFinite(peer.multiple) && peer.multiple > 0);
  if (valid.length < minimumPeers) throw new RangeError(`At least ${minimumPeers} valid peers are required`);
  const initialMedian = median(valid.map((peer) => peer.multiple));
  const ratioFiltered = valid.filter((peer) =>
    peer.multiple >= initialMedian / 5 && peer.multiple <= initialMedian * 5);
  if (ratioFiltered.length < minimumPeers) throw new RangeError(`At least ${minimumPeers} peers must remain after outlier filtering`);
  const sorted = ratioFiltered.map((peer) => peer.multiple).toSorted((a, b) => a - b);
  const lower = sorted.slice(0, Math.floor(sorted.length / 2));
  const upper = sorted.slice(Math.ceil(sorted.length / 2));
  const q1 = median(lower);
  const q3 = median(upper);
  const iqr = q3 - q1;
  const retained = ratioFiltered.filter((peer) =>
    peer.multiple >= q1 - 1.5 * iqr && peer.multiple <= q3 + 1.5 * iqr);
  if (retained.length < minimumPeers) throw new RangeError(`At least ${minimumPeers} peers must remain after outlier filtering`);
  return retained;
}

/** Forward P/E for positive target EPS, otherwise Forward EV/Sales when the
 * provider supplied positive forward revenue. No estimate is synthesized. */
export function calculateForwardMultiples(input: {
  targetForwardEps: number | null;
  targetForwardRevenue: number | null;
  cash: number | null;
  debt: number | null;
  shares: number | null;
  peers: ForwardMultiplePeer[];
  minimumPeers?: number;
}): ForwardMultiplesResult {
  const minimumPeers = input.minimumPeers ?? 4;
  if (!Number.isInteger(minimumPeers) || minimumPeers < 4) throw new RangeError('minimumPeers must be at least four');

  if (input.targetForwardEps !== null
    && Number.isFinite(input.targetForwardEps)
    && input.targetForwardEps > 0) {
    const retained = retainedPeerMultiples(input.peers.map((peer) => ({
      symbol: peer.symbol,
      multiple: peer.price != null && peer.forwardEps != null && peer.price > 0 && peer.forwardEps > 0
        ? peer.price / peer.forwardEps
        : Number.NaN,
    })), minimumPeers);
    const medianMultiple = median(retained.map((peer) => peer.multiple));
    const fairValue = input.targetForwardEps * medianMultiple;
    assertFinite({ medianMultiple, fairValue });
    positive(fairValue, 'fairValue');
    return {
      method: 'forward-pe',
      fairValue,
      medianMultiple,
      peers: retained,
      targetEnterpriseValue: null,
      targetEquityValue: null,
    };
  }

  if (input.targetForwardRevenue === null || !Number.isFinite(input.targetForwardRevenue) || input.targetForwardRevenue <= 0) {
    throw new RangeError('targetForwardRevenue is required when targetForwardEps is non-positive');
  }
  if (input.cash === null || input.debt === null || input.shares === null) {
    throw new RangeError('cash, debt, and shares are required for forward EV/Sales');
  }
  assertFinite({ cash: input.cash, debt: input.debt, shares: input.shares });
  positive(input.shares, 'shares');
  if (input.cash < 0 || input.debt < 0) throw new RangeError('cash and debt must be non-negative');
  const retained = retainedPeerMultiples(input.peers.map((peer) => ({
    symbol: peer.symbol,
    multiple: peer.enterpriseValue != null && peer.forwardRevenue != null
      && peer.enterpriseValue > 0 && peer.forwardRevenue > 0
      ? peer.enterpriseValue / peer.forwardRevenue
      : Number.NaN,
  })), minimumPeers);
  const medianMultiple = median(retained.map((peer) => peer.multiple));
  const targetEnterpriseValue = input.targetForwardRevenue * medianMultiple;
  const targetEquityValue = targetEnterpriseValue + input.cash - input.debt;
  const fairValue = targetEquityValue / input.shares;
  assertFinite({ medianMultiple, targetEnterpriseValue, targetEquityValue, fairValue });
  positive(fairValue, 'fairValue');
  return {
    method: 'forward-ev-sales',
    fairValue,
    medianMultiple,
    peers: retained,
    targetEnterpriseValue,
    targetEquityValue,
  };
}
