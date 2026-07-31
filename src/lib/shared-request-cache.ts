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

/** Process-local cache shared by all requests handled by this server instance. */
export class SharedRequestCache {
  private readonly values = new Map<string, CacheEntry<unknown>>();
  private readonly errors = new Map<string, ErrorEntry>();
  private readonly inflight = new Map<string, Promise<CacheResolution<unknown>>>();

  async resolve<T>(key: string, operation: () => Promise<T>, policy: CachePolicy): Promise<CacheResolution<T>> {
    const now = Date.now();
    const cached = this.values.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.freshUntil > now) {
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
        return { value, state: 'fresh', storedAt: completedAt };
      } catch (error) {
        this.errors.set(key, { error, until: Date.now() + policy.errorMs });
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
