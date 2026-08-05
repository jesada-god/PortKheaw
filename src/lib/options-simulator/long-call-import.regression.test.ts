import { describe, expect, it } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import { importOptionContract, providerContractGaps } from './contract-import';
import { computeMonteCarlo, computeWhatIf } from './server-compute';
import type { SimulationWorkspace } from './types';
import { prepareMonteCarloCalculationInput, prepareWhatIfCalculationInput } from './validation';

/*
  A Long Call imported from the real options chain, traced through the exact
  active path a reader takes: chain snapshot → workspace legs → submit DTO →
  engine. Alpaca is the only entitled options provider and every one of its
  snapshots is `delayed`, so this is the shape production actually carries.

  Every assertion here failed before the import prefilled a delayed quoted side:
  the leg arrived with `entryPremium: 0`, which is precisely the input that makes
  the engine report a zero debit, a zero max loss, an unbounded initial risk, no
  break-even root, no return percentage, a Monte Carlo lower tail pinned at zero,
  and a projected P&L numerically identical to the simulated position value.
*/

const STRIKE = 310;
const ASK = 11.65;
const CONTRACTS = 2;
const MULTIPLIER = 100;
const DEBIT = ASK * CONTRACTS * MULTIPLIER;

const contract = (overrides: Partial<OptionContract> = {}): OptionContract => ({
  contractSymbol: 'AAPL260918C00310000', underlyingSymbol: 'AAPL', type: 'call',
  expiration: '2026-09-18', strike: STRIKE, bid: 11.42, ask: ASK, last: 11.38, mark: 11.535,
  volume: 3_582, openInterest: 17_238, impliedVolatility: 0.2651,
  delta: 0.5239, gamma: 0.014, theta: -0.1437, vega: 0.4273, rho: 0.1813,
  inTheMoney: false, multiplier: MULTIPLIER, currency: 'USD', provider: 'alpaca',
  marketDataProvider: 'alpaca-options-data', marketDataFeed: 'indicative', oiAsOf: '2026-08-03',
  delayedMinutes: null, valuationSource: 'provider',
  asOf: '2026-08-05T19:09:49.387Z', timestampKind: 'receipt', status: 'delayed',
  ...overrides,
});

const chain = (item = contract()): OptionsChain => ({
  underlyingSymbol: 'AAPL', spot: 309.38, expiration: item.expiration, expirations: [item.expiration],
  calls: [item], puts: [],
  provider: 'alpaca', asOf: '2026-08-05T19:09:50.316Z', timestampKind: 'receipt', status: 'delayed',
  delayedMinutes: 15, completeness: 1, warnings: [],
});

const seed = (): SimulationWorkspace => ({
  name: 'New', description: '', symbol: '', companyName: '', exchange: null, currency: 'USD',
  simulationType: 'monte-carlo', strategyType: 'Custom Multi-Leg', underlyingPrice: null,
  stockQuantity: 0, cashPosition: 0, entryDate: '2026-08-06', valuationDate: '2026-08-06',
  legs: [{ id: 'leg-1', kind: 'call', side: 'buy', quantity: CONTRACTS, strike: 0, expiration: '2026-09-05', entryPremium: 0, impliedVolatility: 0, multiplier: MULTIPLIER, fees: 0, style: 'european' }],
  scenarios: [{ id: 'scenario-1', name: 'Base', targetPrice: 0, valuationDate: '2026-08-07', volatilityShift: 0, rate: 0, dividendYield: 0 }],
  monteCarlo: { paths: 1_000, seed: 42, horizonDays: 30, steps: 30, drift: 0, volatility: 0.2, rate: 0, dividendYield: 0 },
  dataSource: null, dataTimestamp: null, dataStatus: 'unavailable', resultSnapshot: null, methodologyVersion: 'options-simulator-v1',
});

function importedWorkspace(): SimulationWorkspace {
  const workspace = importOptionContract(seed(), chain(), contract().contractSymbol);
  if (!workspace) throw new Error('The delayed chain snapshot must import');
  return { ...workspace, scenarios: workspace.scenarios.map((scenario) => ({ ...scenario, targetPrice: 340 })) };
}

