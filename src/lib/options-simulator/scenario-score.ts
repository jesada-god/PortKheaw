import { boundedExpirationProfitFloor, percentile, type SimulationPathSet } from './monte-carlo';
import { priceOptionValue } from './pricing';
import type { MonteCarloSettings, OptionLeg, SimulationWorkspace } from './types';

export const PROFIT_FACTOR_CAP = 10;
export const MINIMUM_COMMON_PATHS = 1_000;

export type ScenarioClassification =
  | 'Positive Scenario Edge'
  | 'No Positive Edge'
  | 'No Clear Edge'
  | 'Neutral'
  | 'Bullish Call Edge'
  | 'Bearish Put Edge'
  | 'ข้อมูลไม่น่าเชื่อถือพอ'
  | 'Not directly comparable'
  | 'Score Unavailable';

export interface StrategyScoreComponents {
  pop: number;
  ev: number;
  median: number;
  tail: number;
  payoff: number;
  robustness: number;
}

export interface StrategyMetrics {
  probabilityOfProfit: number;
  expectedPnL: number;
  medianPnL: number;
  es95PnL: number;
  evr: number;
  medianR: number;
  es95R: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  robustness: number;
  maxLoss: number;
  riskCapital: number;
  effectiveSampleSize: number;
  popStandardError: number;
  expectedPnLStandardError: number;
  expectedPnLConfidence95: [number, number];
  requestedPaths: number;
  generatedPaths: number;
  commonValidPaths: number;
  droppedPaths: number;
}

export interface ConfidenceComponent {
  score: number;
  reasons: string[];
}

export interface ScenarioConfidence {
  score: number;
  inputQuality: ConfidenceComponent;
  scenarioStability: ConfidenceComponent;
  statisticalPrecision: ConfidenceComponent;
  liquidityQuality: ConfidenceComponent;
  meaning: 'data-and-model-reliability-not-success-probability';
}

export interface StressScenarioResult {
  id: 'base' | 'spot-down-10' | 'spot-up-10' | 'iv-down-20' | 'iv-up-20' | 'rate-down-100bp' | 'rate-up-100bp' | 'dividend-up-100bp';
  expectedPnL: number;
  evr: number;
  positive: boolean;
}

export interface ScenarioStrategyScore {
  id: string;
  strategy: string;
  side: 'call' | 'put' | 'mixed';
  status: 'available' | 'unavailable';
  edgeScore: number | null;
  classification: ScenarioClassification;
  positiveEdge: boolean;
  positiveEdgeReasons: string[];
  metrics: StrategyMetrics | null;
  scoreComponents: StrategyScoreComponents | null;
  confidence: ScenarioConfidence | null;
  stressScenarios: StressScenarioResult[];
  assumptions: {
    premium: number;
    premiumSources: string[];
    fees: number;
    multiplier: number[];
    quantity: number[];
    rate: number;
    dividendYield: number;
    targetDate: string;
    source: string | null;
    asOf: string | null;
  };
  reason?: string;
}

export type CallPutScenarioScore =
  | {
    status: 'available';
    mode: 'single' | 'comparison';
    pricingMode: 'forecast' | 'risk-neutral';
    probabilityLabel: 'Forecast probability' | 'Risk-neutral probability';
    strategies: ScenarioStrategyScore[];
    call: ScenarioStrategyScore | null;
    put: ScenarioStrategyScore | null;
    comparable: boolean;
    comparisonClassification: ScenarioClassification | null;
    comparisonConfidence: number | null;
    scoreDifference: number | null;
    pathSet: {
      id: string;
      requestedPaths: number;
      generatedPaths: number;
      commonValidPaths: number;
      droppedPaths: number;
      seed: number;
    };
    marketDirectionProbability: {
      probabilityAboveStartingSpot: number;
      probabilityAtOrAboveTarget: number;
      targetPrice: number;
      source: 'shared-underlying-paths';
      usedInOptionEdgeScore: false;
    };
    assumptions: {
      symbol: string;
      startingSpot: number;
      targetDate: string;
      drift: number;
      volatility: number;
      rate: number;
      dividendYield: number;
      seed: number;
    };
    warnings: string[];
    auditStatus: 'passed';
  }
  | {
    status: 'unavailable';
    reason: string;
    auditStatus: 'not-run' | 'failed';
  };

