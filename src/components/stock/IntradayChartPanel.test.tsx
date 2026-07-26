// @vitest-environment jsdom

import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandleInterval } from '@/src/lib/market-data/candles/contracts';
import { DEFAULT_CHART_PREFERENCES } from '@/src/lib/analytics/timeframe';

vi.mock('next/dynamic', () => ({
  default: () => function DynamicChart(props: { symbol: string; interval: string; datasetKey: string }) {
    return React.createElement('div', {
      'data-testid': 'ported-chart-renderer',
      'data-symbol': props.symbol,
      'data-interval': props.interval,
      'data-dataset-key': props.datasetKey,
    });
  },
}));

vi.mock('@/src/hooks/useAppActive', () => ({ useAppActive: () => true }));

import { MarketCandleChartPanel } from './IntradayChartPanel';

const START = 1_700_000_000;

function candle(timestamp: number, close: number) {
  return {
    timestamp,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1_000,
    session: 'regular' as const,
  };
}

/**
 * The exact body `/api/market/candles` serializes: the server-validated Yahoo
 * Finance Chart JSON result. Polygon is not on this path at all.
 */
function yahooEnvelope(symbol: string, interval: CandleInterval, count = 2) {
  const candles = count === 0
    ? []
    : [candle(START, 100), candle(START + 300, 101)];
  return {
    data: {
      symbol,
      provider: 'yahoo-finance-chart',
      attemptedProviders: ['yahoo-finance-chart'],
      requestedInterval: interval,
      actualInterval: interval,
      sourceInterval: interval,
      requestedRange: '1m',
      actualStart: candles[0]?.timestamp ?? null,
      actualEnd: candles.at(-1)?.timestamp ?? null,
      exchangeTimezone: 'America/New_York',
      currency: 'USD',
      dataStatus: 'delayed',
      delayedByMinutes: 0,
      adjusted: false,
      aggregated: false,
      cacheStatus: 'miss',
      candles,
      warnings: [],
      fallbackReason: null,
    },
    meta: {
      provider: 'yahoo-finance-chart',
      timestamp: new Date(START * 1_000).toISOString(),
      freshness: { status: 'delayed', asOf: null, maxAgeSeconds: 60 },
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function props(symbol = 'AAPL', interval: CandleInterval = '5m') {
  return {
    symbol,
    active: true,
    interval,
    range: '1m' as const,
    session: 'extended' as const,
    adjusted: false,
    liveActive: true,
    preferences: DEFAULT_CHART_PREFERENCES,
    onSelectInterval: () => undefined,
    onSelectRange: () => undefined,
    onToggleFavoriteInterval: () => undefined,
    onToggleFavoriteRange: () => undefined,
    onChartType: () => undefined,
    onToggle: () => undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('MarketCandleChartPanel request lifecycle', () => {
  it('collapses the Strict Mode mount into one Yahoo history request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response(yahooEnvelope('AAPL', '5m')));
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(
      <StrictMode><MarketCandleChartPanel {...props()} /></StrictMode>,
    ));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/market/candles?');
    // Polygon must not be on the chart's historical critical path at all.
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('/api/market/chart?');
    await act(async () => root.unmount());
  });

  it('requests each timeframe/symbol once and aborts a stale symbol response', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return String(input).includes('symbol=MSFT') ? second.promise : first.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<MarketCandleChartPanel {...props('AAPL', '5m')} />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<MarketCandleChartPanel {...props('MSFT', '10m')} />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('symbol=MSFT');
    expect(String(fetchMock.mock.calls[1][0])).toContain('interval=10m');
    expect(signals[0].aborted).toBe(true);
    // The previous AAPL renderer must disappear in the selection render itself.
    // Otherwise its levels effect observes the new interval and emits a stale,
    // duplicate support/resistance request before the MSFT history arrives.
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')).toBeNull();

    await act(async () => {
      second.resolve(response(yahooEnvelope('MSFT', '10m')));
      await second.promise;
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="ported-chart-renderer"]')?.getAttribute('data-symbol')).toBe('MSFT'));
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')?.getAttribute('data-interval')).toBe('10m');

    await act(async () => {
      first.resolve(response(yahooEnvelope('AAPL', '5m')));
      await first.promise;
    });
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')?.getAttribute('data-symbol')).toBe('MSFT');
    await act(async () => root.unmount());
  });

  it('renders truthful empty and provider-error states without candles', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => (
      String(input).includes('symbol=EMPTY')
        ? response(yahooEnvelope('EMPTY', '5m', 0))
        : response({
          data: null,
          error: { code: 'rate-limited', message: 'upstream detail', retryable: true },
        }, 429)
    ));
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(<MarketCandleChartPanel {...props('ERROR')} />));
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('จำกัดอัตราการเรียก'));
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')).toBeNull();

    await act(async () => root.render(<MarketCandleChartPanel {...props('EMPTY')} />));
    await vi.waitFor(() => expect(host.textContent).toContain('ไม่มีแท่งเทียนที่ผ่านการตรวจสอบ'));
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('costs zero market requests for an indicator or favourite toggle', async () => {
    // Every toolbar toggle is a pure re-derivation of bars already in memory.
    // Only a genuine interval/range change may reach the network.
    const fetchMock = vi.fn<typeof fetch>(async () => response(yahooEnvelope('AAPL', '5m')));
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(<MarketCandleChartPanel {...props()} />));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const toggles: Array<Partial<typeof DEFAULT_CHART_PREFERENCES>> = [
      { ema100: true },
      { ema200: true },
      { rsi: true },
      { macd: true },
      { vpvr: true },
      { supportResistance: false },
      { volume: false },
      { chartType: 'heikin-ashi' },
      { favoriteIntervals: ['1D'] },
      { favoriteRanges: ['1y', '5y'] },
    ];
    for (const change of toggles) {
      await act(async () => root.render(<MarketCandleChartPanel
        {...props()}
        preferences={{ ...DEFAULT_CHART_PREFERENCES, ...change }}
      />));
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The one served result is still mounted (no throwaway remount either).
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')?.getAttribute('data-symbol')).toBe('AAPL');

    // A real range change is the only thing that loads new history.
    await act(async () => root.render(<MarketCandleChartPanel {...props()} range="3m" />));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain('range=3m');
    await act(async () => root.unmount());
  });
});
