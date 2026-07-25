'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import type { HistoricalPrices, MarketDataEnvelope } from '@/src/lib/market-data/types';
import { calculateTechnicalAnalysis } from '@/src/lib/analytics/technical/calculations';
import type { TechnicalIndicatorId } from '@/src/lib/analytics/technical/types';
import type { AdvancedChartType } from '@/src/lib/analytics/chart-types/types';
import { calculateSupportResistance } from '@/src/lib/analytics/support-resistance/calculations';
import { Select } from '@/src/components/ui/Select';
import { useToast } from '@/src/components/ui/Toast';
import { calculateVolumeProfile } from '@/src/lib/analytics/volume-profile/calculations';
import { calculateFibonacci } from '@/src/lib/analytics/fibonacci/calculations';
import { DEFAULT_CHART_LAYERS, parseChartLayers, parseChartType, parseIndicatorIds, type ChartLayerPreferences } from '@/src/lib/analytics/chart-layers/preferences';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { normalizeOhlcvTimeline } from '@/src/lib/analytics/chart-data/timeline';
import { useFinalizedTimeline } from '@/src/components/stock/chart/use-finalized-timeline';
import type { MarketDataLabel } from '@/src/lib/stock-detail/market-source';
import type { ChartTooltipContext } from '@/src/components/stock/chart/chart-types';

const Chart = dynamic(() => import('@/src/components/stock/HistoricalChart'), { ssr: false });
const INDICATOR_STORAGE_KEY = 'nexora:technical-indicators:v2';
const CHART_STORAGE_KEY = 'nexora:advanced-chart-type:v1';
const LAYERS_STORAGE_KEY = 'nexora:chart-layers:v1';

const BASE_INDICATORS: Array<{ id: TechnicalIndicatorId; label: string; category: string }> = [
  { id: 'sma', label: 'SMA 20', category: 'Trend' }, { id: 'ema', label: 'EMA 20', category: 'Trend' },
  { id: 'rsi', label: 'RSI 14 (Wilder)', category: 'Momentum' }, { id: 'macd', label: 'MACD 12/26/9', category: 'Trend' },
  { id: 'bollinger', label: 'Bollinger 20/2', category: 'Volatility' }, { id: 'atr', label: 'ATR 14', category: 'Volatility' },
  { id: 'averageVolume', label: 'Average Volume 20', category: 'Volume' },
];
const EXTENDED_INDICATORS: typeof BASE_INDICATORS = [
  { id: 'sma50', label: 'SMA 50', category: 'Trend' }, { id: 'sma100', label: 'SMA 100', category: 'Trend' }, { id: 'sma200', label: 'SMA 200', category: 'Trend' },
  { id: 'ema50', label: 'EMA 50', category: 'Trend' }, { id: 'ema100', label: 'EMA 100', category: 'Trend' }, { id: 'ema200', label: 'EMA 200', category: 'Trend' },
  { id: 'averageVolume50', label: 'Average Volume 50', category: 'Volume' },
  { id: 'stochastic', label: 'Stochastic 14/3/3', category: 'Momentum' }, { id: 'adx', label: 'ADX / +DI / -DI 14', category: 'Trend' },
  { id: 'obv', label: 'OBV', category: 'Volume' }, { id: 'ichimoku', label: 'Ichimoku 9/26/52', category: 'Trend' },
  { id: 'roc', label: 'ROC 12', category: 'Momentum' }, { id: 'vwap', label: 'Session VWAP', category: 'Volume' },
];
const CHART_TYPES: Array<{ id: AdvancedChartType; label: string }> = [
  { id: 'candlestick', label: 'Candlestick' }, { id: 'heikin-ashi', label: 'Heikin Ashi' },
  { id: 'line', label: 'Line (raw close)' }, { id: 'area', label: 'Area (raw close)' },
  { id: 'ohlc', label: 'OHLC Bar' }, { id: 'hollow-candles', label: 'Hollow Candles' },
];
const PRESETS: Record<string, TechnicalIndicatorId[]> = {
  Trend: ['sma', 'ema', 'ema50', 'macd'], 'Long-term': ['sma50', 'sma200', 'ema200'],
  Momentum: ['rsi', 'stochastic', 'roc'], Volatility: ['bollinger', 'atr'],
};

