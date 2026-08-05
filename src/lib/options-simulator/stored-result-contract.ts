import type { MonteCarloDisplayResult } from './compute-dto';
import { valuePortfolio } from './portfolio';
import { buildCanonicalStrategyResult, buildCanonicalWhatIfResult } from './result-contract';
import type { PortfolioValuation, SimulationWorkspace, WhatIfResult } from './types';
import { prepareMonteCarloCalculationInput, prepareWhatIfCalculationInput } from './validation';

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

export function isWhatIfResult(value: unknown): value is WhatIfResult {
  if (!isPortfolioValuation(value)) return false;
  const result = value as unknown as Record<string, unknown>;
  if (!['currentValue', 'simulatedValue', 'changeFromCurrent', 'costBasis', 'projectedPnL']
    .every((key) => finiteValue(result[key]))) return false;
  const matches = (left: number, right: number) => Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(right));
  return matches(result.simulatedValue as number, value.theoreticalValue)
    && matches(result.changeFromCurrent as number, (result.simulatedValue as number) - (result.currentValue as number))
    && matches(result.projectedPnL as number, (result.simulatedValue as number) - (result.costBasis as number))
    && matches(result.projectedPnL as number, value.profitLoss);
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
export function normalizeStoredWhatIfResult(value: unknown, workspace: SimulationWorkspace): WhatIfResult | null {
  if (!prepareWhatIfCalculationInput(workspace).success) return null;
  const normalized = canonicalizeStoredResult(value, workspace, 'profitLoss');
  if (!isPortfolioValuation(normalized) || workspace.underlyingPrice === null || !workspace.scenarios[0]) return null;
  try {
    const scenario = workspace.scenarios[0];
    const current = valuePortfolio(workspace, {
      ...scenario,
      targetPrice: workspace.underlyingPrice,
      valuationDate: workspace.valuationDate,
      volatilityShift: 0,
    });
    const result = buildCanonicalWhatIfResult(normalized, current.theoreticalValue);
    return isWhatIfResult(result) ? result : null;
  } catch {
    return null;
  }
}

/** Rehydrates snapshots without deriving risk or break-even values from Monte Carlo output arrays. */
export function normalizeStoredMonteCarloResult(value: unknown, workspace: SimulationWorkspace): MonteCarloDisplayResult | null {
  if (!prepareMonteCarloCalculationInput(workspace, workspace, workspace.monteCarlo).success) return null;
  const normalized = canonicalizeStoredResult(value, workspace, 'expectedProfitLoss');
  return isMonteCarloDisplayResult(normalized) ? normalized : null;
}
