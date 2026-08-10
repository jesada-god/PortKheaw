// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lightweight = vi.hoisted(() => {
  const charts: Array<Record<string, unknown>> = [];
  return { charts };
});

vi.mock('lightweight-charts', () => {
  const definition = (name: string) => ({ name });
  return {
    ColorType: { Solid: 'solid' },
    AreaSeries: definition('Area'),
    BarSeries: definition('Bar'),
    CandlestickSeries: definition('Candlestick'),
    HistogramSeries: definition('Histogram'),
    LineSeries: definition('Line'),
    createChart: vi.fn((_container: HTMLElement, chartOptions: Record<string, unknown>) => {
      const series: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
      const crosshair = new Set<(value: unknown) => void>();
      const visibleRangeHandlers = new Set<(value: unknown) => void>();
      const chart = {
        /** The options the host asked for — what the attribution contract reads. */
        chartOptions,
        series,
        visibleRangeHandlers,
        addSeries: vi.fn(() => {
          const item = {
            setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(),
            createPriceLine: vi.fn((options) => ({ options })),
            removePriceLine: vi.fn(),
            attachPrimitive: vi.fn(), detachPrimitive: vi.fn(),
            priceToCoordinate: vi.fn(() => 100),
          };
          series.push(item);
          return item;
        }),
        removeSeries: vi.fn(),
        applyOptions: vi.fn(),
        subscribeCrosshairMove: vi.fn((handler) => crosshair.add(handler)),
        unsubscribeCrosshairMove: vi.fn((handler) => crosshair.delete(handler)),
        timeScale: vi.fn(() => ({
          fitContent: chart.fitContent,
          resetTimeScale: chart.resetTimeScale,
          subscribeVisibleLogicalRangeChange: vi.fn((handler) => visibleRangeHandlers.add(handler)),
          unsubscribeVisibleLogicalRangeChange: vi.fn((handler) => visibleRangeHandlers.delete(handler)),
          getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: series.length ? 10 : 0 })),
        })),
        fitContent: vi.fn(),
        resetTimeScale: vi.fn(),
        remove: vi.fn(),
      };
      lightweight.charts.push(chart);
      return chart;
    }),
  };
});

import HistoricalChart, { formatChartTime } from './HistoricalChart';
import { mergeLiveCandleIntoBars } from './live-candle-bridge';

const barSeconds = (date: string) => Math.floor(new Date(`${date}T00:00:00.000Z`).valueOf() / 1_000);

const prices = Array.from({ length: 30 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  open: 40 + index,
  high: 42 + index,
  low: 39 + index,
  close: 41 + index,
  volume: 1_000 + index,
}));

