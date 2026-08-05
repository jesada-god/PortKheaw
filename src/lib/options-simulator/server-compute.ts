import 'server-only';

import { generateMonteCarloPathSet, runMonteCarlo } from './monte-carlo';
import { valuePortfolio } from './portfolio';
import { calculateCallPutScenarioScore } from './scenario-score';
import { calculationPortfolioToWorkspace } from './calculation-workspace';
import { buildCanonicalWhatIfResult } from './result-contract';
import type { MonteCarloCalculationInput, MonteCarloComputeResult, WhatIfCalculationInput, WhatIfComputeResult } from './compute-dto';

/** Premium calculations live behind route entitlement guards, never in a browser worker. */
export function computeWhatIf(input: WhatIfCalculationInput): WhatIfComputeResult {
  const workspace = {
    underlyingPrice: input.spot,
    stockQuantity: input.stockQuantity,
    cashPosition: input.cashPosition,
    legs: input.legs,
  };
  const scenario = { ...input.scenario, valuationDate: input.scenario.targetDate };
  const currentScenario = { ...scenario, targetPrice: input.spot, valuationDate: input.valuationDate, volatilityShift: 0 };
  const current = valuePortfolio(workspace, currentScenario);
  const afterPrice = valuePortfolio(workspace, { ...currentScenario, targetPrice: scenario.targetPrice });
  const afterTime = valuePortfolio(workspace, { ...currentScenario, targetPrice: scenario.targetPrice, valuationDate: scenario.valuationDate });
  const valuation = buildCanonicalWhatIfResult(valuePortfolio(workspace, scenario), current.theoreticalValue);
  return {
    valuation,
    decomposition: {
      priceImpact: afterPrice.theoreticalValue - current.theoreticalValue,
      timeImpact: afterTime.theoreticalValue - afterPrice.theoreticalValue,
      ivImpact: valuation.theoreticalValue - afterTime.theoreticalValue,
    },
  };
}

/**
 * Generate one shared path set so the Monte Carlo summary and Call/Put score
 * use identical paths. Transient terminal prices and the full path set never
 * cross the HTTP boundary.
 */
export function computeMonteCarlo(
  input: MonteCarloCalculationInput,
): MonteCarloComputeResult {
  const { settings, quality } = input;
  const workspace = calculationPortfolioToWorkspace(input.portfolio, settings, quality);
  const comparisonWorkspace = calculationPortfolioToWorkspace(input.comparisonPortfolio, settings, quality);
  const targetPrice = input.portfolio.scenario.targetPrice;
  const pathSet = generateMonteCarloPathSet(workspace, settings, { targetPrice });
  const auditResult = runMonteCarlo(workspace, settings, { targetPrice, pathSet });
  const { terminalPrices: _terminalPrices, pathSet: transientPathSet, ...result } = auditResult;
  const scenarioScore = calculateCallPutScenarioScore(
    comparisonWorkspace,
    settings,
    transientPathSet,
    targetPrice,
  );
  return {
    result,
    scenarioScore,
  };
}
