import 'server-only';

import { boundedExpirationProfitFloor, generateMonteCarloPathSet, runMonteCarlo } from './monte-carlo';
import { valuePortfolio } from './portfolio';
import { calculateCallPutScenarioScore } from './scenario-score';
import type { MonteCarloSettings, SimulationWorkspace } from './types';
import type { MonteCarloComputeResult, WhatIfComputeResult } from './compute-dto';

/** Premium calculations live behind route entitlement guards, never in a browser worker. */
export function computeWhatIf(workspace: SimulationWorkspace): WhatIfComputeResult {
  const scenario = workspace.scenarios[0];
  const currentScenario = { ...scenario, targetPrice: workspace.underlyingPrice ?? scenario.targetPrice, valuationDate: workspace.valuationDate, volatilityShift: 0 };
  const current = valuePortfolio(workspace, currentScenario);
  const afterPrice = valuePortfolio(workspace, { ...currentScenario, targetPrice: scenario.targetPrice });
  const afterTime = valuePortfolio(workspace, { ...currentScenario, targetPrice: scenario.targetPrice, valuationDate: scenario.valuationDate });
  const valuation = valuePortfolio(workspace, scenario);
  return {
    valuation,
    decomposition: {
      currentValue: current.theoreticalValue,
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
  workspace: SimulationWorkspace,
  comparisonWorkspace: SimulationWorkspace,
  settings: MonteCarloSettings,
  targetPrice: number,
): MonteCarloComputeResult {
  const pathSet = generateMonteCarloPathSet(workspace, settings, { targetPrice });
  const auditResult = runMonteCarlo(workspace, settings, { targetPrice, pathSet });
  const { terminalPrices: _terminalPrices, pathSet: transientPathSet, ...result } = auditResult;
  const scenarioScore = calculateCallPutScenarioScore(
    comparisonWorkspace,
    settings,
    transientPathSet,
    targetPrice,
  );
  const payoff = valuePortfolio(workspace, workspace.scenarios[0]);
  return {
    result: {
      ...result,
      breakEvens: payoff.breakEvens,
      expirationProfitFloor: boundedExpirationProfitFloor(workspace),
    },
    scenarioScore,
  };
}
