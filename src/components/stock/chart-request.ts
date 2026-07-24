/**
 * Pure request-coordination decisions for the market candle chart panel.
 *
 * The panel keeps its imperative machinery (AbortController, generation counter,
 * cache and in-flight maps) inline so it can guard React state transitions, but
 * the two decisions that make deduplication correct live here so they can be
 * unit-tested without a DOM: which action a load should take, and whether a
 * settled response is still the current one.
 */

export type ChartRequestPlan = 'serve-cache' | 'join-inflight' | 'wait-cooldown' | 'fetch';

export interface ChartRequestPlanInput {
  /** A forced load (Refresh, retry, live tick) bypasses the cache but never the in-flight join. */
  force: boolean;
  hasCache: boolean;
  hasInflight: boolean;
  now: number;
  cooldownUntil: number;
}

export interface ChartRequestIdentity {
  symbol: string;
  interval: string;
  range: string;
  adjusted: boolean;
  session: string;
}

/** Stable identity for cache, in-flight deduplication, and stale-response isolation. */
export function chartRequestKey(input: ChartRequestIdentity): string {
  return `${input.symbol.toUpperCase()}:${input.interval}:${input.range}:${input.adjusted}:${input.session}`;
}

/**
 * Decide what a load for a given `symbol:interval:range:adjusted:session` key should do.
 *
 * The in-flight check is deliberately evaluated for forced loads too: two identical
 * loads — whether from a double effect run, a tab activation, or a Refresh landing on
 * top of the initial load — collapse onto a single network request.
 */
export function planChartRequest(input: ChartRequestPlanInput): ChartRequestPlan {
  if (!input.force && input.hasCache) return 'serve-cache';
  if (input.hasInflight) return 'join-inflight';
  if (input.now < input.cooldownUntil) return 'wait-cooldown';
  return 'fetch';
}

/**
 * A response is only applied when it belongs to the current generation and was not
 * aborted. Changing interval/range/session bumps the generation and aborts the prior
 * controller, so an older, slower response resolves into this predicate and is dropped
 * rather than overwriting fresher data.
 */
export function shouldApplyResponse(
  currentGeneration: number,
  requestGeneration: number,
  aborted: boolean,
): boolean {
  return !aborted && currentGeneration === requestGeneration;
}
