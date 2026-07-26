'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UTCTimestamp } from 'lightweight-charts';
import type { CandleInterval, CandleRange } from '@/src/lib/market-data/candles/contracts';
import {
  normalizeCanonicalBars,
  finalizedBars,
  type CanonicalBar,
  type CanonicalBarInput,
  type DisplayBar,
} from '@/src/lib/analytics/canonical-bars';
import {
  MACD_FAST,
  MACD_SIGNAL,
  MACD_SLOW,
  RSI_PERIOD,
  emaSeries,
  macdSeries,
  rsiSeries,
} from '@/src/lib/analytics/chart-indicators';
import { calculateLevelStatistics } from '@/src/lib/analytics/level-statistics';
import {
  calculateVisibleRangeVolumeProfile,
  type VisibleRangeVolumeProfile,
  type VrvpInputCandle,
} from '@/src/lib/analytics/institutional-sr/visible-range-profile';
import { buildInstitutionalOverlaySpec } from '@/src/lib/analytics/institutional-sr/overlay-spec';
import { buildOptionsSrOverlay } from '@/src/lib/analytics/options-sr';
import type { ChartPreferences } from '@/src/lib/analytics/timeframe';
import { intervalOption, rangeOption } from '@/src/lib/analytics/timeframe';
import type { PriceAdjustmentMeta } from '@/src/lib/analytics/price-adjustment';
import { MarketTracer } from '@/src/lib/market-data/realtime';
import { mergeLiveCandleIntoBars } from '../../live-candle-bridge';
import type { CanonicalLiveUpdateSink } from '../../useMarketSource';
import { optionToolPivotLevelsSchema, type OptionToolPivotLevels } from '../../option-tool-chart/pivot-levels';
import { useOptionsSupportResistance } from '../useOptionsSupportResistance';
import { ChartToolbar, type ToolbarToggleKey } from './ChartToolbar';
import { TechnicalChartHost, type ChartPriceLineSpec, type EmaLineSpec, type VisibleLogicalRange } from './TechnicalChartHost';
import { SupportResistancePanel, volumeProfileConfirmation, type SupportResistanceRow } from './SupportResistancePanel';
import { assembleLevelRows, nearestLevel, toLevelInputs } from './level-rows';

const chartTracer = new MarketTracer();

const EMA_STYLES = [
  { key: 'ema20', period: 20, color: '#f59e0b', label: 'EMA 20' },
  { key: 'ema50', period: 50, color: '#38bdf8', label: 'EMA 50' },
  { key: 'ema100', period: 100, color: '#a78bfa', label: 'EMA 100' },
  { key: 'ema200', period: 200, color: '#f472b6', label: 'EMA 200' },
] as const;

interface LevelState {
  key: string;
  levels: OptionToolPivotLevels | null;
  error: string | null;
}

export interface TechnicalAnalysisChartProps {
  symbol: string;
  interval: CandleInterval;
  range: CandleRange;
  prices: readonly CanonicalBarInput[];
  datasetKey: string;
  currentPrice?: number | null;
  /** Human-readable provenance of the accepted price, shown on the S/R panel. */
  priceProvenance?: string | null;
  priceAdjustment: PriceAdjustmentMeta;
  currency: string;
  preferences: ChartPreferences;
  onSelectInterval(interval: CandleInterval): void;
  onSelectRange(range: CandleRange): void;
  onToggleFavoriteInterval(interval: CandleInterval): void;
  onToggleFavoriteRange(range: CandleRange): void;
  onChartType(type: ChartPreferences['chartType']): void;
  onToggle(key: ToolbarToggleKey): void;
  liveUpdateSinkRef?: { current: CanonicalLiveUpdateSink | null };
}