interface CandidateEvaluation {
  id: string;
  strategy: string;
  side: 'call' | 'put' | 'mixed';
  workspace: SimulationWorkspace;
  pathPnL: Array<number | null>;
  maxLoss: number | null;
}

export interface EdgeScoreInput {
  probabilityOfProfit: number;
  evr: number;
  medianR: number;
  es95R: number;
  profitFactor: number;
  robustness: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function mean(values: readonly number[]): number {
  if (!values.length) throw new Error('No common valid paths are available');
  return finite(values.reduce((sum, value) => sum + value, 0) / values.length, 'mean');
}

function calendarDaysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 86_400_000) : Number.NaN;
}

export function calculateEdgeScore(input: EdgeScoreInput): { edgeScore: number; components: StrategyScoreComponents } {
  const components = {
    pop: clamp(input.probabilityOfProfit) * 100,
    ev: 100 / (1 + Math.exp(-4 * input.evr)),
    median: 100 / (1 + Math.exp(-4 * input.medianR)),
    tail: 100 * clamp(1 - Math.abs(input.es95R)),
    payoff: 100 * input.profitFactor / (1 + input.profitFactor),
    robustness: clamp(input.robustness) * 100,
  };
  const edgeScore = clamp(
    0.30 * components.pop
      + 0.25 * components.ev
      + 0.10 * components.median
      + 0.15 * components.tail
      + 0.10 * components.payoff
      + 0.10 * components.robustness,
    0,
    100,
  );
  return { edgeScore, components };
}

export function classifySingleStrategy(input: {
  confidence: number;
  positiveEdge: boolean;
  edgeScore: number;
}): ScenarioClassification {
  if (input.confidence < 60) return 'ข้อมูลไม่น่าเชื่อถือพอ';
  if (!input.positiveEdge) return 'No Positive Edge';
  return input.edgeScore >= 60 ? 'Positive Scenario Edge' : 'No Clear Edge';
}

export function classifyCallPutComparison(input: {
  confidence: number;
  call: Pick<ScenarioStrategyScore, 'edgeScore' | 'positiveEdge'>;
  put: Pick<ScenarioStrategyScore, 'edgeScore' | 'positiveEdge'>;
  comparable: boolean;
}): ScenarioClassification {
  if (!input.comparable) return 'Not directly comparable';
  if (input.confidence < 60) return 'ข้อมูลไม่น่าเชื่อถือพอ';
  const callScore = input.call.edgeScore ?? 0;
  const putScore = input.put.edgeScore ?? 0;
  if (!input.call.positiveEdge && !input.put.positiveEdge) return 'No Positive Edge';
  if (callScore < 55 && putScore < 55) return 'No Clear Edge';
  if (Math.abs(callScore - putScore) < 10) return 'Neutral';
  if (callScore >= 60 && callScore - putScore >= 10 && input.call.positiveEdge) return 'Bullish Call Edge';
  if (putScore >= 60 && putScore - callScore >= 10 && input.put.positiveEdge) return 'Bearish Put Edge';
  return 'No Clear Edge';
}

function strategyWorkspace(workspace: SimulationWorkspace, legs: OptionLeg[], includeUnderlying: boolean): SimulationWorkspace {
  return {
    ...workspace,
    legs,
    stockQuantity: includeUnderlying ? workspace.stockQuantity : 0,
    cashPosition: includeUnderlying ? workspace.cashPosition : 0,
  };
}

