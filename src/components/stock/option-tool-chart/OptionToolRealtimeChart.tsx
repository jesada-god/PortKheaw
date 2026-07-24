'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
} from 'lightweight-charts';
import type { OhlcvInputBar } from '@/src/lib/analytics/chart-data/timeline';
import { adaptChartBars, canUpdateLatest, candlestickData, volumeData } from '../chart/chart-data-adapter';
import type { ChartBar } from '../chart/chart-types';
import {
  distancePercent,
  optionToolPivotLevelsSchema,
  type OptionToolPivotLevels,
} from './pivot-levels';

interface Props {
  symbol: string;
  interval: string;
  prices: readonly OhlcvInputBar[];
  datasetKey: string;
  currentPrice?: number | null;
}

type LevelsEnvelope = {
  data: unknown;
  error?: { message?: string };
};

interface LevelState {
  datasetKey: string;
  levels: OptionToolPivotLevels | null;
  error: string | null;
}

const EMPTY_LEVEL_STATE: LevelState = { datasetKey: '', levels: null, error: null };

function chartLayout() {
  return {
    layout: {
      textColor: '#cbd5e1',
      background: { type: ColorType.Solid, color: '#141722' },
      attributionLogo: true,
    },
    grid: {
      vertLines: { color: '#1e2232' },
      horzLines: { color: '#1e2232' },
    },
    rightPriceScale: { visible: true, borderColor: '#242733' },
  } as const;
}

function updateLatest(
  candleSeries: ISeriesApi<'Candlestick'>,
  volumeSeries: ISeriesApi<'Histogram'>,
  previous: readonly ChartBar[],
  next: readonly ChartBar[],
): void {
  if (!canUpdateLatest(previous, next)) {
    candleSeries.setData(candlestickData(next));
    volumeSeries.setData(volumeData(next));
    return;
  }
  if (next.length > previous.length && next.length > 1) {
    candleSeries.update(candlestickData([next.at(-2)!])[0]);
    volumeSeries.update(volumeData([next.at(-2)!])[0]);
  }
  const latest = next.at(-1);
  if (latest) {
    candleSeries.update(candlestickData([latest])[0]);
    volumeSeries.update(volumeData([latest])[0]);
  }
}

