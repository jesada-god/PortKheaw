import type { OptionsSrUnavailableReason } from '@/src/lib/analytics/options-sr';

/**
 * Pure request-planning helpers for the Options S/R data source. Kept free of
 * React and fetch so the single-flight, caching, entitlement-stop and
 * stale-response rules are unit-testable in isolation.
 */

/**
 * The single-flight / cache key. Deliberately excludes viewport so a pan/zoom
 * never refetches.
 *
 * The walls entitlement IS part of the key: the outcome for a reader with
 * Options Walls carries real levels and the outcome for a reader without them
 * carries a locked state, so the two must never share a cache entry. That also
 * makes a trial starting mid-session correct — the next read misses and fetches.
 */
export function optionsRequestKey(symbol: string, expiration: string, wallsEntitled = true): string {
  return `${symbol.toUpperCase()}::${expiration}::walls-${wallsEntitled ? 'on' : 'off'}`;
}

export interface OptionsRequestPlanInput {
  /** The Options S/R overlay toggle (lazy-load gate). */
  enabled: boolean;
  /** True once a non-retryable entitlement/config failure has stopped polling. */
  entitlementBlocked: boolean;
  /** Whether a target expiration is currently selected/known. */
  hasExpiration: boolean;
  /** Whether a cached result already exists for this symbol+expiration. */
  cacheHas: boolean;
  /** Whether an identical request is already in flight. */
  inflightHas: boolean;
  /** Force a manual refresh past the cache. */
  force: boolean;
}

export type OptionsRequestPlan = 'skip' | 'serve-cache' | 'join-inflight' | 'fetch';

/**
 * Decide what to do for a symbol+expiration. Never fetches while disabled,
 * entitlement-blocked, or without an expiration; serves cache before the network;
 * joins an identical in-flight request so exactly one request runs per
 * symbol+expiration.
 */
export function planOptionsRequest(input: OptionsRequestPlanInput): OptionsRequestPlan {
  if (!input.enabled || input.entitlementBlocked || !input.hasExpiration) return 'skip';
  if (!input.force && input.cacheHas) return 'serve-cache';
  if (input.inflightHas) return 'join-inflight';
  return 'fetch';
}

/**
 * A late response may only be applied when it is the newest generation and its
 * request was not aborted — so a superseded expiration's response can never
 * overwrite the current one (item 16).
 */
export function shouldApplyOptionsResponse(currentGeneration: number, requestGeneration: number, aborted: boolean): boolean {
  return !aborted && currentGeneration === requestGeneration;
}

export interface OptionsFailureClassification {
  reason: OptionsSrUnavailableReason;
  retryable: boolean;
  /** Non-retryable entitlement/config faults stop further polling. */
  stopsPolling: boolean;
}

/**
 * Map an HTTP status and/or a market-data error code to a typed Options S/R
 * unavailable reason. An entitlement/config fault is non-retryable and stops
 * polling (item 5); a rate limit is retryable; everything else is a
 * chain-unavailable that may retry only on transient 5xx.
 */
export function classifyOptionsFailure(status: number | null, code: string | null | undefined): OptionsFailureClassification {
  const normalizedCode = (code ?? '').toLowerCase();
  // A plan refusal is also a 401/403, so it is recognised first: telling the
  // reader their provider lacks options data when the real answer is "upgrade"
  // would send them to the wrong remedy.
  if (normalizedCode === 'upgrade_required' || normalizedCode === 'authentication_required') {
    return { reason: 'subscription-required', retryable: false, stopsPolling: true };
  }
  if (status === 401 || status === 403 || normalizedCode === 'forbidden' || normalizedCode === 'provider-unauthorized') {
    return { reason: 'entitlement-required', retryable: false, stopsPolling: true };
  }
  if (normalizedCode === 'provider-not-configured') {
    return { reason: 'entitlement-required', retryable: false, stopsPolling: true };
  }
  if (status === 429 || normalizedCode === 'rate-limited') {
    return { reason: 'rate-limited', retryable: true, stopsPolling: false };
  }
  if (status === 404 || normalizedCode === 'not-found') {
    return { reason: 'chain-unavailable', retryable: false, stopsPolling: false };
  }
  if (status === 422 || normalizedCode === 'insufficient-data') {
    return { reason: 'insufficient-coverage', retryable: false, stopsPolling: false };
  }
  const retryable = status !== null && status >= 500;
  return { reason: 'chain-unavailable', retryable, stopsPolling: false };
}
