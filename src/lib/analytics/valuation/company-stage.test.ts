import { describe, expect, it } from 'vitest';
import { classifyCompanyStage } from './company-stage';
import { calculateFairValue } from './engine';
import { selectSectorModels } from './sector-selection';
import type { FinancialPeriod, ValuationInput } from './types';

const history = Array.from({ length: 60 }, (_, index) => ({
  date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
  open: 100, high: 105, low: 98, close: 102, volume: 3_000_000,
}));

// ── RKLB-shaped: revenue-generating but pre-profit (every profitability/cash line
// negative), no dividends. Same industry label as the mature primes below. ──
function preProfitPeriods(overrides: Partial<FinancialPeriod> = {}): FinancialPeriod[] {
  return [2022, 2023, 2024].map((year, index) => ({
    periodEnd: `${year}-12-31`, currency: 'USD',
    revenue: 210 + index * 110, grossProfit: 40 + index * 20,
    operatingIncome: -120 + index * 10, ebitda: -95 + index * 10, netIncome: -130 + index * 10,
    dilutedEps: -0.28 + index * 0.02, depreciationAmortization: 15, capitalExpenditure: -30,
    changeInWorkingCapital: 5, operatingCashFlow: -70 + index * 5, freeCashFlow: -100 + index * 5,
    dividendsPaid: null, interestExpense: 12, totalDebt: 465, cash: 420,
    totalAssets: 1_100, totalLiabilities: 720, totalEquity: 380, dilutedShares: 490,
    ...overrides,
  }));
}

// ── LMT/NOC-shaped: mature prime — sustained positive earnings & FCF, a multi-period
// dividend history, and only modest revenue growth. Same "Aerospace & Defense" label. ──
function maturePrimePeriods(overrides: Partial<FinancialPeriod> = {}): FinancialPeriod[] {
  return [2022, 2023, 2024].map((year, index) => ({
    periodEnd: `${year}-12-31`, currency: 'USD',
    revenue: 65_000 + index * 1_000, grossProfit: 9_000 + index * 200,
    operatingIncome: 8_000 + index * 100, ebitda: 9_000 + index * 100, netIncome: 6_500 + index * 100,
    dilutedEps: 25 + index, depreciationAmortization: 1_000, capitalExpenditure: -1_500,
    changeInWorkingCapital: 200, operatingCashFlow: 7_500 + index * 100, freeCashFlow: 6_000 + index * 100,
    dividendsPaid: -3_000, interestExpense: 500, totalDebt: 12_000, cash: 3_000,
    totalAssets: 55_000, totalLiabilities: 40_000, totalEquity: 15_000, dilutedShares: 250,
    ...overrides,
  }));
}

function rklbInput(overrides: Partial<ValuationInput> = {}): ValuationInput {
  return {
    symbol: 'RKLB', currency: 'USD', marketPrice: 21, marketCapitalization: 490 * 21,
    priceAsOf: '2025-01-02T00:00:00.000Z', source: 'alpha-vantage', sourceType: 'provider-supplied',
    sector: 'Industrials', industry: 'Aerospace & Defense',
    periods: preProfitPeriods(), historicalPrices: history, historySource: 'alpha-vantage',
    historyFreshness: { status: 'end-of-day', asOf: '2025-01-02T00:00:00.000Z', maxAgeSeconds: 86_400 },
    calculatedAt: '2025-01-03T00:00:00.000Z', ...overrides,
  };
}

function maturePrimeInput(overrides: Partial<ValuationInput> = {}): ValuationInput {
  return {
    symbol: 'LMT', currency: 'USD', marketPrice: 450, marketCapitalization: 250 * 450,
    priceAsOf: '2025-01-02T00:00:00.000Z', source: 'alpha-vantage', sourceType: 'provider-supplied',
    sector: 'Industrials', industry: 'Aerospace & Defense',
    periods: maturePrimePeriods(), historicalPrices: history, historySource: 'alpha-vantage',
    historyFreshness: { status: 'end-of-day', asOf: '2025-01-02T00:00:00.000Z', maxAgeSeconds: 86_400 },
    calculatedAt: '2025-01-03T00:00:00.000Z', ...overrides,
  };
}

const NOW = Date.parse('2025-01-03T00:00:00.000Z');
const FIVE_PEERS = ['ASTS', 'LUNR', 'RDW', 'PL', 'BKSY'].map((symbol, i) => ({ symbol, multiple: 6 + i * 3 }));

describe('classifyCompanyStage (fundamentals, not the industry label)', () => {
  it('classifies an RKLB-shaped name as pre-profit / high-growth', () => {
    const stage = classifyCompanyStage('Industrials', 'Aerospace & Defense', preProfitPeriods());
    expect(stage.stage).toBe('pre-profit-high-growth');
    expect(stage.supportsGrowthMultiple).toBe(true);
    expect(stage.reason).toMatch(/Pre-profit/);
    expect(stage.reason).toMatch(/FCF/);
  });

  it('classifies an LMT/NOC-shaped profitable prime as mature-profitable', () => {
    const stage = classifyCompanyStage('Industrials', 'Aerospace & Defense', maturePrimePeriods());
    expect(stage.stage).toBe('mature-profitable');
    expect(stage.supportsGrowthMultiple).toBe(false);
    expect(stage.reason).toMatch(/Mature profitable/);
    expect(stage.reason).toMatch(/เงินปันผล/);
  });

  it('gives the SAME industry two different stages purely from fundamentals', () => {
    const preProfit = classifyCompanyStage('Industrials', 'Aerospace & Defense', preProfitPeriods());
    const mature = classifyCompanyStage('Industrials', 'Aerospace & Defense', maturePrimePeriods());
    expect(preProfit.stage).not.toBe(mature.stage);
    expect(preProfit.supportsGrowthMultiple).toBe(true);
    expect(mature.supportsGrowthMultiple).toBe(false);
  });

  it('returns insufficient-data when there are no periods, never a guessed stage', () => {
    const stage = classifyCompanyStage('Industrials', 'Aerospace & Defense', []);
    expect(stage.stage).toBe('insufficient-data');
    expect(stage.supportsGrowthMultiple).toBe(false);
    expect(stage.reason).toMatch(/Insufficient-data/);
  });

  it('routes a financial institution to the financial stage (weak sector hint, no growth multiple)', () => {
    const stage = classifyCompanyStage('Financial Services', 'Banks—Regional', maturePrimePeriods());
    expect(stage.stage).toBe('financial');
    expect(stage.supportsGrowthMultiple).toBe(false);
  });
});

describe('stage gates the high-growth industry rule (Aerospace & Defense)', () => {
  it('routes a pre-profit Aerospace name to the high-growth rule', () => {
    const selection = selectSectorModels(rklbInput());
    expect(selection.stage.stage).toBe('pre-profit-high-growth');
    expect(selection.rule.ruleId).toBe('high-growth-industry-v1');
  });

  it('does NOT route a mature Aerospace prime to the high-growth rule (falls to the sector rule)', () => {
    const selection = selectSectorModels(maturePrimeInput());
    expect(selection.stage.stage).toBe('mature-profitable');
    expect(selection.rule.ruleId).toBe('industrials-v1');
  });
});
