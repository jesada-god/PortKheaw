import { describe, expect, it, vi } from 'vitest';
import {
  LastGoodSnapshotCoordinator,
  mapWithConcurrencyDeadline,
} from './industry-snapshot';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('LastGoodSnapshotCoordinator', () => {
  it('returns immediately without a snapshot and singleflights a cold refresh', async () => {
    const clock = { now: 1_000 };
    const coordinator = new LastGoodSnapshotCoordinator<string>(
      { freshMs: 100, staleMs: 1_000 },
      () => clock.now,
    );
    const pending = deferred<string>();
    const operation = vi.fn(() => pending.promise);

    expect(coordinator.read('2026-07-31')).toMatchObject({
      value: null,
      state: 'unavailable',
    });
    const first = coordinator.refresh('2026-07-31', operation);
    const second = coordinator.refresh('2026-07-31', operation);
    expect(first).toBe(second);
    expect(operation).toHaveBeenCalledTimes(1);

    pending.resolve('snapshot');
    await expect(first).resolves.toBe('snapshot');
    expect(coordinator.read('2026-07-31')).toMatchObject({
      value: 'snapshot',
      state: 'ready',
    });
  });

  it('serves last-good while a slow refresh runs and preserves it on failure', async () => {
    const clock = { now: 1_000 };
    const coordinator = new LastGoodSnapshotCoordinator<string>(
      { freshMs: 10, staleMs: 1_000 },
      () => clock.now,
    );
    await coordinator.refresh('2026-07-31', async () => 'last-good');
    clock.now += 11;
    const pending = deferred<string>();
    const refresh = coordinator.refresh('2026-07-31', () => pending.promise);

    expect(coordinator.read('2026-07-31')).toMatchObject({
      value: 'last-good',
      state: 'refreshing',
    });
    pending.reject(new Error('provider timeout'));
    await expect(refresh).resolves.toBe('last-good');
    expect(coordinator.read('2026-07-31').value).toBe('last-good');
  });

  it('does not let a late older trading-date refresh overwrite a newer snapshot', async () => {
    const coordinator = new LastGoodSnapshotCoordinator<string>({
      freshMs: 100,
      staleMs: 1_000,
    });
    const older = deferred<string>();
    const newer = deferred<string>();
    const oldRequest = coordinator.refresh('2026-07-30', () => older.promise);
    const newRequest = coordinator.refresh('2026-07-31', () => newer.promise);

    newer.resolve('newer');
    await newRequest;
    older.resolve('older');
    await oldRequest;
    expect(coordinator.read('2026-07-31').value).toBe('newer');
  });
});

describe('mapWithConcurrencyDeadline', () => {
  it('returns only completed work at the overall deadline and ignores late results', async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const second = deferred<string>();
    const resultPromise = mapWithConcurrencyDeadline(
      ['A', 'B', 'C'],
      2,
      Date.now() + 50,
      (_value, index) => index === 0 ? first.promise : second.promise,
    );
    first.resolve('A');
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;
    expect(result).toEqual({
      completed: [{ index: 0, value: 'A' }],
      timedOut: true,
    });
    second.resolve('late');
    await Promise.resolve();
    expect(result.completed).toHaveLength(1);
    vi.useRealTimers();
  });

  it('isolates one mapper failure and keeps successful siblings', async () => {
    const result = await mapWithConcurrencyDeadline(
      ['A', 'B', 'C'],
      2,
      Date.now() + 1_000,
      async (value) => {
        if (value === 'B') throw new Error('one provider symbol failed');
        return value;
      },
    );
    expect(result.timedOut).toBe(false);
    expect(result.completed.map((item) => item.value).sort()).toEqual(['A', 'C']);
  });
});
