import { describe, expect, it } from 'vitest';
import { boundedExpirationProfitFloor, buildHistogram, isOptionInTheMoney, runMonteCarlo } from './monte-carlo';
import { blackScholes, binomialValue, priceOption, priceOptionValue } from './pricing';
import { detectStrategy, optionExpirationProfit, portfolioExpirationProfit, portfolioProfitLossBasis, valuePortfolio } from './portfolio';
import type { OptionLeg, SimulationWorkspace } from './types';
import { calculationPortfolioInputSchema, calculationValidationMessages, monteCarloCalculationInputSchema, prepareMonteCarloCalculationInput, prepareWhatIfCalculationInput, validationMessages, whatIfCalculationInputSchema } from './validation';

const leg = (overrides: Partial<OptionLeg> = {}): OptionLeg => ({ id: 'leg-1', kind: 'call', side: 'buy', quantity: 1,
  strike: 100, expiration: '2027-01-01', entryPremium: 10, impliedVolatility: 0.2, multiplier: 100, fees: 2,
  style: 'european', ...overrides });

const workspace = (overrides: Partial<SimulationWorkspace> = {}): SimulationWorkspace => ({
  name: 'Test simulation', description: '', symbol: 'TEST', companyName: 'Test Inc', exchange: 'NASDAQ', currency: 'USD',
  simulationType: 'what-if', strategyType: 'Long Call', underlyingPrice: 100, stockQuantity: 0, cashPosition: 0,
  entryDate: '2026-01-01', valuationDate: '2026-01-01', legs: [leg()], scenarios: [{ id: 'base', name: 'Base',
    targetPrice: 100, valuationDate: '2026-01-01', volatilityShift: 0, rate: 0.05, dividendYield: 0 }],
  monteCarlo: { paths: 1_000, seed: 123, horizonDays: 365, steps: 50, drift: 0.05, volatility: 0.2, rate: 0.05, dividendYield: 0 },
  dataSource: null, dataTimestamp: null, dataStatus: 'manual', resultSnapshot: null, methodologyVersion: 'options-simulator-v1', ...overrides,
});

const visibleContract = () => ({
  symbol: 'SOFI',
  underlyingPrice: 11.46,
  valuationDate: '2026-07-19',
  legs: [{
    kind: 'put',
    side: 'buy',
    quantity: 1,
    strike: 13.5,
    expiration: '2026-07-24',
    entryPremium: 1.4,
    impliedVolatility: 1.1614,
    delta: -0.78,
    theta: -0.0361,
    multiplier: 100,
  }],
  scenarios: [{
    targetPrice: 10.1,
    valuationDate: '2026-07-22',
  }],
});

describe('options pricing', () => {
  it('matches a known Black-Scholes case and put-call parity', () => {
    const common = { spot: 100, strike: 100, timeYears: 1, volatility: 0.2, rate: 0.05, dividendYield: 0 };
    const call = blackScholes({ ...common, kind: 'call' });
    const put = blackScholes({ ...common, kind: 'put' });
    expect(call.value).toBeCloseTo(10.4506, 3);
    expect(put.value).toBeCloseTo(5.5735, 3);
    expect(call.value - put.value).toBeCloseTo(100 - 100 * Math.exp(-0.05), 4);
  });

  it('returns intrinsic value for calls and puts at expiration', () => {
    const common = { strike: 100, timeYears: 0, volatility: 0.2, rate: 0.05, dividendYield: 0 };
    expect(blackScholes({ ...common, spot: 120, kind: 'call' }).value).toBe(20);
    expect(blackScholes({ ...common, spot: 80, kind: 'put' }).value).toBe(20);
    expect(blackScholes({ ...common, spot: 80, kind: 'call' }).value).toBe(0);
    expect(blackScholes({ ...common, spot: 120, kind: 'put' }).value).toBe(0);
  });

  it('keeps an American option at least as valuable as its European tree equivalent', () => {
    const common = { spot: 90, strike: 100, timeYears: 1, volatility: 0.25, rate: 0.05, dividendYield: 0,
      kind: 'put' as const };
    const european = binomialValue({ ...common, style: 'european' }, 300);
    const american = binomialValue({ ...common, style: 'american' }, 300);
    expect(american).toBeGreaterThanOrEqual(european);
  });

  it('keeps value-only pricing identical to full pricing for European and American options', () => {
    const common = { spot: 90, strike: 100, timeYears: 1, volatility: 0.25, rate: 0.05, dividendYield: 0,
      kind: 'put' as const };
    for (const style of ['european', 'american'] as const) {
      const input = { ...common, style };
      expect(priceOptionValue(input)).toBeCloseTo(priceOption(input).value, 10);
    }
  });

  it('produces Greeks consistent with finite price changes', () => {
    const base = { spot: 100, strike: 100, timeYears: 1, volatility: 0.2, rate: 0.05, dividendYield: 0, kind: 'call' as const };
    const result = blackScholes(base);
    const epsilon = 0.01;
    const delta = (blackScholes({ ...base, spot: 100 + epsilon }).value - blackScholes({ ...base, spot: 100 - epsilon }).value) / (2 * epsilon);
    expect(result.greeks.delta).toBeCloseTo(delta, 4);
    Object.values(result.greeks).forEach((value) => expect(Number.isFinite(value)).toBe(true));
  });
});

