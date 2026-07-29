import type { OptionsSrResult } from '@/src/lib/analytics/options-sr';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import { fetchOptionsChainOutcome, type OptionsChainOutcome } from './client';
import { optionsRequestKey } from './planner';

type Fetcher = (
  symbol: string,
  expiration: string,
  acceptedPrice: number | null,
  signal: AbortSignal,
) => Promise<OptionsChainOutcome>;

interface LastGoodChain {
  chain: OptionsChain;
  result: OptionsSrResult;
  fetchedAt: number;
}

interface ChainState {
  outcome: OptionsChainOutcome | null;
  freshUntil: number;
  cooldownUntil: number;
  blocked: boolean;
  inflight: Promise<OptionsChainOutcome> | null;
  controller: AbortController | null;
  /** Survives failures: a 429 must not erase a chain we already hold. */
  lastGood: LastGoodChain | null;
}
export const OPTIONS_CHAIN_FRESH_MS = 30_000;
export const OPTIONS_CHAIN_ERROR_COOLDOWN_MS = 30_000;
export const OPTIONS_CHAIN_RATE_LIMIT_COOLDOWN_MS = 60_000;
/**
 * How long a last-good chain may still be offered as an explicitly STALE
 * fallback after a failure. Matches the server cache's stale window so both
 * layers stop trusting the same data at the same time.
 */
export const OPTIONS_CHAIN_STALE_MAX_MS = 15 * 60_000;

/**
 * Browser-wide chain coordinator. A hook remount, Strict Mode, rapid toggle, or
 * a second chart consumer joins the same request and reuses its fresh result.
 * Failed requests are negatively cached; Retry-After always wins for 429s.
 */
export class OptionsChainCoordinator {
  private readonly states = new Map<string, ChainState>();

  constructor(
    private readonly fetcher: Fetcher = fetchOptionsChainOutcome,
    private readonly now: () => number = Date.now,
  ) {}

  private ensure(key: string): ChainState {
    let state = this.states.get(key);
    if (!state) {
      state = { outcome: null, freshUntil: 0, cooldownUntil: 0, blocked: false, inflight: null, controller: null, lastGood: null };
      this.states.set(key, state);
    }
    return state;
  }

  /**
   * Attach the last-good chain to a failed outcome (stale-if-error).
   *
   * Evaluated at READ time, so an outcome replayed from the negative cache stops
   * offering the fallback as soon as it ages out. A successful outcome is
   * returned untouched — fresh data never carries a stale marker.
   */
  private withStaleFallback(state: ChainState, outcome: OptionsChainOutcome, now: number): OptionsChainOutcome {
    if (outcome.ok) return outcome;
    const lastGood = state.lastGood;
    if (!lastGood || now - lastGood.fetchedAt > OPTIONS_CHAIN_STALE_MAX_MS) {
      return { ...outcome, staleFallback: null };
    }
    return {
      ...outcome,
      staleFallback: {
        chain: lastGood.chain,
        result: lastGood.result,
        fetchedAt: new Date(lastGood.fetchedAt).toISOString(),
        reason: outcome.classification?.reason ?? 'chain-unavailable',
      },
    };
  }

  async load(symbol: string, expiration: string, acceptedPrice: number | null): Promise<OptionsChainOutcome> {
    const key = optionsRequestKey(symbol, expiration);
    const state = this.ensure(key);
    const now = this.now();
    if (state.outcome?.ok && now < state.freshUntil) return state.outcome;
    if (state.blocked && state.outcome) return this.withStaleFallback(state, state.outcome, now);
    if (state.outcome && !state.outcome.ok && now < state.cooldownUntil) {
      return this.withStaleFallback(state, state.outcome, now);
    }
    if (state.inflight) return state.inflight;

    const controller = new AbortController();
    state.controller = controller;
    const request = (async () => {
      const outcome = await this.fetcher(symbol.toUpperCase(), expiration, acceptedPrice, controller.signal);
      const completedAt = this.now();
      state.outcome = outcome;
      if (outcome.ok) {
        state.freshUntil = completedAt + OPTIONS_CHAIN_FRESH_MS;
        state.cooldownUntil = 0;
        state.blocked = false;
        // Retain the successful chain so the NEXT failure can degrade to STALE
        // instead of erasing open interest and implied volatility outright.
        if (outcome.chain) {
          state.lastGood = { chain: outcome.chain, result: outcome.result, fetchedAt: completedAt };
        }
      } else if (outcome.classification?.stopsPolling) {
        state.blocked = true;
      } else if (outcome.classification?.reason === 'rate-limited') {
        const retryMs = outcome.retryAfterSeconds && outcome.retryAfterSeconds > 0
          ? outcome.retryAfterSeconds * 1_000
          : OPTIONS_CHAIN_RATE_LIMIT_COOLDOWN_MS;
        state.cooldownUntil = completedAt + retryMs;
      } else {
        state.cooldownUntil = completedAt + OPTIONS_CHAIN_ERROR_COOLDOWN_MS;
      }
      return this.withStaleFallback(state, outcome, completedAt);
    })();
    state.inflight = request;
    try {
      return await request;
    } finally {
      if (state.inflight === request) state.inflight = null;
      if (state.controller === controller) state.controller = null;
    }
  }

  cooldownRemainingMs(symbol: string, expiration: string): number {
    const state = this.states.get(optionsRequestKey(symbol, expiration));
    if (!state) return 0;
    if (state.blocked) return Number.POSITIVE_INFINITY;
    return Math.max(0, state.cooldownUntil - this.now());
  }

  /** Manual retry never bypasses Retry-After and never duplicates an in-flight request. */
  reset(symbol: string, expiration: string): boolean {
    const state = this.states.get(optionsRequestKey(symbol, expiration));
    if (!state) return true;
    if (state.inflight || state.blocked || this.now() < state.cooldownUntil) return false;
    state.outcome = null;
    state.freshUntil = 0;
    return true;
  }

  clear(): void {
    for (const state of this.states.values()) state.controller?.abort();
    this.states.clear();
  }
}

export const optionsChainCoordinator = new OptionsChainCoordinator();

export function clearOptionsChainCoordinatorForTests(): void {
  optionsChainCoordinator.clear();
}