function candidates(workspace: SimulationWorkspace): Array<{ id: string; strategy: string; side: CandidateEvaluation['side']; workspace: SimulationWorkspace }> {
  const calls = workspace.legs.filter((leg) => leg.kind === 'call');
  const puts = workspace.legs.filter((leg) => leg.kind === 'put');
  if (calls.length && puts.length) {
    return [
      { id: 'call', strategy: calls.length === 1 ? 'Long Call' : 'Call Strategy', side: 'call', workspace: strategyWorkspace(workspace, calls, false) },
      { id: 'put', strategy: puts.length === 1 ? 'Long Put' : 'Put Strategy', side: 'put', workspace: strategyWorkspace(workspace, puts, false) },
    ];
  }
  const side = calls.length && !puts.length ? 'call' : puts.length && !calls.length ? 'put' : 'mixed';
  const strategy = workspace.strategyType || (side === 'call' ? 'Call Strategy' : side === 'put' ? 'Put Strategy' : 'Option Strategy');
  return [{ id: side, strategy, side, workspace: strategyWorkspace(workspace, workspace.legs, true) }];
}

function pathProfitLoss(
  workspace: SimulationWorkspace,
  terminalPrice: number,
  targetDate: string,
  shock: { volatilityMultiplier?: number; rateShift?: number; dividendShift?: number } = {},
): number {
  let profit = workspace.cashPosition + workspace.stockQuantity * (terminalPrice - (workspace.underlyingPrice ?? terminalPrice));
  for (const leg of workspace.legs) {
    const days = calendarDaysBetween(targetDate, leg.expiration);
    if (!Number.isFinite(days) || days < 0) throw new Error('Target date exceeds a contract expiration');
    const optionValue = priceOptionValue({
      spot: terminalPrice,
      strike: leg.strike,
      timeYears: days / 365,
      volatility: leg.impliedVolatility * (shock.volatilityMultiplier ?? 1),
      rate: (workspace.scenarios[0]?.rate ?? workspace.monteCarlo.rate) + (shock.rateShift ?? 0),
      dividendYield: (workspace.scenarios[0]?.dividendYield ?? workspace.monteCarlo.dividendYield) + (shock.dividendShift ?? 0),
      kind: leg.kind,
      style: leg.style,
    });
    const sign = leg.side === 'buy' ? 1 : -1;
    profit += sign * (optionValue - leg.entryPremium) * leg.quantity * leg.multiplier - leg.fees;
  }
  return finite(profit, 'path P&L');
}

function evaluateCandidate(
  candidate: ReturnType<typeof candidates>[number],
  pathSet: SimulationPathSet,
  targetDate: string,
): CandidateEvaluation {
  const floor = boundedExpirationProfitFloor(candidate.workspace);
  const maxLoss = floor === null ? null : -floor;
  return {
    ...candidate,
    pathPnL: pathSet.terminalPrices.map((terminalPrice) => {
      try { return pathProfitLoss(candidate.workspace, terminalPrice, targetDate); }
      catch { return null; }
    }),
    maxLoss: maxLoss !== null && Number.isFinite(maxLoss) && maxLoss > 0 ? maxLoss : null,
  };
}

function profitFactor(profits: readonly number[]): { value: number | null; grossProfit: number; grossLoss: number } {
  const grossProfit = profits.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = profits.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  if (grossProfit === 0 && grossLoss < 0) return { value: 0, grossProfit, grossLoss };
  if (grossProfit > 0 && grossLoss === 0) return { value: PROFIT_FACTOR_CAP, grossProfit, grossLoss };
  if (grossProfit === 0 && grossLoss === 0) return { value: null, grossProfit, grossLoss };
  return { value: Math.min(PROFIT_FACTOR_CAP, grossProfit / Math.abs(grossLoss)), grossProfit, grossLoss };
}

