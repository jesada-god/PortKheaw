// @vitest-environment jsdom

/**
 * Regression guard for the live-WebSocket wiring in {@link useMarketSource}.
 *
 * History: the socket was first never OPENED because `resolvePublicMarketWsUrl`
 * was read through a dynamic `process.env` access that Next.js does not inline, so
 * the Gateway URL came back `undefined` → REST-only. It was then CLOSED before its
 * handshake finished because a Strict-Mode/transient unmount tore the connecting
 * socket down (code 1006). The hook now acquires a tab-shared, reference-counted
 * connection (see the market-connection-manager) instead of building and tearing
 * down a source per mount.
 *
 * These tests exercise the real hook against a mocked `acquireMarketConnection`
 * recorder and assert that it: hands over the inlined Gateway URL; acquires on
 * plain mount (Overview — never gated on the Chart tab, the session or a cached
 * snapshot); holds exactly one net subscriber across a Strict-Mode remount;
 * reuses the SAME connection (no re-acquire) on a selection change AND on a symbol
 * change, driving `setSelection` / `setSymbol` in place; and releases on unmount.
 *
 * The reference-counting, grace-period close and generation guard themselves live
 * in `market-connection-manager.test.ts`.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS_URL = 'wss://loving-growth-production-0965.up.railway.app/ws';

interface FakeSource {
  transport: 'polling' | 'websocket';
  symbols: string[];
  selections: number;
  sessions: number;
  visibles: boolean[];
  subscribe: () => () => void;
  setSymbol: (s: string) => void;
  setSelection: () => void;
  setSession: () => void;
  setVisible: (v: boolean) => void;
  refresh: () => Promise<void>;
  cooldownRemainingMs: () => number;
  isSnapshotEntitled: () => boolean;
  start: () => void;
  stop: () => void;
}

interface Acquisition {
  wsUrl: string | null;
  symbol: string;
  source: FakeSource;
  released: number;
}

const acquisitions: Acquisition[] = [];
let acquireCount = 0;
let releaseCount = 0;

function makeFakeSource(wsUrl: string | null): FakeSource {
  return {
    transport: wsUrl ? 'websocket' : 'polling',
    symbols: [],
    selections: 0,
    sessions: 0,
    visibles: [],
    subscribe: () => () => {},
    setSymbol(s) { this.symbols.push(s); },
    setSelection() { this.selections += 1; },
    setSession() { this.sessions += 1; },
    setVisible(v) { this.visibles.push(v); },
    refresh: () => Promise.resolve(),
    cooldownRemainingMs: () => 0,
    isSnapshotEntitled: () => true,
    start: () => {},
    stop: () => {},
  };
}

vi.mock('@/src/lib/stock-detail/market-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/stock-detail/market-source')>();
  return {
    ...actual,
    acquireMarketConnection: vi.fn((params: { wsUrl: string | null; symbol: string }) => {
      acquireCount += 1;
      const source = makeFakeSource(params.wsUrl);
      const record: Acquisition = { wsUrl: params.wsUrl ?? null, symbol: params.symbol, source, released: 0 };
      acquisitions.push(record);
      return {
        source,
        release: () => { releaseCount += 1; record.released += 1; },
      };
    }),
  };
});

type UseMarketSource = typeof import('./useMarketSource')['useMarketSource'];
type Options = Parameters<UseMarketSource>[0];
let useMarketSource: UseMarketSource;

const INITIAL_QUOTE = {
  data: null,
  freshness: 'live',
  provider: null,
  reason: null,
  error: null,
  fallbackLabel: null,
} as unknown as StockDetailQuoteResource;

function baseOptions(overrides: Partial<Options> = {}): Options {
  return {
    symbol: 'RKLB',
    initialQuote: INITIAL_QUOTE,
    session: 'regular',
    active: true,
    online: true,
    enabled: true,
    ...overrides,
  };
}

function mount(options: Options, strict = false) {
  const container = document.createElement('div');
  const root: Root = createRoot(container);
  function Harness(props: Options) {
    useMarketSource(props);
    return null;
  }
  const tree = (props: Options) => (
    strict
      ? React.createElement(React.StrictMode, null, React.createElement(Harness, props))
      : React.createElement(Harness, props)
  );
  act(() => { root.render(tree(options)); });
  return {
    rerender: (next: Options) => act(() => { root.render(tree(next)); }),
    unmount: () => act(() => { root.unmount(); }),
  };
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_MARKET_WS_URL = WS_URL;
  process.env.NEXT_PUBLIC_APP_ENV = 'production';
  ({ useMarketSource } = await import('./useMarketSource'));
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_MARKET_WS_URL;
  delete process.env.NEXT_PUBLIC_APP_ENV;
});

beforeEach(() => { acquisitions.length = 0; acquireCount = 0; releaseCount = 0; });
afterEach(() => { vi.clearAllMocks(); });

describe('useMarketSource live WebSocket wiring', () => {
  it('acquires the shared live connection on mount using the inlined Gateway URL (Overview, no Chart tab)', () => {
    const handle = mount(baseOptions());
    expect(acquireCount).toBe(1);
    expect(acquisitions[0].wsUrl).toBe(WS_URL);
    expect(acquisitions[0].symbol).toBe('RKLB');
    expect(acquisitions[0].source.transport).toBe('websocket');
    handle.unmount();
    expect(releaseCount).toBe(1);
  });

  it('keeps the WebSocket even when the market is closed and the snapshot is cached', () => {
    const handle = mount(baseOptions({ session: 'closed' }));
    expect(acquireCount).toBe(1);
    // A closed session / cached snapshot must NOT downgrade the transport to REST.
    expect(acquisitions[0].wsUrl).toBe(WS_URL);
    expect(acquisitions[0].source.transport).toBe('websocket');
    handle.unmount();
  });

  it('keeps BTC-USD on REST Yahoo polling and never opens the equity live socket', () => {
    const handle = mount(baseOptions({
      symbol: 'BTC-USD',
      session: 'regular',
      marketKind: 'continuous',
      allowWebSocket: false,
    }));
    expect(acquireCount).toBe(1);
    expect(acquisitions[0].symbol).toBe('BTC-USD');
    expect(acquisitions[0].wsUrl).toBeNull();
    expect(acquisitions[0].source.transport).toBe('polling');
    handle.unmount();
  });

  it('holds exactly one net subscriber across a Strict-Mode mount→cleanup→remount', () => {
    const handle = mount(baseOptions(), /* strict */ true);
    // Strict Mode double-invokes: acquire, release, acquire → net one subscriber
    // held on the shared connection (which is what keeps a single live socket).
    expect(acquireCount - releaseCount).toBe(1);
    expect(acquisitions.every((a) => a.wsUrl === WS_URL)).toBe(true);
    handle.unmount();
    expect(acquireCount).toBe(releaseCount); // nothing left held
  });

  it('does not re-acquire when only the chart selection changes (shared Overview/Chart socket)', () => {
    const handle = mount(baseOptions({ selection: { interval: '5m', session: 'regular', adjusted: false } }));
    expect(acquireCount).toBe(1);
    handle.rerender(baseOptions({ selection: { interval: '1m', session: 'regular', adjusted: false } }));
    // Same connection reconfigured in place — no second socket.
    expect(acquireCount).toBe(1);
    expect(acquisitions[0].source.selections).toBeGreaterThanOrEqual(1);
    handle.unmount();
  });

  it('reuses the SAME connection on a symbol change, resubscribing in place (no re-acquire)', () => {
    const handle = mount(baseOptions({ symbol: 'RKLB' }));
    expect(acquireCount).toBe(1);
    handle.rerender(baseOptions({ symbol: 'AAPL' }));
    // Requirement: a symbol change unsubscribes the old symbol and subscribes the
    // new one on the SAME socket — it must not release/re-acquire the connection.
    expect(acquireCount).toBe(1);
    expect(releaseCount).toBe(0);
    expect(acquisitions[0].source.symbols).toContain('AAPL');
    handle.unmount();
  });

  it('does not acquire a connection when the provider is not configured', () => {
    const handle = mount(baseOptions({ enabled: false }));
    expect(acquireCount).toBe(0);
    handle.unmount();
  });
});
