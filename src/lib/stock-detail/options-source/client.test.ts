import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOptionsExpirations, fetchOptionsSr } from './client';

const NOW_MS = Date.UTC(2026, 6, 21);
const EXPIRATION = '2026-08-21';

afterEach(() => vi.unstubAllGlobals());

function rawContract(type: 'call' | 'put', strike: number, openInterest: number) {
  return {
    contractSymbol: `${type}-${strike}`, underlyingSymbol: 'RKLB', type, expiration: EXPIRATION, strike,
    bid: null, ask: null, last: null, mark: null, volume: null, openInterest,
    impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null, multiplier: 100, currency: 'USD', provider: 'alpha-vantage',
    asOf: '2026-07-21T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed',
  };
}

function chainEnvelope() {
  return {
    data: {
      underlyingSymbol: 'RKLB', spot: 50, expiration: EXPIRATION, expirations: [EXPIRATION],
      calls: [
        rawContract('call', 48, 200), rawContract('call', 49, 300),
        rawContract('call', 50, 500), rawContract('call', 51, 450),
      ],
      puts: [rawContract('put', 40, 600), rawContract('put', 45, 200), rawContract('put', 50, 120)],
      provider: 'alpha-vantage', asOf: '2026-07-21T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed',
      delayedMinutes: null, completeness: 0.8, warnings: [],
    },
    meta: { provider: 'alpha-vantage' },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const signal = new AbortController().signal;

describe('fetchOptionsSr — reuses the real chain route and computes typed levels', () => {
  it('computes walls from a validated real chain and marks DELAYED (never real-time)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(chainEnvelope())));
    const result = await fetchOptionsSr('RKLB', EXPIRATION, 50, signal, { nowMs: NOW_MS, config: { minStrikes: 4, clusterTolerancePercent: 0.03 } });
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.callWall!.price).toBe(50);
    expect(result.putWall!.price).toBe(40);
    expect(result.maxPain).not.toBeNull();
    expect(result.dataMode).toBe('DELAYED');
    expect(JSON.stringify(result)).not.toMatch(/real[\s_-]?time/i);
  });

  it('folds a 403 into a non-retryable entitlement-required unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: null, error: { code: 'forbidden', message: 'not entitled' } }, 403)));
    const result = await fetchOptionsSr('RKLB', EXPIRATION, 50, signal, { nowMs: NOW_MS });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('entitlement-required');
  });

  it('folds a 429 into a rate-limited unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: null, error: { code: 'rate-limited', message: 'slow down' } }, 429)));
    const result = await fetchOptionsSr('RKLB', EXPIRATION, 50, signal, { nowMs: NOW_MS });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('rate-limited');
  });
});

describe('fetchOptionsExpirations', () => {
  it('returns only non-expired expirations, sorted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: {
        underlyingSymbol: 'RKLB', expirations: ['2020-01-01', '2026-09-18', '2026-08-21'],
        provider: 'alpha-vantage', asOf: '2026-07-21T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed', delayedMinutes: null, warnings: [],
      },
      meta: { provider: 'alpha-vantage' },
    })));
    const outcome = await fetchOptionsExpirations('RKLB', signal);
    expect(outcome.ok).toBe(true);
    expect(outcome.expirations).toEqual(['2026-08-21', '2026-09-18']);
  });

  it('classifies a 403 as a non-retryable entitlement stop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: null, error: { code: 'forbidden' } }, 403)));
    const outcome = await fetchOptionsExpirations('RKLB', signal);
    expect(outcome.ok).toBe(false);
    expect(outcome.classification?.stopsPolling).toBe(true);
    expect(outcome.classification?.reason).toBe('entitlement-required');
  });
});