function stressResults(
  evaluation: CandidateEvaluation,
  terminalPrices: readonly number[],
  commonIndices: readonly number[],
  targetDate: string,
): StressScenarioResult[] {
  const definitions: Array<{ id: StressScenarioResult['id']; terminalScale: number; volatilityMultiplier?: number; rateShift?: number; dividendShift?: number }> = [
    { id: 'base', terminalScale: 1 },
    { id: 'spot-down-10', terminalScale: 0.9 },
    { id: 'spot-up-10', terminalScale: 1.1 },
    { id: 'iv-down-20', terminalScale: 1, volatilityMultiplier: 0.8 },
    { id: 'iv-up-20', terminalScale: 1, volatilityMultiplier: 1.2 },
    { id: 'rate-down-100bp', terminalScale: 1, rateShift: -0.01 },
    { id: 'rate-up-100bp', terminalScale: 1, rateShift: 0.01 },
    { id: 'dividend-up-100bp', terminalScale: 1, dividendShift: 0.01 },
  ];
  return definitions.map((definition) => {
    const profits = commonIndices.flatMap((index) => {
      try {
        return [pathProfitLoss(
          evaluation.workspace,
          terminalPrices[index] * definition.terminalScale,
          targetDate,
          definition,
        )];
      } catch { return []; }
    });
    const expectedPnL = profits.length ? mean(profits) : Number.NaN;
    const evr = evaluation.maxLoss && Number.isFinite(expectedPnL) ? expectedPnL / evaluation.maxLoss : Number.NaN;
    return {
      id: definition.id,
      expectedPnL,
      evr,
      positive: Number.isFinite(expectedPnL) && Number.isFinite(evr) && expectedPnL > 0 && evr > 0,
    };
  });
}

function inputQuality(workspace: SimulationWorkspace, legs: readonly OptionLeg[]): ConfidenceComponent {
  const statusScore: Record<SimulationWorkspace['dataStatus'], number> = {
    live: 95, delayed: 78, stale: 38, manual: 65, unavailable: 25,
  };
  let score = statusScore[workspace.dataStatus];
  const reasons = [`Input status ${workspace.dataStatus}: ${score}/100`];
  if (legs.some((leg) => leg.inputMode === 'custom')) {
    score -= 8;
    reasons.push('One or more provider-derived contracts were edited and are now custom');
  }
  if (legs.every((leg) => leg.inputMode === 'provider' && leg.contractProvider)) {
    score += 5;
    reasons.push('Contract identity and source provenance are present');
  }
  if (legs.some((leg) => !Number.isFinite(leg.entryPremium) || leg.entryPremium <= 0)) {
    score -= 25;
    reasons.push('A positive entry premium is missing');
  }
  if (legs.some((leg) => !Number.isFinite(leg.impliedVolatility) || leg.impliedVolatility <= 0)) {
    score -= 25;
    reasons.push('A positive provider or disclosed custom IV is missing');
  }
  if (legs.some((leg) => leg.premiumSource === 'manual')) {
    score -= 6;
    reasons.push('At least one premium source is manual');
  }
  if (!workspace.dataSource) {
    score -= 5;
    reasons.push('Workspace data source is not available');
  }
  if (workspace.scenarios.some((scenario) => !Number.isFinite(scenario.rate) || !Number.isFinite(scenario.dividendYield))) {
    score -= 20;
    reasons.push('Rate or dividend assumption is incomplete');
  } else {
    reasons.push('Rate and dividend assumptions are finite and disclosed');
  }
  return { score: clamp(score, 0, 100), reasons };
}

