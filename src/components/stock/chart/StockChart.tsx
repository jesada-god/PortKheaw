'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Time, UTCTimestamp } from 'lightweight-charts';
import type { TechnicalAnalysis, TechnicalIndicatorId } from '@/src/lib/analytics/technical/types';
import type { AdvancedChartType } from '@/src/lib/analytics/chart-types/types';
import type { SupportResistanceResult } from '@/src/lib/analytics/support-resistance/types';
import type { VolumeProfileResult } from '@/src/lib/analytics/volume-profile/types';
import type { FibonacciResult } from '@/src/lib/analytics/fibonacci/types';
import { normalizeOhlcvTimeline, type OhlcvInputBar } from '@/src/lib/analytics/chart-data/timeline';
import { buildSupportResistanceView, summaryRows } from '@/src/lib/analytics/support-resistance/levels';
import {
  buildInstitutionalZones,
  reprojectZoneDistances,
  calculateVisibleRangeVolumeProfile,
  calculateAnchoredVwap,
  buildInstitutionalOverlaySpec,
  readOverlayToggles,
  writeOverlayToggles,
  readAnchor,
  writeAnchor,
  type InstitutionalOverlayToggles,
  type StoredAnchor,
  type AvwapAnchorPreset,
  type InstitutionalZonesResult,
} from '@/src/lib/analytics/institutional-sr';
import {
  buildOptionsSrOverlay,
  readOptionsSrToggle,
  writeOptionsSrToggle,
} from '@/src/lib/analytics/options-sr';
import { adaptChartBars } from './chart-data-adapter';
import { ChartControls, type InstitutionalControls, type OptionsSrControls } from './chart-controls';
import { DecisionPanel } from './DecisionPanel';
import type { AtrEtaInput } from '@/src/lib/analytics/decision-panel';
import type { MarketDataLabel } from '@/src/lib/stock-detail/market-source';
import { useOptionsSupportResistance } from './useOptionsSupportResistance';
import { currentQuotePriceLine, supportResistancePriceLines } from './chart-overlays';
import {
  isDailyReferenceInterval,
  resolveAvwapAnchor,
  sliceVisibleBars,
  toAvwapCandles,
  toVrvpCandles,
  toZoneCandles,
} from './institutional-overlays';
import type { ChartActions, ChartIndicatorLine, ChartTooltipContext } from './chart-types';
import { ChartAttribution } from './ChartAttribution';
import { LightweightChartHost, type VisibleLogicalRange } from './LightweightChartHost';
import { useFinalizedTimeline } from './use-finalized-timeline';

/** localStorage is unavailable in SSR and can throw in privacy modes; degrade to undefined. */
function safeStorage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

const INDICATOR_COLORS: Partial<Record<TechnicalIndicatorId, string>> = {
  sma: '#38bdf8', sma50: '#0ea5e9', sma100: '#6366f1', sma200: '#8b5cf6',
  ema: '#f59e0b', ema50: '#fb923c', ema100: '#f97316', ema200: '#ef4444',
  bollinger: '#a78bfa', rsi: '#2dd4bf', macd: '#fb7185', atr: '#facc15',
  stochastic: '#22d3ee', adx: '#e879f9', obv: '#34d399', ichimoku: '#f472b6', roc: '#c084fc', vwap: '#fde047',
};
const PRICE_OVERLAYS = new Set<TechnicalIndicatorId>(['sma', 'sma50', 'sma100', 'sma200', 'ema', 'ema50', 'ema100', 'ema200', 'bollinger', 'ichimoku', 'vwap']);

function indicatorSeries(technical: TechnicalAnalysis | undefined, enabled: readonly TechnicalIndicatorId[]): ChartIndicatorLine[] {
  if (technical?.status !== 'available') return [];
  return enabled.flatMap((id) => {
    const result = technical.indicators[id];
    if (result.status !== 'available') return [];
    const data = result.points.flatMap((point) => {
      if (!Number.isFinite(point.value)) return [];
      const parsed = new Date(point.date);
      if (Number.isNaN(parsed.valueOf())) return [];
      return [{ time: Math.floor(parsed.valueOf() / 1_000) as UTCTimestamp as Time, value: point.value }];
    });
    return [{ id, label: id.toUpperCase(), color: INDICATOR_COLORS[id] ?? '#94a3b8', pane: PRICE_OVERLAYS.has(id) ? 0 : 2, data }];
  });
}

