import { sourceIntervalFor, YAHOO_CANDLE_CAPABILITIES } from '@/src/lib/market-data/candles/capabilities';
import { chartSupportedRanges } from '@/src/lib/analytics/timeframe/compatibility';
import type { CandleInterval, HistoricalRange, MarketSessionMode } from '@/src/lib/market-data/gateway/contracts';

/**
 * Configurable multi-interval market-source policy (Phase B.2).
 *
 * A single {@link PollingMarketSource} follows the chart's current selection.
 * This module is the pure, deterministic policy that decides — for a given
 * (interval, session, adjusted) — whether that selection is a live intraday
 * bucket the source streams, a history-only series that must never be
 * rapid-polled, or an unsupported combination that must surface a typed
 * unavailable rather than silently substituting different data.
 *
 * Nothing here fabricates, interpolates or forward-fills candles. Yahoo-native
 * intervals remain provider-native; 10m/2h/4h are deterministically aggregated
 * server-side from 5m/1h Yahoo candles with session/date boundaries preserved.
 */

/** Intraday intervals the shared source streams as a live active candle. */
export const LIVE_INTRADAY_INTERVALS: readonly CandleInterval[] = [
  '1m', '5m', '10m', '15m', '30m', '1h', '2h', '4h',
];

/** History-only series: loaded once, never rapid-polled. */
export const HISTORY_ONLY_INTERVALS: readonly CandleInterval[] = ['1D', 'Week', 'Month'];

export type MarketSourceMode = 'intraday-live' | 'history-only' | 'unsupported';

/**
 * Whether the live intraday candle comes straight from the provider or would
 * have to be deterministically aggregated from complete lower-timeframe candles.
 * Yahoo serves most intervals natively; unsupported named resolutions are
 * explicitly marked `aggregated`.
 */
export type IntervalProvenance = 'provider-native' | 'aggregated';

export interface MarketSelection {
  interval: CandleInterval;
  session: MarketSessionMode;
  adjusted: boolean;
}

export interface MarketSourceConfig {
  mode: MarketSourceMode;
  interval: CandleInterval;
  session: MarketSessionMode;
  adjusted: boolean;
  /**
   * Smallest chart-route-compatible range that still contains the newest bucket.
   * Only the latest bar is consumed for the live candle/fallback price, so the
   * live poll uses the minimal range (not the chart's displayed range). Null for
   * history-only / unsupported selections.
   */
  aggregateRange: HistoricalRange | null;
  provenance: IntervalProvenance | null;
  /** True only when the source should run a rapid aggregate poll for this selection. */
  pollsAggregate: boolean;
  /** Machine/human reason when the selection is history-only or unsupported. */
  reason: string | null;
  /** Dedup key excluding symbol (the source prefixes the symbol). */
  selectionKey: string;
}

export function selectionKeyOf(selection: MarketSelection): string {
  return `${selection.interval}:${selection.session}:${selection.adjusted}`;
}

export function isLiveIntradayInterval(interval: CandleInterval): boolean {
  return LIVE_INTRADAY_INTERVALS.includes(interval);
}

export function isHistoryOnlyInterval(interval: CandleInterval): boolean {
  return HISTORY_ONLY_INTERVALS.includes(interval);
}

/**
 * Resolve the deterministic policy for a selection. Extended-hours is honored
 * only for intraday intervals (where the provider actually returns pre/post
 * bars); requesting extended-hours daily/weekly/monthly is unsupported rather
 * than silently downgraded to regular-session data.
 */
export function resolveMarketSourceConfig(selection: MarketSelection): MarketSourceConfig {
  const { interval, session, adjusted } = selection;
  const base = { interval, session, adjusted, selectionKey: selectionKeyOf(selection) } as const;

  if (isHistoryOnlyInterval(interval)) {
    if (session === 'extended') {
      return {
        ...base,
        mode: 'unsupported',
        aggregateRange: null,
        provenance: null,
        pollsAggregate: false,
        reason: `Extended-hours ${interval} candles are not available; regular-session data is never substituted.`,
      };
    }
    return {
      ...base,
      mode: 'history-only',
      aggregateRange: null,
      provenance: null,
      pollsAggregate: false,
      reason: `${interval} candles load once as history and are not rapid-polled.`,
    };
  }

  if (isLiveIntradayInterval(interval)) {
    const sourceInterval = sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, interval);
    return {
      ...base,
      mode: 'intraday-live',
      // Smallest range the Yahoo candles route can actually serve for this
      // interval — the live poll only ever reads the newest bucket from it.
      aggregateRange: chartSupportedRanges(interval)[0] ?? null,
      provenance: sourceInterval === interval ? 'provider-native' : 'aggregated',
      pollsAggregate: true,
      reason: null,
    };
  }

  return {
    ...base,
    mode: 'unsupported',
    aggregateRange: null,
    provenance: null,
    pollsAggregate: false,
    reason: `${interval} (${session}) is not a supported live market-source selection.`,
  };
}

/** True when the shared source streams a live active candle for this selection. */
export function isIntradayLiveSelection(interval: CandleInterval, session: MarketSessionMode): boolean {
  return resolveMarketSourceConfig({ interval, session, adjusted: false }).mode === 'intraday-live';
}