function liquidityQuality(legs: readonly OptionLeg[]): ConfidenceComponent {
  const available = legs.flatMap((leg) => {
    const midpoint = leg.bid !== null && leg.bid !== undefined && leg.ask !== null && leg.ask !== undefined
      ? (leg.bid + leg.ask) / 2
      : null;
    if (midpoint === null || midpoint <= 0) return [];
    const spread = clamp(1 - (leg.ask! - leg.bid!) / midpoint);
    const oi = leg.openInterest == null ? 0.35 : clamp(leg.openInterest / 500);
    const volume = leg.volume == null ? 0.35 : clamp(leg.volume / 100);
    const freshness = leg.contractStatus === 'live' ? 1 : leg.contractStatus === 'delayed' ? 0.8 : leg.contractStatus === 'cached' ? 0.65 : leg.contractStatus === 'stale' ? 0.25 : 0.5;
    return [(0.45 * spread + 0.25 * oi + 0.20 * volume + 0.10 * freshness) * 100];
  });
  if (!available.length) return { score: 45, reasons: ['Bid/ask liquidity is missing; a transparent neutral-low fallback is used'] };
  return { score: mean(available), reasons: ['Bid/ask spread, open interest, volume, and quote status were evaluated'] };
}

function confidence(
  workspace: SimulationWorkspace,
  evaluation: CandidateEvaluation,
  metrics: StrategyMetrics,
  stress: readonly StressScenarioResult[],
): ScenarioConfidence {
  const input = inputQuality(workspace, evaluation.workspace.legs);
  const validStress = stress.filter((scenario) => Number.isFinite(scenario.evr));
  const evrs = validStress.map((scenario) => scenario.evr);
  const spread = evrs.length ? Math.max(...evrs) - Math.min(...evrs) : 1;
  const stability: ConfidenceComponent = {
    score: clamp(40 + metrics.robustness * 50 + (1 - clamp(spread / 2)) * 10, 0, 100),
    reasons: [`${Math.round(metrics.robustness * 100)}% of disclosed stress scenarios retained positive raw edge`, `Stress EVR range: ${Number.isFinite(spread) ? spread.toFixed(4) : 'unavailable'}`],
  };
  const retainedRatio = metrics.generatedPaths > 0 ? metrics.commonValidPaths / metrics.generatedPaths : 0;
  const relativeExpectedError = metrics.maxLoss > 0 ? metrics.expectedPnLStandardError / metrics.maxLoss : 1;
  const precisionFromError = 1 - clamp(relativeExpectedError / 0.10);
  const statistical: ConfidenceComponent = {
    score: clamp(35 * retainedRatio + 25 * clamp(metrics.effectiveSampleSize / 5_000) + 25 * precisionFromError + 15, 0, 100),
    reasons: [`${metrics.commonValidPaths.toLocaleString()} common valid paths / effective sample size ${metrics.effectiveSampleSize.toLocaleString()}`, `${metrics.droppedPaths.toLocaleString()} requested paths were unavailable or dropped`, `POP standard error ${(metrics.popStandardError * 100).toFixed(3)}%; expected P&L standard error ${metrics.expectedPnLStandardError.toFixed(4)}`, `Expected P&L 95% CI: ${metrics.expectedPnLConfidence95[0].toFixed(4)} to ${metrics.expectedPnLConfidence95[1].toFixed(4)}`, 'A deterministic integer seed makes the run reproducible'],
  };
  const liquidity = liquidityQuality(evaluation.workspace.legs);
  const score = 0.35 * input.score + 0.30 * stability.score + 0.20 * statistical.score + 0.15 * liquidity.score;
  return {
    score,
    inputQuality: input,
    scenarioStability: stability,
    statisticalPrecision: statistical,
    liquidityQuality: liquidity,
    meaning: 'data-and-model-reliability-not-success-probability',
  };
}

function positiveEdgeReasons(metrics: StrategyMetrics, confidenceScore: number): string[] {
  const reasons: string[] = [];
  if (!(metrics.expectedPnL > 0)) reasons.push('expectedPnL must be greater than 0');
  if (!(metrics.evr > 0)) reasons.push('EVR must be greater than 0');
  if (metrics.commonValidPaths < MINIMUM_COMMON_PATHS) reasons.push(`commonValidPaths must be at least ${MINIMUM_COMMON_PATHS.toLocaleString()}`);
  if (!(metrics.maxLoss > 0) || !Number.isFinite(metrics.maxLoss)) reasons.push('maxLoss must be finite and greater than 0');
  if (confidenceScore < 60) reasons.push('confidence must be at least 60');
  return reasons;
}