export interface StockChartProps {
  prices: readonly OhlcvInputBar[];
  symbol?: string;
  /** Selected candle interval; institutional D1 zones only build on the daily ('1D') interval. */
  interval?: string;
  technical?: TechnicalAnalysis;
  enabledIndicators?: TechnicalIndicatorId[];
  chartType?: AdvancedChartType;
  supportResistance?: SupportResistanceResult;
  volumeProfile?: VolumeProfileResult;
  fibonacci?: FibonacciResult;
  showVolume?: boolean;
  onToggleVolume?: () => void;
  showVpvr?: boolean;
  showFibonacci?: boolean;
  currentPrice?: number | null;
  /** Provenance of the accepted price (mode/provider/timestamp/delay) for the decision panel. */
  marketLabel?: MarketDataLabel | null;
  datasetKey?: string;
  tooltipContext?: ChartTooltipContext;
}

export function StockChart({
  prices,
  symbol = 'chart',
  interval,
  technical,
  enabledIndicators = [],
  chartType = 'candlestick',
  supportResistance,
  volumeProfile,
  fibonacci,
  showVolume = true,
  onToggleVolume,
  showVpvr = false,
  showFibonacci = false,
  currentPrice,
  marketLabel,
  datasetKey,
  tooltipContext = {},
}: StockChartProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showSr, setShowSr] = useState(false);
  const [actions, setActions] = useState<ChartActions | null>(null);
  const onActions = useCallback((next: ChartActions | null) => setActions(next), []);
  const normalized = useMemo(() => normalizeOhlcvTimeline(prices), [prices]);
  const bars = useMemo(() => adaptChartBars(prices, chartType), [chartType, prices]);
  // Finalized view of the timeline: identity changes only on finalize/append or an
  // official-bar reconciliation, never on an intra-bar tick. Heavy chart analytics
  // (S/R, institutional zones, VRVP, anchored VWAP) key off this so a live trade
  // that only reshapes the current bar retains the last analysis. The drawn series
  // (`bars`) and the live price line still use the live `normalized`/`prices`.
  const analysisBars = useFinalizedTimeline(normalized, (bar) => bar.time);
  const srView = useMemo(() => buildSupportResistanceView(analysisBars, supportResistance), [analysisBars, supportResistance]);
  const indicators = useMemo(() => indicatorSeries(technical, enabledIndicators), [enabledIndicators, technical]);
  const priceLines = useMemo(() => {
    const lines = [...currentQuotePriceLine(currentPrice ?? normalized.at(-1)?.close)];
    if (showSr && srView.status === 'available') lines.push(...supportResistancePriceLines(srView.levels));
    if (showFibonacci && fibonacci?.status === 'available') {
      lines.push(...fibonacci.levels.map((level) => ({ id: `fib-${level.ratio}`, price: level.price, title: `Fib ${level.ratio}`, color: '#c084fc', lineStyle: 2 })));
    }
    if (showVpvr && volumeProfile?.status === 'available') {
      lines.push(
        { id: 'vpvr-poc', price: (volumeProfile.poc.priceLow + volumeProfile.poc.priceHigh) / 2, title: 'POC', color: '#D4FF00', lineStyle: 2 },
        { id: 'vpvr-vah', price: volumeProfile.vah, title: 'VAH', color: '#94a3b8', lineStyle: 2 },
        { id: 'vpvr-val', price: volumeProfile.val, title: 'VAL', color: '#94a3b8', lineStyle: 2 },
      );
    }
    return lines;
  }, [currentPrice, fibonacci, normalized, showFibonacci, showSr, showVpvr, srView, volumeProfile]);
  const stableDatasetKey = datasetKey ?? `${symbol}:${bars[0]?.time ?? ''}:${bars.length}`;

  // ── Institutional overlays (Phase C.1) ──────────────────────────────────────
  // Toggles and the AVWAP anchor are locally persisted and never trigger a market
  // request; every overlay is derived from the already-loaded candles. A viewport
  // change only re-slices those candles for the VRVP/AVWAP.
  const storage = safeStorage();
  const daily = isDailyReferenceInterval(interval);
  const [toggles, setToggles] = useState<InstitutionalOverlayToggles>(() => readOverlayToggles(storage));
  const [visibleRange, setVisibleRange] = useState<VisibleLogicalRange | null>(null);
  // The persisted anchor is scoped by symbol+interval. When the scope changes we
  // re-read it *during render* (React's sanctioned reset-on-prop-change pattern) so
  // an anchor stored for another symbol/interval is rejected by the store rather than
  // reused, and the reset never lags a frame behind an effect.
  const anchorScope = `${symbol}::${interval ?? ''}`;
  const [anchorState, setAnchorState] = useState(() => ({ scope: anchorScope, anchor: readAnchor(storage, symbol, interval ?? '') }));
  let anchor = anchorState.anchor;
  if (anchorState.scope !== anchorScope) {
    anchor = readAnchor(storage, symbol, interval ?? '');
    setAnchorState({ scope: anchorScope, anchor });
  }
  const onVisibleRangeChange = useCallback((range: VisibleLogicalRange | null) => setVisibleRange(range), []);
  const toggleOverlay = useCallback((key: keyof InstitutionalOverlayToggles) => {
    setToggles((previous) => {
      const next = { ...previous, [key]: !previous[key] };
      writeOverlayToggles(storage, next);
      return next;
    });
  }, [storage]);
  const anchorPreset: AvwapAnchorPreset = anchor && typeof anchor.anchor === 'string' ? anchor.anchor : 'earliest-visible';
  const onAnchorPresetChange = useCallback((preset: AvwapAnchorPreset) => {
    const record: StoredAnchor = { symbol, interval: interval ?? '', anchor: preset, source: preset };
    writeAnchor(storage, record);
    setAnchorState({ scope: `${symbol}::${interval ?? ''}`, anchor: record });
  }, [storage, symbol, interval]);

  // D1 zones: built once from completed daily candles (reference price = the last
  // daily close), then only re-projected for distance against the live price — a
  // live tick moves distancePercent but never rebuilds the completed-D1 geometry.
  // Computed whenever the interval is daily (independent of the overlay-draw
  // toggle) so the decision panel always has the references; the chart overlay
  // still draws only when `toggles.zones` is on.
  const lastIsPartial = Boolean((prices.at(-1) as { partial?: boolean } | undefined)?.partial);
  const zoneCandles = useMemo(
    () => (daily ? toZoneCandles(analysisBars, lastIsPartial) : []),
    [daily, analysisBars, lastIsPartial],
  );
  const dailyReferencePrice = zoneCandles.at(-1)?.close ?? null;
  const builtZones = useMemo<InstitutionalZonesResult | null>(() => {
    if (!daily || zoneCandles.length === 0 || dailyReferencePrice == null) return null;
    return buildInstitutionalZones(zoneCandles, dailyReferencePrice);
  }, [daily, zoneCandles, dailyReferencePrice]);
  const zonesForRender = useMemo(() => {
    if (!builtZones || builtZones.status !== 'available') return [];
    const price = currentPrice ?? dailyReferencePrice ?? undefined;
    return typeof price === 'number' ? reprojectZoneDistances(builtZones.zones, price) : builtZones.zones;
  }, [builtZones, currentPrice, dailyReferencePrice]);

  // VRVP + AVWAP are computed from the visible slice of the loaded candles only,
  // always (the decision panel consumes them); the overlay still draws only when
  // the respective toggle is on. A viewport change re-slices — never a refetch.
  const visibleVrvp = useMemo(() => sliceVisibleBars(toVrvpCandles(analysisBars), visibleRange), [analysisBars, visibleRange]);
  const visibleVolumeProfile = useMemo(
    () => calculateVisibleRangeVolumeProfile(visibleVrvp),
    [visibleVrvp],
  );
  const visibleAvwap = useMemo(() => sliceVisibleBars(toAvwapCandles(analysisBars), visibleRange), [analysisBars, visibleRange]);
  const anchoredVwap = useMemo(() => {
    const resolved = resolveAvwapAnchor(visibleAvwap, anchor);
    return resolved ? calculateAnchoredVwap(visibleAvwap, resolved) : undefined;
  }, [visibleAvwap, anchor]);

  // ── Options-Driven S/R (Phase C.2) ──────────────────────────────────────────
  // An independent toggle that lazily loads real options open interest and paints
  // Call Wall / Put Wall / Max Pain lines. It is orthogonal to the D1 zones above:
  // switching expirations repaints only these lines and never rebuilds a zone.
  const optionsRealTicker = symbol.trim().length > 0 && symbol !== 'chart';
  const [optionsEnabled, setOptionsEnabled] = useState(() => readOptionsSrToggle(storage).enabled);
  const acceptedPriceForOptions = currentPrice ?? normalized.at(-1)?.close ?? null;
  const optionsSr = useOptionsSupportResistance({
    symbol,
    acceptedPrice: acceptedPriceForOptions,
    enabled: optionsEnabled && optionsRealTicker,
    active: true,
  });
  const toggleOptions = useCallback(() => {
    setOptionsEnabled((previous) => {
      const next = !previous;
      writeOptionsSrToggle(storage, { enabled: next });
      return next;
    });
  }, [storage]);
  const optionsOverlay = useMemo(
    () => buildOptionsSrOverlay(optionsSr.result, optionsEnabled && optionsRealTicker),
    [optionsSr.result, optionsEnabled, optionsRealTicker],
  );

  const overlaySpec = useMemo(() => {
    const base = buildInstitutionalOverlaySpec({
      zones: zonesForRender,
      showZones: daily && toggles.zones,
      profile: visibleVolumeProfile,
      showVolumeProfile: toggles.volumeProfile,
      avwap: anchoredVwap,
      showAnchoredVwap: toggles.anchoredVwap,
    });
    return {
      bands: [...base.bands, ...optionsOverlay.bands],
      lines: [...base.lines, ...optionsOverlay.lines],
    };
  }, [zonesForRender, daily, toggles, visibleVolumeProfile, anchoredVwap, optionsOverlay]);

  const optionsControls: OptionsSrControls = {
    available: optionsRealTicker,
    visible: optionsEnabled,
    onToggle: toggleOptions,
    loading: optionsSr.loading,
    expirations: optionsSr.expirations,
    selectedExpiration: optionsSr.selectedExpiration,
    onExpirationChange: optionsSr.setExpiration,
    reliability: optionsSr.result?.status === 'available' ? optionsSr.result.reliability : null,
    dataMode: optionsSr.result?.status === 'available' ? optionsSr.result.dataMode : optionsSr.result?.dataMode ?? null,
    statusReason: optionsSr.result?.status === 'unavailable' ? optionsSr.result.reason : null,
  };
  const institutional: InstitutionalControls = {
    zonesAvailable: daily,
    zonesVisible: toggles.zones,
    onToggleZones: () => toggleOverlay('zones'),
    volumeProfileVisible: toggles.volumeProfile,
    onToggleVolumeProfile: () => toggleOverlay('volumeProfile'),
    anchoredVwapVisible: toggles.anchoredVwap,
    onToggleAnchoredVwap: () => toggleOverlay('anchoredVwap'),
    anchorPreset,
    onAnchorPresetChange,
  };

  // ── Decision panel (Phase D) ────────────────────────────────────────────────
  // The ETA ATR method needs a *confirmed 1-hour* ATR; it is only supplied when
  // the chart is on the 1h interval and that ATR is genuinely available — no other
  // timeframe's ATR is substituted, so the ETA is truthful (unavailable otherwise).
  const atrForEta = useMemo<AtrEtaInput | null>(() => {
    if (interval !== '1h' || technical?.status !== 'available') return null;
    const atr = technical.indicators.atr;
    if (atr.status !== 'available' || !Number.isFinite(atr.latest.value) || atr.latest.value <= 0) return null;
    return { value: atr.latest.value, barMinutes: 60, timeframe: '1h' };
  }, [interval, technical]);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  const toggleFullscreen = async () => {
    if (document.fullscreenElement === rootRef.current) await document.exitFullscreen();
    else if (rootRef.current?.requestFullscreen) await rootRef.current.requestFullscreen();
  };

  if (bars.length < 2) return <div className="flex min-h-[20rem] items-center justify-center rounded-xl border border-amber-500/20 p-5 text-center text-sm text-amber-200">{bars.length === 1 ? 'ช่วงที่เลือกมีข้อมูลจริงเพียง 1 แท่ง กรุณาเลือกช่วงที่ยาวขึ้น' : 'ไม่มี OHLCV ที่ผ่าน validation สำหรับช่วงนี้'}</div>;

  return <div ref={rootRef} className={fullscreen ? 'fixed inset-0 z-50 overflow-y-auto bg-[#0A0E17] p-3' : 'relative'}>
    <ChartControls volumeVisible={showVolume} onToggleVolume={onToggleVolume} supportResistanceAvailable={supportResistance !== undefined} supportResistanceVisible={showSr} onToggleSupportResistance={() => setShowSr((value) => !value)} institutional={institutional} optionsSr={optionsControls} fullscreen={fullscreen} onToggleFullscreen={() => void toggleFullscreen()} actions={actions}/>
    <LightweightChartHost bars={bars} chartType={chartType} volumeVisible={showVolume} priceLines={priceLines} indicatorLines={indicators} datasetKey={stableDatasetKey} tooltipContext={tooltipContext} overlaySpec={overlaySpec} onVisibleRangeChange={onVisibleRangeChange} onActions={onActions}/>
    {/* The chart library's licence notice and link. Unconditional: the plot no
        longer carries the built-in mark, so this footer is what satisfies it. */}
    <ChartAttribution className="mt-2"/>
    {chartType === 'heikin-ashi' && <p className="mt-2 text-xs text-amber-300">Heikin Ashi เปลี่ยนเฉพาะ OHLC; Volume, indicators และ S/R ใช้ canonical raw OHLCV เดิม</p>}
    {/* Single source of truth for options-derived levels: the DecisionPanel renders
        Call Wall / Put Wall / Max Pain as reference cards (with the disclosure in its
        options footer). The former standalone options summary duplicated those levels
        and was removed; the toggle/expiration selector (ChartControls) and the
        unavailable/rate-limited state (DecisionPanel footer) are unaffected. */}
    <DecisionPanel acceptedPrice={acceptedPriceForOptions} marketLabel={marketLabel} zones={zonesForRender} volumeProfile={visibleVolumeProfile} anchoredVwap={anchoredVwap} optionsResult={optionsSr.result} optionsEnabled={optionsEnabled && optionsRealTicker} optionsLoading={optionsSr.loading} atr={atrForEta}/>
    {showSr && <section aria-label="Support and resistance summary" className="mt-3 rounded-xl border border-slate-800 bg-[#151B28]/70 p-3 text-xs text-slate-300">{srView.status === 'available' ? summaryRows(srView).map((row) => <div key={'current' in row ? 'current' : row.id} className="flex min-h-10 items-center justify-between border-b border-slate-800 last:border-0"><b>{'current' in row ? 'Now' : row.label}</b><span>${row.price.toFixed(2)}</span></div>) : <p>{srView.reason}</p>}</section>}
  </div>;
}

export default StockChart;

