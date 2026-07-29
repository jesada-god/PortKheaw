import type { MarketDataStatus, OptionContract } from '@/src/lib/market-data/options/contracts';
import type {
  OptionsDataMode,
  OptionsLevel,
  OptionsLevelGreekVariants,
  OptionsLevelMethod,
  OptionsLevelSource,
  OptionsReliability,
  OptionsSrConfig,
  OptionsSrInput,
  OptionsSrResult,
  OptionsSrUnavailable,
  OptionsSrUnavailableReason,
} from './types';

export const DEFAULT_OPTIONS_SR_CONFIG: OptionsSrConfig = {
  minStrikes: 6,
  minOiCoverage: 0.5,
  clusterTolerancePercent: 0.015,
  strikeCoverageSaturation: 14,
  concentrationSaturationPercent: 30,
  nowMs: undefined,
};

const RELIABILITY_METHODOLOGY =
  'Open-interest concentration walls (peak strike + adjacent-strike cluster) and minimum-total-payout Max Pain, computed only from provider-supplied non-stale contracts. Reliability is a deterministic evidence score from strike coverage, OI coverage, chain freshness, concentration strength, and proximity to expiration — never a probability of pinning.';

const LIMITATIONS = [
  'Options-derived reference levels describe where open interest is concentrated; they are NOT a guarantee that market makers will pin, support, or resist price.',
  'Open interest is delayed or end-of-day, not a live feed, and reflects positions already opened — not future intent.',
  'Missing open interest or Greeks are surfaced as typed unavailable states and are never inferred or fabricated.',
];

const round = (value: number, digits = 4): number => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const clampUnit = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

function statusToDataMode(status: MarketDataStatus): OptionsDataMode {
  // 'live' is deliberately downgraded — this account is delayed/EOD, never real-time.
  if (status === 'cached') return 'CACHED';
  if (status === 'stale') return 'STALE';
  return 'DELAYED';
}

function freshnessUnit(status: MarketDataStatus): number {
  if (status === 'cached') return 0.6;
  if (status === 'stale') return 0.2;
  return 1;
}

