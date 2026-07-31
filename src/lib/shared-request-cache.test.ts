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
