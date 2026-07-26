// @vitest-environment jsdom

import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lightweight = vi.hoisted(() => ({ charts: [] as Array<Record<string, unknown>> }));

interface SeriesStub {
  definition: string;
  paneIndex: number | undefined;
  setData: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  createPriceLine: ReturnType<typeof vi.fn>;
  removePriceLine: ReturnType<typeof vi.fn>;
  applyOptions: ReturnType<typeof vi.fn>;
  attachPrimitive: ReturnType<typeof vi.fn>;
  detachPrimitive: ReturnType<typeof vi.fn>;
  priceToCoordinate: ReturnType<typeof vi.fn>;
}

vi.mock('lightweight-charts', () => {
  const definition = (name: string) => ({ name });
  return {
    ColorType: { Solid: 'solid' },
    LineStyle: { Solid: 0, Dashed: 2, Dotted: 1 },
    CandlestickSeries: definition('Candlestick'),
    HistogramSeries: definition('Histogram'),
    LineSeries: definition('Line'),
    createChart: vi.fn((container: HTMLElement) => {
      const series: SeriesStub[] = [];
      const panes: Array<{ setHeight: ReturnType<typeof vi.fn> }> = [
        { setHeight: vi.fn() }, { setHeight: vi.fn() },
      ];
      const timeScale = {
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 10 })),
        fitContent: vi.fn(),
        scrollToRealTime: vi.fn(),
      };
      const chart = {
        container,
        series,
        removed: 0,
        addSeries: vi.fn((def: { name: string }, _options: unknown, paneIndex?: number) => {
          const item: SeriesStub = {
            definition: def.name,
            paneIndex,
            setData: vi.fn(),
            update: vi.fn(),
            createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
            removePriceLine: vi.fn(),
            applyOptions: vi.fn(),
            attachPrimitive: vi.fn(),
            detachPrimitive: vi.fn(),
            priceToCoordinate: vi.fn(() => 10),
          };
          series.push(item);
          if (paneIndex !== undefined) {
            while (panes.length <= paneIndex) panes.push({ setHeight: vi.fn() });
          }
          return item;
        }),
        removeSeries: vi.fn((target: SeriesStub) => {
          const index = series.indexOf(target);
          if (index >= 0) series.splice(index, 1);
        }),
        panes: vi.fn(() => panes),
        removePane: vi.fn(() => { panes.pop(); }),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        timeScale: vi.fn(() => timeScale),
        subscribeCrosshairMove: vi.fn(),
        unsubscribeCrosshairMove: vi.fn(),
        applyOptions: vi.fn(),
        remove: vi.fn(() => { chart.removed += 1; }),
      };
      lightweight.charts.push(chart);
      return chart;
    }),
  };
});

import { TechnicalChartHost, canUpdateIncrementally } from './TechnicalChartHost';
import { normalizeCanonicalBars, toDisplayBars, type CanonicalBar } from '@/src/lib/analytics/canonical-bars';
import { emaSeries } from '@/src/lib/analytics/chart-indicators';

const DAY = 86_400;
const START = Date.UTC(2026, 0, 5) / 1_000;

function bars(count: number, options: { missingVolumeAt?: number } = {}): CanonicalBar[] {
  return normalizeCanonicalBars(Array.from({ length: count }, (_, index) => ({
    time: START + index * DAY,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: index === options.missingVolumeAt ? null : 1_000 + index,
  })));
}

const resizeCallbacks: Array<() => void> = [];
class ResizeObserverMock {
  constructor(callback: () => void) { resizeCallbacks.push(callback); }
  observe = vi.fn();
  disconnect = vi.fn();
}

