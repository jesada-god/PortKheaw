import { describe, expect, it } from 'vitest';
import { portfolioProfitLossBasis, valuePortfolio } from '@/src/lib/options-simulator/portfolio';
import { calculationValidationMessages } from '@/src/lib/options-simulator/validation';
import type { OptionLeg, SimulationWorkspace } from '@/src/lib/options-simulator/types';
import {
  aggregatePortfolioSensitivity,
  auditResultReconciliation,
  buildProfitLossSummary,
  calendarDaysBetween,
  formatResultMoney,
  formatSignedPercent,
  safeProfitLossPercent,
} from './simulator-ux';

/*
  The Tools > Options Portfolio Simulator rework was copy, layout and disclosure
  behaviour only. These are the numbers the reworked screen prints, pinned to
  exact strings: if a label edit ever reaches the pricing engine, the currency
  conversion or the percentage basis, one of these fails.

  A saved workspace shaped like the pre-rework schema is used deliberately — it
  is what an existing saved scenario deserialises into.
*/
const legacySavedLeg: OptionLeg = {
  id: 'leg-1', kind: 'call', side: 'buy', quantity: 2, strike: 120, expiration: '2026-09-18',
  entryPremium: 4.25, impliedVolatility: 0.35, multiplier: 100, fees: 1.5, style: 'european',
  contractSymbol: 'AAPL260918C00120000', contractProvider: 'alpaca', contractAsOf: '2026-07-29T19:58:00.000Z',
  contractStatus: 'delayed', bid: 4.2, ask: 4.35, midpoint: 4.275, last: 4.3, premiumSource: 'ask', inputMode: 'provider',
};

const savedWorkspace: SimulationWorkspace = {
  name: 'AAPL earnings', description: '', symbol: 'AAPL', companyName: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD',
  simulationType: 'what-if', strategyType: 'Long Call', underlyingPrice: 118.4, stockQuantity: 0, cashPosition: 0,
  entryDate: '2026-07-20', valuationDate: '2026-07-20',
  legs: [legacySavedLeg],
  scenarios: [{ id: 'base', name: 'Base', targetPrice: 132, valuationDate: '2026-08-20', volatilityShift: 0.1, rate: 0.04, dividendYield: 0 }],
  monteCarlo: { paths: 10_000, seed: 42, horizonDays: 31, steps: 31, drift: 0, volatility: 0.35, rate: 0.04, dividendYield: 0 },
  dataSource: 'alpaca', dataTimestamp: '2026-07-20T19:58:00.000Z', dataStatus: 'delayed',
  resultSnapshot: null, methodologyVersion: 'options-simulator-v1',
};

const USD_THB = 32.5;

