import { describe, expect, it, vi } from 'vitest';
import { optionsUnavailable } from '@/src/lib/analytics/options-sr';
import {
  OPTIONS_CHAIN_FRESH_MS,
  OptionsChainCoordinator,
} from './chain-coordinator';
import type { OptionsChainOutcome } from './client';

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
});