function baseProps(data: CanonicalBar[]) {
  return {
    bars: data,
    chartType: 'candlestick' as const,
    volumeVisible: true,
    emaLines: [],
    rsi: null,
    macd: null,
    priceLines: [],
    overlaySpec: { bands: [], lines: [] },
    datasetKey: 'AAPL:1D:1y',
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lightweight.charts.length = 0;
  resizeCallbacks.length = 0;
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  return { host, root: createRoot(host) };
}

const candlesOf = (chart: Record<string, unknown>) => (chart.series as SeriesStub[]).find((item) => item.definition === 'Candlestick')!;
const volumeOf = (chart: Record<string, unknown>) => (chart.series as SeriesStub[]).find((item) => item.definition === 'Histogram' && item.paneIndex === 1)!;

describe('TechnicalChartHost — one chart, one time scale', () => {
  it('creates exactly one chart instance with candles and volume as panes of it', async () => {
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(bars(20))} />));

    expect(lightweight.charts).toHaveLength(1);
    const chart = lightweight.charts[0];
    expect(candlesOf(chart).paneIndex).toBe(0);
    expect(volumeOf(chart).paneIndex).toBe(1);
    await act(async () => root.unmount());
  });

  it('does not create a second chart under React Strict Mode', async () => {
    const { root } = mount();
    await act(async () => root.render(<StrictMode><TechnicalChartHost {...baseProps(bars(20))} /></StrictMode>));
    expect(lightweight.charts.filter((chart) => chart.removed === 0)).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('gives candles and volume identical timestamps in the same order', async () => {
    const data = bars(20);
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} />));

    const chart = lightweight.charts[0];
    const candleData = candlesOf(chart).setData.mock.calls.at(-1)?.[0] as Array<{ time: number }>;
    const volumePoints = volumeOf(chart).setData.mock.calls.at(-1)?.[0] as Array<{ time: number }>;
    expect(candleData).toHaveLength(volumePoints.length);
    candleData.forEach((point, index) => expect(point.time).toBe(volumePoints[index].time));
    await act(async () => root.unmount());
  });

  it('holds the volume slot with a whitespace point when the provider reported none', async () => {
    const data = bars(20, { missingVolumeAt: 5 });
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} />));

    const chart = lightweight.charts[0];
    const candleData = candlesOf(chart).setData.mock.calls.at(-1)?.[0] as Array<{ time: number }>;
    const volumePoints = volumeOf(chart).setData.mock.calls.at(-1)?.[0] as Array<{ time: number; value?: number }>;
    expect(volumePoints).toHaveLength(candleData.length);
    expect(volumePoints[5].time).toBe(candleData[5].time);
    // No fabricated zero: the slot exists but carries no value.
    expect(volumePoints[5].value).toBeUndefined();
    await act(async () => root.unmount());
  });

  it('updates the newest candle and its volume together, never one without the other', async () => {
    const data = bars(20);
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} />));
    const chart = lightweight.charts[0];
    const candles = candlesOf(chart);
    const volume = volumeOf(chart);
    candles.update.mockClear();
    volume.update.mockClear();

    const ticked = [...data];
    ticked[ticked.length - 1] = { ...ticked[ticked.length - 1], close: 999, volume: 5_000 };
    await act(async () => root.render(<TechnicalChartHost {...baseProps(ticked)} />));

    expect(candles.update).toHaveBeenCalledTimes(1);
    expect(volume.update).toHaveBeenCalledTimes(1);
    expect((candles.update.mock.calls[0][0] as { time: number }).time)
      .toBe((volume.update.mock.calls[0][0] as { time: number }).time);
    // A live tick must not restart the whole series.
    expect(candles.setData).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('appends a new bucket to both series at the same timestamp', async () => {
    const data = bars(20);
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} />));
    const chart = lightweight.charts[0];
    const candles = candlesOf(chart);
    const volume = volumeOf(chart);
    candles.update.mockClear();
    volume.update.mockClear();

    const appended = [...data, {
      time: START + 20 * DAY, open: 121, high: 123, low: 120, close: 122, volume: 2_000, partial: true,
    }];
    await act(async () => root.render(<TechnicalChartHost {...baseProps(appended)} />));

    expect(candles.update.mock.calls).toHaveLength(volume.update.mock.calls.length);
    candles.update.mock.calls.forEach((call, index) => {
      expect((call[0] as { time: number }).time).toBe((volume.update.mock.calls[index][0] as { time: number }).time);
    });
    await act(async () => root.unmount());
  });

  it('replaces the series wholesale when the dataset is not an append', async () => {
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(bars(20))} />));
    const chart = lightweight.charts[0];
    const candles = candlesOf(chart);
    const volume = volumeOf(chart);

    await act(async () => root.render(<TechnicalChartHost {...baseProps(bars(40))} datasetKey="AAPL:1D:5y" />));
    expect(candles.setData).toHaveBeenCalledTimes(2);
    expect(volume.setData).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });
});

