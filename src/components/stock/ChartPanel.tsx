'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { useToast } from '@/src/components/ui/Toast';
import type { CandleInterval, HistoricalRange, MarketSessionMode } from '@/src/lib/market-data/gateway/contracts';
import type { AcceptedPriceCandidate, LiveCandle, MarketDataLabel, MarketSelection } from '@/src/lib/stock-detail/market-source';
import {
  chartCompatibleSelection as compatibleSelection,
  rangeOption,
  toggleFavoriteInterval,
  toggleFavoriteRange,
  type ChartPreferences,
} from '@/src/lib/analytics/timeframe';
import { isAdjustableInterval } from '@/src/lib/analytics/price-adjustment';
import type { CanonicalLiveUpdateSink } from './useMarketSource';
import type { HistoryResponse } from './history-request';
import { useChartPreferences } from './chart/technical/useChartPreferences';
import type { ToolbarToggleKey } from './chart/technical/ChartToolbar';

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
  liveUpdateSinkRef?: { current: CanonicalLiveUpdateSink | null };
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
  /** Continuous assets have one 24/7 session and no pre/post selector. */
  continuousMarket?: boolean;
  technicalIndicatorsEnabled: boolean;
  advancedChartTypesEnabled: boolean;
  extendedIndicatorsEnabled: boolean;
  supportResistanceEnabled: boolean;
}

export function ChartPanel({
  symbol,
  active,
  initialHistory: _initialHistory,
  currentPrice,
  marketLabel,
  liveCandle,
  liveUpdateSinkRef,
  liveActive,
  onLiveRefresh,
  liveRefreshDisabled,
  onSelectionChange,
  onHistoryFallbackChange,
  continuousMarket = false,
}: Props) {
  const { addToast } = useToast();
  // Interval and range are two independent axes and both live in the persisted
  // preferences: "12 เดือน" is stored as the canonical `1y` range key and never as
  // a candle interval.
  const { preferences, hydrated, update } = useChartPreferences();
  const interval = preferences.selectedInterval;
  const range = preferences.selectedRange;
  const [session, setSession] = useState<MarketSessionMode>('regular');
  const intraday = !isAdjustableInterval(interval);
  // Daily/weekly/monthly history requests Yahoo's adjusted series (splits and
  // dividends, via the provider's own adjusted close); intraday candles are the
  // raw market prints and are never claimed adjusted. One series is never a mix:
  // the request either asks for adjusted or it does not.
  const adjusted = !intraday;

  useEffect(() => {
    onSelectionChange?.({ interval, session, adjusted });
  }, [interval, session, adjusted, onSelectionChange]);

  const applySelection = useCallback((
    nextInterval: CandleInterval,
    nextRange: HistoricalRange,
    changedControl: 'interval' | 'range',
  ) => {
    const next = compatibleSelection(nextInterval, nextRange, changedControl);
    update((previous) => ({ ...previous, selectedInterval: next.interval, selectedRange: next.range }));
    if (next.notice) addToast({ title: 'ปรับช่วงกราฟอัตโนมัติ', message: next.notice, type: 'info' });
  }, [addToast, update]);

  const onSelectInterval = useCallback((next: CandleInterval) => {
    applySelection(next, range, 'interval');
  }, [applySelection, range]);
  const onSelectRange = useCallback((next: HistoricalRange) => {
    applySelection(interval, next, 'range');
  }, [applySelection, interval]);
  const onToggleFavoriteIntervalHandler = useCallback((next: CandleInterval) => {
    update((previous) => toggleFavoriteInterval(previous, next));
  }, [update]);
  const onToggleFavoriteRangeHandler = useCallback((next: HistoricalRange) => {
    update((previous) => toggleFavoriteRange(previous, next));
  }, [update]);
  const onChartType = useCallback((type: ChartPreferences['chartType']) => {
    update((previous) => ({ ...previous, chartType: type }));
  }, [update]);
  const onToggle = useCallback((key: ToolbarToggleKey) => {
    update((previous) => ({ ...previous, [key]: !previous[key] }));
  }, [update]);

  // One live/delayed statement per screen. Once a label has arrived, the chart's
  // own provenance row states the feed, its provider and its delay — repeating
  // "LIVE" here (and again on the candle) said the same thing three times. Only
  // the states that row cannot express, because there is no label yet, still get
  // a chip.
  const feedLabel = marketLabel ? null : (liveActive ? 'CONNECTING' : 'OFFLINE');

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2" data-testid="chart-session-controls">
      {feedLabel && <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] font-semibold tracking-wide text-amber-200" data-testid="chart-feed-status">{feedLabel}</span>}
      {intraday && !continuousMarket && <select aria-label="Market session" value={session} onChange={(event) => setSession(event.target.value as MarketSessionMode)} className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200"><option value="extended">Pre + Regular + Post</option><option value="regular">Regular only</option></select>}
      <span className="ml-auto text-xs text-slate-500">{rangeOption(range).label} · {interval} · {continuousMarket ? '24/7' : session === 'extended' ? 'EXT' : 'REG'}</span>
    </div>

    {/*
      The chart only starts loading once the persisted selection has been read,
      so a restored "12 เดือน" issues exactly one history request instead of
      loading the default range first and replacing it.
    */}
    <MarketCandleChartPanel
      symbol={symbol}
      active={active && hydrated}
      interval={interval}
      range={range}
      session={session}
      adjusted={adjusted}
      currentPrice={currentPrice}
      marketLabel={marketLabel}
      liveCandle={liveCandle}
      liveUpdateSinkRef={liveUpdateSinkRef}
      liveActive={liveActive}
      onLiveRefresh={onLiveRefresh}
      liveRefreshDisabled={liveRefreshDisabled}
      onHistoryFallbackChange={onHistoryFallbackChange}
      continuousMarket={continuousMarket}
      preferences={preferences}
      onSelectInterval={onSelectInterval}
      onSelectRange={onSelectRange}
      onToggleFavoriteInterval={onToggleFavoriteIntervalHandler}
      onToggleFavoriteRange={onToggleFavoriteRangeHandler}
      onChartType={onChartType}
      onToggle={onToggle}
    />
  </div>;
}
