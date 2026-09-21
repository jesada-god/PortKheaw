import { describe, expect, it, vi } from 'vitest';
import { SharedRequestCache } from './shared-request-cache';

describe('SharedRequestCache', () => {
  it('deduplicates concurrent requests for the same key', async () => {
    const cache = new SharedRequestCache(); const operation = vi.fn(async () => 'value');
    const [a, b] = await Promise.all([cache.resolve('history:AAPL:1m', operation, { freshMs: 1, staleMs: 1000, errorMs: 10 }), cache.resolve('history:AAPL:1m', operation, { freshMs: 1, staleMs: 1000, errorMs: 10 })]);
    expect(a.value).toBe('value'); expect(b.value).toBe('value'); expect(operation).toHaveBeenCalledTimes(1);
  });

  it('uses stale data after a provider failure', async () => {
    vi.useFakeTimers(); const cache = new SharedRequestCache(); const policy = { freshMs: 10, staleMs: 1000, errorMs: 100 };
    await cache.resolve('history:AAPL:1m', async () => 'old', policy); vi.advanceTimersByTime(11);
    const result = await cache.resolve('history:AAPL:1m', async () => { throw new Error('quota'); }, policy);
    expect(result).toMatchObject({ value: 'old', state: 'stale', error: expect.any(Error) });
    expect(result.storedAt).toBeTypeOf('number');
    vi.useRealTimers();
  });

  it('keeps a cached Profile available when its provider later fails', async () => {
    vi.useFakeTimers();
    const cache = new SharedRequestCache();
    const policy = { freshMs: 10, staleMs: 7 * 24 * 60 * 60_000, errorMs: 100 };
    await cache.resolve('profile:RKLB', async () => ({ symbol: 'RKLB', name: 'Rocket Lab USA, Inc.' }), policy);
    vi.advanceTimersByTime(11);
    const result = await cache.resolve<{ symbol: string; name: string }>('profile:RKLB', async () => {
      throw new Error('provider unavailable');
    }, policy);
    expect(result.state).toBe('stale');
    expect(result.value.name).toBe('Rocket Lab USA, Inc.');
    expect(result.error).toEqual(expect.objectContaining({ message: 'provider unavailable' }));
    vi.useRealTimers();
  });

  it('does not clear the Profile cache when the Quote key is rate-limited', async () => {
    const cache = new SharedRequestCache();
    const policy = { freshMs: 1_000, staleMs: 1_000, errorMs: 100 };
    await cache.resolve('profile:RKLB', async () => 'Rocket Lab USA, Inc.', policy);
    await expect(cache.resolve('quote:RKLB', async () => {
      throw new Error('quote rate limit');
    }, policy)).rejects.toThrow('quote rate limit');
    const profile = await cache.resolve('profile:RKLB', async () => 'unexpected', policy);
    expect(profile.state).toBe('cache');
    expect(profile.value).toBe('Rocket Lab USA, Inc.');
  });

  it('keeps history ranges in separate cache keys', async () => {
    const cache = new SharedRequestCache(); const operation = vi.fn(async (value: string) => value); const policy = { freshMs: 1000, staleMs: 1000, errorMs: 10 };
    await cache.resolve('history:AAPL:1m', () => operation('1m'), policy); await cache.resolve('history:AAPL:1y', () => operation('1y'), policy);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('invalidates one key without clearing unrelated last-good values', async () => {
    const cache = new SharedRequestCache();
    const policy = { freshMs: 1_000, staleMs: 1_000, errorMs: 10 };
    await cache.resolve('market', async () => 'old-market', policy);
    await cache.resolve('news', async () => 'old-news', policy);
    cache.invalidate('market');
    const market = await cache.resolve('market', async () => 'new-market', policy);
    const news = await cache.resolve('news', async () => 'unexpected', policy);
    expect(market.value).toBe('new-market');
    expect(news.value).toBe('old-news');
  });
});

/**
 * The bound, and the two ways it has to hold.
 *
 * `search:${query}` is keyed by a string an anonymous caller supplies to a
 * public endpoint, so "the map only ever grows" was not a theoretical leak —
 * it was a request away.
 */
describe('SharedRequestCache bounds', () => {
  const policy = { freshMs: 60_000, staleMs: 60_000, errorMs: 1_000 };

  it('drops the coldest entries once the cap is passed', async () => {
    const cache = new SharedRequestCache(3);
    for (const key of ['a', 'b', 'c', 'd']) {
      await cache.resolve(key, async () => key, policy);
    }

    // `a` was the least recently used when `d` arrived.
    const loads: string[] = [];
    for (const key of ['b', 'c', 'd']) {
      await cache.resolve(key, async () => { loads.push(key); return key; }, policy);
    }
    expect(loads, 'entries inside the cap must still be served from memory').toEqual([]);

    await cache.resolve('a', async () => { loads.push('a'); return 'a'; }, policy);
    expect(loads, 'the evicted entry has to be loaded again').toEqual(['a']);
  });

  it('counts a read as use, so a hot key is not evicted for being old', async () => {
    const cache = new SharedRequestCache(2);
    await cache.resolve('hot', async () => 'hot', policy);
    await cache.resolve('cold', async () => 'cold', policy);

    // Touch the oldest. Without re-insertion on read, `Map` order would still
    // put `hot` first and the next write would evict exactly the entry being
    // used most.
    await cache.resolve('hot', async () => 'unused', policy);
    await cache.resolve('new', async () => 'new', policy);

    const loads: string[] = [];
    await cache.resolve('hot', async () => { loads.push('hot'); return 'hot'; }, policy);
    expect(loads).toEqual([]);
  });

  it('returns memory for entries that can never be served again', async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedRequestCache(1_000);
      await cache.resolve('expiring', async () => 'value', policy);
      // Past fresh AND past stale: this entry is unreachable by any caller, so
      // holding it is pure cost. Sweeping happens on the next write.
      vi.advanceTimersByTime(policy.freshMs + policy.staleMs + 1);
      await cache.resolve('other', async () => 'other', policy);

      const loads: string[] = [];
      await cache.resolve('expiring', async () => { loads.push('expiring'); return 'again'; }, policy);
      expect(loads).toEqual(['expiring']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never drops an in-flight request, which would defeat single-flighting', async () => {
    const cache = new SharedRequestCache(1);
    let settleFirst!: (value: string) => void;
    let calls = 0;
    const slow = () => { calls += 1; return new Promise<string>((resolve) => { settleFirst = resolve; }); };

    const first = cache.resolve('slow', slow, policy);
    // A second key writing while the first is still running must not evict the
    // promise the first is waiting on — an evicted in-flight entry means the
    // next caller starts the same provider call again.
    await cache.resolve('other', async () => 'other', policy);
    const second = cache.resolve('slow', slow, policy);

    settleFirst('done');
    await expect(first).resolves.toMatchObject({ value: 'done' });
    await expect(second).resolves.toMatchObject({ value: 'done' });
    expect(calls, 'the operation must have run once').toBe(1);
  });
});