describe('TechnicalChartHost — indicator panes never fetch', () => {
  const data = bars(260);

  it('adds EMA overlays to the price pane without a market request', async () => {
    const series = emaSeries(data, 20);
    if (series.status !== 'available') throw new Error('fixture too short');
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} />));
    fetchMock.mockClear();

    await act(async () => root.render(
      <TechnicalChartHost {...baseProps(data)} emaLines={[{ id: 'ema20', label: 'EMA 20', color: '#f59e0b', points: series.points }]} />,
    ));
    const chart = lightweight.charts[0];
    const emaLine = (chart.series as SeriesStub[]).find((item) => item.definition === 'Line');
    expect(emaLine?.paneIndex).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('opens an RSI pane below volume and closes it again, without fetching', async () => {
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} />));
    fetchMock.mockClear();
    const rsiPoints = data.map((bar) => ({ time: bar.time, value: 55 }));

    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} rsi={{ points: rsiPoints }} />));
    const chart = lightweight.charts[0];
    expect((chart.series as SeriesStub[]).some((item) => item.paneIndex === 2)).toBe(true);

    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} rsi={null} />));
    expect((chart.series as SeriesStub[]).some((item) => item.paneIndex === 2)).toBe(false);
    expect(chart.removePane).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('draws MACD as line, signal and histogram in its own pane, without fetching', async () => {
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} />));
    fetchMock.mockClear();
    const macdPoints = data.map((bar) => ({ time: bar.time, macd: 1, signal: 0.5, histogram: 0.5 }));

    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} macd={{ points: macdPoints }} />));
    const chart = lightweight.charts[0];
    const macdPane = (chart.series as SeriesStub[]).filter((item) => item.paneIndex === 2);
    expect(macdPane).toHaveLength(3);
    expect(macdPane.filter((item) => item.definition === 'Line')).toHaveLength(2);
    expect(macdPane.filter((item) => item.definition === 'Histogram')).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('switches to Heikin-Ashi without fetching, keeping timestamps and raw volume', async () => {
    const short = bars(20);
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(short)} />));
    const chart = lightweight.charts[0];
    const volume = volumeOf(chart);
    const rawVolume = volume.setData.mock.calls.at(-1)?.[0] as Array<{ time: number; value: number }>;
    fetchMock.mockClear();

    await act(async () => root.render(<TechnicalChartHost {...baseProps(short)} chartType="heikin-ashi" />));
    const haCandles = candlesOf(chart).setData.mock.calls.at(-1)?.[0] as Array<{ time: number; close: number }>;
    const haVolume = volume.setData.mock.calls.at(-1)?.[0] as Array<{ time: number; value: number }>;

    expect(fetchMock).not.toHaveBeenCalled();
    haCandles.forEach((point, index) => expect(point.time).toBe(rawVolume[index].time));
    haVolume.forEach((point, index) => expect(point.value).toBe(rawVolume[index].value));
    // Heikin-Ashi actually transformed the drawn OHLC.
    const expected = toDisplayBars(short, 'heikin-ashi');
    haCandles.forEach((point, index) => expect(point.close).toBeCloseTo(expected[index].close, 10));
    await act(async () => root.unmount());
  });

  it('disposes the chart exactly once on unmount', async () => {
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(bars(20))} />));
    const chart = lightweight.charts[0];
    await act(async () => root.unmount());
    expect(chart.remove).toHaveBeenCalledTimes(1);
  });
});

describe('incremental update predicate', () => {
  const display = (data: CanonicalBar[]) => toDisplayBars(data, 'candlestick');

  it('accepts an in-place update of the newest bar', () => {
    const data = bars(10);
    const ticked = [...data];
    ticked[9] = { ...ticked[9], close: 500 };
    expect(canUpdateIncrementally(display(data), display(ticked))).toBe(true);
  });

  it('accepts exactly one appended bucket', () => {
    const data = bars(10);
    const appended = [...data, { time: START + 10 * DAY, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5, partial: true }];
    expect(canUpdateIncrementally(display(data), display(appended))).toBe(true);
  });

  it('rejects a changed historical slot, a shrink and a multi-bar jump', () => {
    const data = bars(10);
    const shifted = bars(10).map((bar, index) => (index === 3 ? { ...bar, time: bar.time + 1 } : bar));
    expect(canUpdateIncrementally(display(data), display(shifted))).toBe(false);
    expect(canUpdateIncrementally(display(data), display(bars(9)))).toBe(false);
    expect(canUpdateIncrementally(display(data), display(bars(13)))).toBe(false);
  });
});
