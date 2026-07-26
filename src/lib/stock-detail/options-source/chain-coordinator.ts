import { fetchOptionsChainOutcome, type OptionsChainOutcome } from './client';
import { optionsRequestKey } from './planner';

type Fetcher = (
  symbol: string,
  expiration: string,
  acceptedPrice: number | null,
  signal: AbortSignal,
) => Promise<OptionsChainOutcome>;

interface ChainState {
  outcome: OptionsChainOutcome | null;
  freshUntil: number;
  cooldownUntil: number;
  blocked: boolean;
  inflight: Promise<OptionsChainOutcome> | null;
  controller: AbortController | null;
}
export const OPTIONS_CHAIN_FRESH_MS = 5 * 60_000;
export const OPTIONS_CHAIN_ERROR_COOLDOWN_MS = 30_000;
export const OPTIONS_CHAIN_RATE_LIMIT_COOLDOWN_MS = 60_000;

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
      state = { outcome: null, freshUntil: 0, cooldownUntil: 0, blocked: false, inflight: null, controller: null };
      this.states.set(key, state);
    }
    return state;
  }

  async load(symbol: string, expiration: string, acceptedPrice: number | null): Promise<OptionsChainOutcome> {
    const key = optionsRequestKey(symbol, expiration);
    const state = this.ensure(key);
    const now = this.now();
    if (state.outcome?.ok && now < state.freshUntil) return state.outcome;
    if (state.blocked && state.outcome) return state.outcome;
    if (state.outcome && !state.outcome.ok && now < state.cooldownUntil) return state.outcome;
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
      return outcome;
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
