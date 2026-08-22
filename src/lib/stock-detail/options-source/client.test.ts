import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOptionsChainOutcome, fetchOptionsExpirations, fetchOptionsSr, fetchOptionsWalls } from './client';

const EXPIRATION = '2026-08-21';

/**
 * The day this file is standing on, pinned.
 *
 * `fetchOptionsExpirations` filters `value >= new Date()`, so every expiration
 * in this file has a shelf life: EXPIRATION expired on 2026-08-22 and the
 * sorted-and-filtered assertion below started failing on that date, for a
 * reason that has nothing to do with the client this file is about. A test that
 * goes red on its own is worse than no test — the next red run cannot be read.
 *
 * Pinned, not computed from `now`: the case under test is that ONE date is
 * dropped and two are kept, and a fixture derived from today can never exercise
 * the filter. Every envelope here carries `asOf: 2026-07-26`, so that is the
 * day these responses describe.
 *
 * `toFake: ['Date']` only. This file awaits real promises; faking timers too
 * would stall them.
 */
const PINNED_NOW = new Date('2026-07-26T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function rawContract(type: 'call' | 'put', strike: number, openInterest: number) {
  return {
    contractSymbol: `${type}-${strike}`, underlyingSymbol: 'RKLB', type, expiration: EXPIRATION, strike,
    bid: null, ask: null, last: null, mark: null, volume: null, openInterest,
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

function wallsEnvelope() {
  return {
    data: {
      status: 'available', symbol: 'RKLB', expiration: EXPIRATION, acceptedPrice: 50,
      callWall: { strike: 50, price: 50, rawOI: 500, clusteredOI: 1_250, distancePercent: 0 },
      putWall: { strike: 40, price: 40, rawOI: 600, clusteredOI: 600, distancePercent: -20 },
      maxPain: { strike: 49, price: 49, rawOI: null, clusteredOI: null, distancePercent: -2 },
      totalCallOI: 1_450, totalPutOI: 920, putCallOIRatio: 0.63,
      strikeCoverage: 7, contractCoverage: 1, provider: 'alpha-vantage',
      asOf: '2026-07-21T00:00:00.000Z', dataMode: 'DELAYED', reliability: 'high', limitations: [],
    },
    meta: { provider: 'alpha-vantage' },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const signal = new AbortController().signal;

describe('fetchOptionsSr — reuses the chain route and reads server-gated walls', () => {
  it('accepts the Pro ledger DTO and hydrates locked fields only after parsing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(chainEnvelope())));

    const outcome = await fetchOptionsChainOutcome('RKLB', EXPIRATION, 50, signal, { wallsEntitled: false });

    expect(outcome.ok).toBe(true);
    expect(outcome.chain?.calls[0]).toMatchObject({ strike: 48, impliedVolatility: null, delta: null, valuationSource: null });
  });

  it('loads a validated chain then reads the typed Walls endpoint result', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse(chainEnvelope()))
      .mockResolvedValueOnce(jsonResponse(wallsEnvelope()));
    vi.stubGlobal('fetch', fetcher);
    const result = await fetchOptionsSr('RKLB', EXPIRATION, 50, signal);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.callWall!.price).toBe(50);
    expect(result.putWall!.price).toBe(40);
    expect(result.maxPain).not.toBeNull();
    expect(result.dataMode).toBe('DELAYED');
    expect(JSON.stringify(result)).not.toMatch(/real[\s_-]?time/i);
    expect(fetcher).toHaveBeenNthCalledWith(1, `/api/market/options/chain?symbol=RKLB&expiration=${EXPIRATION}`, expect.objectContaining({ cache: 'no-store' }));
    expect(fetcher).toHaveBeenNthCalledWith(2, `/api/market/options/walls?symbol=RKLB&expiration=${EXPIRATION}&underlyingPrice=50`, expect.objectContaining({ cache: 'no-store' }));
  });

  it('does not request or compute Walls when the reader lacks the capability', async () => {
    const fetcher = vi.fn(async () => jsonResponse(chainEnvelope()));
    vi.stubGlobal('fetch', fetcher);

    const result = await fetchOptionsSr('RKLB', EXPIRATION, 50, signal, { wallsEntitled: false });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'unavailable', reason: 'subscription-required' });
    expect(JSON.stringify(result)).not.toMatch(/callWall|putWall|maxPain/);
  });

  it('folds a 403 into a non-retryable entitlement-required unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: null, error: { code: 'forbidden', message: 'not entitled' } }, 403)));
    const result = await fetchOptionsSr('RKLB', EXPIRATION, 50, signal);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('entitlement-required');
  });

  it('folds a 429 into a rate-limited unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: null, error: { code: 'rate-limited', message: 'slow down' } }, 429)));
    const result = await fetchOptionsSr('RKLB', EXPIRATION, 50, signal);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('rate-limited');
  });

  it('preserves Retry-After and provider provenance for a handled chain 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: null,
      error: { code: 'rate-limited', message: 'slow down' },
      meta: { provider: 'alpha-vantage' },
    }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '37' } })));
    const outcome = await fetchOptionsChainOutcome('RKLB', EXPIRATION, 50, signal);
    expect(outcome).toMatchObject({ ok: false, provider: 'alpha-vantage', retryAfterSeconds: 37 });
    expect(outcome.result).toMatchObject({ status: 'unavailable', reason: 'rate-limited', provider: 'alpha-vantage' });
  });

  it('classifies a direct Walls upgrade refusal without exposing a value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: null,
      error: { code: 'UPGRADE_REQUIRED', message: 'Elite required' },
      meta: { provider: null },
    }, 403)));

    const result = await fetchOptionsWalls('RKLB', EXPIRATION, 50, signal);

    expect(result).toMatchObject({ status: 'unavailable', reason: 'subscription-required' });
    expect(JSON.stringify(result)).not.toMatch(/callWall|putWall|maxPain/);
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
