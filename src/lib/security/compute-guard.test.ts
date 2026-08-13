import { describe, expect, it } from 'vitest';
import {
  ComputeCache,
  computeCacheKey,
  ConcurrencyGate,
  MONTE_CARLO_WORK_LIMIT,
  monteCarloWorkUnits,
  SIMULATION_CONCURRENCY,
  withTimeout,
} from './compute-guard';

/**
 * The bounds on expensive work.
 *
 * The attack these exist for is not "too many requests" — the rate limiter
 * answers that — it is "one request, four hundred times the work". A caller
 * comfortably inside every request-per-minute bound can still post the largest
 * simulation the schema permits on every single request, and entitlement does
 * not help: being allowed to run a simulation is not being allowed to run the
 * biggest one repeatedly.
 */

describe('bounding the size of one simulation', () => {
  it('counts the path matrix against every leg on both sides of the comparison', () => {
    // Both portfolios are simulated over the same paths; counting one would
    // understate the largest request by half.
    expect(monteCarloWorkUnits({ paths: 1_000, steps: 30, legs: 8 })).toBe(240_000);
  });

  it('admits the heaviest run the product\'s own UI can construct', () => {
    // 50,000 paths, a year of trading days, a four-leg spread and its four-leg
    // comparison — the worst case a person can build in the interface.
    const heaviest = monteCarloWorkUnits({ paths: 50_000, steps: 252, legs: 8 });
    expect(heaviest).toBeLessThanOrEqual(MONTE_CARLO_WORK_LIMIT);
  });

  it('refuses the corner only a script asks for', () => {
    // Every schema maximum at once: 50,000 paths × 366 steps × 40 legs.
    const abusive = monteCarloWorkUnits({ paths: 50_000, steps: 366, legs: 40 });
    expect(abusive).toBeGreaterThan(MONTE_CARLO_WORK_LIMIT);
  });

  it('never reports zero work for a request that would still run', () => {
    expect(monteCarloWorkUnits({ paths: 1_000, steps: 1, legs: 0 })).toBeGreaterThan(0);
  });
});

describe('the concurrency gate', () => {
  it('admits up to the limit and refuses the surplus', () => {
    const gate = new ConcurrencyGate(2);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    expect(gate.inFlight).toBe(2);
  });

  it('gives the slot back however the work ends', async () => {
    const gate = new ConcurrencyGate(1);

    await gate.run(() => 'fine');
    expect(gate.inFlight).toBe(0);

    await expect(gate.run(() => { throw new Error('engine exploded'); })).rejects.toThrow('engine exploded');
    /*
     * The one that matters. A slot leaked on the failure path is a gate that
     * tightens by one every time something goes wrong, until a perfectly healthy
     * instance refuses everybody — and it only shows up in production, under the
     * exact conditions nobody wants to be debugging.
     */
    expect(gate.inFlight).toBe(0);
  });

  it('reports a refusal rather than throwing, so the route answers 429 not 500', async () => {
    const gate = new ConcurrencyGate(1);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });

    const first = gate.run(() => held);
    const second = await gate.run(() => 'never runs');
    expect(second.ok).toBe(false);

    release();
    await first;
    expect(gate.inFlight).toBe(0);
  });

  it('sheds a parallel burst instead of queueing it', async () => {
    const gate = new ConcurrencyGate(SIMULATION_CONCURRENCY);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });

    const inFlight = Array.from({ length: SIMULATION_CONCURRENCY }, () => gate.run(() => held));
    const surplus = await Promise.all(
      Array.from({ length: 20 }, () => gate.run(() => 'never runs')),
    );

    // Every one of the twenty is refused immediately; none of them waits.
    expect(surplus.every((result) => !result.ok)).toBe(true);

    release();
    await Promise.all(inFlight);
  });
});

describe('collapsing identical repeated work', () => {
  it('returns the stored answer inside the window and forgets it after', () => {
    const clock = { now: 0 };
    const cache = new ComputeCache<string>(8, 1_000, () => clock.now);

    cache.set('k', 'answer');
    expect(cache.get('k')).toBe('answer');

    clock.now = 1_001;
    expect(cache.get('k')).toBeNull();
  });

  it('stays bounded, evicting the least recently used', () => {
    const cache = new ComputeCache<number>(3, 60_000, () => 0);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a');            // 'a' is now the most recent
    cache.set('d', 4);         // evicts 'b', the oldest untouched entry

    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeNull();
    expect(cache.get('d')).toBe(4);
  });

  it('separates two requests that differ anywhere in the body', () => {
    const base = JSON.stringify({ input: { seed: 1, paths: 1_000 } });
    const other = JSON.stringify({ input: { seed: 2, paths: 1_000 } });
    expect(computeCacheKey(base)).not.toBe(computeCacheKey(other));
    expect(computeCacheKey(base)).toBe(computeCacheKey(base));
  });

  /*
   * The key is a digest and a length, never the body. A cache keyed by the raw
   * request would hold a copy of every position and price a reader posted, in
   * process memory, for the length of the TTL.
   */
  it('never keeps the request body in the key', () => {
    const raw = JSON.stringify({ input: { symbol: 'SECRET', strike: 123.45 } });
    const key = computeCacheKey(raw);
    expect(key).not.toContain('SECRET');
    expect(key).not.toContain('123.45');
  });
});

describe('bounding asynchronous work', () => {
  it('lets work that finishes in time through unchanged', async () => {
    const result = await withTimeout(Promise.resolve('value'), 1_000);
    expect(result).toEqual({ ok: true, value: 'value' });
  });

  it('gives up on work that does not answer', async () => {
    const never = new Promise<string>(() => {});
    const result = await withTimeout(never, 10);
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });
});
