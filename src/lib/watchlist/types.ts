import type { DataFreshness, Quote } from '@/src/lib/market-data/types';

export interface WatchlistItemRecord {
  id: string;
  symbol: string;
  createdAt: string;
}

export interface WatchlistRecord {
  id: string;
  name: string;
  items: WatchlistItemRecord[];
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
  | { ok: false; code: 'invalid' | 'duplicate' | 'unauthorized' | 'not-found' | 'database' | 'delisted'; message: string };
