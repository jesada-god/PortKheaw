'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { InstitutionalOverlaySpec } from '@/src/lib/analytics/institutional-sr/overlay-spec';
import { toDisplayBars, type CanonicalBar, type CanonicalDisplayMode, type DisplayBar } from '@/src/lib/analytics/canonical-bars';
import type { IndicatorPoint, MacdPoint } from '@/src/lib/analytics/chart-indicators';
import { InstitutionalOverlayPrimitive } from '../chart-institutional-primitive';

/** A visible logical bar-index range, reported for viewport-scoped analytics. */
export interface VisibleLogicalRange { from: number; to: number; }

export interface ChartPriceLineSpec {
  id: string;
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
  width?: 1 | 2 | 3 | 4;
}

export interface EmaLineSpec {
  id: string;
  label: string;
  color: string;
  points: readonly IndicatorPoint[];
}

const EMPTY_SPEC: InstitutionalOverlaySpec = { bands: [], lines: [] };
const RSI_PANE = 2;
const UP = '#00c57f';
const DOWN = '#ff3b30';

function layout() {
  return {
    autoSize: false,
    layout: {
      textColor: '#cbd5e1',
      background: { type: ColorType.Solid, color: '#141722' },
      attributionLogo: true,
      panes: { separatorColor: '#242733', separatorHoverColor: '#2f3446', enableResize: true },
    },
    grid: { vertLines: { color: '#1e2232' }, horzLines: { color: '#1e2232' } },
    rightPriceScale: { visible: true, borderColor: '#242733' },
    timeScale: { borderColor: '#242733', timeVisible: true, secondsVisible: false, rightOffset: 6 },
    crosshair: { vertLine: { color: '#64748b' }, horzLine: { color: '#64748b' } },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
  };
}

