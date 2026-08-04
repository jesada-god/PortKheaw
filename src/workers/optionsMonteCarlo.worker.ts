/// <reference lib="webworker" />
import { generateMonteCarloPathSet, runMonteCarlo } from '@/src/lib/options-simulator/monte-carlo';
import { calculateCallPutScenarioScore } from '@/src/lib/options-simulator/scenario-score';
import { calculationPortfolioToWorkspace } from '@/src/lib/options-simulator/calculation-workspace';
import type { MonteCarloCalculationInput } from '@/src/lib/options-simulator/compute-dto';

self.onmessage = (event: MessageEvent<{ input: MonteCarloCalculationInput }>) => {
  try {
    const { input } = event.data;
    const workspace = calculationPortfolioToWorkspace(input.portfolio, input.settings, input.quality);
    const comparisonWorkspace = calculationPortfolioToWorkspace(input.comparisonPortfolio, input.settings, input.quality);
    const targetPrice = input.portfolio.scenario.targetPrice;
    const pathSet = generateMonteCarloPathSet(workspace, input.settings, {
      targetPrice,
      onProgress: (completed, total) => self.postMessage({ progress: { completed, total } }),
    });
    const auditResult = runMonteCarlo(workspace, input.settings, {
      targetPrice,
      pathSet,
    });
    const { terminalPrices, pathSet: transientPathSet, ...result } = auditResult;
    const scenarioScore = calculateCallPutScenarioScore(
      comparisonWorkspace,
      input.settings,
      transientPathSet,
      targetPrice,
    );
    self.postMessage({ result, scenarioScore });
  }
  catch (error) {
    self.postMessage({ error: { code: 'worker-failed', message: error instanceof Error ? error.message : 'ระบบจำลองใน worker ไม่สำเร็จ' } });
  }
};
export {};