function scoreEvaluation(
  workspace: SimulationWorkspace,
  evaluation: CandidateEvaluation,
  pathSet: SimulationPathSet,
  commonIndices: readonly number[],
  targetDate: string,
): ScenarioStrategyScore {
  const premium = evaluation.workspace.legs.reduce((sum, leg) => sum + leg.entryPremium * leg.quantity * leg.multiplier, 0);
  const assumptions = {
    premium,
    premiumSources: [...new Set(evaluation.workspace.legs.map((leg) => leg.premiumSource ?? 'manual'))],
    fees: evaluation.workspace.legs.reduce((sum, leg) => sum + leg.fees, 0),
    multiplier: [...new Set(evaluation.workspace.legs.map((leg) => leg.multiplier))],
    quantity: [...new Set(evaluation.workspace.legs.map((leg) => leg.quantity))],
    rate: evaluation.workspace.scenarios[0]?.rate ?? evaluation.workspace.monteCarlo.rate,
    dividendYield: evaluation.workspace.scenarios[0]?.dividendYield ?? evaluation.workspace.monteCarlo.dividendYield,
    targetDate,
    source: evaluation.workspace.dataSource,
    asOf: evaluation.workspace.dataTimestamp,
  };
  if (evaluation.maxLoss === null) {
    return {
      id: evaluation.id, strategy: evaluation.strategy, side: evaluation.side,
      status: 'unavailable', edgeScore: null, classification: 'Score Unavailable', positiveEdge: false,
      positiveEdgeReasons: ['maxLoss is null, non-positive, non-finite, or unbounded'], metrics: null,
      scoreComponents: null, confidence: null, stressScenarios: [], assumptions,
      reason: 'A finite positive maxLoss/risk-capital policy is required; the denominator was not clamped or fabricated.',
    };
  }
  const profits = commonIndices.map((index) => evaluation.pathPnL[index] as number).sort((left, right) => left - right);
  if (!profits.length) {
    return {
      id: evaluation.id, strategy: evaluation.strategy, side: evaluation.side,
      status: 'unavailable', edgeScore: null, classification: 'Score Unavailable', positiveEdge: false,
      positiveEdgeReasons: ['No common valid paths'], metrics: null, scoreComponents: null,
      confidence: null, stressScenarios: [], assumptions, reason: 'No common valid path intersection is available.',
    };
  }
  const expectedPnL = mean(profits);
  const medianPnL = percentile(profits, 0.5);
  const tailCount = Math.max(1, Math.ceil(profits.length * 0.05));
  const es95PnL = mean(profits.slice(0, tailCount));
  const factor = profitFactor(profits);
  const probabilityOfProfit = profits.filter((value) => value > 0).length / profits.length;
  const sampleVariance = profits.length > 1
    ? profits.reduce((sum, value) => sum + (value - expectedPnL) ** 2, 0) / (profits.length - 1)
    : 0;
  const expectedPnLStandardError = Math.sqrt(sampleVariance / profits.length);
  const popStandardError = Math.sqrt(probabilityOfProfit * (1 - probabilityOfProfit) / profits.length);
  const stress = stressResults(evaluation, pathSet.terminalPrices, commonIndices, targetDate);
  const robustness = stress.filter((scenario) => scenario.positive).length / stress.length;
  const metrics: StrategyMetrics = {
    probabilityOfProfit,
    expectedPnL,
    medianPnL,
    es95PnL,
    evr: expectedPnL / evaluation.maxLoss,
    medianR: medianPnL / evaluation.maxLoss,
    es95R: es95PnL / evaluation.maxLoss,
    grossProfit: factor.grossProfit,
    grossLoss: factor.grossLoss,
    profitFactor: factor.value,
    robustness,
    maxLoss: evaluation.maxLoss,
    riskCapital: evaluation.maxLoss,
    effectiveSampleSize: profits.length,
    popStandardError,
    expectedPnLStandardError,
    expectedPnLConfidence95: [expectedPnL - 1.96 * expectedPnLStandardError, expectedPnL + 1.96 * expectedPnLStandardError],
    requestedPaths: pathSet.requestedPaths,
    generatedPaths: pathSet.generatedPaths,
    commonValidPaths: profits.length,
    droppedPaths: Math.max(0, pathSet.requestedPaths - profits.length),
  };
  if (factor.value === null) {
    return {
      id: evaluation.id, strategy: evaluation.strategy, side: evaluation.side,
      status: 'unavailable', edgeScore: null, classification: 'Score Unavailable', positiveEdge: false,
      positiveEdgeReasons: ['ProfitFactor is unavailable because gross profit and gross loss are both zero'],
      metrics, scoreComponents: null, confidence: null, stressScenarios: stress, assumptions,
      reason: 'ProfitFactor is unavailable.',
    };
  }
  const scored = calculateEdgeScore({
    probabilityOfProfit: metrics.probabilityOfProfit,
    evr: metrics.evr,
    medianR: metrics.medianR,
    es95R: metrics.es95R,
    profitFactor: factor.value,
    robustness,
  });
  const confidenceResult = confidence(workspace, evaluation, metrics, stress);
  const gateReasons = positiveEdgeReasons(metrics, confidenceResult.score);
  const positiveEdge = gateReasons.length === 0;
  return {
    id: evaluation.id, strategy: evaluation.strategy, side: evaluation.side,
    status: 'available', edgeScore: scored.edgeScore,
    classification: classifySingleStrategy({ confidence: confidenceResult.score, positiveEdge, edgeScore: scored.edgeScore }),
    positiveEdge, positiveEdgeReasons: gateReasons, metrics, scoreComponents: scored.components,
    confidence: confidenceResult, stressScenarios: stress, assumptions,
  };
}