/** Calendar days between two YYYY-MM-DD dates (>= 0). */
function calendarDaysBetween(fromIso: string, toDate: string): number {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

function dteProximityUnit(dte: number): number {
  if (dte <= 0) return 0.3;
  if (dte <= 45) return 1;
  if (dte >= 180) return 0.3;
  return clampUnit(1 - ((dte - 45) / (180 - 45)) * 0.7);
}

function reliabilityTier(score: number): OptionsReliability {
  if (score >= 0.7) return 'high';
  if (score >= 0.45) return 'moderate';
  return 'low';
}

/**
 * Deterministically deduplicate by canonical contract identity. When the same
 * contractSymbol appears twice, the row with the greater open interest wins;
 * ties fall through to greater volume, then the lexically-larger as-of snapshot,
 * so the result never depends on input order.
 */
function dedupeContracts(contracts: readonly OptionContract[]): OptionContract[] {
  const bySymbol = new Map<string, OptionContract>();
  for (const contract of contracts) {
    const previous = bySymbol.get(contract.contractSymbol);
    if (!previous) {
      bySymbol.set(contract.contractSymbol, contract);
      continue;
    }
    const a = previous.openInterest ?? -1;
    const b = contract.openInterest ?? -1;
    if (b > a) { bySymbol.set(contract.contractSymbol, contract); continue; }
    if (b < a) continue;
    const av = previous.volume ?? -1;
    const bv = contract.volume ?? -1;
    if (bv > av) { bySymbol.set(contract.contractSymbol, contract); continue; }
    if (bv < av) continue;
    if (contract.asOf > previous.asOf) bySymbol.set(contract.contractSymbol, contract);
  }
  return [...bySymbol.values()];
}

/** A contract usable for structure: finite positive strike and not stale. */
function isQualified(contract: OptionContract): boolean {
  return Number.isFinite(contract.strike) && contract.strike > 0 && contract.status !== 'stale';
}

/**
 * Open interest that may legitimately enter a sum: present, finite and
 * non-negative. Anything else — null, NaN, or negative — is SKIPPED, never
 * coerced to 0, so a malformed row cannot silently deflate a side's total or
 * poison it into NaN. Contract COUNT is never substituted for open interest.
 */
export function validOpenInterest(contract: OptionContract): number | null {
  const openInterest = contract.openInterest;
  return openInterest !== null && Number.isFinite(openInterest) && openInterest >= 0
    ? openInterest
    : null;
}

/** Σ of the valid open interest on one side. Invalid rows contribute nothing. */
function sumOpenInterest(contracts: readonly OptionContract[]): number {
  return contracts.reduce((sum, contract) => {
    const openInterest = validOpenInterest(contract);
    return openInterest === null ? sum : sum + openInterest;
  }, 0);
}

interface StrikeAggregate {
  strike: number;
  oi: number;
  /** Σ oi×|delta| across the strike's contracts (0 when Greeks absent). */
  deltaWeight: number;
  /** Σ oi×gamma across the strike's contracts (0 when Greeks absent). */
  gammaWeight: number;
  /** True only when every OI-bearing contract at this strike had finite delta & gamma. */
  greeksComplete: boolean;
}

/** Aggregate OI (and optional Greek weights) by strike for the contracts that carry OI. */
function aggregateByStrike(contracts: readonly OptionContract[]): StrikeAggregate[] {
  const byStrike = new Map<number, StrikeAggregate>();
  for (const contract of contracts) {
    const oi = validOpenInterest(contract);
    if (oi === null) continue;
    const hasGreeks = contract.delta !== null && Number.isFinite(contract.delta)
      && contract.gamma !== null && Number.isFinite(contract.gamma);
    const existing = byStrike.get(contract.strike);
    const deltaWeight = hasGreeks ? oi * Math.abs(contract.delta as number) : 0;
    const gammaWeight = hasGreeks ? oi * (contract.gamma as number) : 0;
    if (!existing) {
      byStrike.set(contract.strike, { strike: contract.strike, oi, deltaWeight, gammaWeight, greeksComplete: hasGreeks });
    } else {
      existing.oi += oi;
      existing.deltaWeight += deltaWeight;
      existing.gammaWeight += gammaWeight;
      existing.greeksComplete = existing.greeksComplete && hasGreeks;
    }
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

function greekVariants(cluster: readonly StrikeAggregate[]): OptionsLevelGreekVariants | undefined {
  if (!cluster.length || !cluster.every((item) => item.greeksComplete)) return undefined;
  const deltaDenominator = cluster.reduce((sum, item) => sum + item.deltaWeight, 0);
  const gammaDenominator = cluster.reduce((sum, item) => sum + item.gammaWeight, 0);
  const delta = deltaDenominator > 0
    ? round(cluster.reduce((sum, item) => sum + item.strike * item.deltaWeight, 0) / deltaDenominator, 2)
    : null;
  const gamma = gammaDenominator > 0
    ? round(cluster.reduce((sum, item) => sum + item.strike * item.gammaWeight, 0) / gammaDenominator, 2)
    : null;
  if (delta === null && gamma === null) return undefined;
  return { delta, gamma };
}

interface WallCandidate {
  price: number;
  rawOI: number;
  clusterOI: number;
  oiSharePercent: number;
  greekVariants?: OptionsLevelGreekVariants;
}

/**
 * Find the OI wall for one side: the peak strike by open interest, then the sum
 * of OI at every adjacent strike within the cluster tolerance. A tie on peak OI
 * resolves to the strike nearest the accepted price, then the lower strike, so
 * the wall is deterministic regardless of input order.
 */
function findWall(aggregates: readonly StrikeAggregate[], acceptedPrice: number, totalOI: number, tolerance: number): WallCandidate | null {
  if (!aggregates.length || totalOI <= 0) return null;
  const peak = [...aggregates].sort((a, b) => (
    b.oi - a.oi
    || Math.abs(a.strike - acceptedPrice) - Math.abs(b.strike - acceptedPrice)
    || a.strike - b.strike
  ))[0];
  if (peak.oi <= 0) return null;
  const cluster = aggregates.filter((item) => Math.abs(item.strike - peak.strike) <= tolerance);
  const clusterOI = cluster.reduce((sum, item) => sum + item.oi, 0);
  return {
    price: peak.strike,
    rawOI: peak.oi,
    clusterOI,
    oiSharePercent: round((clusterOI / totalOI) * 100, 2),
    greekVariants: greekVariants(cluster),
  };
}

interface MaxPainCandidate {
  price: number;
  rawOI: number;
  oiSharePercent: number;
}

/**
 * Max Pain: the settlement strike K that minimises total option-holder payout,
 *   callPayout(K) = Σ callOI×max(0,K−strike)×multiplier
 *   putPayout(K)  = Σ putOI ×max(0,strike−K)×multiplier
 * using each contract's real multiplier. Deterministic tie-break: the strike
 * nearest the accepted price, then the lower strike.
 */
function calculateMaxPain(
  calls: readonly OptionContract[],
  puts: readonly OptionContract[],
  acceptedPrice: number,
  totalOI: number,
): MaxPainCandidate | null {
  const priced = [...calls, ...puts].filter((c) => c.openInterest !== null && c.openInterest > 0);
  if (!priced.length || totalOI <= 0) return null;
  const candidateStrikes = [...new Set(priced.map((c) => c.strike))].sort((a, b) => a - b);
  if (!candidateStrikes.length) return null;

  let best: { strike: number; payout: number } | null = null;
  for (const strike of candidateStrikes) {
    let payout = 0;
    for (const call of calls) {
      if (call.openInterest === null || call.openInterest <= 0) continue;
      payout += call.openInterest * Math.max(0, strike - call.strike) * call.multiplier;
    }
    for (const put of puts) {
      if (put.openInterest === null || put.openInterest <= 0) continue;
      payout += put.openInterest * Math.max(0, put.strike - strike) * put.multiplier;
    }
    if (!Number.isFinite(payout)) continue;
    if (
      best === null
      || payout < best.payout
      || (payout === best.payout && (
        Math.abs(strike - acceptedPrice) < Math.abs(best.strike - acceptedPrice)
        || (Math.abs(strike - acceptedPrice) === Math.abs(best.strike - acceptedPrice) && strike < best.strike)
      ))
    ) {
      best = { strike, payout };
    }
  }
  if (best === null) return null;
  const oiAtStrike = priced.filter((c) => c.strike === best!.strike).reduce((sum, c) => sum + (c.openInterest ?? 0), 0);
  return {
    price: best.strike,
    rawOI: oiAtStrike,
    oiSharePercent: round((oiAtStrike / totalOI) * 100, 2),
  };
}

interface ReliabilityInputs {
  strikeCoverage: number;
  contractCoverage: number;
  status: MarketDataStatus;
  concentrationPercent: number;
  dte: number;
  config: OptionsSrConfig;
}

/** Deterministic 0..1 reliability score from the documented evidence components. */
function reliabilityScore(inputs: ReliabilityInputs): number {
  const strike = clampUnit(inputs.strikeCoverage / Math.max(1, inputs.config.strikeCoverageSaturation));
  const coverage = clampUnit(inputs.contractCoverage);
  const freshness = freshnessUnit(inputs.status);
  const concentration = clampUnit(inputs.concentrationPercent / Math.max(1, inputs.config.concentrationSaturationPercent));
  const dte = dteProximityUnit(inputs.dte);
  const weights = { strike: 0.2, coverage: 0.25, freshness: 0.2, concentration: 0.25, dte: 0.1 };
  return clampUnit(
    strike * weights.strike
    + coverage * weights.coverage
    + freshness * weights.freshness
    + concentration * weights.concentration
    + dte * weights.dte,
  );
}

function toLevel(
  candidate: { price: number; rawOI: number; clusterOI: number; oiSharePercent: number; greekVariants?: OptionsLevelGreekVariants },
  method: OptionsLevelMethod,
  source: OptionsLevelSource,
  input: OptionsSrInput,
  base: Omit<ReliabilityInputs, 'concentrationPercent'>,
): OptionsLevel {
  const reliability = reliabilityTier(reliabilityScore({ ...base, concentrationPercent: candidate.oiSharePercent }));
  return {
    price: round(candidate.price, 4),
    distancePercent: round(Math.abs(candidate.price - input.acceptedPrice) / input.acceptedPrice * 100, 4),
    rawOI: candidate.rawOI,
    clusterOI: candidate.clusterOI,
    oiSharePercent: candidate.oiSharePercent,
    method,
    source,
    expiration: input.expiration,
    asOf: input.asOf,
    reliability,
    ...(candidate.greekVariants ? { greekVariants: candidate.greekVariants } : {}),
  };
}

/**
 * Compute Options-Driven Support/Resistance for one expiration. Pure and
 * deterministic: identical inputs always yield identical output, and every
 * absent input becomes a typed unavailable state rather than a fabricated value.
 */
export function computeOptionsSupportResistance(
  input: OptionsSrInput,
  overrides: Partial<OptionsSrConfig> = {},
): OptionsSrResult {
  const config: OptionsSrConfig = { ...DEFAULT_OPTIONS_SR_CONFIG, ...overrides };
  const dataMode = statusToDataMode(input.status);
  const nowIso = new Date(config.nowMs ?? Date.now()).toISOString();
  const today = nowIso.slice(0, 10);

  const fail = (reason: OptionsSrUnavailableReason, message: string): OptionsSrResult => ({
    status: 'unavailable',
    symbol: input.symbol,
    expiration: input.expiration ?? null,
    reason,
    message,
    provider: input.provider ?? null,
    asOf: input.asOf ?? null,
    dataMode,
    limitations: LIMITATIONS,
  });

  if (!Number.isFinite(input.acceptedPrice) || input.acceptedPrice <= 0) {
    return fail('no-accepted-price', 'A validated accepted underlying price is required to compute distances.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiration) || input.expiration < today) {
    return fail('expired-expiration', 'The requested expiration is expired or malformed.');
  }
  if (input.status === 'stale') {
    return fail('stale', 'Options data is stale after a provider failure; reference levels are withheld.');
  }

  const calls = dedupeContracts(input.calls.filter(isQualified));
  const puts = dedupeContracts(input.puts.filter(isQualified));
  const qualified = [...calls, ...puts];
  if (qualified.length === 0) {
    return fail('chain-unavailable', 'No qualified (non-stale, valid-strike) contracts were returned for this expiration.');
  }

  const strikeCoverage = new Set(qualified.map((c) => c.strike)).size;
  const withOi = qualified.filter((c) => validOpenInterest(c) !== null);
  const contractCoverage = round(withOi.length / qualified.length, 4);
  const totalCallOI = sumOpenInterest(calls);
  const totalPutOI = sumOpenInterest(puts);

  if (totalCallOI + totalPutOI <= 0) {
    return fail('no-open-interest', 'The provider returned no usable open interest for this expiration.');
  }
  if (strikeCoverage < config.minStrikes || contractCoverage < config.minOiCoverage) {
    return fail('insufficient-coverage', `Chain coverage is below the documented threshold (${strikeCoverage} strikes, ${(contractCoverage * 100).toFixed(0)}% OI coverage).`);
  }

  const dte = calendarDaysBetween(nowIso, input.expiration);
  const reliabilityBase = { strikeCoverage, contractCoverage, status: input.status, dte, config };
  const tolerance = input.acceptedPrice * config.clusterTolerancePercent;

  const callAgg = aggregateByStrike(calls);
  const putAgg = aggregateByStrike(puts);
  const callWallCandidate = findWall(callAgg, input.acceptedPrice, totalCallOI, tolerance);
  const putWallCandidate = findWall(putAgg, input.acceptedPrice, totalPutOI, tolerance);
  const maxPainCandidate = calculateMaxPain(calls, puts, input.acceptedPrice, totalCallOI + totalPutOI);

  const callWall = callWallCandidate
    ? toLevel(callWallCandidate, 'call-oi-concentration', 'call-oi', input, reliabilityBase)
    : null;
  const putWall = putWallCandidate
    ? toLevel(putWallCandidate, 'put-oi-concentration', 'put-oi', input, reliabilityBase)
    : null;
  const maxPain = maxPainCandidate
    ? toLevel(
      { price: maxPainCandidate.price, rawOI: maxPainCandidate.rawOI, clusterOI: maxPainCandidate.rawOI, oiSharePercent: maxPainCandidate.oiSharePercent },
      'min-total-payout',
      'max-pain',
      input,
      reliabilityBase,
    )
    : null;

  const concentration = Math.max(callWall?.oiSharePercent ?? 0, putWall?.oiSharePercent ?? 0);
  const reliability = reliabilityTier(reliabilityScore({ ...reliabilityBase, concentrationPercent: concentration }));

  return {
    status: 'available',
    symbol: input.symbol,
    expiration: input.expiration,
    acceptedPrice: round(input.acceptedPrice, 4),
    callWall,
    putWall,
    maxPain,
    totalCallOI,
    totalPutOI,
    putCallOIRatio: totalCallOI > 0 ? round(totalPutOI / totalCallOI, 4) : null,
    strikeCoverage,
    contractCoverage,
    provider: input.provider,
    asOf: input.asOf,
    dataMode,
    reliability,
    limitations: LIMITATIONS,
  };
}

/** Build a typed unavailable result (used by data-source failure paths and the hook). */
export function optionsUnavailable(
  symbol: string,
  expiration: string | null,
  reason: OptionsSrUnavailableReason,
  message: string,
  provider: string | null = null,
  dataMode: OptionsDataMode | null = null,
): OptionsSrUnavailable {
  return { status: 'unavailable', symbol, expiration, reason, message, provider, asOf: null, dataMode, limitations: LIMITATIONS };
}

export { RELIABILITY_METHODOLOGY, LIMITATIONS as OPTIONS_SR_LIMITATIONS };
