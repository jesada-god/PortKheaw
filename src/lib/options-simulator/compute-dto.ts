import type { CallPutScenarioScore } from './scenario-score';
import type { MonteCarloResult, PortfolioValuation } from './types';

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
