import type { OptionContract } from './contracts';
import type { OptionMarketSnapshot } from '../providers/alpaca/options-snapshots';
import {
  black76Greeks,
  optionExpiryInstantMs,
  solveForwardCurve,
  solveImpliedVolatility,
  yearsToExpiry,
  type ParityObservation,
} from './pricing';

/**
 * Merge a contract CATALOGUE (identity, strike, expiration, open interest) with
 * an options MARKET-DATA snapshot (bid/ask/last/volume/IV/Greeks) into the one
 * canonical contract the UI renders.
 *
 * Two rules govern this file:
 *
 *  1. **Join by exact `contractSymbol` only.** The catalogue and the snapshot are
 *     independently ordered and independently filtered — the snapshot omits
 *     contracts it has no market for — so a positional join would silently
 *     attach one strike's prices to another strike's row. That is the single
 *     most dangerous defect this module can have, and it is why the snapshot
 *     arrives as a `Map` rather than an array.
 *  2. **A field the provider does not supply stays `null`.** Never 0, never a
 *     carried-over neighbour. `null` is what makes the UI render "—".
 *
 * IV and Greeks the provider DID supply are always preferred and tagged
 * `provider`. Only when the provider omitted them may they be solved from the
 * contract's own observed price ({@link deriveValuation}), and the result is
 * tagged `nexora-derived` so the UI can label it as calculated.
 */

export interface EnrichmentContext {
  /** Accepted underlying price. Required for spot Greeks; without it none are derived. */
  spot: number | null;
  /** Evaluation instant, used for the time to expiry. */
  nowMs: number;
  /** Snapshot provider id, recorded on every enriched contract. */
  marketDataProvider: string;
  /** Upstream feed, disclosed in provenance (e.g. `indicative`). */
  marketDataFeed: string;
  /** Disclosed delay of the market-data snapshot, when the provider states one. */
  delayedMinutes?: number | null;
}

export interface EnrichmentResult {
  contracts: OptionContract[];
  warnings: string[];
  /** How many contracts carry provider-supplied IV/Greeks. */
  providerValuedCount: number;
  /** How many carry IV/Greeks solved by Nexora from their own market price. */
  derivedValuedCount: number;
}