const resizeCallbacks: Array<() => void> = [];
class ResizeObserverMock {
  constructor(private readonly callback: () => void) { resizeCallbacks.push(callback); }
  observe = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  lightweight.charts.length = 0;
  resizeCallbacks.length = 0;
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('HistoricalChart Lightweight Charts boundary', () => {
  it('formats date-only slots deterministically', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const server = formatChartTime('2026-07-17');
      process.env.TZ = 'America/New_York';
      expect(formatChartTime('2026-07-17')).toBe(server);
      expect(server).not.toContain('00:00');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('creates/removes safely in Strict Mode and cleans ResizeObserver subscriptions', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<React.StrictMode><HistoricalChart symbol="RKLB" prices={prices} datasetKey="RKLB:1d:5m"/></React.StrictMode>));
    const activeCharts = lightweight.charts.filter((chart) => !(chart.remove as ReturnType<typeof vi.fn>).mock.calls.length);
    expect(activeCharts).toHaveLength(1);
    await act(async () => root.unmount());
    expect(lightweight.charts.every((chart) => (chart.remove as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
    expect(lightweight.charts.every((chart) => (chart.unsubscribeCrosshairMove as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
  });

  /*
   * The whole chart screen, not just the host: the plot is asked to draw no
   * TradingView mark, and the notice that permission depends on is standing in
   * the DOM beneath it. Asserting both in one mount is the point — the licence is
   * satisfied by the pair, and a change that removes either one fails here.
   */
  it('drops the in-plot attribution mark and carries the notice in the footer instead', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<HistoricalChart symbol="RKLB" prices={prices} datasetKey="RKLB:1d:5m"/>));

    const options = lightweight.charts[0].chartOptions as { layout: { attributionLogo: boolean } };
    expect(options.layout.attributionLogo).toBe(false);

    const footer = host.querySelector('[data-testid="chart-attribution"]');
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain('TradingView Lightweight Charts™');
    expect(footer!.textContent).toContain('Copyright (с) 2025 TradingView, Inc.');
    expect(footer!.querySelector('a[href="https://www.tradingview.com/"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it('updates the latest bar without recreating the chart or resetting viewport', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<HistoricalChart symbol="RKLB" prices={prices} datasetKey="RKLB:1d:5m"/>));
    const chart = lightweight.charts[0] as { series: Array<Record<string, ReturnType<typeof vi.fn>>>; fitContent: ReturnType<typeof vi.fn> };
    const created = lightweight.charts.length;
    const initialFitCalls = chart.fitContent.mock.calls.length;
    const refreshed = [...prices.slice(0, -1), { ...prices.at(-1)!, close: prices.at(-1)!.close + 1 }];
    await act(async () => root.render(<HistoricalChart symbol="RKLB" prices={refreshed} datasetKey="RKLB:1d:5m"/>));
    expect(lightweight.charts).toHaveLength(created);
    expect(chart.series.some((series) => series.update.mock.calls.length > 0)).toBe(true);
    expect(chart.fitContent).toHaveBeenCalledTimes(initialFitCalls);
    await act(async () => root.unmount());
  });

  it('appends a strictly newer live candle into the mounted series without recreating the chart', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<HistoricalChart symbol="RKLB" prices={prices} datasetKey="RKLB:1d:5m"/>));
    const chart = lightweight.charts[0] as { series: Array<Record<string, ReturnType<typeof vi.fn>>>; fitContent: ReturnType<typeof vi.fn> };
    const created = lightweight.charts.length;
    const initialFitCalls = chart.fitContent.mock.calls.length;
    // A strictly newer 5m bucket from the shared source appends exactly one bar.
    const newerTime = barSeconds(prices.at(-1)!.date) + 86_400;
    const appended = mergeLiveCandleIntoBars(prices, { time: newerTime, open: 70, high: 71, low: 69, close: 70.5, volume: 10 });
    expect(appended).toHaveLength(prices.length + 1);
    await act(async () => root.render(<HistoricalChart symbol="RKLB" prices={appended as typeof prices} datasetKey="RKLB:1d:5m"/>));
    expect(lightweight.charts).toHaveLength(created); // same chart, not recreated
    expect(chart.series.some((series) => series.update.mock.calls.length > 0)).toBe(true);
    expect(chart.fitContent).toHaveBeenCalledTimes(initialFitCalls); // viewport preserved
    await act(async () => root.unmount());
  });

  it('a disposed chart cannot receive further live candle updates', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<HistoricalChart symbol="RKLB" prices={prices} datasetKey="RKLB:1d:5m"/>));
    const chart = lightweight.charts[0] as { series: Array<Record<string, ReturnType<typeof vi.fn>>>; remove: ReturnType<typeof vi.fn> };
    await act(async () => root.unmount());
    expect(chart.remove.mock.calls.length).toBe(1);
    const updatesAtDispose = chart.series.reduce((sum, series) => sum + series.update.mock.calls.length, 0);
    // The bridge still produces a real update, but nothing reaches the disposed chart.
    const merged = mergeLiveCandleIntoBars(prices, { time: barSeconds(prices.at(-1)!.date), open: 1, high: 2, low: 0, close: 1.5, volume: 9 });
    expect(merged).not.toBe(prices);
    const updatesAfterDispose = chart.series.reduce((sum, series) => sum + series.update.mock.calls.length, 0);
    expect(updatesAfterDispose).toBe(updatesAtDispose);
  });

  it('ignores a late resize after unmount instead of touching a disposed chart', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<HistoricalChart symbol="RKLB" prices={prices} datasetKey="RKLB:1d:5m"/>));
    const chart = lightweight.charts[0] as { applyOptions: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
    const optionCallsBeforeUnmount = chart.applyOptions.mock.calls.length;
    await act(async () => root.unmount());
    expect(chart.remove.mock.calls.length).toBe(1);
    // Simulate a ResizeObserver notification arriving after the chart was removed.
    expect(() => resizeCallbacks.forEach((callback) => callback())).not.toThrow();
    expect(chart.applyOptions.mock.calls.length).toBe(optionCallsBeforeUnmount);
  });

  it('attaches the institutional overlay primitive and repaints it disposal-safely', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    // The daily interval builds D1 zones; the overlay is painted by a series primitive.
    await act(async () => root.render(<HistoricalChart symbol="RKLB" prices={prices} interval="1D" datasetKey="RKLB:1D:1y"/>));
    const chart = lightweight.charts[0] as {
      series: Array<Record<string, ReturnType<typeof vi.fn>>>;
      visibleRangeHandlers: Set<() => void>;
      remove: ReturnType<typeof vi.fn>;
    };
    const primary = chart.series[0];
    expect(primary.attachPrimitive.mock.calls.length).toBeGreaterThan(0);
    // A viewport change re-slices loaded candles for the VRVP but never fetches.
    await act(async () => chart.visibleRangeHandlers.forEach((handler) => handler()));
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(chart.remove.mock.calls.length).toBe(1);
    // A late overlay/viewport event after dispose must not touch the removed chart.
    expect(() => chart.visibleRangeHandlers.forEach((handler) => handler())).not.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses native chart interactions and never fetches while Fit/Reset is used', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<HistoricalChart prices={prices}/>));
    for (const label of ['Fit', 'Reset']) {
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
      await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    }
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
