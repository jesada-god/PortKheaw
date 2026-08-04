import { intrinsicValue, priceOption } from './pricing';
import { calendarDaysBetween } from './calendar-date';
import type { Greeks, OptionLeg, PortfolioValuation, ScenarioInput, SimulationWorkspace } from './types';
import { analyzeExpirationPayoff, buildCanonicalStrategyResult, optionExpirationProfit, portfolioExpirationProfit } from './result-contract';

const emptyGreeks = (): Greeks => ({ delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 });
const yearsBetween = (from: string, to: string) => Math.max(0, calendarDaysBetween(from, to) / 365.25);
const signOf = (leg: OptionLeg) => leg.side === 'buy' ? 1 : -1;
export { detectStrategy, portfolioProfitLossBasis } from './portfolio-inputs';
export { optionExpirationProfit, portfolioExpirationProfit } from './result-contract';

type PortfolioCalculationWorkspace = Pick<SimulationWorkspace,
  'legs' | 'stockQuantity' | 'cashPosition' | 'underlyingPrice'
>;
type PortfolioCalculationScenario = Pick<ScenarioInput,
  'targetPrice' | 'valuationDate' | 'volatilityShift' | 'rate' | 'dividendYield'
>;

function payoffGrid(workspace: PortfolioCalculationWorkspace): PortfolioValuation['payoff'] {
  const spot = workspace.underlyingPrice ?? Math.max(...workspace.legs.map((leg) => leg.strike));
  const high = Math.max(spot * 3, ...workspace.legs.map((leg) => leg.strike * 2.5));
  return Array.from({ length: 241 }, (_, index) => ({
    price: high * index / 240,
    profitLoss: portfolioExpirationProfit(workspace, high * index / 240),
  }));
}

export function valuePortfolio(workspace: PortfolioCalculationWorkspace, scenario: PortfolioCalculationScenario): PortfolioValuation {
  const aggregateGreeks = emptyGreeks();
  let theoreticalValue = workspace.cashPosition + workspace.stockQuantity * scenario.targetPrice;
  let profitLoss = workspace.cashPosition + workspace.stockQuantity * (scenario.targetPrice - (workspace.underlyingPrice ?? scenario.targetPrice));
  const legs = workspace.legs.map((leg) => {
    const volatility = Math.max(0.0001, leg.impliedVolatility * (1 + scenario.volatilityShift));
    const priced = priceOption({ spot: scenario.targetPrice, strike: leg.strike, timeYears: yearsBetween(scenario.valuationDate, leg.expiration),
      volatility, rate: scenario.rate, dividendYield: scenario.dividendYield, kind: leg.kind, style: leg.style });
    const sign = signOf(leg);
    const scale = sign * leg.quantity * leg.multiplier;
    const legValue = priced.value * scale;
    const legEntry = leg.entryPremium * scale;
    const legProfitLoss = legValue - legEntry - leg.fees;
    theoreticalValue += legValue;
    profitLoss += legProfitLoss;
    (Object.keys(aggregateGreeks) as Array<keyof Greeks>).forEach((key) => { aggregateGreeks[key] += priced.greeks[key] * scale; });
    const intrinsic = intrinsicValue(scenario.targetPrice, leg.strike, leg.kind);
    return { legId: leg.id, value: legValue, profitLoss: legProfitLoss, intrinsicValue: intrinsic,
      timeValue: Math.max(0, priced.value - intrinsic), breakEven: leg.kind === 'call' ? leg.strike + leg.entryPremium : leg.strike - leg.entryPremium,
      greeks: Object.fromEntries((Object.keys(priced.greeks) as Array<keyof Greeks>).map((key) => [key, priced.greeks[key] * scale])) as unknown as Greeks };
  });
  const netDebitCredit = workspace.legs.reduce((sum, leg) => sum + signOf(leg) * leg.entryPremium * leg.quantity * leg.multiplier + leg.fees, 0);
  const payoff = payoffGrid(workspace);
  const expirationAnalysis = analyzeExpirationPayoff(workspace);
  return { legs, theoreticalValue, profitLoss, netDebitCredit, greeks: aggregateGreeks,
    payoff, ...expirationAnalysis, ...buildCanonicalStrategyResult(workspace, profitLoss, expirationAnalysis) };
}
