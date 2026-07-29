import { describe, expect, it, vi } from 'vitest';
import { optionsUnavailable, type OptionsSrResult } from '@/src/lib/analytics/options-sr';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import {
  OPTIONS_CHAIN_FRESH_MS,
  OPTIONS_CHAIN_STALE_MAX_MS,
  OptionsChainCoordinator,
} from './chain-coordinator';
import type { OptionsChainOutcome } from './client';

/** A minimal but structurally real success payload, so last-good retention is exercised end to end. */
const goodChain = { underlyingSymbol: 'AAPL', expiration: '2026-08-21', status: 'delayed', provider: 'alpaca', asOf: '2026-07-28T20:00:00.000Z' } as unknown as OptionsChain;
const goodResult = { status: 'available', symbol: 'AAPL', expiration: '2026-08-21', putCallOIRatio: 0.82, totalCallOI: 1_000, totalPutOI: 820, dataMode: 'DELAYED', provider: 'alpaca', asOf: '2026-07-28T20:00:00.000Z' } as unknown as OptionsSrResult;

function success(): OptionsChainOutcome {
  return { ok: true, chain: goodChain, result: goodResult, provider: 'alpaca', classification: null, retryAfterSeconds: null };
}

function outcome(ok = true, retryAfterSeconds: number | null = null): OptionsChainOutcome {
  const classification = ok ? null : { reason: 'rate-limited' as const, retryable: true, stopsPolling: false };
  return {
    ok,
    chain: null,
    result: optionsUnavailable('AAPL', '2026-08-21', ok ? 'no-open-interest' : 'rate-limited', ok ? 'no OI' : 'limited', 'alpha-vantage'),
    provider: 'alpha-vantage',
    classification,
    retryAfterSeconds,
  };
}

describe('OptionsChainCoordinator', () => {
  it('uses a provider-semantic 30 second success TTL', () => {
    expect(OPTIONS_CHAIN_FRESH_MS).toBe(30_000);
  });

  it('single-flights the same symbol and expiration', async () => {
    let resolve!: (value: OptionsChainOutcome) => void;
    const fetcher = vi.fn(() => new Promise<OptionsChainOutcome>((done) => { resolve = done; }));
    const coordinator = new OptionsChainCoordinator(fetcher);
    const a = coordinator.load('AAPL', '2026-08-21', 200);
    const b = coordinator.load('aapl', '2026-08-21', 201);
    resolve(outcome());
    await Promise.all([a, b]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reuses a fresh success across close/reopen and refetches only after TTL', async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () => outcome());
    const coordinator = new OptionsChainCoordinator(fetcher, () => now);
    await coordinator.load('AAPL', '2026-08-21', 200);
    await coordinator.load('AAPL', '2026-08-21', 200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += OPTIONS_CHAIN_FRESH_MS + 1;
    await coordinator.load('AAPL', '2026-08-21', 200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('respects Retry-After and refuses a retry storm', async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () => outcome(false, 45));
    const coordinator = new OptionsChainCoordinator(fetcher, () => now);
    await coordinator.load('AAPL', '2026-08-21', 200);
    expect(coordinator.reset('AAPL', '2026-08-21')).toBe(false);
    await coordinator.load('AAPL', '2026-08-21', 200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 45_001;
    expect(coordinator.reset('AAPL', '2026-08-21')).toBe(true);
    await coordinator.load('AAPL', '2026-08-21', 200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  describe('stale-if-error', () => {
    it('keeps the last good chain when the refresh is rate limited, labelled with its real fetch time', async () => {
      let now = 1_000;
      const fetcher = vi.fn()
        .mockResolvedValueOnce(success())
        .mockResolvedValue(outcome(false, 45));
      const coordinator = new OptionsChainCoordinator(fetcher, () => now);

      const first = await coordinator.load('AAPL', '2026-08-21', 200);
      expect(first.ok).toBe(true);
      // A success must never advertise a stale fallback.
      expect(first.staleFallback ?? null).toBeNull();

      now += OPTIONS_CHAIN_FRESH_MS + 1;
      const limited = await coordinator.load('AAPL', '2026-08-21', 200);

      expect(limited.ok).toBe(false);
      expect(limited.chain).toBeNull();
      expect(limited.staleFallback).not.toBeNull();
      expect(limited.staleFallback!.chain).toBe(goodChain);
      expect(limited.staleFallback!.result).toBe(goodResult);
      expect(limited.staleFallback!.reason).toBe('rate-limited');
      // fetchedAt is the moment the GOOD chain arrived, not the moment of failure.
      expect(limited.staleFallback!.fetchedAt).toBe(new Date(1_000).toISOString());
    });

    it('offers no fallback when nothing good was ever fetched', async () => {
      const fetcher = vi.fn(async () => outcome(false, 45));
      const coordinator = new OptionsChainCoordinator(fetcher, () => 1_000);
      const limited = await coordinator.load('AAPL', '2026-08-21', 200);
      expect(limited.ok).toBe(false);
      expect(limited.staleFallback).toBeNull();
    });

    it('stops offering the fallback once it ages past the stale window', async () => {
      let now = 1_000;
      const fetcher = vi.fn()
        .mockResolvedValueOnce(success())
        .mockResolvedValue(outcome(false, 1));
      const coordinator = new OptionsChainCoordinator(fetcher, () => now);
      await coordinator.load('AAPL', '2026-08-21', 200);

      now += OPTIONS_CHAIN_FRESH_MS + 1;
      expect((await coordinator.load('AAPL', '2026-08-21', 200)).staleFallback).not.toBeNull();

      now += OPTIONS_CHAIN_STALE_MAX_MS + 1;
      const expired = await coordinator.load('AAPL', '2026-08-21', 200);
      expect(expired.staleFallback).toBeNull();
    });

    it('still serves the fallback while the failure is replayed from the negative cache', async () => {
      let now = 1_000;
      const fetcher = vi.fn()
        .mockResolvedValueOnce(success())
        .mockResolvedValue(outcome(false, 45));
      const coordinator = new OptionsChainCoordinator(fetcher, () => now);
      await coordinator.load('AAPL', '2026-08-21', 200);
      now += OPTIONS_CHAIN_FRESH_MS + 1;
      await coordinator.load('AAPL', '2026-08-21', 200);

      // Inside the cooldown: no new provider call, but the fallback is still offered.
      const replayed = await coordinator.load('AAPL', '2026-08-21', 200);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(replayed.staleFallback).not.toBeNull();
    });

    it('drops the fallback again as soon as a fresh chain succeeds', async () => {
      let now = 1_000;
      const fetcher = vi.fn()
        .mockResolvedValueOnce(success())
        .mockResolvedValueOnce(outcome(false, 1))
        .mockResolvedValue(success());
      const coordinator = new OptionsChainCoordinator(fetcher, () => now);
      await coordinator.load('AAPL', '2026-08-21', 200);
      now += OPTIONS_CHAIN_FRESH_MS + 1;
      expect((await coordinator.load('AAPL', '2026-08-21', 200)).staleFallback).not.toBeNull();

      now += 2_000;
      const recovered = await coordinator.load('AAPL', '2026-08-21', 200);
      expect(recovered.ok).toBe(true);
      expect(recovered.staleFallback ?? null).toBeNull();
    });
  });
});