function isTradeable(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Midpoint of a real two-sided quote. This is the only value computed from the
 * book here, it is the standard definition of an option's mark, and it is null
 * unless BOTH sides are genuinely quoted.
 */
export function markPrice(bid: number | null, ask: number | null): number | null {
  if (!isTradeable(bid) || !isTradeable(ask) || bid > ask) return null;
  const mark = (bid + ask) / 2;
  return Number.isFinite(mark) ? mark : null;
}

function hasProviderGreeks(snapshot: OptionMarketSnapshot): boolean {
  return snapshot.delta !== null || snapshot.gamma !== null
    || snapshot.theta !== null || snapshot.vega !== null;
}

/** Apply one snapshot onto one catalogue row, without touching catalogue-owned fields. */
function mergeOne(
  contract: OptionContract,
  snapshot: OptionMarketSnapshot | undefined,
  context: EnrichmentContext,
): OptionContract {
  if (!snapshot) {
    return {
      ...contract,
      marketDataProvider: null,
      marketDataFeed: null,
      delayedMinutes: context.delayedMinutes ?? contract.delayedMinutes ?? null,
      valuationSource: null,
    };
  }
  const bid = snapshot.bid;
  const ask = snapshot.ask;
  const providerValued = snapshot.impliedVolatility !== null || hasProviderGreeks(snapshot);
  return {
    ...contract,
    bid,
    ask,
    // The catalogue's `last` is a previous settlement close; a real traded print
    // from the market-data feed supersedes it, but never erases it.
    last: snapshot.last ?? contract.last,
    mark: markPrice(bid, ask),
    volume: snapshot.volume ?? contract.volume,
    impliedVolatility: snapshot.impliedVolatility,
    delta: snapshot.delta,
    gamma: snapshot.gamma,
    theta: snapshot.theta,
    vega: snapshot.vega,
    rho: snapshot.rho,
    marketDataProvider: context.marketDataProvider,
    marketDataFeed: context.marketDataFeed,
    // Once quote/trade data is merged, `asOf` follows that observation rather
    // than the older catalogue receipt. The OI settlement date remains separate
    // in `oiAsOf`, so neither timestamp can masquerade as the other.
    asOf: snapshot.observedAt ?? contract.asOf,
    delayedMinutes: context.delayedMinutes ?? contract.delayedMinutes ?? null,
    valuationSource: providerValued ? 'provider' : null,
  };
}

/**
 * Solve IV and Greeks for contracts the provider left unvalued.
 *
 * The discount factor and forward come from put–call parity across this
 * expiration's own observed marks ({@link solveForwardCurve}), so no interest
 * rate or dividend yield is ever assumed. When the curve cannot be solved, or a
 * contract has no real two-sided mark, or the solver does not converge, the
 * contract is returned untouched with its nulls intact.
 */
export function deriveValuation(
  contracts: readonly OptionContract[],
  context: EnrichmentContext,
): { contracts: OptionContract[]; derivedCount: number; warning: string | null } {
  const unvalued = contracts.filter((contract) =>
    contract.valuationSource === null && isTradeable(contract.mark));
  if (!unvalued.length || !isTradeable(context.spot)) {
    return { contracts: [...contracts], derivedCount: 0, warning: null };
  }

  const expiration = contracts[0]?.expiration;
  const expiryMs = expiration ? optionExpiryInstantMs(expiration) : null;
  const timeToExpiryYears = expiryMs === null ? null : yearsToExpiry(context.nowMs, expiryMs);
  if (timeToExpiryYears === null) {
    return { contracts: [...contracts], derivedCount: 0, warning: null };
  }

  // Parity pairs are built from marks only — a settlement close from the
  // catalogue is not a current price and would bias the fitted curve.
  const byStrike = new Map<number, ParityObservation>();
  for (const contract of contracts) {
    if (!isTradeable(contract.mark)) continue;
    const row = byStrike.get(contract.strike) ?? { strike: contract.strike, callPrice: 0, putPrice: 0 };
    if (contract.type === 'call') row.callPrice = contract.mark;
    else row.putPrice = contract.mark;
    byStrike.set(contract.strike, row);
  }
  const curve = solveForwardCurve([...byStrike.values()], timeToExpiryYears);
  if (!curve) {
    return {
      contracts: [...contracts],
      derivedCount: 0,
      warning: 'Implied volatility could not be derived: the chain did not supply enough two-sided call/put pairs to solve the forward curve',
    };
  }

  let derivedCount = 0;
  const enriched = contracts.map((contract) => {
    if (contract.valuationSource !== null || !isTradeable(contract.mark)) return contract;
    const volatility = solveImpliedVolatility({
      type: contract.type,
      strike: contract.strike,
      optionPrice: contract.mark,
      spot: context.spot!,
      timeToExpiryYears,
      discountFactor: curve.discountFactor,
      forward: curve.forward,
    });
    if (volatility === null) return contract;
    const greeks = black76Greeks({
      type: contract.type,
      strike: contract.strike,
      spot: context.spot!,
      timeToExpiryYears,
      discountFactor: curve.discountFactor,
      forward: curve.forward,
      volatility,
    });
    if (!greeks) return contract;
    derivedCount += 1;
    return {
      ...contract,
      impliedVolatility: volatility,
      delta: greeks.delta,
      gamma: greeks.gamma,
      theta: greeks.theta,
      vega: greeks.vega,
      valuationSource: 'nexora-derived' as const,
    };
  });

  return { contracts: enriched, derivedCount, warning: null };
}

/**
 * Full enrichment pass: merge by contract symbol, then fill the remaining
 * IV/Greeks gaps from observed prices.
 */
export function enrichOptionContracts(
  contracts: readonly OptionContract[],
  snapshots: ReadonlyMap<string, OptionMarketSnapshot>,
  context: EnrichmentContext,
): EnrichmentResult {
  const warnings: string[] = [];
  const merged = contracts.map((contract) => mergeOne(contract, snapshots.get(contract.contractSymbol), context));
  const matched = merged.filter((contract) => contract.marketDataProvider !== null).length;
  if (matched === 0 && contracts.length > 0) {
    warnings.push('No options market data matched this chain; bid, ask, volume, implied volatility and Greeks are unavailable');
  } else if (matched < merged.length) {
    warnings.push(`Options market data covered ${matched} of ${merged.length} contracts; the rest show unavailable prices`);
  }

  const derived = deriveValuation(merged, context);
  if (derived.warning) warnings.push(derived.warning);
  if (derived.derivedCount > 0) {
    warnings.push(`Implied volatility and Greeks for ${derived.derivedCount} contracts were calculated by Nexora from the contract's own quoted mark, not supplied by the provider`);
  }

  return {
    contracts: derived.contracts,
    warnings,
    providerValuedCount: derived.contracts.filter((contract) => contract.valuationSource === 'provider').length,
    derivedValuedCount: derived.derivedCount,
  };
}
