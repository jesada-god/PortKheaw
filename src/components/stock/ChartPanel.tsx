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

/**
 * What slice of the trading day the drawn series covers.
 *
 * `EXT`/`REG` are US-equity session names and mean nothing off that clock.
 * `24/7` is the crypto pair. `GLOBEX` is the CME week the metals and crude
 * trade on — one continuous session with a weekend and a daily halt, which is
 * neither of the other two and must not borrow either one's label.
 */
function sessionScopeLabel(
  marketKind: 'us-equity' | 'continuous' | 'commodity',
  session: MarketSessionMode,
): string {
  if (marketKind === 'continuous') return '24/7';
  if (marketKind === 'commodity') return 'GLOBEX';
  return session === 'extended' ? 'EXT' : 'REG';
}

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
  /**
   * Which kind of trading day the chart is drawing.
   *
   * Was a single `continuousMarket` boolean, which forced a futures contract to
   * be described as one of the two things it is not: left false it offered a
   * Pre/Regular/Post selector for a market that has no pre-market, and set true
   * it would have labelled the Globex week "24/7" and erased its weekend.
   */
  marketKind?: 'us-equity' | 'continuous' | 'commodity';
  /**
   * Whether anything lists options on this instrument. False hides the Options
   * toggle and its panel outright rather than leaving a control that can only
   * ever answer "unavailable".
   */
  optionsAvailable?: boolean;
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
  marketKind = 'us-equity',
  optionsAvailable = true,
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
      {feedLabel && <span className="rounded-full border border-[var(--warning-line)] bg-[var(--warning-soft)] px-2 py-1 text-[10px] font-semibold tracking-wide text-[var(--warning)]" data-testid="chart-feed-status">{feedLabel}</span>}
      {/* Pre and post are US-equity windows. Neither the 24/7 pair nor the
          Globex contract has them, so neither is offered the choice. */}
      {intraday && marketKind === 'us-equity' && <select aria-label="Market session" value={session} onChange={(event) => setSession(event.target.value as MarketSessionMode)} className="min-h-11 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-xs text-[var(--text)]"><option value="extended">Pre + Regular + Post</option><option value="regular">Regular only</option></select>}
      <span className="figure ml-auto text-xs text-[var(--text-muted)]">{rangeOption(range).label} · {interval} · {sessionScopeLabel(marketKind, session)}</span>
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
      marketKind={marketKind}
      optionsAvailable={optionsAvailable}
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