export function OptionToolRealtimeChart({
  symbol,
  interval,
  prices,
  datasetKey,
  currentPrice,
}: Props) {
  const priceContainerRef = useRef<HTMLDivElement>(null);
  const volumeContainerRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<IChartApi | null>(null);
  const volumeChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const previousBarsRef = useRef<ChartBar[]>([]);
  const displayedDatasetRef = useRef<string | null>(null);
  const supportResistanceLinesRef = useRef<IPriceLine[]>([]);
  const currentPriceLineRef = useRef<IPriceLine | null>(null);
  const syncingRef = useRef(false);
  const disposedRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const [levelState, setLevelState] = useState<LevelState>(EMPTY_LEVEL_STATE);
  const [srDataset, setSrDataset] = useState<string | null>(null);

  const bars = useMemo(() => adaptChartBars(prices, 'candlestick'), [prices]);
  const activeLevels = levelState.datasetKey === datasetKey ? levelState.levels : null;
  const levelsError = levelState.datasetKey === datasetKey ? levelState.error : null;
  const showSupportResistance = srDataset === datasetKey && activeLevels != null;
  const acceptedPrice = currentPrice != null && Number.isFinite(currentPrice)
    ? currentPrice
    : bars.at(-1)?.close ?? null;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ symbol, timeframe: interval });
    let cancelled = false;
    // Strict Mode runs effect setup/cleanup/setup once in development. Deferring
    // the request one microtask lets the throwaway setup cancel before any
    // network request is made, so a dataset issues exactly one levels request.
    queueMicrotask(() => {
      if (cancelled) return;
      void (async () => {
        try {
          const response = await fetch(`/api/market/chart-levels?${query.toString()}`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          const payload = await response.json() as LevelsEnvelope;
          if (!response.ok) throw new Error(payload.error?.message ?? 'Support/resistance is unavailable.');
          const parsed = optionToolPivotLevelsSchema.safeParse(payload.data);
          if (!parsed.success) throw new Error('Support/resistance response failed validation.');
          if (!controller.signal.aborted) setLevelState({ datasetKey, levels: parsed.data, error: null });
        } catch (cause) {
          if (!controller.signal.aborted) {
            setLevelState({
              datasetKey,
              levels: null,
              error: cause instanceof Error ? cause.message : 'Support/resistance is unavailable.',
            });
          }
        }
      })();
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [datasetKey, interval, symbol]);

  useEffect(() => {
    const priceContainer = priceContainerRef.current;
    const volumeContainer = volumeContainerRef.current;
    if (!priceContainer || !volumeContainer) return;
    disposedRef.current = false;

    const priceChart = createChart(priceContainer, {
      ...chartLayout(),
      leftPriceScale: {
        visible: false,
        borderColor: '#242733',
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: '#242733',
        visible: false,
        rightOffset: 50,
        barSpacing: 9,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: false },
        mouseWheel: true,
        pinch: true,
      },
    });
    const volumeChart = createChart(volumeContainer, {
      ...chartLayout(),
      leftPriceScale: { visible: false },
      timeScale: {
        borderColor: '#242733',
        timeVisible: true,
        rightOffset: 50,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: false },
        mouseWheel: true,
        pinch: true,
      },
    });
    const candleSeries = priceChart.addSeries(CandlestickSeries, {
      upColor: '#00c57f',
      downColor: '#ff3b30',
      borderVisible: false,
      wickUpColor: '#00c57f',
      wickDownColor: '#ff3b30',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const volumeSeries = volumeChart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'right',
    });

    const sync = (target: IChartApi) => (range: LogicalRange | null) => {
      if (syncingRef.current || range == null || disposedRef.current) return;
      syncingRef.current = true;
      try {
        target.timeScale().setVisibleLogicalRange(range);
      } finally {
        syncingRef.current = false;
      }
    };
    const syncVolume = sync(volumeChart);
    const syncPrice = sync(priceChart);
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(syncVolume);
    volumeChart.timeScale().subscribeVisibleLogicalRangeChange(syncPrice);

    const resize = () => {
      if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        if (disposedRef.current) return;
        priceChart.applyOptions({
          width: Math.max(1, priceContainer.clientWidth),
          height: Math.max(280, priceContainer.clientHeight),
        });
        volumeChart.applyOptions({
          width: Math.max(1, volumeContainer.clientWidth),
          height: Math.max(100, volumeContainer.clientHeight),
        });
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(priceContainer);
    observer.observe(volumeContainer);
    resize();

    priceChartRef.current = priceChart;
    volumeChartRef.current = volumeChart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      disposedRef.current = true;
      observer.disconnect();
      if (resizeFrameRef.current != null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      priceChart.timeScale().unsubscribeVisibleLogicalRangeChange(syncVolume);
      volumeChart.timeScale().unsubscribeVisibleLogicalRangeChange(syncPrice);
      priceChart.remove();
      volumeChart.remove();
      priceChartRef.current = null;
      volumeChartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      supportResistanceLinesRef.current = [];
      currentPriceLineRef.current = null;
      previousBarsRef.current = [];
      displayedDatasetRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const priceChart = priceChartRef.current;
    const volumeChart = volumeChartRef.current;
    if (!candleSeries || !volumeSeries || !priceChart || !volumeChart || disposedRef.current) return;

    updateLatest(candleSeries, volumeSeries, previousBarsRef.current, bars);
    previousBarsRef.current = [...bars];
    if (displayedDatasetRef.current !== datasetKey) {
      displayedDatasetRef.current = datasetKey;
      priceChart.priceScale('right').applyOptions({ autoScale: true });
      priceChart.priceScale('left').applyOptions({ autoScale: true });
      volumeChart.priceScale('right').applyOptions({ autoScale: true });
      priceChart.timeScale().scrollToRealTime();
      volumeChart.timeScale().scrollToRealTime();
    }
  }, [bars, datasetKey]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || disposedRef.current || acceptedPrice == null) return;
    const latest = bars.at(-1);
    const color = latest && acceptedPrice < latest.open ? '#ff3b30' : '#00c57f';
    if (!currentPriceLineRef.current) {
      currentPriceLineRef.current = series.createPriceLine({
        price: acceptedPrice,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: 'Current',
      });
      return;
    }
    currentPriceLineRef.current.applyOptions({
      price: acceptedPrice,
      color,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: 'Current',
    });
  }, [acceptedPrice, bars]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || disposedRef.current) return;
    supportResistanceLinesRef.current.forEach((line) => {
      try { series.removePriceLine(line); } catch { /* chart may be tearing down */ }
    });
    supportResistanceLinesRef.current = [];
    if (!showSupportResistance || !activeLevels) return;

    const resistanceColors = ['#ff8a80', '#ff5c4d', '#ff3b30'];
    const supportColors = ['#69f0ae', '#2ee08a', '#00c57f'];
    supportResistanceLinesRef.current = [
      ...activeLevels.resistance.map((price, index) => series.createPriceLine({
        price,
        color: resistanceColors[index],
        lineWidth: index === 0 ? 4 : 3,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `R${index + 1} แนวต้าน`,
      })),
      ...activeLevels.support.map((price, index) => series.createPriceLine({
        price,
        color: supportColors[index],
        lineWidth: index === 0 ? 4 : 3,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `S${index + 1} แนวรับ`,
      })),
    ];
  }, [activeLevels, showSupportResistance]);

  const resetChartView = () => {
    const priceChart = priceChartRef.current;
    const volumeChart = volumeChartRef.current;
    if (!priceChart || !volumeChart || disposedRef.current) return;
    priceChart.priceScale('right').applyOptions({ autoScale: true });
    priceChart.priceScale('left').applyOptions({ autoScale: true });
    volumeChart.priceScale('right').applyOptions({ autoScale: true });
    priceChart.timeScale().scrollToRealTime();
    volumeChart.timeScale().scrollToRealTime();
  };

  const levelRows = activeLevels ? [
    ...activeLevels.resistance.map((price, index) => ({ label: `R${index + 1}`, price, side: 'resistance' as const })).reverse(),
    ...(acceptedPrice == null ? [] : [{ label: 'Now', price: acceptedPrice, side: 'current' as const }]),
    ...activeLevels.support.map((price, index) => ({ label: `S${index + 1}`, price, side: 'support' as const })),
  ] : [];
  const nearest = activeLevels && acceptedPrice != null
    ? [...activeLevels.resistance, ...activeLevels.support].reduce((best, level) => (
      Math.abs(level - acceptedPrice) < Math.abs(best - acceptedPrice) ? level : best
    ))
    : null;
  const nearestDistance = nearest == null ? null : distancePercent(nearest, acceptedPrice);

  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-[#141722]" data-testid="option-tool-realtime-chart">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#242733] p-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={activeLevels == null}
            aria-pressed={showSupportResistance}
            onClick={() => setSrDataset(showSupportResistance ? null : datasetKey)}
            title={levelsError ?? undefined}
            className={`min-h-11 rounded-md border px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${showSupportResistance ? 'border-[#f0b90b] bg-[#f0b90b]/10 text-[#f0b90b]' : 'border-[#f0b90b] text-[#f0b90b]'}`}
          >
            S/R
          </button>
          <button type="button" onClick={resetChartView} className="min-h-11 rounded-lg border border-sky-400/60 px-3 text-xs text-sky-300">
            ↻ รีเซ็ต
          </button>
        </div>
        <span className="font-mono text-[10px] text-slate-500">
          {symbol} · {interval} · Price + Volume
        </span>
      </div>

      {nearestDistance != null && nearestDistance <= 1.5 && (
        <div role="status" className="border-b border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          ราคาอยู่ใกล้ระดับ {nearest?.toFixed(2)} ({nearestDistance.toFixed(2)}%)
        </div>
      )}

      <div ref={priceContainerRef} className="h-[380px] w-full md:h-[480px]" aria-label="Option tool candlestick chart" />
      <div ref={volumeContainerRef} className="mt-2.5 h-[100px] w-full border-t border-[#242733] md:h-[120px]" aria-label="Option tool volume chart" />

      {showSupportResistance && activeLevels && (
        <div className="border-t border-[#242733] p-3">
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
            <span>Support / Resistance</span>
            <span>{activeLevels.basisInterval} · {new Date(activeLevels.sourceTime * 1_000).toLocaleDateString()}</span>
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
            {levelRows.map((row) => {
              const distance = distancePercent(row.price, acceptedPrice);
              const tone = row.side === 'resistance' ? 'text-rose-300' : row.side === 'support' ? 'text-emerald-300' : 'text-[#D4FF00]';
              return (
                <div key={row.label} className="flex items-center justify-between rounded-md bg-slate-950/40 px-2 py-1.5 text-xs">
                  <b className={tone}>{row.label}</b>
                  <span className="font-mono text-slate-200">${row.price.toFixed(2)}</span>
                  <span className="text-[10px] text-slate-500">{distance == null ? '—' : `${distance.toFixed(2)}%`}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export default OptionToolRealtimeChart;