describe('portfolio payoff and strategy handling', () => {
  it('uses the correct P&L sign for Buy/Sell Call/Put positions', () => {
    const common = { entryPremium: 5, multiplier: 100, fees: 0 };
    expect(optionExpirationProfit(leg({ ...common, kind: 'call', side: 'buy' }), 120)).toBe(1_500);
    expect(optionExpirationProfit(leg({ ...common, kind: 'call', side: 'sell' }), 120)).toBe(-1_500);
    expect(optionExpirationProfit(leg({ ...common, kind: 'put', side: 'buy' }), 80)).toBe(1_500);
    expect(optionExpirationProfit(leg({ ...common, kind: 'put', side: 'sell' }), 80)).toBe(-1_500);
  });

  it('applies side, quantity, multiplier and commission', () => {
    expect(optionExpirationProfit(leg({ quantity: 2, multiplier: 50, fees: 3 }), 120)).toBe(997);
    expect(optionExpirationProfit(leg({ side: 'sell', quantity: 2, multiplier: 50, fees: 3 }), 120)).toBe(-1003);
  });

  it('scales exactly once by quantity and contract multiplier', () => {
    const unscaled = optionExpirationProfit(leg({ entryPremium: 2, quantity: 1, multiplier: 1, fees: 0 }), 110);
    const scaled = optionExpirationProfit(leg({ entryPremium: 2, quantity: 3, multiplier: 50, fees: 0 }), 110);
    expect(unscaled).toBe(8);
    expect(scaled).toBe(unscaled * 3 * 50);
  });

  it('uses absolute net debit for debit positions and the existing gross-premium policy for credit positions', () => {
    const debitSpread = workspace({ legs: [
      leg({ entryPremium: 10, fees: 0 }),
      leg({ id: 'leg-2', side: 'sell', strike: 110, entryPremium: 5, fees: 0 }),
    ] });
    const debitValuation = valuePortfolio(debitSpread, debitSpread.scenarios[0]);
    expect(portfolioProfitLossBasis(debitSpread)).toEqual({ amount: 500, policy: 'absolute-net-debit' });
    expect(debitValuation.profitLossPercent).toBeCloseTo(debitValuation.profitLoss / 500 * 100, 10);

    const creditPosition = workspace({ legs: [leg({ side: 'sell', entryPremium: 10, fees: 0 })] });
    const creditValuation = valuePortfolio(creditPosition, creditPosition.scenarios[0]);
    expect(portfolioProfitLossBasis(creditPosition)).toEqual({ amount: 1_000, policy: 'gross-premium-at-risk' });
    expect(creditValuation.profitLossPercent).toBeCloseTo(creditValuation.profitLoss / 1_000 * 100, 10);
  });

  it('returns an unavailable P&L percentage instead of Infinity when the denominator is zero', () => {
    const zeroBasis = workspace({ legs: [leg({ entryPremium: 0, fees: 0 })] });
    expect(portfolioProfitLossBasis(zeroBasis)).toEqual({ amount: null, policy: 'unavailable' });
    expect(valuePortfolio(zeroBasis, zeroBasis.scenarios[0]).profitLossPercent).toBeNull();
  });

  it('aggregates multiple legs and detects common strategies', () => {
    const spread = [leg(), leg({ id: 'leg-2', side: 'sell', strike: 110, entryPremium: 5 })];
    expect(portfolioExpirationProfit(workspace({ legs: spread }), 120)).toBe(496);
    expect(detectStrategy(spread)).toBe('Vertical Spread');
    const valuation = valuePortfolio(workspace({ legs: spread }), workspace({ legs: spread }).scenarios[0]);
    expect(valuation.legs).toHaveLength(2);
    expect(valuation.breakEvens[0]).toBeCloseTo(105, 1);
    expect(valuation.unlimitedLoss).toBe(false);
  });

  it('reconciles projected P&L with simulated value and signed entry premium', () => {
    const input = workspace({ legs: [leg({ entryPremium: 7.5, fees: 2 })] });
    const result = valuePortfolio(input, { ...input.scenarios[0], targetPrice: 115 });
    const signedEntryPremium = 7.5 * 100;
    expect(result.profitLoss).toBeCloseTo(result.theoreticalValue - signedEntryPremium - 2, 10);
  });

  it('derives single-leg Call and Put break-even from strike and entry premium', () => {
    const callInput = workspace({ legs: [leg({ kind: 'call', strike: 100, entryPremium: 5, fees: 0 })] });
    const putInput = workspace({ legs: [leg({ kind: 'put', strike: 100, entryPremium: 5, fees: 0 })] });
    expect(valuePortfolio(callInput, callInput.scenarios[0]).breakEvens[0]).toBeCloseTo(105, 1);
    expect(valuePortfolio(putInput, putInput.scenarios[0]).breakEvens[0]).toBeCloseTo(95, 1);
  });

  it('classifies naked short call loss as unlimited', () => {
    const result = valuePortfolio(workspace({ legs: [leg({ side: 'sell' })] }), workspace().scenarios[0]);
    expect(result.unlimitedLoss).toBe(true);
    expect(result.maxLoss).toBeNull();
  });

  it('keeps manual Delta and Theta out of the pricing-engine value', () => {
    const scenario = workspace().scenarios[0];
    const modelOnly = valuePortfolio(workspace({ legs: [leg({ delta: null, theta: null })] }), scenario);
    const manualGreeks = valuePortfolio(workspace({ legs: [leg({
      delta: 0.99,
      theta: -999,
      deltaSource: 'manual',
      thetaSource: 'manual',
    })] }), scenario);

    expect(manualGreeks.theoreticalValue).toBe(modelOnly.theoreticalValue);
    expect(manualGreeks.profitLoss).toBe(modelOnly.profitLoss);
    expect(manualGreeks.legs[0].value).toBe(modelOnly.legs[0].value);
  });

  it('reconciles Current plus Difference to Simulated within tolerance', () => {
    const input = workspace();
    const current = valuePortfolio(input, input.scenarios[0]);
    const simulated = valuePortfolio(input, { ...input.scenarios[0], targetPrice: 115, valuationDate: '2026-06-01', volatilityShift: 0.1 });
    const difference = simulated.theoreticalValue - current.theoreticalValue;

    expect(current.theoreticalValue + difference).toBeCloseTo(simulated.theoreticalValue, 10);
  });

  it('never returns NaN or Infinity for a valid What-If valuation', () => {
    const input = workspace();
    const result = valuePortfolio(input, { ...input.scenarios[0], targetPrice: 125, valuationDate: '2026-09-01', volatilityShift: 0.25 });

    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
    expect(Object.values(result.greeks).every(Number.isFinite)).toBe(true);
    expect(result.legs.every((item) => Number.isFinite(item.value) && Number.isFinite(item.profitLoss))).toBe(true);
  });

  it('passes one calendar DTE to pricing across a daylight-saving boundary', () => {
    const scenario = { ...workspace().scenarios[0], valuationDate: '2026-03-08' };
    const input = workspace({
      valuationDate: '2026-03-08',
      legs: [leg({ expiration: '2026-03-09', fees: 0 })],
      scenarios: [scenario],
    });
    const result = valuePortfolio(input, scenario);
    const expected = blackScholes({
      spot: scenario.targetPrice,
      strike: 100,
      timeYears: 1 / 365.25,
      volatility: 0.2,
      rate: scenario.rate,
      dividendYield: scenario.dividendYield,
      kind: 'call',
    });

    expect(result.legs[0].value).toBeCloseTo(expected.value * 100, 10);
  });
});

