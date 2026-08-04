import { detectStrategy } from './portfolio-inputs';
import type { CalculationPortfolioInput, MonteCarloQualityInput } from './compute-dto';
import type { MonteCarloSettings, SimulationWorkspace } from './types';

/**
 * Adapts the calculation-only wire DTO to the existing engine shape. Persistence
 * fields are deterministic server/worker internals and never cross the boundary.
 */
export function calculationPortfolioToWorkspace(
  input: CalculationPortfolioInput,
  settings: MonteCarloSettings,
  quality: MonteCarloQualityInput,
): SimulationWorkspace {
  const qualityByLeg = new Map(quality.legs.map((leg) => [leg.id, leg]));
  const legs = input.legs.map((leg) => ({ ...leg, ...(qualityByLeg.get(leg.id) ?? {}) }));
  return {
    name: 'Calculation',
    description: '',
    symbol: input.symbol,
    companyName: input.symbol,
    exchange: null,
    currency: 'USD',
    simulationType: 'monte-carlo',
    strategyType: detectStrategy(legs, input.stockQuantity),
    underlyingPrice: input.spot,
    stockQuantity: input.stockQuantity,
    cashPosition: input.cashPosition,
    entryDate: input.valuationDate,
    valuationDate: input.valuationDate,
    legs,
    scenarios: [{
      id: 'calculation-scenario',
      name: 'Base',
      targetPrice: input.scenario.targetPrice,
      valuationDate: input.scenario.targetDate,
      volatilityShift: input.scenario.volatilityShift,
      rate: input.scenario.rate,
      dividendYield: input.scenario.dividendYield,
    }],
    monteCarlo: settings,
    dataSource: quality.dataSource,
    dataTimestamp: quality.dataTimestamp,
    dataStatus: quality.dataStatus,
    resultSnapshot: null,
    methodologyVersion: 'options-simulator-v1',
  };
}
