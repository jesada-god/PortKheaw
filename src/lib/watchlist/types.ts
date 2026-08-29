import type { DataFreshness, Quote } from '@/src/lib/market-data/types';

export interface WatchlistItemRecord {
  id: string;
  symbol: string;
  createdAt: string;
  /**
   * Chosen by the reader for the Overview preview.
   *
   * Defaults false everywhere, including for every row that predates the
   * column, so an account that has never pinned anything gets the stated
   * fallback order rather than an empty preview.
   */
  pinned: boolean;
}

export interface WatchlistRecord {
  id: string;
  name: string;
  /** ISO instant the list was created. The tie-break every ordering shares. */
  createdAt: string;
  items: WatchlistItemRecord[];
}

/** One list without its rows, for the switcher and the Overview selector. */
export interface WatchlistSummary {
  id: string;
  name: string;
  createdAt: string;
  itemCount: number;
}

export interface WatchlistQuote {
  quote: Quote | null;
  freshness: DataFreshness;
}

export type WatchlistActionResult =
  /**
   * `logoUrl` carries the logo resolved for a newly added symbol in the very
   * response that created it, so the new row draws its picture immediately
   * instead of waiting for a later render to discover it.
   */
  | { ok: true; item?: WatchlistItemRecord; logoUrl?: string | null; companyName?: string | null }
  | { ok: false; code: WatchlistActionErrorCode; message: string };

/**
 * Why a watchlist mutation did not happen.
 *
 * `duplicate` covers two different unique indexes — a symbol already in this
 * list, and a list name already used by this account — and the action that
 * raises it supplies the sentence, because the code alone cannot say which.
 *
 * `last-list` is its own code rather than a `database` failure: refusing to
 * delete the only list is a RULE, and a reader who is told "something went
 * wrong" will try again. It is raised by `public.delete_watchlist` as 23514.
 *
 * `limit` is the twenty-list ceiling, raised as 54000.
 */
export type WatchlistActionErrorCode =
  | 'invalid'
  | 'duplicate'
  | 'unauthorized'
  | 'not-found'
  | 'database'
  | 'delisted'
  | 'last-list'
  | 'limit';
