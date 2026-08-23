import type { NewsCacheClient } from './cache-client';

/**
 * An in-memory stand-in for Redis with real expiry and real `SET NX` semantics.
 *
 * It exists so the summary store's concurrency argument can actually be tested:
 * the interesting claims — one generation per fingerprint, one winner among
 * twenty simultaneous readers, a lock left to expire as a cooldown — are all
 * claims about what `SET key value NX EX` returns, and a double that always says
 * "you took it" would prove none of them. Time is supplied by the caller so a
 * test can move nine days forward without waiting.
 *
 * Values are JSON round-tripped on the way in, matching Upstash's REST client:
 * what comes back out is a copy, never the object the caller still holds.
 */
export class InMemoryNewsCache implements NewsCacheClient {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private now: () => number = () => Date.now()) {}

  /** Move the double's clock, so TTL expiry can be observed without waiting. */
  setClock(now: () => number) {
    this.now = now;
  }

  private live(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get<TValue>(key: string): Promise<TValue | null> {
    const entry = this.live(key);
    return entry ? JSON.parse(entry.value) as TValue : null;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.entries.set(key, {
      value: JSON.stringify(value),
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** Test-only view of what is currently held, ignoring expired keys. */
  has(key: string): boolean {
    return Boolean(this.live(key));
  }
}
