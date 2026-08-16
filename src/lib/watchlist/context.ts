/**
 * The one line of context a watched symbol earns, and the order the list is
 * read in.
 *
 * A watchlist is not a screener, so this adds no columns and no metrics of its
 * own: the percentage is the change the quote pipeline already accepted, and the
 * earnings note is the calendar service's own day count. Both are optional, and
 * a symbol with neither shows no context line rather than a placeholder.
 */

/**
 * How large a single day's move has to be before it is worth naming.
 *
 * Said as an observation — "เคลื่อนไหวแรงวันนี้" — and never as "more than
 * usual": PortKheaw has no canonical volatility baseline for a symbol, so a
 * claim about what is usual for it would be invented.
 */
export const STRONG_MOVE_PERCENT = 5;

/** How soon a report is close enough to mention beside a watched symbol. */
export const EARNINGS_NOTICE_DAYS = 14;

export type WatchlistSortKey = 'newest' | 'symbol' | 'price' | 'change';

export const WATCHLIST_SORT_LABELS: Readonly<Record<WatchlistSortKey, string>> = {
  change: 'การเปลี่ยนแปลง',
  symbol: 'ตัวอักษร',
  newest: 'เพิ่มล่าสุด',
  price: 'ราคา',
};

export interface WatchlistRowContext {
  changePercent: number | null;
  /** Whole days to the next scheduled report, or null when there is none. */
  earningsDays: number | null;
}

export function watchlistContextLine({ changePercent, earningsDays }: WatchlistRowContext): string | null {
  const parts: string[] = [];
  if (changePercent !== null && Number.isFinite(changePercent)) {
    parts.push(`${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}% วันนี้`);
    if (Math.abs(changePercent) >= STRONG_MOVE_PERCENT) parts.push('เคลื่อนไหวแรงวันนี้');
  }
  if (earningsDays !== null && Number.isFinite(earningsDays) && earningsDays >= 0 && earningsDays <= EARNINGS_NOTICE_DAYS) {
    parts.push(earningsDays === 0
      ? 'ประกาศผลประกอบการวันนี้'
      : `ประกาศผลประกอบการในอีก ${earningsDays} วัน`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

export interface WatchlistSortRow {
  symbol: string;
  createdAt: string;
  price: number | null;
  changePercent: number | null;
}

/**
 * Sorts a copy, never the caller's array. A row with no priced value sorts last
 * on every price-driven order rather than being treated as zero.
 */
export function sortWatchlistRows<T extends WatchlistSortRow>(rows: readonly T[], sort: WatchlistSortKey): T[] {
  return [...rows].sort((left, right) => {
    if (sort === 'symbol') return left.symbol.localeCompare(right.symbol);
    if (sort === 'price') return (right.price ?? -Infinity) - (left.price ?? -Infinity) || left.symbol.localeCompare(right.symbol);
    if (sort === 'change') {
      return (right.changePercent ?? -Infinity) - (left.changePercent ?? -Infinity)
        || left.symbol.localeCompare(right.symbol);
    }
    return right.createdAt.localeCompare(left.createdAt) || left.symbol.localeCompare(right.symbol);
  });
}
