import type { CanonicalStrategyResult, OptionLeg, SimulationWorkspace } from './types';

type StrategyWorkspace = Pick<SimulationWorkspace,
  'legs' | 'stockQuantity' | 'cashPosition' | 'underlyingPrice'
>;

const ROOT_TOLERANCE = 1e-9;

const signOf = (leg: Pick<OptionLeg, 'side'>) => leg.side === 'buy' ? 1 : -1;
const nearZero = (value: number) => Math.abs(value) <= ROOT_TOLERANCE;

export function optionExpirationProfit(leg: OptionLeg, terminalPrice: number): number {
  const intrinsic = leg.kind === 'call'
    ? Math.max(0, terminalPrice - leg.strike)
    : Math.max(0, leg.strike - terminalPrice);
  return signOf(leg) * (intrinsic - leg.entryPremium) * leg.quantity * leg.multiplier - leg.fees;
}

export function portfolioExpirationProfit(workspace: StrategyWorkspace, terminalPrice: number): number {
  const options = workspace.legs.reduce((sum, leg) => sum + optionExpirationProfit(leg, terminalPrice), 0);
  const stock = workspace.stockQuantity * (terminalPrice - (workspace.underlyingPrice ?? terminalPrice));
  return options + stock + workspace.cashPosition;
}

function breakEvenLimit(workspace: StrategyWorkspace): number {
  const calls = workspace.legs.filter((leg) => leg.kind === 'call');
  const puts = workspace.legs.filter((leg) => leg.kind === 'put');
  const uniqueStrikes = new Set(workspace.legs.map((leg) => leg.strike)).size;

  if (workspace.legs.length === 1) return 1;
  if (workspace.legs.length === 2 && calls.length === 1 && puts.length === 1) return 2;
  if (workspace.legs.length === 2 && (calls.length === 2 || puts.length === 2)) return 2;
  if (workspace.legs.length === 3 && (calls.length === 3 || puts.length === 3)) return 2;
  if (workspace.legs.length === 4 && calls.length === 2 && puts.length === 2) return 2;

  // A custom piecewise-linear payoff has at most one isolated root per price
  // interval. This is a mathematical bound, not a display truncation policy.
  return Math.max(1, uniqueStrikes + 1);
}

export function normalizeBreakEvenPrices(values: readonly number[], limit: number): number[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Break-even limit must be a non-negative integer');
  if (!values.every(Number.isFinite)) throw new Error('Break-even prices must be finite');
  const sorted = [...values].sort((left, right) => left - right);
  const unique = sorted.filter((value, index) => (
    index === 0 || Math.abs(value - sorted[index - 1]) > ROOT_TOLERANCE * Math.max(1, Math.abs(value))
  ));
  if (unique.length > limit) {
    throw new Error(`Break-even invariant failed: found ${unique.length}, strategy allows ${limit}`);
  }
  return unique.map((value) => Object.is(value, -0) ? 0 : value);
}

export interface ExpirationPayoffAnalysis {
  breakEvenPrices: number[];
  maxProfit: number | null;
  maxLoss: number | null;
  unlimitedProfit: boolean;
  unlimitedLoss: boolean;
}

/**
 * Analyze the exact piecewise-linear expiration payoff at its strike knots.
 * Payoff chart sampling, histogram bins, and Monte Carlo paths never enter this
 * calculation, so none of them can accidentally become break-even prices.
 */
export function analyzeExpirationPayoff(workspace: StrategyWorkspace): ExpirationPayoffAnalysis {
  const knots = [...new Set([0, ...workspace.legs.map((leg) => leg.strike)])]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!knots.length) knots.push(0);

  const values = knots.map((price) => portfolioExpirationProfit(workspace, price));
  if (!values.every(Number.isFinite)) throw new Error('Expiration payoff must be finite at every strike knot');

  const roots: number[] = [];
  for (let index = 0; index < knots.length; index += 1) {
    const value = values[index];
    const previous = values[index - 1];
    const next = values[index + 1];
    if (nearZero(value) && (
      (previous !== undefined && !nearZero(previous))
      || (next !== undefined && !nearZero(next))
      || (previous === undefined && next === undefined)
    )) roots.push(knots[index]);

    if (index === knots.length - 1) continue;
    const nextValue = values[index + 1];
    if (!nearZero(value) && !nearZero(nextValue) && Math.sign(value) !== Math.sign(nextValue)) {
      roots.push(knots[index] + (knots[index + 1] - knots[index]) * Math.abs(value) / (Math.abs(value) + Math.abs(nextValue)));
    }
  }

  const upperTailSlope = workspace.stockQuantity + workspace.legs.reduce((slope, leg) => (
    slope + (leg.kind === 'call' ? signOf(leg) * leg.quantity * leg.multiplier : 0)
  ), 0);
  const lastKnot = knots.at(-1) ?? 0;
  const lastValue = values.at(-1) ?? portfolioExpirationProfit(workspace, lastKnot);
  if (!nearZero(upperTailSlope)) {
    const tailRoot = lastKnot - lastValue / upperTailSlope;
    if (tailRoot > lastKnot + ROOT_TOLERANCE) roots.push(tailRoot);
  }

  const unlimitedProfit = upperTailSlope > ROOT_TOLERANCE;
  const unlimitedLoss = upperTailSlope < -ROOT_TOLERANCE;
  const minimumProfitLoss = Math.min(...values);
  return {
    breakEvenPrices: normalizeBreakEvenPrices(roots, breakEvenLimit(workspace)),
    maxProfit: unlimitedProfit ? null : Math.max(...values),
    maxLoss: unlimitedLoss ? null : Math.max(0, -minimumProfitLoss),
    unlimitedProfit,
    unlimitedLoss,
  };
}

export function initialDebit(workspace: StrategyWorkspace): number {
  const optionDebit = workspace.legs.reduce((sum, leg) => (
    sum + signOf(leg) * leg.entryPremium * leg.quantity * leg.multiplier + leg.fees
  ), 0);
  const stockDebit = workspace.stockQuantity * (workspace.underlyingPrice ?? 0);
  const debit = Math.max(0, optionDebit + stockDebit);
  if (!Number.isFinite(debit)) throw new Error('Initial debit must be finite');
  return Object.is(debit, -0) ? 0 : debit;
}

export function buildCanonicalStrategyResult(
  workspace: StrategyWorkspace,
  profitLoss: number,
  analysis = analyzeExpirationPayoff(workspace),
): CanonicalStrategyResult {
  if (!Number.isFinite(profitLoss)) throw new Error('Return P&L must be finite');
  const initialRisk = analysis.maxLoss !== null && analysis.maxLoss > 0 ? analysis.maxLoss : null;
  return {
    initialDebit: initialDebit(workspace),
    initialRisk,
    returnPct: initialRisk === null ? null : profitLoss / initialRisk * 100,
    maxLoss: analysis.maxLoss,
    breakEvenPrices: analysis.breakEvenPrices,
  };
}
