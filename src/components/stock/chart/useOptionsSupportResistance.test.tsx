// @vitest-environment jsdom

import React, { StrictMode, act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOptionsChainCoordinatorForTests,
  clearOptionsExpirationsCoordinatorForTests,
} from '@/src/lib/stock-detail/options-source';
import { useOptionsSupportResistance, type UseOptionsSupportResistanceResult } from './useOptionsSupportResistance';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';

const EXP_1 = '2026-08-21';
const EXP_2 = '2026-09-18';

function contract(type: 'call' | 'put', strike: number, expiration: string) {
  return {
    contractSymbol: `${type}-${expiration}-${strike}`, underlyingSymbol: 'AAPL', type, expiration, strike,
    bid: null, ask: null, last: null, mark: null, volume: 5, openInterest: 100 + strike,
    impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null, multiplier: 100, currency: 'USD', provider: 'alpha-vantage',
    asOf: '2026-07-26T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed',
  };
}

function expirationEnvelope() {
  return { data: { underlyingSymbol: 'AAPL', expirations: [EXP_1, EXP_2], provider: 'alpha-vantage', asOf: '2026-07-26T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed', delayedMinutes: null, warnings: [] } };
}

function chainEnvelope(expiration: string) {
  const strikes = [190, 195, 200, 205, 210, 215];
  return { data: {
    underlyingSymbol: 'AAPL', spot: 203, expiration, expirations: [EXP_1, EXP_2],
    calls: strikes.map((strike) => contract('call', strike, expiration)),
    puts: strikes.map((strike) => contract('put', strike, expiration)),
    provider: 'alpha-vantage', asOf: '2026-07-26T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed',
    delayedMinutes: null, completeness: 1, warnings: [],
  } };
}

function wallsEnvelope(expiration: string) {
  return { data: {
    status: 'available', symbol: 'AAPL', expiration, acceptedPrice: 203,
    callWall: { strike: 210, price: 210, rawOI: 310, clusteredOI: 900, distancePercent: 3.45 },
    putWall: { strike: 195, price: 195, rawOI: 295, clusteredOI: 800, distancePercent: -3.94 },
    maxPain: { strike: 203, price: 203, rawOI: null, clusteredOI: null, distancePercent: 0 },
    totalCallOI: 1_000, totalPutOI: 900, putCallOIRatio: 0.9, strikeCoverage: 6, contractCoverage: 1,
    provider: 'alpha-vantage', asOf: '2026-07-26T00:00:00.000Z', dataMode: 'DELAYED', reliability: 'high', limitations: [],
  } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let latest: UseOptionsSupportResistanceResult | null = null;

function HarnessState({ enabled }: { enabled: boolean }) {
  const state = useOptionsSupportResistance({ symbol: 'AAPL', acceptedPrice: 203, enabled, active: true });
  useEffect(() => { latest = state; }, [state]);
  return <div data-loading={String(state.loading)} />;
}

function Harness({ enabled, tier = 'elite' }: { enabled: boolean; tier?: SubscriptionTier }) {
  return <EntitlementProvider tier={tier} authenticated trialOffer="used"><HarnessState enabled={enabled} /></EntitlementProvider>;
}

beforeEach(() => {
  latest = null;
  clearOptionsChainCoordinatorForTests();
  clearOptionsExpirationsCoordinatorForTests();
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('useOptionsSupportResistance request policy', () => {
  it('issues zero options requests for Basic even when the overlay is requested open', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);

    await act(async () => root.render(<Harness enabled tier="basic" />));
    await act(async () => { await Promise.resolve(); });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest).toMatchObject({ chain: null, result: null, loading: false, expirations: [] });
    await act(async () => root.unmount());
  });

  it('does zero work while closed, then spends one request per entitled endpoint and reuses them on reopen', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/chain?')) return json(chainEnvelope(EXP_1));
      if (url.includes('/walls?')) return json(wallsEnvelope(EXP_1));
      return json(expirationEnvelope());
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);

    await act(async () => root.render(<StrictMode><Harness enabled={false} /></StrictMode>));
    expect(fetchMock).not.toHaveBeenCalled();

    // Opening the section resolves straight to the nearest expiration's chain:
    // one expirations request, one chain request, and nothing further.
    await act(async () => root.render(<StrictMode><Harness enabled /></StrictMode>));
    await vi.waitFor(() => expect(latest?.chain?.expiration).toBe(EXP_1));
    expect(latest?.expirations).toEqual([EXP_1, EXP_2]);
    expect(latest?.selectedExpiration).toBe(EXP_1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/expirations?'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/chain?'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/walls?'))).toHaveLength(1);

    await act(async () => root.render(<StrictMode><Harness enabled={false} /></StrictMode>));
    await act(async () => root.render(<StrictMode><Harness enabled /></StrictMode>));
    await vi.waitFor(() => expect(latest?.chain?.expiration).toBe(EXP_1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
  });

  it('rejects a stale expiration response after a rapid switch', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/expirations?')) return Promise.resolve(json(expirationEnvelope()));
      if (url.includes('/walls?')) return Promise.resolve(json(wallsEnvelope(url.includes(encodeURIComponent(EXP_2)) ? EXP_2 : EXP_1)));
      if (url.includes(encodeURIComponent(EXP_1))) return first;
      return Promise.resolve(json(chainEnvelope(EXP_2)));
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(<Harness enabled />));
    await vi.waitFor(() => expect(latest?.expirations).toHaveLength(2));

    await act(async () => latest?.setExpiration(EXP_1));
    await act(async () => latest?.setExpiration(EXP_2));
    await vi.waitFor(() => expect(latest?.chain?.expiration).toBe(EXP_2));
    await act(async () => { resolveFirst(json(chainEnvelope(EXP_1))); await first; });
    expect(latest?.chain?.expiration).toBe(EXP_2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/chain?'))).toHaveLength(2);
    await act(async () => root.unmount());
  });
});