function candleData(bars: readonly DisplayBar[]) {
  return bars.map((bar) => ({
    time: bar.time as UTCTimestamp as Time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
}

/**
 * Volume points derived from the *same* bar array as the candles, so the two
 * series can never occupy different time slots. A slot whose volume the provider
 * did not report becomes a whitespace point: it holds its place on the timeline
 * without drawing a fabricated zero column.
 */
function volumeData(bars: readonly DisplayBar[]) {
  return bars.map((bar) => (bar.volume == null
    ? { time: bar.time as UTCTimestamp as Time }
    : {
      time: bar.time as UTCTimestamp as Time,
      value: bar.volume,
      color: bar.rawClose >= bar.rawOpen ? '#00c57f99' : '#ff3b3099',
    }));
}

function linePoints(points: readonly IndicatorPoint[]) {
  return points.map((point) => ({ time: point.time as UTCTimestamp as Time, value: point.value }));
}

/**
 * Whether the incoming bars are the previous bars plus at most one appended bar,
 * with every stable slot unchanged — the only case in which an incremental
 * `update()` is correct. Anything else is a new dataset and gets a full setData.
 */
export function canUpdateIncrementally(previous: readonly DisplayBar[], next: readonly DisplayBar[]): boolean {
  if (!previous.length || !next.length) return false;
  if (next.length < previous.length || next.length > previous.length + 1) return false;
  for (let index = 0; index < previous.length - 1; index += 1) {
    if (previous[index].time !== next[index].time) return false;
  }
  const previousLast = previous[previous.length - 1];
  if (next.length === previous.length) return previousLast.time === next[next.length - 1].time;
  // Exactly one appended bucket: the shared slot must still line up and the new
  // bucket must be strictly newer.
  return previousLast.time === next[previous.length - 1].time
    && next[next.length - 1].time > previousLast.time;
}

export interface TechnicalChartHostProps {
  bars: readonly CanonicalBar[];
  chartType: CanonicalDisplayMode;
  volumeVisible: boolean;
  emaLines: readonly EmaLineSpec[];
  rsi: { points: readonly IndicatorPoint[] } | null;
  macd: { points: readonly MacdPoint[] } | null;
  priceLines: readonly ChartPriceLineSpec[];
  overlaySpec: InstitutionalOverlaySpec;
  /** Changing this refits the viewport once; a live tick never does. */
  datasetKey: string;
  onVisibleRangeChange?(range: VisibleLogicalRange | null): void;
  onCrosshairBar?(bar: DisplayBar | null): void;
  /** Receives an imperative reset handle for the toolbar. */
  onReady?(actions: { reset: () => void; fit: () => void } | null): void;
  heightClassName?: string;
}

/**
 * One chart. One time scale.
 *
 * The candle pane, the volume pane, the RSI pane and the MACD pane are *panes of
 * a single lightweight-charts instance*, so they share one time scale by
 * construction. The previous implementation created two independent charts and
 * cross-posted their logical ranges; because each chart sizes its own price axis
 * (a price label and a volume label are different widths) the identical logical
 * range landed on different pixel offsets and the candles visibly ran ahead of
 * the volume columns. No amount of range syncing can fix that — only one chart
 * can.
 */
export function TechnicalChartHost({
  bars,
  chartType,
  volumeVisible,
  emaLines,
  rsi,
  macd,
  priceLines,
  overlaySpec,
  datasetKey,
  onVisibleRangeChange,
  onCrosshairBar,
  onReady,
  heightClassName = 'h-[460px] md:h-[560px]',
}: TechnicalChartHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const emaRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const rsiRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const macdRefs = useRef<Array<ISeriesApi<'Line'> | ISeriesApi<'Histogram'>>>([]);
  const priceLineRefs = useRef<IPriceLine[]>([]);
  const primitiveRef = useRef<InstitutionalOverlayPrimitive | null>(null);
  const overlaySpecRef = useRef(overlaySpec);
  const previousBarsRef = useRef<DisplayBar[]>([]);
  /** Chart type the current series data was written with; a change forces a full rewrite. */
  const previousChartTypeRef = useRef<CanonicalDisplayMode | null>(null);
  const barsRef = useRef<readonly DisplayBar[]>([]);
  const fittedRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const rangeFrameRef = useRef<number | null>(null);
  const rangeHandlerRef = useRef(onVisibleRangeChange);
  const crosshairHandlerRef = useRef(onCrosshairBar);
  const [ready, setReady] = useState(false);

  // Candles, volume, Heikin-Ashi and every tooltip value come from this one
  // derivation of the canonical bars — there is no second filtering path.
  const displayBars = useMemo(() => toDisplayBars(bars, chartType), [bars, chartType]);
  useEffect(() => { barsRef.current = displayBars; }, [displayBars]);
  useEffect(() => { rangeHandlerRef.current = onVisibleRangeChange; }, [onVisibleRangeChange]);
  useEffect(() => { crosshairHandlerRef.current = onCrosshairBar; }, [onCrosshairBar]);

  const paneCount = 2 + (rsi ? 1 : 0) + (macd ? 1 : 0);
  const macdPane = rsi ? RSI_PANE + 1 : RSI_PANE;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;
    const chart = createChart(container, layout());
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      lastValueVisible: true,
      priceLineVisible: false,
    }, 0);
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    }, 1);
    candleRef.current = candles;
    volumeRef.current = volume;

    const primitive = new InstitutionalOverlayPrimitive();
    primitiveRef.current = primitive;
    try {
      candles.attachPrimitive(primitive);
      primitive.setSpec(overlaySpecRef.current ?? EMPTY_SPEC);
    } catch { /* only throws on a disposed series */ }

    const crosshair = (parameter: MouseEventParams<Time>) => {
      if (parameter.time == null) { crosshairHandlerRef.current?.(null); return; }
      const key = Number(parameter.time);
      crosshairHandlerRef.current?.(barsRef.current.find((bar) => bar.time === key) ?? null);
    };
    chart.subscribeCrosshairMove(crosshair);

    // Viewport-scoped analytics (VPVR) re-slice the already-loaded candles on
    // pan/zoom. Coalesced through requestAnimationFrame; never a market request.
    const emitRange = () => {
      if (rangeFrameRef.current != null) cancelAnimationFrame(rangeFrameRef.current);
      rangeFrameRef.current = requestAnimationFrame(() => {
        rangeFrameRef.current = null;
        if (disposedRef.current || chartRef.current !== chart) return;
        try {
          const logical = chart.timeScale().getVisibleLogicalRange();
          rangeHandlerRef.current?.(logical ? { from: logical.from, to: logical.to } : null);
        } catch { /* time scale may be mid-teardown */ }
      });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(emitRange);

    const resize = () => {
      if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        if (disposedRef.current || chartRef.current !== chart) return;
        chart.applyOptions({
          width: Math.max(1, container.clientWidth),
          height: Math.max(320, container.clientHeight),
        });
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    setReady(true);

    return () => {
      disposedRef.current = true;
      setReady(false);
      observer.disconnect();
      chart.unsubscribeCrosshairMove(crosshair);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(emitRange);
      if (resizeFrameRef.current != null) { cancelAnimationFrame(resizeFrameRef.current); resizeFrameRef.current = null; }
      if (rangeFrameRef.current != null) { cancelAnimationFrame(rangeFrameRef.current); rangeFrameRef.current = null; }
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      primitiveRef.current = null;
      emaRefs.current = [];
      rsiRefs.current = [];
      macdRefs.current = [];
      priceLineRefs.current = [];
      previousBarsRef.current = [];
      previousChartTypeRef.current = null;
      fittedRef.current = null;
    };
  }, []);

  const reset = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || disposedRef.current) return;
    try {
      chart.priceScale('right').applyOptions({ autoScale: true });
      chart.timeScale().fitContent();
    } catch { /* chart may be mid-teardown */ }
  }, []);
  const fit = useCallback(() => {
    if (!chartRef.current || disposedRef.current) return;
    try { chartRef.current.timeScale().fitContent(); } catch { /* mid-teardown */ }
  }, []);
  useEffect(() => {
    if (!ready) return;
    onReady?.({ reset, fit });
    return () => onReady?.(null);
  }, [ready, onReady, reset, fit]);

  // ── Candles + volume: one write path, always both together ─────────────────
  useEffect(() => {
    if (!ready || disposedRef.current) return;
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!candles || !volume) return;
    const previous = previousBarsRef.current;
    // Switching Candles ↔ Heikin-Ashi keeps every timestamp but rewrites every
    // drawn OHLC, so it can never take the incremental path.
    const sameChartType = previousChartTypeRef.current === chartType;
    if (sameChartType && canUpdateIncrementally(previous, displayBars)) {
      // Finalize the previous bar first when a new bucket appeared, then the
      // newest one. Both series receive exactly the same bars in the same order.
      if (displayBars.length > previous.length && displayBars.length > 1) {
        const settled = displayBars[displayBars.length - 2];
        candles.update(candleData([settled])[0]);
        volume.update(volumeData([settled])[0]);
      }
      const latest = displayBars[displayBars.length - 1];
      candles.update(candleData([latest])[0]);
      volume.update(volumeData([latest])[0]);
    } else {
      candles.setData(candleData(displayBars));
      volume.setData(volumeData(displayBars));
    }
    previousBarsRef.current = [...displayBars];
    previousChartTypeRef.current = chartType;
    if (displayBars.length >= 2 && fittedRef.current !== datasetKey) {
      fittedRef.current = datasetKey;
      try { chartRef.current?.timeScale().fitContent(); } catch { /* mid-teardown */ }
    }
  }, [ready, displayBars, chartType, datasetKey]);

  useEffect(() => {
    if (!ready || disposedRef.current || !volumeRef.current) return;
    volumeRef.current.applyOptions({ visible: volumeVisible });
  }, [ready, volumeVisible]);

  // ── EMA overlays on the price pane ─────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart || disposedRef.current) return;
    emaRefs.current.forEach((series) => {
      try { chart.removeSeries(series); } catch { /* already removed */ }
    });
    emaRefs.current = emaLines.map((line) => {
      const series = chart.addSeries(LineSeries, {
        color: line.color,
        lineWidth: 2,
        title: line.label,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      }, 0);
      series.setData(linePoints(line.points));
      return series;
    });
  }, [ready, emaLines]);

  // ── RSI / MACD sub-panes ───────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart || disposedRef.current) return;
    [...rsiRefs.current, ...macdRefs.current].forEach((series) => {
      try { chart.removeSeries(series); } catch { /* already removed */ }
    });
    rsiRefs.current = [];
    macdRefs.current = [];
    // Drop panes that are no longer needed so a disabled indicator leaves no gap.
    try {
      while (chart.panes().length > paneCount) chart.removePane(chart.panes().length - 1);
    } catch { /* pane API unavailable mid-teardown */ }

    if (rsi) {
      const line = chart.addSeries(LineSeries, {
        color: '#2dd4bf', lineWidth: 2, title: 'RSI 14', lastValueVisible: true, priceLineVisible: false,
      }, RSI_PANE);
      line.setData(linePoints(rsi.points));
      [
        { value: 70, color: '#f87171' },
        { value: 50, color: '#64748b' },
        { value: 30, color: '#34d399' },
      ].forEach((reference) => {
        line.createPriceLine({
          price: reference.value,
          color: reference.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: String(reference.value),
        });
      });
      rsiRefs.current = [line];
      try { chart.panes()[RSI_PANE]?.setHeight(110); } catch { /* pane not ready */ }
    }

    if (macd) {
      const histogram = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
        priceScaleId: 'right',
        lastValueVisible: false,
        priceLineVisible: false,
      }, macdPane);
      histogram.setData(macd.points.flatMap((point) => (point.histogram == null ? [] : [{
        time: point.time as UTCTimestamp as Time,
        value: point.histogram,
        color: point.histogram >= 0 ? '#00c57f88' : '#ff3b3088',
      }])));
      const macdLine = chart.addSeries(LineSeries, {
        color: '#fb7185', lineWidth: 2, title: 'MACD', lastValueVisible: true, priceLineVisible: false,
      }, macdPane);
      macdLine.setData(linePoints(macd.points.map((point) => ({ time: point.time, value: point.macd }))));
      const signalLine = chart.addSeries(LineSeries, {
        color: '#facc15', lineWidth: 2, title: 'Signal', lastValueVisible: true, priceLineVisible: false,
      }, macdPane);
      signalLine.setData(linePoints(macd.points.flatMap((point) => (point.signal == null ? [] : [{ time: point.time, value: point.signal }]))));
      macdRefs.current = [histogram, macdLine, signalLine];
      try { chart.panes()[macdPane]?.setHeight(110); } catch { /* pane not ready */ }
    }
  }, [ready, rsi, macd, paneCount, macdPane]);

  // ── S/R + accepted-price lines ─────────────────────────────────────────────
  useEffect(() => {
    const candles = candleRef.current;
    if (!ready || !candles || disposedRef.current) return;
    priceLineRefs.current.forEach((line) => {
      try { candles.removePriceLine(line); } catch { /* already removed */ }
    });
    priceLineRefs.current = priceLines.map((spec) => candles.createPriceLine({
      price: spec.price,
      color: spec.color,
      lineWidth: spec.width ?? 1,
      lineStyle: spec.dashed ? LineStyle.Dashed : LineStyle.Solid,
      axisLabelVisible: true,
      title: spec.title,
    }));
    return () => {
      priceLineRefs.current.forEach((line) => {
        try { candleRef.current?.removePriceLine(line); } catch { /* chart removed */ }
      });
      priceLineRefs.current = [];
    };
  }, [ready, priceLines]);

  useEffect(() => {
    overlaySpecRef.current = overlaySpec;
    if (!ready || disposedRef.current || !primitiveRef.current) return;
    primitiveRef.current.setSpec(overlaySpec ?? EMPTY_SPEC);
  }, [ready, overlaySpec]);

  return (
    <div
      ref={containerRef}
      className={`w-full ${heightClassName}`}
      data-testid="technical-chart-host"
      aria-label="กราฟราคาพร้อมปริมาณการซื้อขายและอินดิเคเตอร์"
    />
  );
}

export default TechnicalChartHost;