function externalPathSet(
  workspace: SimulationWorkspace,
  settings: MonteCarloSettings,
  prices: readonly number[],
  targetPrice: number,
): SimulationPathSet {
  const valid = prices.filter((price) => Number.isFinite(price) && price > 0);
  return {
    id: `pathset-external-${settings.seed}-${valid.length}`,
    requestedPaths: settings.paths,
    generatedPaths: prices.length,
    validPaths: valid.length,
    droppedPaths: Math.max(0, settings.paths - valid.length),
    seed: settings.seed,
    startingSpot: workspace.underlyingPrice ?? Number.NaN,
    horizonDays: settings.horizonDays,
    steps: settings.steps,
    drift: settings.driftMode === 'risk-neutral' ? settings.rate : settings.drift,
    volatility: settings.volatility,
    rate: settings.rate,
    dividendYield: settings.dividendYield,
    driftMode: settings.driftMode ?? 'forecast',
    targetPrice,
    terminalPrices: valid,
    drawdowns: valid.map(() => 0),
    reachedTarget: valid.map((price) => targetPrice >= (workspace.underlyingPrice ?? targetPrice) ? price >= targetPrice : price <= targetPrice),
    samplePaths: [],
  };
}

export function calculateCallPutScenarioScore(
  workspace: SimulationWorkspace,
  settings: MonteCarloSettings,
  paths: SimulationPathSet | readonly number[],
  targetPrice = workspace.scenarios[0]?.targetPrice,
): CallPutScenarioScore {
  const targetDate = workspace.scenarios[0]?.valuationDate;
  if (!targetDate || !Number.isFinite(targetPrice) || !(targetPrice > 0)) {
    return { status: 'unavailable', reason: 'A valid target date and target price are required', auditStatus: 'not-run' };
  }
  if (!workspace.underlyingPrice || workspace.underlyingPrice <= 0) {
    return { status: 'unavailable', reason: 'A finite positive starting spot is required', auditStatus: 'not-run' };
  }
  try {
    const pathSet = Array.isArray(paths)
      ? externalPathSet(workspace, settings, paths, targetPrice)
      : paths as SimulationPathSet;
    if (pathSet.seed !== settings.seed || pathSet.startingSpot !== workspace.underlyingPrice) {
      throw new Error('Path set seed or starting spot does not match the comparison assumptions');
    }
    const evaluated = candidates(workspace).map((candidate) => evaluateCandidate(candidate, pathSet, targetDate));
    const commonIndices = pathSet.terminalPrices.flatMap((_, index) => (
      evaluated.every((candidate) => candidate.pathPnL[index] !== null) ? [index] : []
    ));
    const strategies = evaluated.map((evaluation) => scoreEvaluation(workspace, evaluation, pathSet, commonIndices, targetDate));
    const call = strategies.find((strategy) => strategy.side === 'call') ?? null;
    const put = strategies.find((strategy) => strategy.side === 'put') ?? null;
    const mode = call && put ? 'comparison' as const : 'single' as const;
    const comparable = Boolean(call && put && call.status === 'available' && put.status === 'available');
    const comparisonConfidence = call && put && comparable
      ? Math.min(call.confidence?.score ?? 0, put.confidence?.score ?? 0)
      : null;
    const comparisonClassification = call && put
      ? classifyCallPutComparison({ confidence: comparisonConfidence ?? 0, call, put, comparable })
      : null;
    const scoreDifference = call?.edgeScore !== null && call?.edgeScore !== undefined
      && put?.edgeScore !== null && put?.edgeScore !== undefined
      ? call.edgeScore - put.edgeScore
      : null;
    const directionPrices = commonIndices.map((index) => pathSet.terminalPrices[index]);
    const denominator = directionPrices.length || 1;
    const warnings = [
      'Option Strategy Edge Score is independent for each strategy and is not forced to sum to 100.',
      'ES95 is the only weighted tail-risk input; P5 and VaR remain diagnostics.',
      'Greeks are not used directly as directional score inputs.',
    ];
    if (commonIndices.length < pathSet.validPaths) warnings.push('Strategy repricing used the common valid-path intersection');
    if (comparisonClassification === 'Not directly comparable') warnings.push('Both sides are shown independently; no winner is declared');
    return {
      status: 'available',
      mode,
      pricingMode: pathSet.driftMode,
      probabilityLabel: pathSet.driftMode === 'risk-neutral' ? 'Risk-neutral probability' : 'Forecast probability',
      strategies,
      call,
      put,
      comparable,
      comparisonClassification,
      comparisonConfidence,
      scoreDifference,
      pathSet: {
        id: pathSet.id,
        requestedPaths: pathSet.requestedPaths,
        generatedPaths: pathSet.generatedPaths,
        commonValidPaths: commonIndices.length,
        droppedPaths: Math.max(0, pathSet.requestedPaths - commonIndices.length),
        seed: pathSet.seed,
      },
      marketDirectionProbability: {
        probabilityAboveStartingSpot: directionPrices.filter((price) => price > pathSet.startingSpot).length / denominator,
        probabilityAtOrAboveTarget: directionPrices.filter((price) => price >= targetPrice).length / denominator,
        targetPrice,
        source: 'shared-underlying-paths',
        usedInOptionEdgeScore: false,
      },
      assumptions: {
        symbol: workspace.symbol,
        startingSpot: pathSet.startingSpot,
        targetDate,
        drift: pathSet.drift,
        volatility: pathSet.volatility,
        rate: pathSet.rate,
        dividendYield: pathSet.dividendYield,
        seed: pathSet.seed,
      },
      warnings,
      auditStatus: 'passed',
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `Scenario score audit failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      auditStatus: 'failed',
    };
  }
}
