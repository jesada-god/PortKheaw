import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import { optionMarketQuote } from '@/src/lib/market-data/quote-model';
import { detectStrategy } from './portfolio';
import type { OptionLeg, PremiumSource, SimulationWorkspace } from './types';

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000));
}

/**
 * Only a quoted executable side is safe to prefill. Last and the provider mark
 * remain reference observations and are never silently treated as a fill.
 *
 * `delayed` and `cached` snapshots still carry a real quoted side. Alpaca is the
 * only entitled options provider, it never publishes a `live` chain, and the
 * import re-reads a chain the panel has usually just fetched — so in production
 * the status is always `delayed` or `cached`. Accepting `live` alone meant every
 * imported leg arrived with no premium at all, and a leg with no premium is
 * exactly the input that collapses initial debit, max loss, the break-even root
 * and the return percentage to zero.
 *
 * `stale` stays refused: that snapshot is old enough that the workspace already
 * makes the reader confirm it before calculating, so its quote is not a fill. A
 * zero on the executable side is refused for the same reason — it is an absent
 * quote, not a price someone could pay.
 */
export function selectProviderPremium(
  contract: OptionContract,
  side: OptionLeg['side'] = 'buy',
): { value: number; source: PremiumSource } | null {
  if (contract.status === 'stale') return null;
  const source = side === 'buy' ? 'ask' : 'bid';
  const value = contract[source];
  return value !== null && Number.isFinite(value) && value > 0 ? { value, source } : null;
}

export function findChainContract(chain: OptionsChain, contractSymbol: string): OptionContract | null {
  return [...chain.calls, ...chain.puts].find((item) => item.contractSymbol === contractSymbol) ?? null;
}

export interface ProviderContractGap {
  /** The same validation path the inputs form and the schema messages use. */
  path: string;
  label: string;
}

const GAP_LABELS = {
  entryPremium: 'ราคาสัญญาต่อหุ้น (Premium)',
  impliedVolatility: 'ความผันผวนที่ตลาดคาด (IV)',
} as const;

/**
 * Names every field a provider snapshot could not supply, so an imported leg
 * says which input is still missing instead of presenting a fabricated zero as
 * a real number. Only legs that carry a provider contract identity are reported,
 * so an untouched blank workspace stays quiet.
 */
export function providerContractGaps(workspace: Pick<SimulationWorkspace, 'legs'>): ProviderContractGap[] {
  return workspace.legs.flatMap((leg, index) => {
    if (!leg.contractSymbol) return [];
    return (['entryPremium', 'impliedVolatility'] as const)
      .filter((field) => !(Number.isFinite(leg[field]) && leg[field] > 0))
      .map((field) => ({ path: `legs.${index}.${field}`, label: GAP_LABELS[field] }));
  });
}

export function importOptionContract(
  current: SimulationWorkspace,
  chain: OptionsChain,
  contractSymbol: string,
): SimulationWorkspace | null {
  const contract = findChainContract(chain, contractSymbol);
  if (!contract) return null;
  const existing = current.legs[0];
  const side = existing?.side ?? 'buy';
  const premium = selectProviderPremium(contract, side);
  const marketQuote = optionMarketQuote(contract);
  /*
    The seed workspace carries no dates until the mount effect applies the
    reader's calendar day, and a fast chain response can land first. An undated
    workspace therefore falls back to the snapshot's own date rather than being
    treated as a date that sorts before every expiration.
  */
  const valuationDate = current.valuationDate && current.valuationDate < contract.expiration
    ? current.valuationDate
    : chain.asOf.slice(0, 10);
  if (valuationDate >= contract.expiration) return null;
  /*
    A field the provider could not supply stays 0 here only because the form
    renders an empty input for 0. It is never presented as a real number:
    `providerContractGaps` names every such field, and the calculation schemas
    reject it by path, so no zero premium or zero IV can reach an engine.
  */
  const leg: OptionLeg = {
    id: existing?.id ?? globalThis.crypto.randomUUID(),
    kind: contract.type,
    side,
    quantity: existing?.quantity && existing.quantity > 0 ? existing.quantity : 1,
    strike: contract.strike,
    expiration: contract.expiration,
    entryPremium: premium?.value ?? 0,
    impliedVolatility: contract.impliedVolatility ?? 0,
    multiplier: contract.multiplier,
    fees: existing?.fees ?? 0,
    style: existing?.style ?? 'european',
    delta: contract.delta,
    gamma: contract.gamma,
    theta: contract.theta,
    vega: contract.vega,
    rho: contract.rho,
    ...(contract.delta === null ? {} : { deltaSource: 'provider' as const, deltaTimestamp: contract.asOf }),
    ...(contract.theta === null ? {} : { thetaSource: 'provider' as const, thetaTimestamp: contract.asOf }),
    contractSymbol: contract.contractSymbol,
    bid: contract.bid,
    ask: contract.ask,
    midpoint: marketQuote.midpoint,
    mark: contract.mark,
    last: contract.last,
    volume: contract.volume,
    openInterest: contract.openInterest,
    premiumSource: premium?.source ?? 'manual',
    inputMode: 'provider',
    contractProvider: contract.provider,
    contractAsOf: contract.asOf,
    contractStatus: contract.status,
  };
  const targetDate = addDays(valuationDate, Math.min(30, daysBetween(valuationDate, contract.expiration)));
  const scenarioDate = targetDate > contract.expiration ? contract.expiration : targetDate;
  const legs = [leg];
  return {
    ...current,
    id: undefined,
    updatedAt: undefined,
    name: `${contract.underlyingSymbol} ${contract.type.toUpperCase()} ${contract.strike} ${contract.expiration}`,
    description: `Imported from ${contract.provider} at ${contract.asOf}. Exercise style remains the disclosed simulator assumption (${leg.style}).`,
    symbol: contract.underlyingSymbol,
    companyName: current.symbol === contract.underlyingSymbol && current.companyName ? current.companyName : contract.underlyingSymbol,
    exchange: current.symbol === contract.underlyingSymbol ? current.exchange : null,
    currency: contract.currency,
    underlyingPrice: chain.spot,
    valuationDate,
    entryDate: valuationDate,
    legs,
    strategyType: detectStrategy(legs),
    scenarios: current.scenarios.map((scenario, index) => index === 0 ? {
      ...scenario,
      targetPrice: chain.spot,
      valuationDate: scenarioDate,
    } : scenario),
    monteCarlo: {
      ...current.monteCarlo,
      volatility: contract.impliedVolatility ?? 0,
      horizonDays: daysBetween(valuationDate, scenarioDate),
      steps: Math.min(366, daysBetween(valuationDate, scenarioDate)),
    },
    dataSource: contract.provider,
    dataTimestamp: contract.asOf,
    dataStatus: contract.status === 'live' ? 'live' : contract.status === 'stale' ? 'stale' : 'delayed',
    resultSnapshot: null,
  };
}
