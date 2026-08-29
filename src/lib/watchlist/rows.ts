/**
 * One watchlist row, and the order the rows are read in.
 *
 * ===========================================================================
 * WHAT IS IN THE MAIN ROW, AND WHAT IS NOT
 * ===========================================================================
 * The main row carries four things: the symbol, the price, today's move, and
 * the trend. That is what somebody scanning a dozen holdings is scanning FOR,
 * and a column they have to read past is a column that costs every other row.
 *
 * Support, resistance, volume and the earnings date are real and are kept — in
 * the EXPANDED row, one symbol at a time. They are not four more columns,
 * because they are not scanning material: a support level means something when
 * you are looking at one stock and means nothing as the fourth number in a line
 * of twelve. `expanded` on this type is the whole of that split, and the
 * component may not render any of it in the collapsed row.
 *
 * ===========================================================================
 * WHY THE EXTRAS ARE NULLABLE AND STAY THAT WAY
 * ===========================================================================
 * Every field in `expanded` is `null` whenever the thing that produces it did
 * not produce it. Support and resistance come from the signal engine's own
 * metrics and are absent on a symbol whose structure did not support them;
 * volume is absent whenever the quote pipeline did not accept one; the earnings
 * day count is absent whenever the calendar could not answer, which is a normal
 * outcome and not an error. None of them becomes a zero or a dash on the way
 * here — the row draws the absence, and a reader is told there is no reading
 * rather than shown a number that looks like one.
 */

import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import type { StatusLevel } from '@/src/lib/presentation/status';
import { trendProminence, watchlistTrend, type WatchlistTrend } from './trend';
import type { WatchlistDayChange } from './day-change';

/** The four numbers the expanded row adds, each absent rather than guessed. */
export interface WatchlistRowDetail {
  /** Nearest level below the close, from the engine's own metrics. */
  support: number | null;
  /** Nearest level above it. */
  resistance: number | null;
  /** Shares traded, as the quote reported them. */
  volume: number | null;
  /** Whole days to the next scheduled report; null when the calendar had none. */
  earningsDays: number | null;
}

export interface WatchlistRow {
  id: string;
  symbol: string;
  createdAt: string;
  /**
   * The list this row belongs to, carried on the row itself.
   *
   * The pin control writes to one list and one symbol, and with several lists
   * on the page a component that reached for "the current list" from context
   * would pin into whichever one happened to be selected when the request
   * landed rather than the one the row is in.
   */
  watchlistId: string;
  /** Chosen by the reader for the Overview preview. */
  pinned: boolean;
  companyName: string;
  logoUrl: string | null;
  price: number | null;
  currency: string;
  day: WatchlistDayChange;
  trend: WatchlistTrend;
  expanded: WatchlistRowDetail;
}

/**
 * The engine's support and resistance, when it published them.
 *
 * Read off `metrics` rather than off `zones`, deliberately. The zone frame is
 * the card's own construct and comes with a vocabulary this surface is not
 * allowed to use — `CARD_MUST_NOT_SAY` bans โซน and ของกรอบ — whereas
 * `nearestSupport` and `nearestResistance` are two prices a reader can read as
 * prices. A row that showed a frame edge would be showing a number whose
 * meaning it cannot state.
 */
export function detailFromSignal(
  signal: MarketSignalResult | null,
  volume: number | null,
  earningsDays: number | null,
): WatchlistRowDetail {
  const metrics = signal?.status === 'available' ? signal.metrics : null;
  return {
    support: metrics?.nearestSupport ?? null,
    resistance: metrics?.nearestResistance ?? null,
    volume: volume !== null && Number.isFinite(volume) ? volume : null,
    earningsDays: earningsDays !== null && Number.isFinite(earningsDays) && earningsDays >= 0
      ? earningsDays
      : null,
  };
}

export interface WatchlistRowInput {
  id: string;
  symbol: string;
  createdAt: string;
  watchlistId: string;
  pinned: boolean;
  companyName: string;
  logoUrl: string | null;
  price: number | null;
  currency: string;
  day: WatchlistDayChange;
  signal: MarketSignalResult | null;
  volume: number | null;
  earningsDays: number | null;
}

export function buildWatchlistRow(input: WatchlistRowInput): WatchlistRow {
  return {
    id: input.id,
    symbol: input.symbol,
    createdAt: input.createdAt,
    watchlistId: input.watchlistId,
    pinned: input.pinned,
    companyName: input.companyName,
    logoUrl: input.logoUrl,
    price: input.price,
    currency: input.currency,
    day: input.day,
    trend: watchlistTrend(input.signal),
    expanded: detailFromSignal(input.signal, input.volume, input.earningsDays),
  };
}

/**
 * Mobile order: the most pronounced trends first.
 *
 * A phone shows three or four rows at a time, so the order IS the interface —
 * whatever is at the top is what most readers will ever see. "เด่นสุด" is how
 * strongly the reading commits, not how good it is, so a 🔴 sorts alongside a
 * 🟢: a holding that is falling hard is the row a reader most needs to reach,
 * and an order that buried it under every flat symbol would be optimistic in
 * the one place optimism costs something.
 *
 * Rows with no reading sort LAST, never among the calm ones. That is
 * `trendProminence`'s floor, and it is the same rule as `status.ts`'s "missing
 * data never reads as good news" applied to position rather than to colour.
 *
 * Ties break by symbol so the order is TOTAL: two rows can never swap between
 * renders, which on a list that re-sorts as quotes arrive would look like the
 * page rearranging itself under the reader's thumb.
 *
 * Sorts a copy. The caller's array is never mutated.
 */
export function sortRowsByTrend<T extends { symbol: string; trend: { level: StatusLevel } }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((left, right) =>
    trendProminence(right.trend.level) - trendProminence(left.trend.level)
    || left.symbol.localeCompare(right.symbol));
}
