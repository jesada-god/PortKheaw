'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { useToast } from '@/src/components/ui/Toast';
import { compatibleSelection, supportedRangesForInterval } from '@/src/lib/market-data/gateway/capabilities';
import type { CandleInterval, HistoricalRange, MarketSessionMode } from '@/src/lib/market-data/gateway/contracts';
import type { AcceptedPriceCandidate, LiveCandle, MarketDataLabel, MarketSelection } from '@/src/lib/stock-detail/market-source';
import type { HistoryResponse } from './history-request';
import { TRADER_TIMEFRAME_PRESETS, traderPresetForInterval } from './trader-chart-presets';

const MarketCandleChartPanel = dynamic(
  () => import('./IntradayChartPanel').then((module) => module.MarketCandleChartPanel),
  { ssr: false, loading: () => <Skeleton className="h-[420px] w-full" /> },
);

export const RANGE_LABELS: Record<HistoricalRange, string> = {
  '1d': '1D', '5d': '5D', '1m': '1M', '3m': '3M', '6m': '6M',
  ytd: 'YTD', '1y': '1Y', '3y': '3Y', '5y': '5Y',
};

interface Props {
  symbol: string;
  active: boolean;
  initialHistory?: HistoryResponse | null;
  currentPrice?: number | null;
  /** Provenance of the accepted price for the decision panel (never REAL-TIME). */
  marketLabel?: MarketDataLabel | null;
  /** Latest accepted candle from the shared market source (single source of truth). */
  liveCandle?: LiveCandle | null;
  /** Whether the shared market source is running (provider configured). */
  liveActive?: boolean;
  /** Trigger one shared-source refresh (header + candle) instead of a history reload. */
  onLiveRefresh?: () => void;
  /** Disable the shared-refresh button while the source is loading or cooling down. */
  liveRefreshDisabled?: boolean;
  /** Report the live-relevant selection (interval/session/adjusted) up so the shared source follows it. */
  onSelectionChange?: (selection: MarketSelection) => void;
  /** Report the chart's newest completed displayed bar up as the header's history-fallback price. */
  onHistoryFallbackChange?: (fallback: AcceptedPriceCandidate | null) => void;
  technicalIndicatorsEnabled: boolean;
  advancedChartTypesEnabled: boolean;
  extendedIndicatorsEnabled: boolean;
  supportResistanceEnabled: boolean;
  fairValueEnabled: boolean;
}

export function ChartPanel({
  symbol,
  active,
  initialHistory: _initialHistory,
  currentPrice,
  marketLabel,
  liveCandle,
  liveActive,
  onLiveRefresh,
  liveRefreshDisabled,
  onSelectionChange,
  onHistoryFallbackChange,
}: Props) {
  const { addToast } = useToast();
  const [interval, setInterval] = useState<CandleInterval>('1D');
  const [range, setRange] = useState<HistoricalRange>('1y');
  const [session, setSession] = useState<MarketSessionMode>('regular');
  const [adjusted, setAdjusted] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const intraday = !['1D', 'Week', 'Month'].includes(interval);

  // Report only the live-relevant dimensions (range is a history scope, not part
  // of the live bucket). The single shared source reconfigures to follow this.
  useEffect(() => {
    onSelectionChange?.({ interval, session, adjusted });
  }, [interval, session, adjusted, onSelectionChange]);

  const applySelection = (nextInterval: CandleInterval, nextRange: HistoricalRange, changedControl: 'interval' | 'range') => {
    const next = compatibleSelection(nextInterval, nextRange, changedControl);
    setInterval(next.interval);
    setRange(next.range);
    setSelectionNotice(next.notice);
    if (next.notice) addToast({ title: 'ปรับช่วงกราฟอัตโนมัติ', message: next.notice, type: 'info' });
    if (!['1D', 'Week', 'Month'].includes(next.interval)) setAdjusted(false);
  };

  const applyTraderTimeframe = (nextInterval: CandleInterval) => {
    const preset = traderPresetForInterval(nextInterval);
    if (!preset) return;
    setInterval(preset.interval);
    setRange(preset.range);
    setSession(preset.session);
    setAdjusted(false);
    setSelectionNotice(null);
  };

  const feedLabel = marketLabel?.realtime
    ? 'LIVE'
    : marketLabel?.mode ?? (liveActive ? 'CONNECTING' : 'OFFLINE');
  const feedTone = marketLabel?.realtime
    ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300'
    : 'border-amber-400/30 bg-amber-400/10 text-amber-200';

  return <div className="space-y-3">
    <section aria-label="Legacy trader chart controls" className="rounded-lg border border-[#242733] bg-[#1c2030] p-2.5" data-testid="legacy-trader-chart-controls">
      <div className="flex min-w-0 gap-1 overflow-x-auto pb-2" role="tablist" aria-label="Candle interval">
        {TRADER_TIMEFRAME_PRESETS.map((preset) => <button key={preset.interval} type="button" role="tab" aria-selected={interval === preset.interval} onClick={() => applyTraderTimeframe(preset.interval)} className={`min-h-11 min-w-12 shrink-0 rounded-md border px-3 font-mono text-xs font-semibold ${interval === preset.interval ? 'border-[#2962ff] bg-[#2962ff] text-white' : 'border-[#434651] bg-[#2a2e39] text-slate-200 hover:border-slate-500'}`}>{preset.label}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2">
        <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold tracking-wide ${feedTone}`} data-testid="chart-feed-status">{feedLabel}</span>
        {intraday && <select aria-label="Market session" value={session} onChange={(event) => setSession(event.target.value as MarketSessionMode)} className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200"><option value="extended">Pre + Regular + Post</option><option value="regular">Regular only</option></select>}
        {!intraday && <button type="button" aria-pressed={adjusted} onClick={() => setAdjusted((value) => !value)} className="min-h-11 rounded-lg border border-slate-700 px-3 text-xs text-slate-300">{adjusted ? 'Adjusted' : 'Unadjusted'}</button>}
        <label className="flex min-h-11 items-center gap-2 text-xs text-slate-400">History
          <select aria-label="Historical range" value={range} onChange={(event) => applySelection(interval, event.target.value as HistoricalRange, 'range')} className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200">
            {supportedRangesForInterval(interval).map((value) => <option key={value} value={value}>{RANGE_LABELS[value]}</option>)}
          </select>
        </label>
        <span className="ml-auto text-xs text-slate-500">{RANGE_LABELS[range]} · {interval} · {session === 'extended' ? 'EXT' : 'REG'}</span>
      </div>
    </section>
    {selectionNotice && <p role="status" className="text-xs text-amber-300">{selectionNotice}</p>}

    <MarketCandleChartPanel symbol={symbol} active={active} interval={interval} range={range} session={session} adjusted={adjusted} currentPrice={currentPrice} marketLabel={marketLabel} liveCandle={liveCandle} liveActive={liveActive} onLiveRefresh={onLiveRefresh} liveRefreshDisabled={liveRefreshDisabled} onHistoryFallbackChange={onHistoryFallbackChange} />
  </div>;
}