describe('Long Call imported from a delayed provider chain', () => {
  it('carries the quoted premium, contracts and multiplier all the way into the submit DTO', () => {
    const workspace = importedWorkspace();
    expect(providerContractGaps(workspace)).toEqual([]);
    const prepared = prepareWhatIfCalculationInput(workspace);
    expect(prepared.success).toBe(true);
    if (!prepared.success) return;
    expect(prepared.data.legs[0]).toEqual(expect.objectContaining({
      kind: 'call', side: 'buy', quantity: CONTRACTS, strike: STRIKE, entryPremium: ASK, multiplier: MULTIPLIER,
    }));
  });

  it('holds every What-If invariant of a bought call', () => {
    const prepared = prepareWhatIfCalculationInput(importedWorkspace());
    if (!prepared.success) throw new Error(prepared.issues.join('; '));
    const { valuation } = computeWhatIf(prepared.data);

    expect(valuation.initialDebit).toBeCloseTo(DEBIT, 9);
    expect(valuation.initialRisk).toBeCloseTo(DEBIT, 9);
    expect(valuation.maxLoss).toBeCloseTo(DEBIT, 9);
    expect(valuation.unlimitedLoss).toBe(false);
    expect(valuation.breakEvenPrices).toHaveLength(1);
    expect(valuation.breakEvenPrices[0]).toBeCloseTo(STRIKE + ASK, 9);

    // Four distinct position-value meanings, none of them standing in for another.
    expect(valuation.costBasis).toBeCloseTo(DEBIT, 9);
    expect(valuation.projectedPnL).toBeCloseTo(valuation.simulatedValue - valuation.costBasis, 9);
    expect(valuation.changeFromCurrent).toBeCloseTo(valuation.simulatedValue - valuation.currentValue, 9);
    expect(valuation.projectedPnL).not.toBeCloseTo(valuation.simulatedValue, 6);
    expect(valuation.currentValue).not.toBeCloseTo(valuation.simulatedValue, 6);

    expect(valuation.returnPct).toBeCloseTo(valuation.projectedPnL / DEBIT * 100, 9);
  });

  it('holds every Monte Carlo invariant, with a net lower tail and a numeric score', () => {
    const workspace = importedWorkspace();
    const prepared = prepareMonteCarloCalculationInput(workspace, workspace, { ...workspace.monteCarlo, driftMode: 'forecast' });
    if (!prepared.success) throw new Error(prepared.issues.join('; '));
    const { result, scenarioScore } = computeMonteCarlo(prepared.data);

    expect(result.initialDebit).toBeCloseTo(DEBIT, 9);
    expect(result.initialRisk).toBeCloseTo(DEBIT, 9);
    expect(result.maxLoss).toBeCloseTo(DEBIT, 9);
    expect(result.breakEvenPrices).toHaveLength(1);
    expect(result.breakEvenPrices[0]).toBeCloseTo(STRIKE + ASK, 9);
    expect(result.returnPct).toBeCloseTo(result.expectedProfitLoss / DEBIT * 100, 9);

    // The lower tail is a net loss after the debit, never clamped up to zero.
    expect(result.percentiles.p5).toBeLessThan(0);
    expect(result.percentiles.p5).toBeGreaterThanOrEqual(-DEBIT);
    expect(result.valueAtRisk.p95).toBeGreaterThan(0);
    expect(result.expectedShortfall.p95).toBeGreaterThan(0);
    expect(result.expectedShortfall.p95).toBeGreaterThanOrEqual(result.valueAtRisk.p95);

    expect(scenarioScore.status).toBe('available');
    const scored = scenarioScore.status === 'available'
      ? scenarioScore.strategies.find((strategy) => strategy.status === 'available' && strategy.edgeScore !== null)
      : undefined;
    expect(Number.isFinite(scored?.status === 'available' ? scored.edgeScore : Number.NaN)).toBe(true);
  });

  /*
    The chain panel has usually just fetched the same expiration, so the import's
    own read comes back from cache. That is the snapshot the browser really hands
    the workspace, and it must carry the same debit as the first read.
  */
  it('carries the same debit from the cached snapshot the browser re-reads', () => {
    const item = contract({ status: 'cached' });
    const workspace = importOptionContract(seed(), { ...chain(item), status: 'cached' }, item.contractSymbol);
    expect(workspace?.legs[0]).toEqual(expect.objectContaining({ entryPremium: ASK, premiumSource: 'ask', contractStatus: 'cached' }));
    expect(providerContractGaps(workspace!)).toEqual([]);
  });

  it('refuses to calculate and names the field when the provider quotes no premium', () => {
    const workspace = importOptionContract(seed(), chain(contract({ bid: null, ask: null })), contract().contractSymbol);
    if (!workspace) throw new Error('The delayed chain snapshot must import');
    expect(providerContractGaps(workspace)).toEqual([{ path: 'legs.0.entryPremium', label: 'ราคาสัญญาต่อหุ้น (Premium)' }]);
    const prepared = prepareWhatIfCalculationInput(workspace);
    expect(prepared.success).toBe(false);
    if (prepared.success) return;
    expect(prepared.issues).toContain('legs.0.entryPremium: ราคาสัญญาต่อหุ้นต้องมากกว่า 0');
  });
});
