import type { CallPutScenarioScore } from './scenario-score';
import type { DataStatus, MonteCarloResult, MonteCarloSettings, OptionLeg, PortfolioValuation } from './types';

export type CalculationLeg = Pick<OptionLeg,
  | 'id'
  | 'kind'
  | 'side'
  | 'quantity'
  | 'strike'
  | 'expiration'
  | 'entryPremium'
  | 'impliedVolatility'
  | 'multiplier'
  | 'fees'
  | 'style'
>;

/** Pricing-only portfolio shared by What-If and Monte Carlo at the HTTP boundary. */
export interface CalculationPortfolioInput {
  symbol: string;
  spot: number;
  valuationDate: string;
  stockQuantity: number;
  cashPosition: number;
  legs: CalculationLeg[];
  scenario: {
    targetPrice: number;
    targetDate: string;
    volatilityShift: number;
    rate: number;
    dividendYield: number;
  };
}

export type WhatIfCalculationInput = CalculationPortfolioInput;

export interface MonteCarloQualityInput {
  dataStatus: DataStatus;
  dataSource: string | null;
  dataTimestamp: string | null;
  legs: Array<Pick<OptionLeg,
    | 'id'
    | 'inputMode'
    | 'contractProvider'
    | 'premiumSource'
    | 'bid'
    | 'ask'
    | 'volume'
    | 'openInterest'
    | 'contractStatus'
  >>;
}

export interface MonteCarloCalculationInput {
  portfolio: CalculationPortfolioInput;
  comparisonPortfolio: CalculationPortfolioInput;
  settings: MonteCarloSettings & { driftMode: 'forecast' | 'risk-neutral' };
  quality: MonteCarloQualityInput;
}

export interface WhatIfDecomposition {
  currentValue: number;
  priceImpact: number;
  timeImpact: number;
  ivImpact: number;
}

export interface WhatIfComputeResult {
  valuation: PortfolioValuation;
  decomposition: WhatIfDecomposition;
}

export interface MonteCarloDisplayResult extends MonteCarloResult {
  validPaths?: number;
  discardedPaths?: number;
  terminalPriceHistogram?: Array<{ lower: number; upper: number; count: number }>;
  /** Server-derived display references, deliberately omitted from persistence. */
  breakEvens?: number[];
  expirationProfitFloor?: number | null;
}

export interface MonteCarloComputeResult {
  result: MonteCarloDisplayResult;
  scenarioScore: CallPutScenarioScore;
}
