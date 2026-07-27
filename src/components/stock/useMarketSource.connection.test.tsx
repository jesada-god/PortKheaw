// @vitest-environment jsdom

/**
 * Behavioural guard for the connection-state plumbing in {@link useMarketSource}.
 *
 * The hook surfaces the typed {@link ConnectionStatus} forwarded by the market
 * coordinator to the header, WITHOUT ever letting it drive a fetch. These tests
 * assert that: a connection-state change never triggers a refresh or a re-acquire
 * (#3); a REST-only deployment with no Gateway URL never surfaces a state (#4); a
 * `reconnecting → connected` recovery clears the exposed state (#5); and the
 * subscription is released on unmount so no state update can fire afterwards (#6).
 *
 * A fresh module load per test controls whether a Gateway URL is inlined, so the
 * REST-only vs. WS paths are exercised deterministically.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketUpdate } from '@/src/lib/stock-detail/market-source';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS_URL = 'wss://loving-growth-production-0965.up.railway.app/ws';

const rec = {
  listener: null as ((u: MarketUpdate) => void) | null,
  acquired: 0,
  released: 0,
  subscribed: 0,
  unsubscribed: 0,
  refreshCalls: 0,
};

vi.mock('@/src/lib/stock-detail/market-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/stock-detail/market-source')>();
  return {
    ...actual,
    acquireMarketConnection: vi.fn(() => {
      rec.acquired += 1;
      const source = {
        transport: 'websocket' as const,
        start() {}, stop() {},
        setVisible() {}, setSession() {}, setSelection() {}, setSymbol() {},
        refresh() { rec.refreshCalls += 1; return Promise.resolve(); },
        cooldownRemainingMs() { return 0; },
        isSnapshotEntitled() { return true; },
        subscribe(listener: (u: MarketUpdate) => void) {
          rec.subscribed += 1;
          rec.listener = listener;
          return () => { rec.unsubscribed += 1; rec.listener = null; };
        },
      };
      return { source, release: () => { rec.released += 1; } };
    }),
  };
});

type UseMarketSource = typeof import('./useMarketSource')['useMarketSource'];
type Options = Parameters<UseMarketSource>[0];
type Result = ReturnType<UseMarketSource>;

const INITIAL_QUOTE = {
  data: null, freshness: 'live', provider: null, reason: null, error: null, fallbackLabel: null,
} as unknown as StockDetailQuoteResource;

const INITIAL_REGULAR_QUOTE = {
  data: {
    symbol: 'NVTS',
    currency: 'USD',
    price: 11.41,
    regularClose: 11.41,
    previousClose: 10.92,
    previousRegularClose: 10.92,
    change: 0.49,
    changePercent: (0.49 / 10.92) * 100,
    open: 11,
    high: 11.5,
    low: 10.8,
    volume: 1_000,
    latestTradingDay: '2026-07-27',
    quoteTimestamp: '2026-07-27T20:00:01.000Z',
    session: 'after-hours',
  },
  freshness: {
    status: 'delayed',
    asOf: '2026-07-27T20:00:01.000Z',
    maxAgeSeconds: 60,
  },
  provider: 'yahoo-finance-chart',
  reason: null,
  error: null,
  fallbackLabel: null,
} as StockDetailQuoteResource;

function baseOptions(overrides: Partial<Options> = {}): Options {
  return {
    symbol: 'AAPL',
    initialQuote: INITIAL_QUOTE,
    session: 'regular',
    active: true,
    online: true,
    enabled: true,
    ...overrides,
  };
}

/** A minimal, non-priced update (candidateFromUpdate → null) carrying a state. */
function update(connectionState?: MarketUpdate['connectionState']): MarketUpdate {
  return {
    symbol: 'AAPL',
    price: null,
    quote: null,
    candle: null,
    label: {
      mode: 'DELAYED', provider: null, source: null,
      exchangeTimestamp: null, receivedAt: '', delayAgeSeconds: null, fallbackNote: null,
    },
    error: null,
    connectionState,
  };
}

function liveSnapshot(): MarketUpdate {
  return {
    symbol: 'AAPL',
    price: 206.87,
    quote: null,
    candle: null,
    label: {
      mode: 'REAL-TIME',
      provider: 'alpaca:iex',
      source: 'aggregate-fallback',
      exchangeTimestamp: '2026-07-24T19:26:14.801Z',
      receivedAt: '2026-07-24T19:26:14.900Z',
      delayAgeSeconds: 0,
      fallbackNote: null,
      realtime: true,
      feed: 'iex',
    },
    error: null,
    connectionState: 'connected',
    eventKind: 'snapshot',
    session: 'regular',
  };
}