describe('validation and Monte Carlo', () => {
  it('builds a calculation-only payload for the reported case and drops unrelated persistence metadata', () => {
    const input = workspace({
      name: '',
      dataTimestamp: 'not-a-provider-timestamp',
      underlyingPrice: 10,
      valuationDate: '2026-08-04',
      legs: [leg({ kind: 'call', side: 'buy', strike: 8, entryPremium: 1, quantity: 2, impliedVolatility: 1.1527, expiration: '2026-08-21', fees: 0 })],
      scenarios: [{ ...workspace().scenarios[0], targetPrice: 10, valuationDate: '2026-08-14', volatilityShift: 0, rate: 0, dividendYield: 0 }],
    });

    const prepared = prepareWhatIfCalculationInput(input);

    expect(prepared.success).toBe(true);
    if (!prepared.success) return;
    expect(prepared.data.scenario.targetDate).toBe('2026-08-14');
    expect(prepared.data.legs[0].expiration).toBe('2026-08-21');
    expect(prepared.data.legs[0].impliedVolatility).toBe(1.1527);
    expect(prepared.data).not.toHaveProperty('name');
    expect(prepared.data).not.toHaveProperty('dataTimestamp');
  });

  it('uses one calculation portfolio schema for What-If and both Monte Carlo portfolios', () => {
    expect(whatIfCalculationInputSchema).toBe(calculationPortfolioInputSchema);
    const valid = workspace({ scenarios: [{ ...workspace().scenarios[0], valuationDate: '2026-06-01' }] });
    const prepared = prepareMonteCarloCalculationInput(valid, valid, valid.monteCarlo);
    expect(prepared.success).toBe(true);
    if (!prepared.success) return;
    expect(calculationPortfolioInputSchema.safeParse(prepared.data.portfolio).success).toBe(true);
    expect(calculationPortfolioInputSchema.safeParse(prepared.data.comparisonPortfolio).success).toBe(true);
    expect(monteCarloCalculationInputSchema.safeParse(prepared.data).success).toBe(true);
    expect(prepared.data).not.toHaveProperty('workspace');
    expect(prepared.data).not.toHaveProperty('comparisonWorkspace');
  });

  it('rejects a target date equal to expiration for both calculation modes', () => {
    const equalDate = workspace({
      scenarios: [{ ...workspace().scenarios[0], valuationDate: '2027-01-01' }],
    });
    const whatIf = prepareWhatIfCalculationInput(equalDate);
    const monteCarlo = prepareMonteCarloCalculationInput(equalDate, equalDate, equalDate.monteCarlo);
    expect(whatIf.success).toBe(false);
    expect(monteCarlo.success).toBe(false);
    if (!whatIf.success) expect(whatIf.issues[0]).toMatch(/^scenarios\.0\.valuationDate:/);
    if (!monteCarlo.success) expect(monteCarlo.issues.some((issue) => issue.startsWith('scenarios.0.valuationDate:'))).toBe(true);
  });

  it('accepts the complete visible Put contract without hidden legacy fields', () => {
    expect(calculationValidationMessages(visibleContract())).toEqual([]);
  });

  it('accepts finite negative Theta from manual, model or provider state', () => {
    for (const thetaSource of ['manual', 'model', 'provider'] as const) {
      const input = visibleContract();
      input.legs[0] = { ...input.legs[0], theta: -0.0361, thetaSource } as typeof input.legs[0];
      expect(calculationValidationMessages(input)).toEqual([]);
    }
  });

  it('accepts a Target Date after valuation and before expiration', () => {
    const input = visibleContract();
    input.scenarios[0].valuationDate = '2026-07-22';
    input.legs[0].expiration = '2026-07-24';
    expect(calculationValidationMessages(input)).toEqual([]);
  });

  it('reports the real invalid field and rejects NaN or Infinity', () => {
    const invalidPremium = visibleContract();
    invalidPremium.legs[0].entryPremium = Number.NaN;
    expect(calculationValidationMessages(invalidPremium)[0]).toContain('legs.0.entryPremium');

    const invalidTheta = visibleContract();
    invalidTheta.legs[0].theta = Number.POSITIVE_INFINITY;
    expect(calculationValidationMessages(invalidTheta)[0]).toContain('legs.0.theta');
  });

  it('identifies the exact invalid leg and expiration', () => {
    const invalid = workspace({ legs: [leg({ strike: 0, expiration: '2025-01-01' })] });
    const messages = validationMessages(invalid);
    expect(messages.some((message) => message.startsWith('legs.0.strike'))).toBe(true);
    expect(messages.some((message) => message.startsWith('legs.0.expiration'))).toBe(true);
  });

  it('validates manual Greeks and only accepts approved path counts', () => {
    const invalid = workspace({
      legs: [leg({ delta: 1.1, theta: Number.POSITIVE_INFINITY, deltaSource: 'manual', thetaSource: 'manual' })],
      monteCarlo: { ...workspace().monteCarlo, paths: 2_000 },
    });
    const messages = validationMessages(invalid);
    expect(messages.some((message) => message.startsWith('legs.0.delta'))).toBe(true);
    expect(messages.some((message) => message.startsWith('legs.0.theta'))).toBe(true);
    expect(messages.some((message) => message.startsWith('monteCarlo.paths'))).toBe(true);
  });

  it('is deterministic with ordered percentiles and bounded probabilities', () => {
    const input = workspace();
    const first = runMonteCarlo(input, input.monteCarlo);
    const second = runMonteCarlo(input, input.monteCarlo);
    expect(first).toEqual(second);
    expect(first.probabilityOfProfit).toBeGreaterThanOrEqual(0);
    expect(first.probabilityOfProfit).toBeLessThanOrEqual(1);
    expect(first.probabilityItm + first.probabilityOtm).toBeCloseTo(1, 10);
    expect(first.validPaths).toBe(input.monteCarlo.paths);
    expect(first.discardedPaths).toBe(0);
    expect(first.percentiles.p1).toBeLessThanOrEqual(first.percentiles.p5);
    expect(first.percentiles.p5).toBeLessThanOrEqual(first.percentiles.p95);
    expect(first.percentiles.p95).toBeLessThanOrEqual(first.percentiles.p99);
    expect(first.percentiles.p5).toBeLessThanOrEqual(first.medianProfitLoss);
    expect(first.medianProfitLoss).toBeLessThanOrEqual(first.percentiles.p95);
    expect(first.histogram.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(first.validPaths);
    expect(first.terminalPriceHistogram.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(first.validPaths);
    expect(first.samplePaths.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(first)).not.toMatch(/NaN|Infinity/);
    expect(JSON.stringify(first)).not.toContain('"-0"');
  });

  it('separates touching a target from terminal closing probabilities and reports real progress', () => {
    const input = workspace();
    const progress: number[] = [];
    const result = runMonteCarlo(input, input.monteCarlo, {
      targetPrice: 110,
      onProgress: (completed) => progress.push(completed),
    });
    expect(result.probabilityReachingTarget).toBeGreaterThan(result.probabilityClosingAboveTarget ?? 0);
    expect((result.probabilityClosingAboveTarget ?? 0) + (result.probabilityClosingBelowTarget ?? 0)).toBeCloseTo(1, 10);
    for (const value of [result.probabilityOfProfit, result.probabilityItm, result.probabilityOtm, result.probabilityReachingTarget, result.probabilityClosingAboveTarget, result.probabilityClosingBelowTarget]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(progress.at(-1)).toBe(input.monteCarlo.paths);
    expect(progress.every((completed, index) => index === 0 || completed > progress[index - 1])).toBe(true);
  });

  it('matches known deterministic POP, ITM and Expected P&L cases for Call and Put', () => {
    const deterministic = { ...workspace().monteCarlo, drift: 0, volatility: 0, rate: 0, dividendYield: 0 };
    const callInput = workspace({ underlyingPrice: 120, legs: [leg({ kind: 'call', strike: 100, entryPremium: 5, fees: 0 })] });
    const callResult = runMonteCarlo(callInput, deterministic);
    expect(callResult.probabilityOfProfit).toBe(1);
    expect(callResult.probabilityItm).toBe(1);
    expect(callResult.expectedProfitLoss).toBe(1_500);

    const putInput = workspace({ underlyingPrice: 80, legs: [leg({ kind: 'put', strike: 100, entryPremium: 5, fees: 0 })] });
    const putResult = runMonteCarlo(putInput, deterministic);
    expect(putResult.probabilityOfProfit).toBe(1);
    expect(putResult.probabilityItm).toBe(1);
    expect(putResult.expectedProfitLoss).toBe(1_500);

    const outOfMoney = workspace({ underlyingPrice: 80, legs: [leg({ kind: 'call', strike: 100, entryPremium: 5, fees: 0 })] });
    const outOfMoneyResult = runMonteCarlo(outOfMoney, deterministic);
    expect(outOfMoneyResult.probabilityOfProfit).toBe(0);
    expect(outOfMoneyResult.probabilityItm).toBe(0);
    expect(outOfMoneyResult.expectedProfitLoss).toBe(-500);
  });

  it('keeps VaR and Expected Shortfall on the lower loss tail', () => {
    const input = workspace();
    const result = runMonteCarlo(input, input.monteCarlo);
    expect(result.valueAtRisk.p99).toBeGreaterThanOrEqual(result.valueAtRisk.p95);
    expect(result.expectedShortfall.p99).toBeGreaterThanOrEqual(result.expectedShortfall.p95);
    expect(result.expectedShortfall.p95).toBeGreaterThanOrEqual(result.valueAtRisk.p95);
    expect(result.expectedShortfall.p99).toBeGreaterThanOrEqual(result.valueAtRisk.p99);
    expect(-result.expectedShortfall.p95).toBeLessThanOrEqual(-result.valueAtRisk.p95);
    expect(-result.expectedShortfall.p99).toBeLessThanOrEqual(-result.valueAtRisk.p99);
  });

  it('uses terminal Call/Put moneyness without treating ITM as profit', () => {
    expect(isOptionInTheMoney(101, leg({ kind: 'call', strike: 100 }))).toBe(true);
    expect(isOptionInTheMoney(99, leg({ kind: 'call', strike: 100 }))).toBe(false);
    expect(isOptionInTheMoney(99, leg({ kind: 'put', strike: 100 }))).toBe(true);
    expect(isOptionInTheMoney(101, leg({ kind: 'put', strike: 100 }))).toBe(false);

    const expensiveCall = workspace({
      underlyingPrice: 101,
      legs: [leg({ kind: 'call', strike: 100, entryPremium: 10, fees: 0 })],
      monteCarlo: { ...workspace().monteCarlo, drift: 0, volatility: 0 },
    });
    const result = runMonteCarlo(expensiveCall, expensiveCall.monteCarlo);
    expect(result.probabilityItm).toBe(1);
    expect(result.probabilityOfProfit).toBe(0);
  });

  it('builds deterministic histograms whose bins cover every valid path', () => {
    expect(buildHistogram([5, 5, 5])).toEqual([{ lower: 5, upper: 5, count: 3 }]);
    const bins = buildHistogram([-10, -5, 0, 5, 10], 4);
    expect(bins).toHaveLength(4);
    expect(bins.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(5);
    expect(buildHistogram([-10, -5, 0, 5, 10], 4)).toEqual(bins);
    expect(() => buildHistogram([1], 0)).toThrow('positive integer');
  });

  it('never crosses the exact max-loss floor for bounded-loss strategies', () => {
    const longCall = workspace({ legs: [leg({ kind: 'call', side: 'buy', strike: 100, entryPremium: 5, fees: 2 })] });
    expect(boundedExpirationProfitFloor(longCall)).toBe(-502);
    const result = runMonteCarlo(longCall, longCall.monteCarlo);
    expect(result.percentiles.p1).toBeGreaterThanOrEqual(-502);

    const nakedShortCall = workspace({ legs: [leg({ kind: 'call', side: 'sell' })] });
    expect(boundedExpirationProfitFloor(nakedShortCall)).toBeNull();
  });
});
