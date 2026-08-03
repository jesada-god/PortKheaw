import { describe, expect, it } from 'vitest';
import { convertUsdForDisplay } from '../../components/options-simulator/simulator-ux';
import { generateMonteCarloPathSet } from './monte-carlo';
import {
  calculateCallPutScenarioScore,
  calculateEdgeScore,
  classifyCallPutComparison,
  classifySingleStrategy,
  PROFIT_FACTOR_CAP,
  type ScenarioStrategyScore,
} from './scenario-score';
import type { OptionLeg, SimulationWorkspace } from './types';

const optionLeg = (overrides: Partial<OptionLeg> = {}): OptionLeg => ({
  id: 'call',
  kind: 'call',
  side: 'buy',
  quantity: 1,
  strike: 100,
  expiration: '2027-01-01',
  entryPremium: 5,
  impliedVolatility: 0.2,
  multiplier: 100,
  fees: 1,
  style: 'european',
  premiumSource: 'mark',
  inputMode: 'provider',
  contractProvider: 'test-provider',
  contractAsOf: '2026-01-01T15:00:00.000Z',
  contractStatus: 'live',
  bid: 4.9,
  ask: 5.1,
  mark: 5,
  volume: 100,
  openInterest: 500,
  ...overrides,
});

const workspace = (overrides: Partial<SimulationWorkspace> = {}): SimulationWorkspace => ({
  name: 'Scenario score',
  description: '',
  symbol: 'RKLB',
  companyName: 'Rocket Lab USA, Inc.',
  exchange: 'NASDAQ',
  currency: 'USD',
  simulationType: 'monte-carlo',
  strategyType: 'Long Call',
  underlyingPrice: 100,
  stockQuantity: 0,
  cashPosition: 0,
  entryDate: '2026-01-01',
  valuationDate: '2026-01-01',
  legs: [optionLeg()],
  scenarios: [{
    id: 'base',
    name: 'Base',
    targetPrice: 110,
    valuationDate: '2026-06-01',
    volatilityShift: 0,
    rate: 0.02,
    dividendYield: 0,
  }],
  monteCarlo: {
    paths: 1_000,
    seed: 42,
    horizonDays: 151,
    steps: 30,
    drift: 0.08,
    volatility: 0.2,
    rate: 0.02,
    dividendYield: 0,
    driftMode: 'forecast',
  },
  dataSource: 'test-provider',
  dataTimestamp: '2026-01-01T15:00:00.000Z',
  dataStatus: 'live',
  resultSnapshot: null,
  methodologyVersion: 'options-simulator-v1',
  ...overrides,
});

const comparisonWorkspace = (overrides: Partial<SimulationWorkspace> = {}) => workspace({
  strategyType: 'Straddle',
  legs: [optionLeg(), optionLeg({ id: 'put', kind: 'put' })],
  ...overrides,
});

const available = (input: SimulationWorkspace, prices: readonly number[] = Array(1_000).fill(120)) => {
  const result = calculateCallPutScenarioScore(input, input.monteCarlo, prices);
  expect(result.status).toBe('available');
  if (result.status !== 'available') throw new Error(result.reason);
  return result;
};

const classified = (edgeScore: number, positiveEdge: boolean): Pick<ScenarioStrategyScore, 'edgeScore' | 'positiveEdge'> => ({ edgeScore, positiveEdge });