function afterHoursTrade(price = 11.05): MarketUpdate {
  return {
    ...liveSnapshot(),
    symbol: 'NVTS',
    price,
    label: {
      ...liveSnapshot().label,
      provider: 'finnhub',
      feed: 'finnhub',
      exchangeTimestamp: '2026-07-27T21:08:30.000Z',
      receivedAt: '2026-07-27T21:08:30.100Z',
    },
    session: 'after-hours',
    eventKind: 'trade',
  };
}

async function loadHook(wsUrl?: string): Promise<UseMarketSource> {
  vi.resetModules();
  if (wsUrl) process.env.NEXT_PUBLIC_MARKET_WS_URL = wsUrl;
  else delete process.env.NEXT_PUBLIC_MARKET_WS_URL;
  process.env.NEXT_PUBLIC_APP_ENV = 'production';
  return (await import('./useMarketSource')).useMarketSource;
}

let latest: Result | null = null;

function mount(useHook: UseMarketSource, options: Options) {
  const container = document.createElement('div');
  const root: Root = createRoot(container);
  function Harness(props: Options) { latest = useHook(props); return null; }
  act(() => { root.render(React.createElement(Harness, options)); });
  return { unmount: () => act(() => { root.unmount(); }) };
}

function emit(connectionState?: MarketUpdate['connectionState']) {
  act(() => { rec.listener?.(update(connectionState)); });
}

beforeEach(() => {
  rec.listener = null;
  rec.acquired = 0; rec.released = 0;
  rec.subscribed = 0; rec.unsubscribed = 0;
  rec.refreshCalls = 0;
  latest = null;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_MARKET_WS_URL;
  delete process.env.NEXT_PUBLIC_APP_ENV;
});

describe('useMarketSource connection state', () => {
  it('surfaces the state but never refetches or re-acquires when it changes (#3)', async () => {
    const useHook = await loadHook(WS_URL);
    const view = mount(useHook, baseOptions());
    emit('connected');
    emit('reconnecting');
    emit('degraded');
    emit('connected');
    // A connection-state change is status-only: no refresh(), no second acquire.
    expect(rec.refreshCalls).toBe(0);
    expect(rec.acquired).toBe(1);
    expect(latest?.connectionState).toBe('connected');
    view.unmount();
  });

  it('never surfaces a connection state on a REST-only deployment (no Gateway URL) (#4)', async () => {
    const useHook = await loadHook(/* no WS URL */);
    const view = mount(useHook, baseOptions());
    // Even if a state is forwarded, no configured socket ⇒ no "reconnecting" pill.
    emit('reconnecting');
    expect(latest?.connectionState).toBeNull();
    view.unmount();
  });

  it('clears the state on recovery: reconnecting → connected (#5)', async () => {
    const useHook = await loadHook(WS_URL);
    const view = mount(useHook, baseOptions());
    emit('reconnecting');
    expect(latest?.connectionState).toBe('reconnecting');
    emit('connected');
    expect(latest?.connectionState).toBe('connected');
    view.unmount();
  });

  it('commits a live snapshot and sends its price plus provenance to the imperative sink', async () => {
    const sink = vi.fn();
    const useHook = await loadHook(WS_URL);
    const view = mount(useHook, baseOptions({
      transientPriceSinkRef: { current: sink },
    }));

    act(() => { rec.listener?.(liveSnapshot()); });

    expect(sink).toHaveBeenCalledWith(206.87, {
      asOf: '2026-07-24T19:26:14.801Z',
      feed: 'iex',
      session: 'regular',
    });
    expect(latest?.quoteResource.data?.price).toBe(206.87);
    expect(latest?.dataLabel?.realtime).toBe(true);
    expect(latest?.connectionState).toBe('connected');
    view.unmount();
  });

  it('commits an AFTER trade only to the extended domain and preserves the regular snapshot atomically', async () => {
    const useHook = await loadHook(WS_URL);
    const view = mount(useHook, baseOptions({
      symbol: 'NVTS',
      initialQuote: INITIAL_REGULAR_QUOTE,
      session: 'closed',
    }));

    act(() => { rec.listener?.(afterHoursTrade()); });

    expect(latest?.quoteResource.data?.price).toBe(11.41);
    expect(latest?.priceState).toMatchObject({
      regularPrice: 11.41,
      regularTradingDate: '2026-07-27',
      previousRegularClose: 10.92,
      previousTradingDate: '2026-07-24',
      extendedPrice: 11.05,
      extendedSession: 'AFTER',
      extendedTradingDate: '2026-07-27',
    });
    view.unmount();
  });

  it('releases and unsubscribes on unmount, leaving no listener to update state (#6)', async () => {
    const useHook = await loadHook(WS_URL);
    const view = mount(useHook, baseOptions());
    expect(rec.subscribed).toBe(1);
    view.unmount();
    expect(rec.unsubscribed).toBe(1);
    expect(rec.released).toBe(1);
    // No dangling listener → a late emission can never setState after unmount.
    expect(rec.listener).toBeNull();
  });
});
