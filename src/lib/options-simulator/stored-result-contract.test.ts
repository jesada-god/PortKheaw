import { describe, expect, it } from 'vitest';
import { runMonteCarlo } from './monte-carlo';
import { valuePortfolio } from './portfolio';
import { isPortfolioValuation, isWhatIfResult, normalizeStoredMonteCarloResult, normalizeStoredWhatIfResult } from './stored-result-contract';
import type { SimulationWorkspace } from './types';

const workspace: SimulationWorkspace = {
  name: 'Legacy long call', description: '', symbol: 'TEST', companyName: 'Test', exchange: 'NASDAQ', currency: 'USD',
  simulationType: 'what-if', strategyType: 'Long Call', underlyingPrice: 100, stockQuantity: 0, cashPosition: 0,
  entryDate: '2026-01-01', valuationDate: '2026-01-01',
  legs: [{ id: 'call', kind: 'call', side: 'buy', quantity: 1, strike: 100, expiration: '2027-01-01',
    entryPremium: 5, impliedVolatility: 0.2, multiplier: 100, fees: 0, style: 'european' }],
  scenarios: [{ id: 'base', name: 'Base', targetPrice: 110, valuationDate: '2026-02-01', volatilityShift: 0, rate: 0.04, dividendYield: 0 }],
  monteCarlo: { paths: 1_000, seed: 7, horizonDays: 30, steps: 10, drift: 0, volatility: 0.2, rate: 0.04, dividendYield: 0 },
  dataSource: null, dataTimestamp: null, dataStatus: 'manual', resultSnapshot: null, methodologyVersion: 'options-simulator-v1',
};

function removeCanonicalFields(value: Record<string, unknown>): Record<string, unknown> {
  const legacy = { ...value };
  delete legacy.initialDebit;
  delete legacy.initialRisk;
  delete legacy.returnPct;
  delete legacy.maxLoss;
  delete legacy.breakEvenPrices;
  return legacy;
}

describe('stored simulator result contract', () => {
  it('rehydrates a pre-contract What-If snapshot from the strategy, not its payoff grid', () => {
    const current = valuePortfolio(workspace, workspace.scenarios[0]);
    const legacy = { ...removeCanonicalFields({ ...current }), breakEvens: current.payoff.map((point) => point.price) };
    const normalized = normalizeStoredWhatIfResult(legacy, workspace);

    expect(normalized).not.toBeNull();
    expect(normalized?.initialDebit).toBe(500);
    expect(normalized?.initialRisk).toBe(500);
    expect(normalized?.maxLoss).toBe(500);
    expect(normalized?.breakEvenPrices).toEqual([105]);
    expect(normalized?.breakEvenPrices).not.toEqual(legacy.breakEvens);
    expect(normalized?.returnPct).toBeCloseTo(current.profitLoss / 500 * 100, 10);
    expect(normalized?.simulatedValue).toBe(current.theoreticalValue);
    expect(normalized?.costBasis).toBe(500);
    expect(normalized?.projectedPnL).toBe(current.profitLoss);
    expect(normalized?.projectedPnL).toBeCloseTo((normalized?.simulatedValue ?? 0) - (normalized?.costBasis ?? 0), 10);
    expect(normalized?.changeFromCurrent).toBeCloseTo((normalized?.simulatedValue ?? 0) - (normalized?.currentValue ?? 0), 10);
    expect(normalized?.projectedPnL).not.toBe(normalized?.simulatedValue);
    expect(isWhatIfResult(normalized)).toBe(true);
  });

  it('rehydrates a pre-contract Monte Carlo snapshot without reading histogram bins or paths as break-evens', () => {
    const current = runMonteCarlo(workspace, workspace.monteCarlo);
    const legacy = removeCanonicalFields({ ...current });
    const normalized = normalizeStoredMonteCarloResult(legacy, workspace);

    expect(normalized).not.toBeNull();
    expect(normalized?.initialDebit).toBe(500);
    expect(normalized?.initialRisk).toBe(500);
    expect(normalized?.maxLoss).toBe(500);
    expect(normalized?.breakEvenPrices).toEqual([105]);
    expect(normalized?.returnPct).toBeCloseTo(current.expectedProfitLoss / 500 * 100, 10);
  });

  it('rejects a result whose return percentage does not reconcile to its canonical risk', () => {
    const current = valuePortfolio(workspace, workspace.scenarios[0]);
    expect(isPortfolioValuation({ ...current, returnPct: current.returnPct === null ? 1 : current.returnPct + 1 })).toBe(false);
  });

  it('rejects a legacy Long Call missing a positive per-share premium instead of mapping risk to unlimited', () => {
    const invalidWorkspace = {
      ...workspace,
      legs: [{ ...workspace.legs[0], entryPremium: 0 }],
    };
    const current = valuePortfolio(invalidWorkspace, invalidWorkspace.scenarios[0]);

    expect(normalizeStoredWhatIfResult(current, invalidWorkspace)).toBeNull();
    expect(normalizeStoredMonteCarloResult(runMonteCarlo(invalidWorkspace, invalidWorkspace.monteCarlo), invalidWorkspace)).toBeNull();
  });
});
