import { fetchOptionsExpirations, type ExpirationsOutcome } from './client';

/**
 * Browser-side coordinator that guarantees **one options-expirations request per
 * symbol** and honours a rate-limit cooldown (item 17). React StrictMode's
 * double-invoke, tab toggles and re-renders all funnel through here, so a symbol
 * is fetched at most once until it either succeeds, is permanently blocked
 * (entitlement), or its 429 cooldown lapses. It is transport-only: all HTTP and
 * classification live in {@link fetchOptionsExpirations}; this layer only decides
 * whether a network call is allowed to run.
 */

type Fetcher = (symbol: string, signal: AbortSignal) => Promise<ExpirationsOutcome>;

interface SymbolState {
  outcome: ExpirationsOutcome | null;
  /** Successful expiration lists are fresh only for this bounded window. */
  freshUntil: number;
  /** Epoch ms before which no automatic re-fetch is allowed (rate-limit / transient cooldown). */
  cooldownUntil: number;
  /** A non-retryable entitlement/config fault — never auto-retried. */
  blocked: boolean;
  inflight: Promise<ExpirationsOutcome> | null;
}

/** Fallback cooldown when a 429 arrives without a usable Retry-After. */
export const DEFAULT_EXPIRATIONS_COOLDOWN_MS = 60_000;
export const EXPIRATIONS_FRESH_MS = 5 * 60_000;

export class OptionsExpirationsCoordinator {
  private readonly state = new Map<string, SymbolState>();

  constructor(
    private readonly fetcher: Fetcher = fetchOptionsExpirations,
    private readonly now: () => number = Date.now,
  ) {}

  private ensure(symbol: string): SymbolState {
    let entry = this.state.get(symbol);
    if (!entry) {
      entry = { outcome: null, freshUntil: 0, cooldownUntil: 0, blocked: false, inflight: null };
      this.state.set(symbol, entry);
    }
    return entry;
  }

  /** True when a cooldown is active and an automatic retry would be suppressed. */
  isCoolingDown(symbol: string): boolean {
    const entry = this.state.get(symbol.toUpperCase());
    return Boolean(entry && !entry.outcome?.ok && (entry.blocked || this.now() < entry.cooldownUntil));
  }

  /**
   * Resolve the expirations for a symbol. Serves a cached success or a still-cooling
   * failure without touching the network; otherwise runs exactly one request and
   * records the resulting cooldown/block.
   */
  async load(symbol: string): Promise<ExpirationsOutcome> {
    const key = symbol.toUpperCase();
    const entry = this.ensure(key);

    // A permanent block or an earlier success is authoritative — never re-fetch.
    if (entry.blocked && entry.outcome) return entry.outcome;
    if (entry.outcome?.ok && this.now() < entry.freshUntil) return entry.outcome;
    // Within an active cooldown, replay the last failure so the UI stays truthful
    // without generating repeated 429s.
    if (entry.outcome && this.now() < entry.cooldownUntil) return entry.outcome;
    // Collapse concurrent callers (StrictMode / fast re-mounts) onto one request.
    if (entry.inflight) return entry.inflight;

    // The shared request uses its own controller so a single consumer unmounting
    // can never abort the in-flight fetch that other consumers are awaiting.
    const controller = new AbortController();
    const promise = (async () => {
      const outcome = await this.fetcher(key, controller.signal);
      if (outcome.ok) {
        entry.freshUntil = this.now() + EXPIRATIONS_FRESH_MS;
        entry.cooldownUntil = 0;
        entry.blocked = false;
      } else if (outcome.classification?.stopsPolling) {
        entry.blocked = true;
      } else if (outcome.classification?.reason === 'rate-limited') {
        const retryMs = outcome.retryAfterSeconds && outcome.retryAfterSeconds > 0
          ? outcome.retryAfterSeconds * 1_000
          : DEFAULT_EXPIRATIONS_COOLDOWN_MS;
        entry.cooldownUntil = this.now() + retryMs;
      } else {
        // Other transient failures still get a brief cooldown so a flapping route
        // cannot produce a request storm.
        entry.cooldownUntil = this.now() + DEFAULT_EXPIRATIONS_COOLDOWN_MS;
      }
      entry.outcome = outcome;
      return outcome;
    })();
    entry.inflight = promise;
    try {
      return await promise;
    } finally {
      if (entry.inflight === promise) entry.inflight = null;
    }
  }

  /**
   * User-initiated retry: drop a cached failure and any cooldown so the next
   * {@link load} runs a fresh request. An entitlement block is preserved — those
   * are never auto- or manually re-polled here.
   */
  reset(symbol: string): boolean {
    const entry = this.state.get(symbol.toUpperCase());
    if (!entry) return true;
    if (entry.blocked || entry.inflight || this.now() < entry.cooldownUntil) return false;
    entry.outcome = null;
    entry.freshUntil = 0;
    entry.cooldownUntil = 0;
    return true;
  }

  /** Test/teardown hook. */
  clear(symbol?: string): void {
    if (symbol) this.state.delete(symbol.toUpperCase());
    else this.state.clear();
  }
}

export const optionsExpirationsCoordinator = new OptionsExpirationsCoordinator();

export function clearOptionsExpirationsCoordinatorForTests(): void {
  optionsExpirationsCoordinator.clear();
}
