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

function polygonEnvelope(symbol: string, interval: CandleInterval, count = 2) {
  const candles = count === 0
    ? []
    : [candle(START, 100), candle(START + 300, 101)];
  return {
    data: {
      instrument: {
        canonicalSymbol: symbol,
        providerSymbol: symbol,
        name: symbol,
        assetType: 'stock',
        exchange: 'NASDAQ',
        mic: 'XNAS',
        currency: 'USD',
        timezone: 'America/New_York',
        active: true,
        supported: true,
        unsupportedReason: null,
      },
      bars: {
        symbol,
        provider: 'polygon',
        interval,
        range: '1m',
        adjusted: false,
        session: 'extended',
        timezone: 'America/New_York',
        currency: 'USD',
        firstTimestamp: candles[0]?.timestamp ?? null,
        lastTimestamp: candles.at(-1)?.timestamp ?? null,
        asOf: candles.at(-1)?.timestamp ?? null,
        dataStatus: 'delayed',
        delayedByMinutes: 0,
        bars: candles.map((item) => ({
          time: item.timestamp,
          open: item.open,
          high: item.high,
          low: item.low,
          close: item.close,
          volume: item.volume,
          partial: false,
        })),
        warnings: [],
      },
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
  it('collapses the Strict Mode mount into one Polygon history request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response(polygonEnvelope('AAPL', '5m')));
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(
      <StrictMode><MarketCandleChartPanel {...props()} /></StrictMode>,
    ));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/market/chart?');
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
      second.resolve(response(polygonEnvelope('MSFT', '10m')));
      await second.promise;
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="ported-chart-renderer"]')?.getAttribute('data-symbol')).toBe('MSFT'));
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')?.getAttribute('data-interval')).toBe('10m');

    await act(async () => {
      first.resolve(response(polygonEnvelope('AAPL', '5m')));
      await first.promise;
    });
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')?.getAttribute('data-symbol')).toBe('MSFT');
    await act(async () => root.unmount());
  });

  it('renders truthful empty and provider-error states without candles', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => (
      String(input).includes('symbol=EMPTY')
        ? response(polygonEnvelope('EMPTY', '5m', 0))
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
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('Polygon is cooling down'));
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')).toBeNull();

    await act(async () => root.render(<MarketCandleChartPanel {...props('EMPTY')} />));
    await vi.waitFor(() => expect(host.textContent).toContain('No validated Polygon candles'));
    expect(host.querySelector('[data-testid="ported-chart-renderer"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
