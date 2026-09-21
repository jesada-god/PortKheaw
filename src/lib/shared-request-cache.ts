export interface CachePolicy {
  freshMs: number;
  staleMs: number;
  errorMs: number;
}

interface CacheEntry<T> {
  value: T;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}

interface ErrorEntry {
  error: unknown;
  until: number;
}

export interface CacheResolution<T> {
  value: T;
  state: 'fresh' | 'cache' | 'stale';
  storedAt: number;
  error?: unknown;
}

/**
 * How many completed entries one cache may hold before the coldest are dropped.
 *
 * Chosen against the thing that actually fills these maps: the tradable symbol
 * universe. Five thousand is well above the number of instruments any instance
 * serves in the lifetime of a serverless container, so eviction is not part of
 * normal operation — it is the bound that exists for the case where the key is
 * not a symbol at all.
 */
const DEFAULT_MAX_ENTRIES = 5_000;

/**
 * Process-local cache shared by all requests handled by this server instance.
 *
 * ===========================================================================
 * WHY IT IS BOUNDED
 * ===========================================================================
 * These were three unbounded `Map`s, and at least one of them takes a key an
 * outsider chooses: `search:${query}` comes from `/api/market/search`, which is
 * public. A caller iterating random queries grew the map with every request,
 * and nothing ever removed an entry — expiry made a value unusable but left it
 * in memory, so even ordinary traffic only ever added. In a long-lived
 * container that is a slow leak; against a script it is an out-of-memory.
 *
 * Three rules, and each covers a case the others do not:
 *
 *   * **A cap with least-recently-used eviction** bounds the worst case. `Map`
 *     iterates in insertion order, so re-inserting a key on read is what makes
 *     "oldest entry" mean "coldest" rather than "first ever seen" — without
 *     that, a hot symbol inserted at startup would be the first evicted.
 *   * **A sweep of expired entries**, so memory is returned in the normal case
 *     rather than only under pressure. An entry past its stale window can
 *     never be served again; keeping it is pure cost.
 *   * **`inflight` is bounded too**, and deliberately never evicted early: a
 *     promise removed from that map while it is still running would let a
 *     second caller start the same provider request, which is the opposite of
 *     what single-flighting is for. It is bounded by rejecting nothing and
 *     relying on its own `finally` — plus the cap below as a backstop against
 *     a promise that somehow never settles.
 */
export class SharedRequestCache {
  private readonly values = new Map<string, CacheEntry<unknown>>();
  private readonly errors = new Map<string, ErrorEntry>();
  private readonly inflight = new Map<string, Promise<CacheResolution<unknown>>>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  /**
   * Drop what can no longer be served, then the coldest of what remains.
   *
   * Sweeping first matters: it usually frees enough that nothing has to be
   * evicted at all, so a cache under its cap never loses a live entry just
   * because an expired one was sitting in front of it.
   */
  private prune<T>(map: Map<string, T>, now: number, expiryOf: (entry: T) => number): void {
    for (const [key, entry] of map) {
      if (expiryOf(entry) <= now) map.delete(key);
    }
    // `Map` keys iterate oldest-first, and `touch` re-inserts on every read, so
    // the front of this iteration is the least recently used.
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  /*
   * The expiry is read through a function per map rather than by casting them
   * to a shared shape. The two entry types spell it differently —
   * `staleUntil` and `until` — and a cast asserting a field neither of them
   * has would compile, read `undefined`, compare false, and sweep nothing at
   * all. A pruner that silently never prunes is worse than none, because the
   * bound it claims to enforce is the reason nobody looks again.
   */
  private pruneAll(now: number): void {
    this.prune(this.values, now, (entry) => entry.staleUntil);
    this.prune(this.errors, now, (entry) => entry.until);
    /*
     * `inflight` is deliberately NOT capped, and this is the one map where a
     * cap would be a bug rather than a safeguard.
     *
     * Evicting an entry here does not free a promise — the operation keeps
     * running — it only hides it, so the next caller for that key starts the
     * same provider request again. A first attempt at this pruner did cap it,
     * and the effect was exactly that: a write on any other key while a slow
     * request was in flight dropped the slow request's entry and the work ran
     * twice. Single-flighting is the property this map exists for; a bound
     * that breaks it is not a bound worth having.
     *
     * It does not need one. Every entry is removed in the `finally` of the
     * request that created it, so the map's size is the number of requests
     * running right now — bounded by the instance's own concurrency, not by
     * anything a caller can choose. A promise that never settles is a leak in
     * whatever made it, and dropping it here would hide that while paying for
     * duplicate work.
     */
  }

  /** Move a key to the back of the queue, marking it recently used. */
  private touch<T>(map: Map<string, T>, key: string, entry: T): void {
    map.delete(key);
    map.set(key, entry);
  }

  async resolve<T>(key: string, operation: () => Promise<T>, policy: CachePolicy): Promise<CacheResolution<T>> {
    const now = Date.now();
    const cached = this.values.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.freshUntil > now) {
      this.touch(this.values, key, cached as CacheEntry<unknown>);
      return { value: cached.value, state: 'cache', storedAt: cached.storedAt };
    }

    const pending = this.inflight.get(key) as Promise<CacheResolution<T>> | undefined;
    if (pending) return pending;

    const recentError = this.errors.get(key);
    if (recentError && recentError.until > now) {
      if (cached && cached.staleUntil > now) {
        return {
          value: cached.value,
          state: 'stale',
          storedAt: cached.storedAt,
          error: recentError.error,
        };
      }
      throw recentError.error;
    }

    const request = (async (): Promise<CacheResolution<T>> => {
      try {
        const value = await operation();
        const completedAt = Date.now();
        this.values.set(key, {
          value,
          storedAt: completedAt,
          freshUntil: completedAt + policy.freshMs,
          staleUntil: completedAt + policy.freshMs + policy.staleMs,
        });
        this.errors.delete(key);
        // Swept on write, never on a timer: an interval would keep a
        // serverless instance awake to tidy a cache nothing is reading, and
        // the only way these maps grow is a write.
        this.pruneAll(completedAt);
        return { value, state: 'fresh', storedAt: completedAt };
      } catch (error) {
        this.errors.set(key, { error, until: Date.now() + policy.errorMs });
        this.pruneAll(Date.now());
        const fallback = this.values.get(key) as CacheEntry<T> | undefined;
        if (fallback && fallback.staleUntil > Date.now()) {
          return {
            value: fallback.value,
            state: 'stale',
            storedAt: fallback.storedAt,
            error,
          };
        }
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, request as Promise<CacheResolution<unknown>>);
    return request;
  }

  clear(): void {
    this.values.clear();
    this.errors.clear();
    this.inflight.clear();
  }

  /** Invalidate one completed key without disrupting an in-flight singleflight. */
  invalidate(key: string): void {
    this.values.delete(key);
    this.errors.delete(key);
  }
}
