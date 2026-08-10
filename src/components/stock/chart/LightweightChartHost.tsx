'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ColorType,
  LineSeries,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import type { AdvancedChartType } from '@/src/lib/analytics/chart-types/types';
import type { InstitutionalOverlaySpec } from '@/src/lib/analytics/institutional-sr/overlay-spec';
import { canUpdateLatest } from './chart-data-adapter';
import { asLineStyle } from './chart-overlays';
import { InstitutionalOverlayPrimitive } from './chart-institutional-primitive';
import { addPrimarySeries, addVolumeSeries, setPrimaryData, setVolumeData, updatePrimary, updateVolume, type PrimarySeries } from './chart-series-manager';
import { ChartTooltip } from './chart-tooltip';
import type { ChartActions, ChartBar, ChartIndicatorLine, ChartPriceLine, ChartTooltipContext } from './chart-types';
import { getChartThemeColors, subscribeToAppearanceChange } from '@/src/themes/chart-theme';

/** A visible logical bar-index range, reported for viewport-scoped analytics. */
export interface VisibleLogicalRange { from: number; to: number; }

const EMPTY_OVERLAY_SPEC: InstitutionalOverlaySpec = { bands: [], lines: [] };

export function LightweightChartHost({
  bars,
  chartType,
  volumeVisible,
  priceLines,
  indicatorLines,
  datasetKey,
  tooltipContext,
  overlaySpec,
  onVisibleRangeChange,
  onActions,
}: {
  bars: readonly ChartBar[];
  chartType: AdvancedChartType;
  volumeVisible: boolean;
  priceLines: readonly ChartPriceLine[];
  indicatorLines: readonly ChartIndicatorLine[];
  datasetKey: string;
  tooltipContext: ChartTooltipContext;
  /** Institutional overlay bands/lines painted by a series primitive (never refetches). */
  overlaySpec?: InstitutionalOverlaySpec;
  /** Reports the visible logical bar-index range for viewport-scoped analytics (VRVP). */
  onVisibleRangeChange?(range: VisibleLogicalRange | null): void;
  onActions(actions: ChartActions | null): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const primaryRef = useRef<PrimarySeries | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlayRefs = useRef<Array<{ series: PrimarySeries; line: IPriceLine }>>([]);
  const indicatorRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const previousBarsRef = useRef<ChartBar[]>([]);
  const barsRef = useRef<readonly ChartBar[]>(bars);
  const fittedDatasetRef = useRef<string | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  // The institutional overlay primitive lives for the chart's lifetime and is
  // re-attached to whichever primary series is current (chart type can swap it).
  const primitiveRef = useRef<InstitutionalOverlayPrimitive | null>(null);
  // Latest spec/handler kept in refs so overlay-spec or callback changes never
  // recreate the series (which would reset zoom/pan).
  const overlaySpecRef = useRef<InstitutionalOverlaySpec | undefined>(overlaySpec);
  const visibleRangeHandlerRef = useRef(onVisibleRangeChange);
  const visibleRangeFrameRef = useRef<number | null>(null);
  // Guards every chart/series call against a torn-down instance. lightweight-charts
  // throws an uncaught "Object is disposed" if any method (applyOptions, createPriceLine,
  // update, removeSeries…) runs after chart.remove(). Set true in cleanup, reset per mount.
  const disposedRef = useRef(false);
  const [chartReady, setChartReady] = useState(false);
  const [tooltipBar, setTooltipBar] = useState<ChartBar | null>(null);

  useEffect(() => { barsRef.current = bars; }, [bars]);
  useEffect(() => { visibleRangeHandlerRef.current = onVisibleRangeChange; }, [onVisibleRangeChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;
    const colors = getChartThemeColors();
    const chart = createChart(container, {
      autoSize: false,
      // `attributionLogo: false` is the library's own supported way to keep the
      // TradingView mark out of the plot. It is allowed only because the licence's
      // notice-and-link requirement is met in the footer instead — see
      // `ChartAttribution`, which StockChart renders directly beneath this host.
      layout: { background: { type: ColorType.Solid, color: colors.background }, textColor: colors.text, attributionLogo: false },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { vertLine: { color: colors.axis }, horzLine: { color: colors.axis } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    chartRef.current = chart;
    const unsubscribeAppearance = subscribeToAppearanceChange(window, () => {
      if (disposedRef.current || chartRef.current !== chart) return;
      const next = getChartThemeColors();
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: next.background }, textColor: next.text },
        grid: { vertLines: { color: next.grid }, horzLines: { color: next.grid } },
        rightPriceScale: { borderColor: next.border },
        timeScale: { borderColor: next.border },
        crosshair: { vertLine: { color: next.axis }, horzLine: { color: next.axis } },
      });
    });
    const crosshair = (parameter: MouseEventParams<Time>) => {
      if (parameter.time == null) { setTooltipBar(null); return; }
      const key = typeof parameter.time === 'number' ? parameter.time : String(parameter.time);
      const match = barsRef.current.find((bar) => (typeof key === 'number' ? Number(bar.time) === key : bar.sourceTime === key));
      setTooltipBar(match ?? null);
    };
    chart.subscribeCrosshairMove(crosshair);
    // Report the visible logical range for viewport-scoped analytics (VRVP). Debounced
    // through requestAnimationFrame; a late frame after teardown is dropped. This only
    // re-slices already-loaded candles upstream — it never triggers a market request.
    const emitVisibleRange = () => {
      if (visibleRangeFrameRef.current != null) cancelAnimationFrame(visibleRangeFrameRef.current);
      visibleRangeFrameRef.current = requestAnimationFrame(() => {
        visibleRangeFrameRef.current = null;
        if (disposedRef.current || chartRef.current !== chart) return;
        let range: VisibleLogicalRange | null = null;
        try {
          const logical = chart.timeScale().getVisibleLogicalRange();
          range = logical ? { from: logical.from, to: logical.to } : null;
        } catch {
          return; // time scale may be mid-teardown
        }
        visibleRangeHandlerRef.current?.(range);
      });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(emitVisibleRange);
    const resize = () => {
      if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        // A late frame can fire after the chart was removed or replaced; never
        // apply options to a disposed/stale instance.
        if (disposedRef.current || chartRef.current !== chart) return;
        const width = Math.max(1, container.clientWidth);
        const height = Math.max(280, container.clientHeight);
        chart.applyOptions({ width, height });
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const actions: ChartActions = {
      fitContent: () => chart.timeScale().fitContent(),
      reset: () => chart.timeScale().resetTimeScale(),
    };
    onActions(actions);
    setChartReady(true);
    return () => {
      disposedRef.current = true;
      onActions(null);
      setChartReady(false);
      unsubscribeAppearance();
      observer.disconnect();
      chart.unsubscribeCrosshairMove(crosshair);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(emitVisibleRange);
      if (resizeFrameRef.current != null) { cancelAnimationFrame(resizeFrameRef.current); resizeFrameRef.current = null; }
      if (visibleRangeFrameRef.current != null) { cancelAnimationFrame(visibleRangeFrameRef.current); visibleRangeFrameRef.current = null; }
      chart.remove();
      chartRef.current = null;
      primaryRef.current = null;
      volumeRef.current = null;
      // The primitive was disposed with the series by chart.remove(); drop the ref.
      primitiveRef.current = null;
      overlayRefs.current = [];
      indicatorRefs.current = [];
      previousBarsRef.current = [];
      fittedDatasetRef.current = null;
    };
  }, [onActions]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chartReady || !chart || disposedRef.current) return;
    if (primaryRef.current) {
      // Detach the overlay from the outgoing series before it is removed.
      if (primitiveRef.current) {
        try { primaryRef.current.detachPrimitive(primitiveRef.current); } catch { /* series may already be gone */ }
      }
      chart.removeSeries(primaryRef.current);
    }
    primaryRef.current = addPrimarySeries(chart, chartType);
    // Re-attach the institutional overlay primitive to the current primary series
    // and repaint it with the latest spec. This follows zoom/pan without recreating.
    if (!primitiveRef.current) primitiveRef.current = new InstitutionalOverlayPrimitive();
    try {
      primaryRef.current.attachPrimitive(primitiveRef.current);
      primitiveRef.current.setSpec(overlaySpecRef.current ?? EMPTY_OVERLAY_SPEC);
    } catch { /* attach can throw only on a disposed series; guarded elsewhere */ }
    previousBarsRef.current = [];
  }, [chartReady, chartType]);

  // Push a new overlay spec to the live primitive without touching the series/chart
  // geometry. Guarded against a disposed instance so a late update is disposal-safe.
  useEffect(() => {
    overlaySpecRef.current = overlaySpec;
    if (!chartReady || disposedRef.current || !primitiveRef.current) return;
    primitiveRef.current.setSpec(overlaySpec ?? EMPTY_OVERLAY_SPEC);
  }, [chartReady, overlaySpec]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chartReady || !chart || disposedRef.current) return;
    if (!volumeRef.current) volumeRef.current = addVolumeSeries(chart);
    volumeRef.current.applyOptions({ visible: volumeVisible });
  }, [chartReady, volumeVisible]);

  useEffect(() => {
    if (!chartReady || disposedRef.current) return;
    const primary = primaryRef.current;
    const volume = volumeRef.current;
    if (!primary || !volume) return;
    const previous = previousBarsRef.current;
    if (canUpdateLatest(previous, bars)) {
      if (bars.length > previous.length && bars.length > 1) {
        updatePrimary(primary, chartType, bars.at(-2)!);
        updateVolume(volume, bars.at(-2)!);
      }
      const latest = bars.at(-1);
      if (latest) { updatePrimary(primary, chartType, latest); updateVolume(volume, latest); }
    } else {
      setPrimaryData(primary, chartType, bars);
      setVolumeData(volume, bars);
    }
    previousBarsRef.current = [...bars];
    if (bars.length >= 2 && fittedDatasetRef.current !== datasetKey) {
      chartRef.current?.timeScale().fitContent();
      fittedDatasetRef.current = datasetKey;
    }
  }, [chartReady, bars, chartType, datasetKey]);

  useEffect(() => {
    const primary = primaryRef.current;
    if (!chartReady || !chartRef.current || !primary || disposedRef.current) return;
    overlayRefs.current.forEach(({ series, line }) => {
      try { series.removePriceLine(line); } catch { /* series may already be removed */ }
    });
    overlayRefs.current = priceLines.map((item) => ({
      series: primary,
      line: primary.createPriceLine({
        price: item.price,
        color: item.color,
        lineWidth: 1,
        lineStyle: asLineStyle(item.lineStyle),
        axisLabelVisible: true,
        title: item.title,
      }),
    }));
    return () => {
      overlayRefs.current.forEach(({ series, line }) => {
        try { series.removePriceLine(line); } catch { /* chart may already be removed */ }
      });
      overlayRefs.current = [];
    };
  }, [chartReady, chartType, priceLines]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chartReady || !chart || disposedRef.current) return;
    indicatorRefs.current.forEach((series) => chart.removeSeries(series));
    indicatorRefs.current = indicatorLines.map((indicator) => {
      const series = chart.addSeries(LineSeries, { color: indicator.color, lineWidth: 1, title: indicator.label, lastValueVisible: false }, indicator.pane);
      series.setData(indicator.data);
      return series;
    });
    return () => {
      const active = chartRef.current;
      if (!active) return;
      indicatorRefs.current.forEach((series) => {
        try { active.removeSeries(series); } catch { /* chart may already be removed */ }
      });
      indicatorRefs.current = [];
    };
  }, [chartReady, indicatorLines]);

  return <div className="relative h-[26rem] min-h-[20rem] w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--chart-bg)] md:h-[32rem]" aria-label="Interactive price and volume chart" data-testid="lightweight-chart-host">
    <div ref={containerRef} className="h-full w-full" />
    {tooltipBar && <div className="absolute left-2 top-2 z-10"><ChartTooltip bar={tooltipBar} context={tooltipContext}/></div>}
  </div>;
}
