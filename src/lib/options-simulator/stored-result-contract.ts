import type { MonteCarloDisplayResult } from './compute-dto';
import { buildCanonicalStrategyResult } from './result-contract';
import type { PortfolioValuation, SimulationWorkspace } from './types';

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function canonicalFieldsAreValid(value: Record<string, unknown>, profitLoss: number): boolean {
  if (!finiteValue(value.initialDebit) || value.initialDebit < 0) return false;
  if (value.initialRisk !== null && (!finiteValue(value.initialRisk) || value.initialRisk <= 0)) return false;
  if (value.maxLoss !== null && (!finiteValue(value.maxLoss) || value.maxLoss < 0)) return false;
  if (value.returnPct !== null && !finiteValue(value.returnPct)) return false;
  if ((value.initialRisk === null) !== (value.returnPct === null)) return false;
  if (finiteValue(value.initialRisk) && finiteValue(value.returnPct)) {
    const expected = profitLoss / value.initialRisk * 100;
    if (Math.abs(value.returnPct - expected) > 1e-9 * Math.max(1, Math.abs(expected))) return false;
  }
  if (!Array.isArray(value.breakEvenPrices) || !value.breakEvenPrices.every(finiteValue)) return false;
  return value.breakEvenPrices.every((price, index, prices) => index === 0 || price > prices[index - 1]);
}

export function isPortfolioValuation(value: unknown): value is PortfolioValuation {
  if (!recordValue(value) || !finiteValue(value.profitLoss) || !canonicalFieldsAreValid(value, value.profitLoss)) return false;
  if (!Array.isArray(value.legs) || !Array.isArray(value.payoff) || !recordValue(value.greeks)) return false;
  const greeks = value.greeks;
  return ['theoreticalValue', 'netDebitCredit'].every((key) => finiteValue(value[key]))
    && value.payoff.every((point) => recordValue(point) && finiteValue(point.price) && finiteValue(point.profitLoss))
    && ['delta', 'gamma', 'theta', 'vega', 'rho'].every((key) => finiteValue(greeks[key]))
    && (value.maxProfit === null || finiteValue(value.maxProfit))
    && typeof value.unlimitedProfit === 'boolean'
    && typeof value.unlimitedLoss === 'boolean';
}

export function isMonteCarloDisplayResult(value: unknown): value is MonteCarloDisplayResult {
  if (!recordValue(value) || !finiteValue(value.expectedProfitLoss)
    || !canonicalFieldsAreValid(value, value.expectedProfitLoss)) return false;
  if (!Array.isArray(value.histogram) || !Array.isArray(value.samplePaths)) return false;
  return ['paths', 'seed', 'probabilityOfProfit', 'probabilityItm', 'probabilityOtm', 'medianProfitLoss', 'expectedDrawdown']
    .every((key) => finiteValue(value[key]))
    && value.histogram.every((bucket) => recordValue(bucket) && finiteValue(bucket.lower) && finiteValue(bucket.upper) && finiteValue(bucket.count))
    && value.samplePaths.every((path) => Array.isArray(path) && path.every(finiteValue));
}

function canonicalizeStoredResult(
  value: unknown,
  workspace: SimulationWorkspace,
  profitLossKey: 'profitLoss' | 'expectedProfitLoss',
): unknown {
  if (!recordValue(value) || !finiteValue(value[profitLossKey])) return value;
  try {
    return { ...value, ...buildCanonicalStrategyResult(workspace, value[profitLossKey]) };
  } catch {
    return value;
  }
}

/** Rehydrates snapshots written before the canonical result fields existed. */
export function normalizeStoredWhatIfResult(value: unknown, workspace: SimulationWorkspace): PortfolioValuation | null {
  const normalized = canonicalizeStoredResult(value, workspace, 'profitLoss');
  return isPortfolioValuation(normalized) ? normalized : null;
}

/** Rehydrates snapshots without deriving risk or break-even values from Monte Carlo output arrays. */
export function normalizeStoredMonteCarloResult(value: unknown, workspace: SimulationWorkspace): MonteCarloDisplayResult | null {
  const normalized = canonicalizeStoredResult(value, workspace, 'expectedProfitLoss');
  return isMonteCarloDisplayResult(normalized) ? normalized : null;
}