function toVrvpCandles(bars: readonly CanonicalBar[]): VrvpInputCandle[] {
  return bars.map((bar) => ({
    date: new Date(bar.time * 1_000).toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
}

function sliceVisible(bars: readonly CanonicalBar[], range: VisibleLogicalRange | null): CanonicalBar[] {
  if (!range || !bars.length) return [...bars];
  const from = Math.max(0, Math.floor(range.from));
  const to = Math.min(bars.length - 1, Math.ceil(range.to));
  return from <= to ? bars.slice(from, to + 1) : [...bars];
}

/**
 * Stock Detail → Chart: the technical analysis surface.
 *
 * One canonical bar array feeds every consumer here — the drawn candles, the
 * volume histogram, EMA/RSI/MACD, the visible-range volume profile and the S/R
 * touch/hold/break statistics. Every toggle on the toolbar is a pure
 * re-derivation of those bars, so nothing but a genuine interval/range change
 * ever reaches the network.
 */
export function TechnicalAnalysisChart({
  symbol,
  interval,
  range,
  prices,
  datasetKey,
  currentPrice,
  priceProvenance,
  priceAdjustment,
  currency,
  preferences,
  onSelectInterval,
  onSelectRange,
  onToggleFavoriteInterval,
  onToggleFavoriteRange,
  onChartType,
  onToggle,
  liveUpdateSinkRef,
}: TechnicalAnalysisChartProps) {
  const [visibleRange, setVisibleRange] = useState<VisibleLogicalRange | null>(null);
  const [tooltipBar, setTooltipBar] = useState<DisplayBar | null>(null);
  const [levelState, setLevelState] = useState<LevelState>({ key: '', levels: null, error: null });
  const [actions, setActions] = useState<{ reset: () => void; fit: () => void } | null>(null);
  // The live sink folds ticks into a bar array the React tree also owns, so the
  // component keeps its own live copy rather than mutating props. The copy is
  // tagged with the dataset it belongs to: a selection change makes the previous
  // dataset's live bars simply stop matching, with no reset effect needed.
  const [live, setLive] = useState<{ key: string; bars: CanonicalBar[] } | null>(null);

  // ── Canonical OHLCV: the single source of truth ────────────────────────────
  const historyBars = useMemo(() => normalizeCanonicalBars(prices), [prices]);
  const bars = live?.key === datasetKey ? live.bars : historyBars;
  const analysisBars = useMemo(() => finalizedBars(bars), [bars]);

  const acceptedPrice = currentPrice != null && Number.isFinite(currentPrice)
    ? currentPrice
    : bars.at(-1)?.close ?? null;

  // ── Indicators: memoized on the dataset + settings only ────────────────────
  const emaLines = useMemo<EmaLineSpec[]>(() => EMA_STYLES.flatMap((style) => {
    if (!preferences[style.key]) return [];
    const series = emaSeries(bars, style.period);
    if (series.status !== 'available') return [];
    return [{ id: style.key, label: style.label, color: style.color, points: series.points }];
  }), [bars, preferences]);

  const rsi = useMemo(() => {
    if (!preferences.rsi) return null;
    const series = rsiSeries(bars, RSI_PERIOD);
    return series.status === 'available' ? { points: series.points } : null;
  }, [bars, preferences.rsi]);
  const rsiUnavailable = useMemo(() => {
    if (!preferences.rsi) return null;
    const series = rsiSeries(bars, RSI_PERIOD);
    return series.status === 'unavailable' ? series.reason : null;
  }, [bars, preferences.rsi]);

  const macd = useMemo(() => {
    if (!preferences.macd) return null;
    const series = macdSeries(bars, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
    return series.status === 'available' ? { points: series.points } : null;
  }, [bars, preferences.macd]);
  const macdUnavailable = useMemo(() => {
    if (!preferences.macd) return null;
    const series = macdSeries(bars, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
    return series.status === 'unavailable' ? series.reason : null;
  }, [bars, preferences.macd]);

  // ── VPVR: visible slice of the already-loaded candles, never a fetch ────────
  const visibleProfile = useMemo<VisibleRangeVolumeProfile>(
    () => calculateVisibleRangeVolumeProfile(toVrvpCandles(sliceVisible(analysisBars, visibleRange))),
    [analysisBars, visibleRange],
  );

  // ── S/R levels (existing classic-pivot engine) ─────────────────────────────
  const levelKey = `${symbol}:${interval}`;
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    // Strict Mode runs setup/cleanup/setup once in development; deferring one
    // microtask lets the throwaway setup abort before any request is made.
    queueMicrotask(() => {
      if (cancelled) return;
      void (async () => {
        try {
          const query = new URLSearchParams({ symbol, timeframe: interval });
          const response = await fetch(`/api/market/chart-levels?${query.toString()}`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          const payload = await response.json() as { data: unknown; error?: { message?: string } };
          if (!response.ok) throw new Error(payload.error?.message ?? 'ยังไม่มีข้อมูลแนวรับ–แนวต้านสำหรับช่วงนี้');
          const parsed = optionToolPivotLevelsSchema.safeParse(payload.data);
          if (!parsed.success) throw new Error('ข้อมูลแนวรับ–แนวต้านไม่ผ่านการตรวจสอบ');
          if (!controller.signal.aborted) setLevelState({ key: levelKey, levels: parsed.data, error: null });
        } catch (cause) {
          if (controller.signal.aborted) return;
          setLevelState({
            key: levelKey,
            levels: null,
            error: cause instanceof Error ? cause.message : 'ยังไม่มีข้อมูลแนวรับ–แนวต้าน',
          });
        }
      })();
    });
    return () => { cancelled = true; controller.abort(); };
  }, [levelKey, symbol, interval]);

  const activeLevels = levelState.key === levelKey ? levelState.levels : null;
  const levelsError = levelState.key === levelKey ? levelState.error : null;

  // ── Touch / Hold / Break over the displayed canonical bars ─────────────────
  const statistics = useMemo(() => {
    if (!activeLevels) return null;
    return calculateLevelStatistics(analysisBars, toLevelInputs(activeLevels));
  }, [activeLevels, analysisBars]);

  const srRows = useMemo<SupportResistanceRow[]>(() => {
    if (!activeLevels) return [];
    return assembleLevelRows(activeLevels, statistics?.levels ?? [], acceptedPrice).map((row) => ({
      ...row,
      // VPVR is a confirmation layer only — it never changes a level's price.
      confirmation: preferences.vpvr ? volumeProfileConfirmation(visibleProfile, row.price) : null,
    }));
  }, [activeLevels, statistics, acceptedPrice, preferences.vpvr, visibleProfile]);
  const nearest = useMemo(() => nearestLevel(srRows, acceptedPrice), [srRows, acceptedPrice]);

  // ── Options-driven levels (real open interest only) ────────────────────────
  const optionsTicker = symbol.trim().length > 0;
  const optionsSr = useOptionsSupportResistance({
    symbol,
    acceptedPrice,
    enabled: preferences.options && optionsTicker,
    active: true,
  });
  const optionsOverlay = useMemo(
    () => buildOptionsSrOverlay(optionsSr.result, preferences.options && optionsTicker),
    [optionsSr.result, preferences.options, optionsTicker],
  );

  // ── Overlays and price lines ───────────────────────────────────────────────
  const overlaySpec = useMemo(() => {
    const base = buildInstitutionalOverlaySpec({
      showZones: false,
      profile: visibleProfile,
      showVolumeProfile: preferences.vpvr,
      showAnchoredVwap: false,
      showVolumeProfileHistogram: preferences.vpvr,
    });
    return {
      bands: [...base.bands, ...optionsOverlay.bands],
      lines: [...base.lines, ...optionsOverlay.lines],
      ...(base.histogram ? { histogram: base.histogram } : {}),
    };
  }, [visibleProfile, preferences.vpvr, optionsOverlay]);

  const priceLines = useMemo<ChartPriceLineSpec[]>(() => {
    const lines: ChartPriceLineSpec[] = [];
    if (acceptedPrice != null) {
      lines.push({ id: 'current', price: acceptedPrice, color: '#D4FF00', title: 'ราคาปัจจุบัน', dashed: true });
    }
    if (preferences.supportResistance && activeLevels) {
      activeLevels.resistance.forEach((price, index) => lines.push({
        id: `R${index + 1}`, price, color: ['#ff8a80', '#ff5c4d', '#ff3b30'][index], title: `R${index + 1}`, width: index === 0 ? 2 : 1,
      }));
      activeLevels.support.forEach((price, index) => lines.push({
        id: `S${index + 1}`, price, color: ['#69f0ae', '#2ee08a', '#00c57f'][index], title: `S${index + 1}`, width: index === 0 ? 2 : 1,
      }));
    }
    return lines;
  }, [acceptedPrice, preferences.supportResistance, activeLevels]);

  // ── Live tick: candle and volume always move together ──────────────────────
  useEffect(() => {
    if (!liveUpdateSinkRef) return;
    const sink: CanonicalLiveUpdateSink = (update) => {
      const candle = update.candle;
      if (!candle || update.symbol.toUpperCase() !== symbol.toUpperCase()) return;
      setLive((previous) => {
        const current = previous?.key === datasetKey ? previous.bars : historyBars;
        if (!current.length) return previous;
        const bucketInterval = interval === '1D' || interval === 'Week' ? interval : undefined;
        const bridge = current.map((bar) => ({
          date: new Date(bar.time * 1_000).toISOString(),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume ?? 0,
        }));
        const merged = mergeLiveCandleIntoBars(bridge, candle, bucketInterval);
        if (merged === bridge) return previous;
        return {
          key: datasetKey,
          bars: normalizeCanonicalBars(merged.map((bar, index) => ({
            ...bar,
            partial: index === merged.length - 1 ? !update.barFinalized : false,
          }))),
        };
      });
      const chartUpdatedAtMs = Date.now();
      chartTracer.trace({
        stage: 'chart_updated',
        symbol: update.symbol,
        price: update.price ?? candle.close,
        exchangeTimestampMs: update.observation?.exchangeTimestampMs,
        gatewayReceivedAtMs: update.observation?.gatewayReceivedAtMs,
        browserReceivedAtMs: update.observation?.browserReceivedAtMs,
        acceptedAtMs: update.observation?.acceptedAtMs,
        chartUpdatedAtMs,
        latencyMs: update.observation ? chartUpdatedAtMs - update.observation.exchangeTimestampMs : undefined,
      });
    };
    liveUpdateSinkRef.current = sink;
    return () => {
      if (liveUpdateSinkRef.current === sink) liveUpdateSinkRef.current = null;
    };
  }, [datasetKey, historyBars, interval, liveUpdateSinkRef, symbol]);

  const onVisibleRangeChange = useCallback((next: VisibleLogicalRange | null) => setVisibleRange(next), []);
  const onCrosshairBar = useCallback((bar: DisplayBar | null) => setTooltipBar(bar), []);
  const onReady = useCallback((next: { reset: () => void; fit: () => void } | null) => setActions(next), []);

  const heikin = preferences.chartType === 'heikin-ashi';
  const optionsResult = optionsSr.result;

  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-[#141722]" data-testid="technical-analysis-chart">
      <ChartToolbar
        interval={interval}
        range={range}
        preferences={preferences}
        optionsAvailable={optionsTicker}
        onSelectInterval={onSelectInterval}
        onSelectRange={onSelectRange}
        onToggleFavoriteInterval={onToggleFavoriteInterval}
        onToggleFavoriteRange={onToggleFavoriteRange}
        onChartType={onChartType}
        onToggle={onToggle}
        onResetView={() => actions?.reset()}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#242733] px-3 py-1.5 text-[11px] text-slate-500">
        <span className="font-mono text-slate-300">{symbol}</span>
        <span>แท่ง {intervalOption(interval).label}</span>
        <span>ช่วงข้อมูล {rangeOption(range).label}</span>
        <span data-testid="price-adjustment-label">
          ราคา: {priceAdjustment.mode === 'adjusted' ? 'Adjusted' : 'Raw'} · {priceAdjustment.label}
        </span>
        <span>{bars.length.toLocaleString()} แท่ง</span>
      </div>
      {priceAdjustment.downgradeReason && (
        <p className="border-b border-[#242733] px-3 py-1.5 text-[11px] text-amber-300">{priceAdjustment.downgradeReason}</p>
      )}

      <div className="relative">
        <TechnicalChartHost
          bars={bars}
          chartType={preferences.chartType}
          volumeVisible={preferences.volume}
          emaLines={emaLines}
          rsi={rsi}
          macd={macd}
          priceLines={priceLines}
          overlaySpec={overlaySpec}
          datasetKey={datasetKey}
          onVisibleRangeChange={onVisibleRangeChange}
          onCrosshairBar={onCrosshairBar}
          onReady={onReady}
        />
        {tooltipBar && (
          <div className="pointer-events-none absolute left-2 top-2 z-10 rounded-lg border border-slate-700 bg-[#0F1420]/95 px-2.5 py-2 font-mono text-[11px] text-slate-200 shadow-xl" data-testid="chart-tooltip">
            <div className="text-slate-400">{new Date(tooltipBar.time * 1_000).toLocaleString('th-TH')}</div>
            {heikin && <div className="text-amber-300">Heikin-Ashi (ราคาแปลงแล้ว)</div>}
            <div>O {tooltipBar.open.toFixed(2)} · H {tooltipBar.high.toFixed(2)} · L {tooltipBar.low.toFixed(2)} · C {tooltipBar.close.toFixed(2)}</div>
            {heikin && (
              <div className="text-slate-400">
                Raw O {tooltipBar.rawOpen.toFixed(2)} · H {tooltipBar.rawHigh.toFixed(2)} · L {tooltipBar.rawLow.toFixed(2)} · C {tooltipBar.rawClose.toFixed(2)}
              </div>
            )}
            <div className="text-slate-400">
              Vol {tooltipBar.volume == null ? 'ไม่มีข้อมูล' : tooltipBar.volume.toLocaleString()}
            </div>
          </div>
        )}
      </div>

      {(rsiUnavailable || macdUnavailable) && (
        <p className="border-t border-[#242733] px-3 py-1.5 text-[11px] text-amber-300">
          {rsiUnavailable && <span>RSI: {rsiUnavailable} </span>}
          {macdUnavailable && <span>MACD: {macdUnavailable}</span>}
        </p>
      )}

      {preferences.vpvr && (
        <p className="border-t border-[#242733] px-3 py-1.5 text-[11px] text-slate-500" data-testid="vpvr-summary">
          {visibleProfile.status === 'available'
            ? `VPVR (ช่วงที่มองเห็น ${visibleProfile.candleCount} แท่ง): POC ${currency}${visibleProfile.poc.toFixed(2)} · VAH ${currency}${visibleProfile.vah.toFixed(2)} · VAL ${currency}${visibleProfile.val.toFixed(2)}`
            : `VPVR ยังใช้ไม่ได้: ${visibleProfile.reason}`}
        </p>
      )}

      {preferences.options && (
        <div className="border-t border-[#242733] px-3 py-2 text-[11px]" data-testid="options-levels">
          {optionsSr.loading && <p className="text-slate-500">กำลังโหลดข้อมูล Options…</p>}
          {!optionsSr.loading && optionsResult?.status === 'available' && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-300">
              <span>Call Wall: {optionsResult.callWall ? `${currency}${optionsResult.callWall.price.toFixed(2)}` : 'ไม่มีข้อมูล'}</span>
              <span>Put Wall: {optionsResult.putWall ? `${currency}${optionsResult.putWall.price.toFixed(2)}` : 'ไม่มีข้อมูล'}</span>
              <span>Max Pain: {optionsResult.maxPain ? `${currency}${optionsResult.maxPain.price.toFixed(2)}` : 'ไม่มีข้อมูล'}</span>
              <span className="text-slate-500">
                OI รวม C {optionsResult.totalCallOI.toLocaleString()} / P {optionsResult.totalPutOI.toLocaleString()}
                {optionsResult.putCallOIRatio == null ? '' : ` · P/C ${optionsResult.putCallOIRatio.toFixed(2)}`}
              </span>
            </div>
          )}
          {!optionsSr.loading && optionsResult?.status === 'unavailable' && (
            <p className="text-slate-500">Options ยังใช้ไม่ได้: {optionsResult.message}</p>
          )}
          {!optionsSr.loading && !optionsResult && <p className="text-slate-500">ยังไม่มีข้อมูล Options สำหรับสัญลักษณ์นี้</p>}
        </div>
      )}

      <SupportResistancePanel
        rows={srRows}
        acceptedPrice={acceptedPrice}
        priceLabel={priceProvenance ?? null}
        basisLabel={activeLevels?.basisInterval === 'Week' ? 'W1' : 'D1'}
        nearest={nearest}
        statisticsReason={statistics?.status === 'unavailable' ? statistics.reason : null}
        levelsError={levelsError}
        currency={currency}
      />
    </section>
  );
}

export type { UTCTimestamp };
export default TechnicalAnalysisChart;
