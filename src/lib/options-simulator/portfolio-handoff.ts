import type { OptionToolContext } from '@/src/lib/tools/handoff';
import { addCalendarDays, calendarDaysBetween } from './calendar-date';
import { detectStrategy } from './portfolio';
import type { OptionLeg, SimulationWorkspace } from './types';

/**
 * One option position from the portfolio, opened as a simulator workspace.
 *
 * Deliberately not the chain import. That path re-fetches the provider's chain
 * and prices the leg at the current ask, which is the right premium for somebody
 * choosing a contract to buy and the wrong one for somebody asking what the
 * contract they ALREADY own is going to do — their entry premium is their own
 * average, and answering "what if" against today's ask would show them a
 * position they never took. Everything needed is already on the position summary
 * the portfolio computed, so this is pure, offline and immediate.
 *
 * Returns `null` when the contract cannot be simulated at all — an expiration
 * that is not in the future leaves the pricing engine nothing to value — and the
 * caller then opens an empty workspace rather than a broken one.
 */
export function applyPortfolioOptionHandoff(
  current: SimulationWorkspace,
  context: OptionToolContext,
  today: string,
): SimulationWorkspace | null {
  const valuationDate = today || current.valuationDate;
  if (!valuationDate || valuationDate >= context.expiration) return null;

  const leg: OptionLeg = {
    id: current.legs[0]?.id ?? 'leg-1',
    kind: context.optionKind,
    // Long is a bought leg and short is a sold one. This is the field that stops
    // a covered call being simulated as if the reader had paid for it.
    side: context.side === 'long' ? 'buy' : 'sell',
    quantity: context.contracts,
    strike: context.strike,
    expiration: context.expiration,
    entryPremium: context.premium,
    /*
      A zero here is the "still missing" signal the inputs form and the
      calculation schemas already understand: `providerContractGaps` names it and
      the engines refuse it, so an unpriced position asks for the number rather
      than pretending to have it.
    */
    impliedVolatility: context.impliedVolatility ?? 0,
    multiplier: context.multiplier,
    fees: 0,
    style: 'european',
    contractSymbol: context.contractSymbol,
    mark: context.mark,
    inputMode: 'custom',
    premiumSource: 'manual',
  };

  const horizon = Math.min(30, calendarDaysBetween(valuationDate, context.expiration));
  const scenarioDate = horizon > 0 ? addCalendarDays(valuationDate, horizon) : context.expiration;
  const targetPrice = context.underlyingPrice ?? context.strike;
  const legs = [leg];

  return {
    ...current,
    id: undefined,
    updatedAt: undefined,
    name: `${context.symbol} ${context.optionKind.toUpperCase()} ${context.strike} ${context.expiration}`,
    description: 'นำเข้าจากสถานะในพอร์ตโฟลิโอ — ราคาต้นทุนและจำนวนสัญญามาจาก Transaction Ledger',
    symbol: context.symbol,
    companyName: current.symbol === context.symbol && current.companyName ? current.companyName : context.symbol,
    exchange: current.symbol === context.symbol ? current.exchange : null,
    currency: 'USD',
    underlyingPrice: context.underlyingPrice,
    entryDate: valuationDate,
    valuationDate,
    legs,
    strategyType: detectStrategy(legs),
    scenarios: current.scenarios.map((scenario, index) => index === 0
      ? { ...scenario, targetPrice, valuationDate: scenarioDate }
      : scenario),
    monteCarlo: {
      ...current.monteCarlo,
      volatility: context.impliedVolatility ?? current.monteCarlo.volatility,
      horizonDays: Math.max(1, calendarDaysBetween(valuationDate, scenarioDate)),
      steps: Math.min(366, Math.max(1, calendarDaysBetween(valuationDate, scenarioDate))),
    },
    /*
      The reader's own ledger is the source, so the provenance line says so
      rather than naming a market provider that supplied none of these numbers.
    */
    dataSource: 'portfolio-ledger',
    dataTimestamp: null,
    dataStatus: 'manual',
    resultSnapshot: null,
  };
}
