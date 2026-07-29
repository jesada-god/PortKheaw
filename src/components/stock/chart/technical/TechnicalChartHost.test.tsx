// @vitest-environment jsdom

import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lightweight = vi.hoisted(() => ({ charts: [] as Array<Record<string, unknown>> }));

interface PriceLineStub {
  options: {
    price: number;
    color: string;
    lineWidth: number;
    lineStyle: number;
    axisLabelVisible: boolean;
    title: string;
  };
  applyOptions: ReturnType<typeof vi.fn>;
}

interface SeriesStub {
  definition: string;
  paneIndex: number | undefined;
  /** Price lines currently attached — created minus removed. */
  livePriceLines: PriceLineStub[];
  setData: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  createPriceLine: ReturnType<typeof vi.fn>;
  removePriceLine: ReturnType<typeof vi.fn>;
  applyOptions: ReturnType<typeof vi.fn>;
  attachPrimitive: ReturnType<typeof vi.fn>;
  detachPrimitive: ReturnType<typeof vi.fn>;
  priceToCoordinate: ReturnType<typeof vi.fn>;
}

/** Pixels the stubbed time scale reports; drives the readable-spacing rule. */
const timeScaleWidth = vi.hoisted(() => ({ value: 900 }));

vi.mock('lightweight-charts', () => {
  const definition = (name: string) => ({ name });
  return {
    ColorType: { Solid: 'solid' },
    LineStyle: { Solid: 0, Dashed: 2, Dotted: 1 },
    CandlestickSeries: definition('Candlestick'),
    HistogramSeries: definition('Histogram'),
    LineSeries: definition('Line'),
    AreaSeries: definition('Area'),
    BarSeries: definition('Bar'),
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
        width: vi.fn(() => timeScaleWidth.value),
        applyOptions: vi.fn(),
      };
      const chart = {
        container,
        series,
        removed: 0,
        addSeries: vi.fn((def: { name: string }, _options: unknown, paneIndex?: number) => {
          const livePriceLines: PriceLineStub[] = [];
          const item: SeriesStub = {
            definition: def.name,
            paneIndex,
            livePriceLines,
            setData: vi.fn(),
            update: vi.fn(),
            createPriceLine: vi.fn((options: PriceLineStub['options']) => {
              const line: PriceLineStub = { options, applyOptions: vi.fn() };
              livePriceLines.push(line);
              return line;
            }),
            removePriceLine: vi.fn((line: PriceLineStub) => {
              const index = livePriceLines.indexOf(line);
              if (index >= 0) livePriceLines.splice(index, 1);
            }),
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
  timeScaleWidth.value = 900;
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
    const panes = (chart.panes as () => Array<{ setHeight: ReturnType<typeof vi.fn> }>)();
    expect(panes[0].setHeight).toHaveBeenCalledWith(224);
    expect(panes[1].setHeight).toHaveBeenCalledWith(96);
    expect(panes[1].setHeight.mock.invocationCallOrder[0])
      .toBeLessThan(volumeOf(chart).setData.mock.invocationCallOrder[0]);
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

  it('shows the latest plotted EMA value at symbol precision and removes line and label together', async () => {
    const points = [
      { time: data[20].time, value: 10.1234 },
      { time: data[21].time, value: 10.856 },
    ];
    const { host, root } = mount();
    await act(async () => root.render(
      <TechnicalChartHost
        {...baseProps(data)}
        pricePrecision={2}
        emaLines={[{ id: 'ema20', label: 'EMA 20', color: '#f59e0b', points }]}
      />,
    ));
    const label = host.querySelector('[data-testid="chart-label-ema20"]');
    expect(label?.textContent).toContain('EMA 20  10.86');
    // The EMA belongs to the right edge; the price scale is over there.
    expect(label?.getAttribute('data-side')).toBe('right');

    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} emaLines={[]} />));
    expect(host.querySelector('[data-testid="chart-label-ema20"]')).toBeNull();
    expect((lightweight.charts[0].series as SeriesStub[]).filter((item) => item.definition === 'Line')).toHaveLength(0);
    await act(async () => root.unmount());
  });

  it('leaves an EMA with no plotted value unlabelled rather than printing a zero', async () => {
    const { host, root } = mount();
    await act(async () => root.render(
      <TechnicalChartHost
        {...baseProps(data)}
        emaLines={[{ id: 'ema200', label: 'EMA 200', color: '#f472b6', points: [] }]}
      />,
    ));
    expect(host.querySelector('[data-testid="chart-label-ema200"]')).toBeNull();
    expect(host.querySelector('[data-testid="chart-label-layer"]')?.textContent ?? '').not.toContain('0.00');
    await act(async () => root.unmount());
  });

  it('carries the EMA value into the label instead of the chart title, which can only print the name', async () => {
    const { root } = mount();
    await act(async () => root.render(
      <TechnicalChartHost
        {...baseProps(data)}
        emaLines={[{ id: 'ema20', label: 'EMA 20', color: '#f59e0b', points: [{ time: data[20].time, value: 10.86 }] }]}
      />,
    ));
    const emaOptions = (lightweight.charts[0].addSeries as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => (call[0] as { name: string }).name === 'Line')?.[1] as { title?: string };
    expect(emaOptions.title).toBe('');
    await act(async () => root.unmount());
  });

  it('keeps pane and series ownership deterministic through rapid chart/indicator changes', async () => {
    const { root } = mount();
    const rsiPoints = data.map((bar) => ({ time: bar.time, value: 55 }));
    const macdPoints = data.map((bar) => ({ time: bar.time, macd: 1, signal: 0.5, histogram: 0.5 }));
    for (let index = 0; index < 10; index += 1) {
      await act(async () => root.render(
        <TechnicalChartHost
          {...baseProps(data)}
          chartType={index % 2 ? 'heikin-ashi' : 'candlestick'}
          rsi={index % 3 === 0 ? { points: rsiPoints } : null}
          macd={index % 4 === 0 ? { points: macdPoints } : null}
        />,
      ));
    }
    await act(async () => root.render(<TechnicalChartHost {...baseProps(data)} rsi={null} macd={null} />));
    const chart = lightweight.charts[0];
    expect((chart.series as SeriesStub[]).filter((item) => item.paneIndex === 0)).toHaveLength(1);
    expect((chart.series as SeriesStub[]).filter((item) => item.paneIndex === 1)).toHaveLength(1);
    expect((chart.panes as () => unknown[])()).toHaveLength(2);
    expect(lightweight.charts.filter((item) => item.removed === 0)).toHaveLength(1);
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

  it('swaps the price series for Line, Area, OHLC and Hollow without fetching or touching volume', async () => {
    const short = bars(20);
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(short)} />));
    const chart = lightweight.charts[0];
    const volume = volumeOf(chart);
    const originalVolume = volume.setData.mock.calls.at(-1)?.[0] as Array<{ time: number; value?: number }>;
    fetchMock.mockClear();

    for (const [chartType, expected] of [
      ['line', 'Line'], ['area', 'Area'], ['ohlc', 'Bar'], ['hollow-candles', 'Candlestick'],
    ] as const) {
      await act(async () => root.render(<TechnicalChartHost {...baseProps(short)} chartType={chartType} />));
      const price = (chart.series as SeriesStub[]).find((item) => item.paneIndex === 0)!;
      expect(price.definition).toBe(expected);
      // The new series is written in full, from the same bars.
      const written = price.setData.mock.calls.at(-1)?.[0] as Array<{ time: number }>;
      expect(written).toHaveLength(short.length);
      // Exactly one price series on the price pane — the old one is removed.
      expect((chart.series as SeriesStub[]).filter((item) => item.paneIndex === 0)).toHaveLength(1);
    }

    // Line and area carry the closing value only; OHLC carries the traded bar.
    await act(async () => root.render(<TechnicalChartHost {...baseProps(short)} chartType="line" />));
    const line = (chart.series as SeriesStub[]).find((item) => item.paneIndex === 0)!;
    const linePoints = line.setData.mock.calls.at(-1)?.[0] as Array<{ value?: number; close?: number }>;
    expect(linePoints[0].value).toBe(short[0].close);
    expect(linePoints[0].close).toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    // The volume histogram is never recreated by a chart-type change, and the
    // traded sizes it carries are byte-for-byte the ones it started with.
    expect(volumeOf(chart)).toBe(volume);
    expect(volume.setData.mock.calls.at(-1)?.[0]).toEqual(originalVolume);
    await act(async () => root.unmount());
  });

  it('re-creates the S/R price lines on the new series after a chart-type swap', async () => {
    const short = bars(20);
    const priceLines = [{ id: 'S1', price: 100, color: '#0f0', title: 'S1' }];
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(short)} priceLines={priceLines} />));
    const chart = lightweight.charts[0];

    await act(async () => root.render(<TechnicalChartHost {...baseProps(short)} priceLines={priceLines} chartType="line" />));
    const line = (chart.series as SeriesStub[]).find((item) => item.paneIndex === 0)!;
    expect(line.definition).toBe('Line');
    expect(line.createPriceLine).toHaveBeenCalledTimes(1);
    expect(line.attachPrimitive).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('opens at a readable bar width instead of squeezing a long history to fit', async () => {
    // 900px / 260 bars ≈ 3.5px per bar — too tight to count a level touch.
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(bars(260))} />));
    const chart = lightweight.charts[0];
    const timeScale = (chart.timeScale as () => Record<string, ReturnType<typeof vi.fn>>)();
    expect(timeScale.applyOptions).toHaveBeenCalledWith({ barSpacing: 9 });
    expect(timeScale.scrollToRealTime).toHaveBeenCalled();
    // The whole history is still loaded; only the viewport starts nearer.
    expect(candlesOf(chart).setData.mock.calls.at(-1)?.[0]).toHaveLength(260);
    await act(async () => root.unmount());
  });

  it('still fits the content when the bars already have room to breathe', async () => {
    const { root } = mount();
    await act(async () => root.render(<TechnicalChartHost {...baseProps(bars(20))} />));
    const chart = lightweight.charts[0];
    const timeScale = (chart.timeScale as () => Record<string, ReturnType<typeof vi.fn>>)();
    expect(timeScale.fitContent).toHaveBeenCalled();
    expect(timeScale.applyOptions).not.toHaveBeenCalled();
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

describe('TechnicalChartHost — level lines and the accepted-price line', () => {
  const data = bars(60);
  const ACCEPTED = 60.64;
  const priceLines = [
    { id: 'current', price: ACCEPTED, color: '#D4FF00', title: 'ราคาปัจจุบัน', dashed: true, width: 2 as const, labelSide: 'right' as const, axisLabel: true },
    { id: 'R1', price: 70.23, color: '#ff3b30', labelColor: '#ff3b30', title: 'R1', width: 2 as const, labelSide: 'left' as const },
    { id: 'R2', price: 76.56, color: '#ff3b30d9', labelColor: '#ff3b30', title: 'R2', width: 2 as const, labelSide: 'left' as const },
    { id: 'R3', price: 80.17, color: '#ff3b30b3', labelColor: '#ff3b30', title: 'R3', width: 2 as const, labelSide: 'left' as const },
    { id: 'S1', price: 60.29, color: '#00c57f', labelColor: '#00c57f', title: 'S1', width: 2 as const, labelSide: 'left' as const },
    { id: 'S2', price: 56.68, color: '#00c57fd9', labelColor: '#00c57f', title: 'S2', width: 2 as const, labelSide: 'left' as const },
    { id: 'S3', price: 50.35, color: '#00c57fb3', labelColor: '#00c57f', title: 'S3', width: 2 as const, labelSide: 'left' as const },
  ];
  const emaLines = [
    { id: 'ema20', label: 'EMA 20', color: '#f59e0b', points: [{ time: data[30].time, value: 85.42 }] },
    { id: 'ema50', label: 'EMA 50', color: '#38bdf8', points: [{ time: data[30].time, value: 73.18 }] },
  ];
  const withLevels = (extra: Record<string, unknown> = {}) => (
    <TechnicalChartHost {...baseProps(data)} priceLines={priceLines} emaLines={emaLines} {...extra} />
  );
  /** Every price line still attached to a series the chart still owns. */
  const attachedLines = (chart: Record<string, unknown>) => (chart.series as SeriesStub[])
    .flatMap((series) => series.livePriceLines);
  const currentLineOf = (chart: Record<string, unknown>) => attachedLines(chart)
    .find((line) => line.options.price === ACCEPTED);

  it('labels R1–R3 and S1–S3 on the left edge, with the level price', async () => {
    const { host, root } = mount();
    await act(async () => root.render(withLevels()));
    ['R1  70.23', 'R2  76.56', 'R3  80.17', 'S1  60.29', 'S2  56.68', 'S3  50.35'].forEach((text) => {
      const id = text.slice(0, 2);
      const node = host.querySelector(`[data-testid="chart-label-${id}"]`);
      expect(node?.textContent).toBe(text);
      expect(node?.getAttribute('data-side')).toBe('left');
    });
    await act(async () => root.unmount());
  });

  it('keeps the accepted price and every EMA label on the right edge', async () => {
    const { host, root } = mount();
    await act(async () => root.render(withLevels()));
    const right = [...host.querySelectorAll('[data-side="right"]')].map((node) => node.textContent);
    expect(right).toEqual(['ราคาปัจจุบัน  60.64', 'EMA 20  85.42', 'EMA 50  73.18']);
    await act(async () => root.unmount());
  });

  it('hands the level text to the chart canvas, not to lightweight-charts price-line titles', async () => {
    const { root } = mount();
    await act(async () => root.render(withLevels()));
    const lines = attachedLines(lightweight.charts[0]);
    // A price-line title can only be drawn on the price-scale side, which is why
    // the labels are painted by the overlay layer instead.
    expect(lines.every((line) => line.options.title === '')).toBe(true);
    // Only the accepted price keeps a chip on the price scale; six level chips
    // there would collide with each other and with the axis ticks.
    expect(lines.filter((line) => line.options.axisLabelVisible)).toHaveLength(1);
    expect(lines.find((line) => line.options.axisLabelVisible)?.options.price).toBe(ACCEPTED);
    await act(async () => root.unmount());
  });

  it('draws every level as a solid 2px stroke and the accepted price as a dashed one', async () => {
    const { root } = mount();
    await act(async () => root.render(withLevels()));
    const lines = attachedLines(lightweight.charts[0]);
    const levels = lines.filter((line) => line.options.price !== ACCEPTED);
    expect(levels).toHaveLength(6);
    levels.forEach((line) => {
      expect(line.options.lineWidth).toBe(2);
      expect(line.options.lineStyle).toBe(0);
    });
    expect(currentLineOf(lightweight.charts[0])?.options.lineStyle).toBe(2);
    expect(currentLineOf(lightweight.charts[0])?.options.lineWidth).toBe(2);
    await act(async () => root.unmount());
  });

  it('draws the accepted price line at the accepted price, not at an EMA or a level', async () => {
    const { root } = mount();
    await act(async () => root.render(withLevels()));
    const current = currentLineOf(lightweight.charts[0]);
    expect(current?.options.price).toBe(ACCEPTED);
    expect(current?.options.color).toBe('#D4FF00');
    [85.42, 73.18, 70.23, 60.29].forEach((other) => expect(current?.options.price).not.toBe(other));
    await act(async () => root.unmount());
  });

  it('keeps the accepted-price line through a live tick, a symbol change and a chart-type swap', async () => {
    const { root } = mount();
    await act(async () => root.render(withLevels()));
    const chart = lightweight.charts[0];
    expect(currentLineOf(chart)).toBeDefined();

    // A live tick: same selection, one more recent close.
    const ticked = [...data];
    ticked[ticked.length - 1] = { ...ticked[ticked.length - 1], close: 999 };
    await act(async () => root.render(
      <TechnicalChartHost {...baseProps(ticked)} priceLines={priceLines} emaLines={emaLines} />,
    ));
    expect(currentLineOf(chart)).toBeDefined();

    // A new symbol: a fresh dataset key and a fresh bar array.
    await act(async () => root.render(
      <TechnicalChartHost {...baseProps(bars(80))} datasetKey="RKLB:1D:1y" priceLines={priceLines} emaLines={emaLines} />,
    ));
    expect(currentLineOf(chart)).toBeDefined();

    // A chart-type swap replaces the price series the lines hang off.
    await act(async () => root.render(
      <TechnicalChartHost {...baseProps(bars(80))} datasetKey="RKLB:1D:1y" chartType="line" priceLines={priceLines} emaLines={emaLines} />,
    ));
    expect(currentLineOf(chart)?.options.price).toBe(ACCEPTED);
    expect(currentLineOf(chart)?.options.lineStyle).toBe(2);
    await act(async () => root.unmount());
  });

  it('follows a moving accepted price instead of pinning the first one drawn', async () => {
    const { host, root } = mount();
    await act(async () => root.render(withLevels()));
    const moved = priceLines.map((line) => (line.id === 'current' ? { ...line, price: 61.5 } : line));
    await act(async () => root.render(
      <TechnicalChartHost {...baseProps(data)} priceLines={moved} emaLines={emaLines} />,
    ));
    const lines = attachedLines(lightweight.charts[0]);
    expect(lines.filter((line) => line.options.lineStyle === 2)).toHaveLength(1);
    expect(lines.find((line) => line.options.lineStyle === 2)?.options.price).toBe(61.5);
    expect(host.querySelector('[data-testid="chart-label-current"]')?.textContent).toBe('ราคาปัจจุบัน  61.50');
    await act(async () => root.unmount());
  });

  it('reaches the overlay primitive with one label per level, EMA and price', async () => {
    const { root } = mount();
    await act(async () => root.render(withLevels()));
    const primitive = candlesOf(lightweight.charts[0]).attachPrimitive.mock.calls[0][0] as {
      currentSpec(): { lines: Array<{ id: string; side?: string; drawLine?: boolean }> };
    };
    const lines = primitive.currentSpec().lines;
    expect(lines.map((line) => line.id)).toEqual([
      'current', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3', 'ema20', 'ema50',
    ]);
    // The strokes belong to the price lines and the EMA series; this layer is text.
    expect(lines.every((line) => line.drawLine === false)).toBe(true);
    await act(async () => root.unmount());
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