describe('Phase 11 option strategy edge score', () => {
  it('scores 1,000 American-option paths without calculating unused Greeks', () => {
    const result = available(workspace({ legs: [optionLeg({ style: 'american' })] }));
    expect(result.call?.metrics?.commonValidPaths).toBe(1_000);
  });

  it('supports a Long Call without inventing a Put result', () => {
    const result = available(workspace());
    expect(result.mode).toBe('single');
    expect(result.strategies).toHaveLength(1);
    expect(result.call?.side).toBe('call');
    expect(result.put).toBeNull();
    expect(result.comparisonClassification).toBeNull();
  });

  it('supports a Long Put without inventing a Call result', () => {
    const input = workspace({ strategyType: 'Long Put', legs: [optionLeg({ id: 'put', kind: 'put' })] });
    const result = available(input, Array(1_000).fill(80));
    expect(result.mode).toBe('single');
    expect(result.call).toBeNull();
    expect(result.put?.side).toBe('put');
  });

  it('compares both sides on one shared path set without forcing scores to sum to 100', () => {
    const input = comparisonWorkspace({
      legs: [optionLeg({ entryPremium: 3 }), optionLeg({ id: 'put', kind: 'put', entryPremium: 11 })],
    });
    const paths = [...Array(700).fill(125), ...Array(300).fill(82)];
    const result = available(input, paths);
    expect(result.mode).toBe('comparison');
    expect(result.comparable).toBe(true);
    expect(result.pathSet.id).toContain(String(input.monteCarlo.seed));
    expect(result.call?.metrics?.commonValidPaths).toBe(result.put?.metrics?.commonValidPaths);
    expect((result.call?.edgeScore ?? 0) + (result.put?.edgeScore ?? 0)).not.toBeCloseTo(100, 8);
  });

  it('shows two scores but declares them not directly comparable when one side has unbounded loss', () => {
    const input = comparisonWorkspace({
      legs: [optionLeg({ side: 'sell' }), optionLeg({ id: 'put', kind: 'put' })],
    });
    const result = available(input);
    expect(result.mode).toBe('comparison');
    expect(result.call?.status).toBe('unavailable');
    expect(result.put?.status).toBe('available');
    expect(result.comparable).toBe(false);
    expect(result.comparisonClassification).toBe('Not directly comparable');
  });

  it('implements the published normalization and weights exactly', () => {
    const result = calculateEdgeScore({
      probabilityOfProfit: 0.3004,
      evr: -0.1431,
      medianR: -1,
      es95R: -1,
      profitFactor: 0.4,
      robustness: 0.2,
    });
    const ev = 100 / (1 + Math.exp(-4 * -0.1431));
    const median = 100 / (1 + Math.exp(4));
    const payoff = 100 * 0.4 / 1.4;
    expect(result.components).toEqual(expect.objectContaining({ pop: 30.04, tail: 0, robustness: 20 }));
    expect(result.components.ev).toBeCloseTo(ev, 12);
    expect(result.components.median).toBeCloseTo(median, 12);
    expect(result.edgeScore).toBeCloseTo(0.30 * 30.04 + 0.25 * ev + 0.10 * median + 0.10 * payoff + 0.10 * 20, 12);
  });

  it('does not confuse a normalized score with positive edge', () => {
    expect(classifySingleStrategy({ confidence: 85, positiveEdge: false, edgeScore: 63 }))
      .toBe('No Positive Edge');
  });

  it('follows all comparison classification gates in order', () => {
    expect(classifyCallPutComparison({ confidence: 85, comparable: true, call: classified(50, true), put: classified(52, true) })).toBe('No Clear Edge');
    expect(classifyCallPutComparison({ confidence: 85, comparable: true, call: classified(61, true), put: classified(55, true) })).toBe('Neutral');
    expect(classifyCallPutComparison({ confidence: 85, comparable: true, call: classified(72, true), put: classified(55, true) })).toBe('Bullish Call Edge');
    expect(classifyCallPutComparison({ confidence: 85, comparable: true, call: classified(55, true), put: classified(72, true) })).toBe('Bearish Put Edge');
    expect(classifyCallPutComparison({ confidence: 85, comparable: true, call: classified(70, false), put: classified(45, false) })).toBe('No Positive Edge');
    expect(classifyCallPutComparison({ confidence: 59.99, comparable: true, call: classified(90, true), put: classified(20, false) })).toBe('ข้อมูลไม่น่าเชื่อถือพอ');
  });

  it('uses the actual premium, fees, multiplier and quantity in finite max loss', () => {
    const input = workspace({ legs: [optionLeg({ entryPremium: 7, fees: 13, multiplier: 50, quantity: 3 })] });
    const result = available(input);
    expect(result.call?.metrics?.maxLoss).toBe(7 * 50 * 3 + 13);
    expect(result.call?.metrics?.riskCapital).toBe(7 * 50 * 3 + 13);
    expect(result.call?.assumptions).toEqual(expect.objectContaining({ premium: 7 * 50 * 3, fees: 13, multiplier: [50], quantity: [3] }));
  });

  it('makes the score unavailable for zero-risk and unbounded-loss denominators', () => {
    const zeroRisk = available(workspace({ legs: [optionLeg({ entryPremium: 0, fees: 0 })] }));
    const unbounded = available(workspace({ legs: [optionLeg({ side: 'sell' })] }));
    expect(zeroRisk.call?.status).toBe('unavailable');
    expect(zeroRisk.call?.reason).toContain('finite positive maxLoss');
    expect(unbounded.call?.status).toBe('unavailable');
    expect(unbounded.call?.metrics).toBeNull();
  });

  it('reports dropped inputs and fails the positive-edge minimum common-path gate', () => {
    const result = available(workspace(), [...Array(998).fill(120), Number.NaN, Number.POSITIVE_INFINITY]);
    expect(result.pathSet).toEqual(expect.objectContaining({ requestedPaths: 1_000, generatedPaths: 1_000, commonValidPaths: 998, droppedPaths: 2 }));
    expect(result.call?.positiveEdge).toBe(false);
    expect(result.call?.positiveEdgeReasons.join(' ')).toContain('1,000');
  });

  it('caps ProfitFactor when paths have profit but no loss and returns zero with loss but no profit', () => {
    const allProfit = available(workspace(), Array(1_000).fill(140));
    const allLoss = available(workspace(), Array(1_000).fill(50));
    expect(allProfit.call?.metrics?.profitFactor).toBe(PROFIT_FACTOR_CAP);
    expect(allLoss.call?.metrics?.profitFactor).toBe(0);
  });

  it('keeps risk-neutral and forecast probability labels distinct', () => {
    const forecast = available(workspace());
    const riskNeutralInput = workspace({ monteCarlo: { ...workspace().monteCarlo, driftMode: 'risk-neutral' } });
    const riskNeutral = available(riskNeutralInput);
    expect(forecast.probabilityLabel).toBe('Forecast probability');
    expect(riskNeutral.probabilityLabel).toBe('Risk-neutral probability');
    expect(riskNeutral.probabilityLabel).not.toMatch(/real-world/i);
  });

  it('does not use supplied Greeks directly as directional score inputs', () => {
    const input = workspace();
    const altered = workspace({ legs: input.legs.map((leg) => ({ ...leg, delta: -1, gamma: 999, theta: 999, vega: -999, rho: 999 })) });
    const paths = [...Array(600).fill(125), ...Array(400).fill(80)];
    expect(calculateCallPutScenarioScore(altered, altered.monteCarlo, paths))
      .toEqual(calculateCallPutScenarioScore(input, input.monteCarlo, paths));
  });

  it('uses ES95 once and does not expose P5 or VaR as weighted components', () => {
    const result = calculateEdgeScore({ probabilityOfProfit: 0.5, evr: 0, medianR: 0, es95R: -0.25, profitFactor: 1, robustness: 0.5 });
    expect(result.components.tail).toBe(75);
    expect(Object.keys(result.components)).toEqual(['pop', 'ev', 'median', 'tail', 'payoff', 'robustness']);
  });

  it('is deterministic for the same seed and reuses the generated path-set identity', () => {
    const input = comparisonWorkspace();
    const firstPaths = generateMonteCarloPathSet(input, input.monteCarlo, { targetPrice: 110 });
    const secondPaths = generateMonteCarloPathSet(input, input.monteCarlo, { targetPrice: 110 });
    expect(firstPaths.id).toBe(secondPaths.id);
    expect(firstPaths.terminalPrices).toEqual(secondPaths.terminalPrices);
    expect(calculateCallPutScenarioScore(input, input.monteCarlo, firstPaths))
      .toEqual(calculateCallPutScenarioScore(input, input.monteCarlo, secondPaths));
  });

  it('keeps USD calculation results unchanged when values are formatted for THB display', () => {
    const result = available(workspace());
    const before = structuredClone(result);
    convertUsdForDisplay(result.call?.metrics?.expectedPnL ?? 0, 'THB', 35);
    convertUsdForDisplay(result.call?.metrics?.maxLoss ?? 0, 'THB', 35);
    expect(result).toEqual(before);
  });
});
