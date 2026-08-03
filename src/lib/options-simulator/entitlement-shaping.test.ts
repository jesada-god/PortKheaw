import { describe, expect, it } from 'vitest';
import type { MonteCarloResult, PortfolioValuation, SimulationWorkspace } from './types';
import { shapeSimulationForTier, simulationCapability } from './entitlement-shaping';

const workspace = (overrides: Partial<SimulationWorkspace> = {}): SimulationWorkspace => ({
  name: 'Test', description: '', symbol: 'TEST', companyName: 'Test Inc', exchange: null, currency: 'USD',
  simulationType: 'what-if', strategyType: 'Long Call', underlyingPrice: 100, stockQuantity: 0, cashPosition: 0,
  entryDate: '2026-01-01', valuationDate: '2026-01-01',
  legs: [{ id: 'leg', kind: 'call', side: 'buy', quantity: 1, strike: 100, expiration: '2027-01-01', entryPremium: 5, impliedVolatility: 0.2, multiplier: 100, fees: 0, style: 'european' }],
  scenarios: [{ id: 'base', name: 'Base', targetPrice: 110, valuationDate: '2026-06-01', volatilityShift: 0, rate: 0.05, dividendYield: 0 }],
  monteCarlo: { paths: 1_000, seed: 42, horizonDays: 30, steps: 30, drift: 0.05, volatility: 0.2, rate: 0.05, dividendYield: 0 },
  dataSource: null, dataTimestamp: null, dataStatus: 'manual', resultSnapshot: null, methodologyVersion: 'options-simulator-v1',
  ...overrides,
});

const whatIfResult: PortfolioValuation = {
  legs: [], theoreticalValue: 123, profitLoss: 23, profitLossPercent: 23, netDebitCredit: 100,
  greeks: { delta: 0.5, gamma: 0.01, theta: -0.02, vega: 0.1, rho: 0.01 }, breakEvens: [105],
  maxProfit: null, maxLoss: 100, unlimitedProfit: true, unlimitedLoss: false, payoff: [],
};

const monteCarloResult: MonteCarloResult = {
  paths: 1_000, seed: 42, probabilityOfProfit: 0.5, probabilityItm: 0.5, probabilityOtm: 0.5,
  expectedProfitLoss: 10, medianProfitLoss: 5, percentiles: { p1: -100, p5: -50, p95: 80, p99: 120 },
  confidenceIntervals: { p95: [-50, 80], p99: [-100, 120] }, expectedDrawdown: 0.2,
  valueAtRisk: { p95: 50, p99: 100 }, expectedShortfall: { p95: 70, p99: 120 }, histogram: [],
  samplePaths: [], pathSetId: 'ELITE_SECRET',
};

describe('simulation entitlement shaping', () => {
  it('requires Elite for a Monte Carlo workspace or persisted Monte Carlo result', () => {
    expect(simulationCapability(workspace())).toBe('simulator.what_if');
    expect(simulationCapability(workspace({ simulationType: 'monte-carlo' }))).toBe('simulator.monte_carlo');
    expect(simulationCapability(workspace({ resultSnapshot: { monteCarlo: monteCarloResult } }))).toBe('simulator.monte_carlo');
  });

  it('strips downgrade-ineligible snapshots without mutating the saved object', () => {
    const saved = workspace({ resultSnapshot: { whatIf: whatIfResult, monteCarlo: monteCarloResult } });

    const pro = shapeSimulationForTier(saved, 'pro');
    const basic = shapeSimulationForTier(saved, 'basic');

    expect(pro.resultSnapshot).toEqual({ whatIf: whatIfResult });
    expect(JSON.stringify(pro)).not.toContain('ELITE_SECRET');
    expect(basic.resultSnapshot).toBeNull();
    expect(saved.resultSnapshot?.monteCarlo).toBe(monteCarloResult);
    expect(shapeSimulationForTier(saved, 'elite')).toBe(saved);
  });
});