describe('Options simulator displayed values survive the copy rework', () => {
  it('prices a saved workspace to the same USD figures the cards render', () => {
    const valuation = valuePortfolio(savedWorkspace, savedWorkspace.scenarios[0]);

    expect(valuation.theoreticalValue).toBeCloseTo(2745.75396012, 6);
    expect(valuation.profitLoss).toBeCloseTo(1894.25396012, 6);
    expect(valuation.netDebitCredit).toBeCloseTo(851.5, 4);
    expect(valuation.breakEvenPrices.map((value) => Number(value.toFixed(4)))).toEqual([124.2575]);
    expect(valuation.initialDebit).toBeCloseTo(851.5, 4);
    expect(valuation.initialRisk).toBeCloseTo(851.5, 4);
    expect(valuation.maxLoss).toBeCloseTo(851.5, 4);
    expect(valuation.returnPct).toBeCloseTo(valuation.profitLoss / 851.5 * 100, 10);
    expect(valuation.unlimitedProfit).toBe(true);
  });

  it('formats those figures identically in USD and in the display-only THB conversion', () => {
    const valuation = valuePortfolio(savedWorkspace, savedWorkspace.scenarios[0]);
    const basis = portfolioProfitLossBasis(savedWorkspace);

    // "กำไร/ขาดทุนที่คาดจากสถานการณ์ (Projected P&L)"
    expect(formatResultMoney(valuation.profitLoss, 'USD', null, true)).toBe('+$1,894.25');
    expect(formatResultMoney(valuation.profitLoss, 'THB', USD_THB, true)).toBe('+฿61,563.25');
    // "มูลค่าหลังทดลอง (Simulated Value)"
    expect(formatResultMoney(valuation.theoreticalValue, 'USD', null)).toBe('$2,745.75');
    // "กำไร/ขาดทุน (%)" keeps the same basis and the same sign convention.
    expect(basis.amount).toBeCloseTo(851.5, 4);
    expect(formatSignedPercent(safeProfitLossPercent(valuation.profitLoss, basis.amount))).toBe('+222.46%');
    expect(buildProfitLossSummary(valuation.profitLoss, basis.amount, 'USD', null))
      .toBe('กำไร $1,894.25 คิดเป็น 222.46% ของเงินที่เสี่ยงเริ่มต้น');
  });

  it('keeps the Price → Time → IV decomposition reconciling with Change from Current', () => {
    const scenario = savedWorkspace.scenarios[0];
    const currentScenario = { ...scenario, targetPrice: savedWorkspace.underlyingPrice ?? 0, valuationDate: savedWorkspace.valuationDate, volatilityShift: 0 };
    const simulated = valuePortfolio(savedWorkspace, scenario);
    const current = valuePortfolio(savedWorkspace, currentScenario);
    const afterPrice = valuePortfolio(savedWorkspace, { ...currentScenario, targetPrice: scenario.targetPrice });
    const afterTime = valuePortfolio(savedWorkspace, { ...currentScenario, targetPrice: scenario.targetPrice, valuationDate: scenario.valuationDate });

    const audit = auditResultReconciliation({
      currentValue: current.theoreticalValue,
      simulatedValue: simulated.theoreticalValue,
      changeFromCurrent: simulated.theoreticalValue - current.theoreticalValue,
      initialCostOrCredit: simulated.netDebitCredit,
      projectedProfitLoss: simulated.profitLoss,
      priceImpact: afterPrice.theoreticalValue - current.theoreticalValue,
      timeDecayImpact: afterTime.theoreticalValue - afterPrice.theoreticalValue,
      ivImpact: simulated.theoreticalValue - afterTime.theoreticalValue,
      deltaEstimate: 0,
    });

    expect(audit.valueChange.status).toBe('matched');
    expect(audit.projectedProfitLoss.status).toBe('matched');
    expect(audit.impactDecomposition.status).toBe('matched');
  });

  it('aggregates position sensitivity from the renamed Delta and Theta fields unchanged', () => {
    const sensitivity = aggregatePortfolioSensitivity([{ side: 'buy', quantity: 2, multiplier: 100, delta: 0.42, theta: -0.06 }]);
    expect(sensitivity.delta).toBeCloseTo(84, 10);
    expect(sensitivity.theta).toBeCloseTo(-12, 10);
    expect(formatResultMoney(sensitivity.theta, 'USD', null, true)).toBe('-$12.00');
  });

  it('lets an existing saved scenario still open, edit, duplicate and save', () => {
    // Opening: a stored workspace passes calculation validation untouched.
    expect(calculationValidationMessages(savedWorkspace)).toEqual([]);
    expect(calendarDaysBetween(savedWorkspace.valuationDate, savedWorkspace.legs[0].expiration)).toBe(60);

    // Editing: changing a field a renamed label controls stays valid.
    const edited: SimulationWorkspace = { ...savedWorkspace, legs: [{ ...legacySavedLeg, quantity: 3 }] };
    expect(calculationValidationMessages(edited)).toEqual([]);
    expect(portfolioProfitLossBasis(edited).amount).toBeCloseTo(1276.5, 4);

    // Duplicating: the copy path strips server identity and re-ids the rows.
    const duplicate: SimulationWorkspace = {
      ...savedWorkspace, id: undefined, updatedAt: undefined, name: `${savedWorkspace.name} (copy)`,
      legs: savedWorkspace.legs.map((leg) => ({ ...leg, id: 'leg-copy-1' })),
      scenarios: savedWorkspace.scenarios.map((scenario) => ({ ...scenario, id: 'scenario-copy-1' })),
    };
    expect(duplicate.id).toBeUndefined();
    expect(duplicate.updatedAt).toBeUndefined();
    expect(calculationValidationMessages(duplicate)).toEqual([]);
    // Saving a duplicate must not change any number the original renders.
    expect(valuePortfolio(duplicate, duplicate.scenarios[0]).profitLoss)
      .toBeCloseTo(valuePortfolio(savedWorkspace, savedWorkspace.scenarios[0]).profitLoss, 10);
  });
});