interface Props {
  history: HistoricalPrices;
  meta: MarketDataEnvelope<HistoricalPrices>['meta'];
  technicalIndicatorsEnabled: boolean;
  advancedChartTypesEnabled: boolean;
  extendedIndicatorsEnabled: boolean;
  supportResistanceEnabled: boolean;
  visibleBarCount: number;
  onRequestMoreHistory?: (minimumDataPoints: number) => void;
  currentPrice?: number | null;
  /** Provenance of the accepted price for the decision panel (never REAL-TIME). */
  marketLabel?: MarketDataLabel | null;
  datasetKey?: string;
  /** Selected candle interval; forwarded so D1 institutional zones only build on '1D'. */
  interval?: string;
  tooltipContext?: ChartTooltipContext;
}

export function TechnicalIndicatorControls({ history, meta, technicalIndicatorsEnabled, advancedChartTypesEnabled, extendedIndicatorsEnabled, supportResistanceEnabled, visibleBarCount, onRequestMoreHistory, currentPrice, marketLabel, datasetKey, interval, tooltipContext }: Props) {
  const indicators = useMemo(() => [...(technicalIndicatorsEnabled ? BASE_INDICATORS : []), ...(extendedIndicatorsEnabled ? EXTENDED_INDICATORS : [])], [extendedIndicatorsEnabled, technicalIndicatorsEnabled]);
  const [enabled, setEnabled] = useState<TechnicalIndicatorId[]>([]);
  const [chartType, setChartType] = useState<AdvancedChartType>(advancedChartTypesEnabled ? 'candlestick' : 'area');
  const [isMobile, setIsMobile] = useState(false);
  const [layers, setLayers] = useState<ChartLayerPreferences>(DEFAULT_CHART_LAYERS);
  const { addToast } = useToast();

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(media.matches);
    queueMicrotask(() => {
      update();
      try {
        const saved = parseIndicatorIds(window.localStorage.getItem(INDICATOR_STORAGE_KEY), indicators.map((item) => item.id));
        setEnabled(saved.slice(0, media.matches ? 3 : indicators.length));
        setLayers(parseChartLayers(window.localStorage.getItem(LAYERS_STORAGE_KEY)));
        if (advancedChartTypesEnabled) {
          setChartType(parseChartType(window.localStorage.getItem(CHART_STORAGE_KEY), 'candlestick'));
        }
      } catch { /* invalid device preferences are ignored */ }
    });
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [advancedChartTypesEnabled, indicators]);

  const context = useMemo(() => ({ symbol: history.symbol, source: meta.provider, freshness: meta.freshness }), [history.symbol, meta.freshness, meta.provider]);
  const canonicalBars = useMemo(() => normalizeOhlcvTimeline(history.prices), [history.prices]);
  const analyticalPrices = useMemo(() => canonicalBars.map((bar) => ({ date: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })), [canonicalBars]);
  // Heavy indicator/S/R/VPVR/Fibonacci calculations run on the FINALIZED timeline
  // only: a live trade that merely reshapes the current forming bar keeps the same
  // reference here, so these memos skip work until a bar finalizes/appends or an
  // official bar reconciles completed data. The drawn series below still receives
  // the live `history.prices`, so the candle keeps moving via series.update().
  const finalizedPrices = useFinalizedTimeline(analyticalPrices, (bar) => bar.date);
  const analysis = useMemo(() => calculateTechnicalAnalysis(finalizedPrices, context), [finalizedPrices, context]);
  const supportResistance = useMemo(() => supportResistanceEnabled ? calculateSupportResistance(finalizedPrices, context) : undefined, [finalizedPrices, context, supportResistanceEnabled]);
  const volumeProfile = useMemo(() => layers.vpvr ? calculateVolumeProfile(finalizedPrices) : undefined, [finalizedPrices, layers.vpvr]);
  const fibonacci = useMemo(() => layers.fibonacci ? calculateFibonacci(finalizedPrices) : undefined, [finalizedPrices, layers.fibonacci]);

  const saveEnabled = (next: TechnicalIndicatorId[]) => {
    setEnabled(next);
    window.localStorage.setItem(INDICATOR_STORAGE_KEY, JSON.stringify(next));
  };
  const toggle = (id: TechnicalIndicatorId) => {
    const next = enabled.includes(id) ? enabled.filter((value) => value !== id) : [...enabled, id];
    if (isMobile && next.length > 3) {
      addToast({ title: 'เปิดได้สูงสุด 3 layers บนมือถือ', message: 'ปิด layer อื่นก่อนแล้วลองอีกครั้ง', type: 'info' });
      return;
    }
    if (!enabled.includes(id) && analysis.status === 'available') {
      const result = analysis.indicators[id];
      if (result.status === 'unavailable') onRequestMoreHistory?.(result.minimumDataPoints);
    }
    saveEnabled(next);
  };
  const applyPreset = (name: string) => {
    const next = (PRESETS[name] ?? []).filter((id) => indicators.some((item) => item.id === id));
    if (isMobile && next.length > 3) {
      addToast({ title: 'Preset นี้เกินขีดจำกัดมือถือ', message: 'เปิดได้พร้อมกันสูงสุด 3 layers', type: 'info' });
      return;
    }
    if (analysis.status === 'available') {
      const required = next.flatMap((id) => {
        const result = analysis.indicators[id];
        return result.status === 'unavailable' ? [result.minimumDataPoints] : [];
      });
      if (required.length) onRequestMoreHistory?.(Math.max(...required));
    }
    saveEnabled(next);
  };
  const selectChartType = (next: AdvancedChartType) => {
    setChartType(next);
    window.localStorage.setItem(CHART_STORAGE_KEY, next);
  };
  const toggleLayer = (id: keyof ChartLayerPreferences) => {
    setLayers((current) => {
      const next = { ...current, [id]: !current[id] };
      window.localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const chartSelect = <Select aria-label="ประเภทกราฟ" value={chartType} onChange={(event) => selectChartType(event.target.value as AdvancedChartType)}>{CHART_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</Select>;
  return <div className="space-y-3">
    {advancedChartTypesEnabled && <div className="hidden items-center justify-end gap-2 md:flex"><span className="text-xs text-slate-500">Chart type</span><div className="w-52">{chartSelect}</div></div>}
    <details className="rounded-xl border border-slate-800 bg-[#151B28] p-3">
      <summary className="cursor-pointer select-none text-sm font-semibold text-white">Chart Settings / Indicators <span className="ml-2 text-xs font-normal text-slate-500">{enabled.length} layers</span></summary>
      {advancedChartTypesEnabled && <div className="mt-3 md:hidden"><label className="mb-1 block text-xs text-slate-400">ประเภทกราฟ</label>{chartSelect}</div>}
      {extendedIndicatorsEnabled && <div className="mt-3 flex flex-wrap gap-2"><span className="self-center text-xs text-slate-500">Presets:</span>{Object.keys(PRESETS).map((name) => <button type="button" key={name} aria-label={`ใช้ ${name} indicator preset`} onClick={() => applyPreset(name)} className="min-h-11 rounded-full border border-slate-700 px-3 text-xs text-slate-300">{name}</button>)}</div>}
      {indicators.length > 0 && <div className="mt-3 space-y-3">{[...new Set(indicators.map((item) => item.category))].map((category) => <fieldset key={category}><legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{category}</legend><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{indicators.filter((item) => item.category === category).map((item) => {
        const result = analysis.status === 'available' ? analysis.indicators[item.id] : null;
        const unavailable = result?.status === 'unavailable';
        const disabled = !enabled.includes(item.id) && isMobile && enabled.length >= 3;
        return <div key={item.id} className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm ${disabled ? 'border-slate-800 text-slate-600' : 'border-slate-700 text-slate-200'}`} title={unavailable ? result.reason : undefined}><label className="flex flex-1 items-center gap-2"><input type="checkbox" checked={enabled.includes(item.id)} disabled={disabled} onChange={() => toggle(item.id)} className="accent-[#D4FF00]"/><span>{item.label}</span>{result?.status === 'available' && <span className="ml-auto font-mono text-[10px] text-slate-500">{result.latest.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}</label>{unavailable && <button type="button" onClick={() => onRequestMoreHistory?.(result.minimumDataPoints)} className="min-h-11 max-w-36 text-right text-[10px] text-amber-400">ต้องการ {result.minimumDataPoints} จุด · โหลดย้อนหลังเพิ่ม</button>}</div>;
      })}</div></fieldset>)}</div>}
      {isMobile && <p className="mt-2 text-xs text-slate-500">บนมือถือเปิดได้สูงสุด 3 layers พร้อมกัน</p>}
      <fieldset className="mt-4 border-t border-slate-800 pt-3"><legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Chart layers</legend><div className="mt-2 flex flex-wrap gap-2">{([['volume', 'Volume'], ['vpvr', 'VPVR'], ['fibonacci', 'Fibonacci']] as const).map(([id, label]) => <button key={id} type="button" aria-label={`${layers[id] ? 'ปิด' : 'เปิด'} ${label}`} aria-pressed={layers[id]} onClick={() => toggleLayer(id)} className={`min-h-11 rounded-lg border px-3 text-xs ${layers[id] ? 'border-[#D4FF00] text-[#D4FF00]' : 'border-slate-700 text-slate-300'}`}>{label}</button>)}</div>{layers.vpvr && volumeProfile?.status === 'unavailable' && <p className="mt-2 text-xs text-amber-300">VPVR unavailable: {volumeProfile.reason}</p>}{layers.fibonacci && fibonacci?.status === 'unavailable' && <p className="mt-2 text-xs text-amber-300">Fibonacci unavailable: {fibonacci.reason}</p>}<p className="mt-2 text-xs text-slate-500">ทุก layer คำนวณจาก history.prices ชุดเดิม การเปิด/ปิดไม่เรียก provider และไม่เปลี่ยน timeframe</p></fieldset>
      <details className="mt-3 border-t border-slate-800 pt-3 text-xs text-slate-400"><summary className="cursor-pointer text-slate-300">รายละเอียดวิธีคำนวณและแหล่งข้อมูล</summary><dl className="mt-2 grid gap-1 sm:grid-cols-2"><div>Symbol: <span className="text-slate-200">{analysis.symbol}</span></div><div>Source: <span className="text-slate-200">{analysis.dataSource ?? 'unavailable'}</span></div><div>Data points: <span className="text-slate-200">{analysis.dataPoints}</span></div><div>Latest data: <span className="text-slate-200">{analysis.latestDataAt ?? 'unavailable'}</span></div><div>Calculated: <span className="text-slate-200">{formatBangkokDateTime(analysis.calculatedAt)}</span></div><div>Freshness: <span className="text-slate-200">{analysis.freshness.status}</span></div><div className="sm:col-span-2">Method: <span className="text-slate-200">{analysis.methodology}; raw OHLCV, close field</span></div></dl><ul className="mt-2 list-disc space-y-1 pl-4">{analysis.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul><p className="mt-2 text-amber-300">ค่าทั้งหมดคำนวณจากข้อมูลย้อนหลัง ไม่ใช่คำแนะนำหรือการรับประกันผลตอบแทน</p></details>
    </details>
    {chartType === 'heikin-ashi' && <p role="note" className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">Heikin Ashi เป็นค่าที่แปลงจาก OHLC ไม่ใช่ราคาซื้อขายจริง</p>}
    <Chart symbol={history.symbol} prices={history.prices} interval={interval} visibleBarCount={visibleBarCount} technical={analysis} enabledIndicators={enabled} chartType={chartType} supportResistance={supportResistance} volumeProfile={volumeProfile} fibonacci={fibonacci} showVolume={layers.volume} onToggleVolume={() => toggleLayer('volume')} showVpvr={layers.vpvr} showFibonacci={layers.fibonacci} currentPrice={currentPrice} marketLabel={marketLabel} datasetKey={datasetKey} tooltipContext={tooltipContext}/>
  </div>;
}
