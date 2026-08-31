import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { lastCompletedSessionDate, marketSession } from '@/src/lib/market-data/market-session';
import { US_EQUITY_TIMEZONE, exchangeSessionDate } from '@/src/lib/market-data/session';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { loadWatchlistView, type WatchlistView } from '@/src/lib/watchlist/service';
import type { WatchlistRecord } from '@/src/lib/watchlist/types';
import { LastGoodSnapshotCoordinator } from './industry-snapshot';

/**
 * THE WATCHLIST VIEW, ON THE OVERVIEW, WITH A CEILING ON WHAT IT COSTS.
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * `loadWatchlistView` is the only thing in the product that produces a trend
 * per symbol and the detector inputs behind "สิ่งที่เปลี่ยนไป". Until now it ran
 * on `/watchlist` alone, where a reader has chosen to look at their list. The
 * overview is the first screen everybody sees, so running it there without a
 * ceiling would put the signal engine and a daily-bar read behind every app
 * open.
 *
 * Three bounds, all of them here rather than at the call site:
 *
 *   1. AT MOST {@link OVERVIEW_WATCHLIST_TREND_CAP} SYMBOLS. Rows past the cap
 *      are still on the page — the overview draws them from the quote loaders
 *      it already runs — they simply have no trend column. A truncated list
 *      would be a different product on the overview than on `/watchlist`.
 *   2. CACHED, per reader and per trading date, through `SharedRequestCache`:
 *      in-flight dedupe, a fresh window, and a stale window that keeps the last
 *      good view alive through a provider failure.
 *   3. LAST-GOOD + BACKGROUND WARM, through `LastGoodSnapshotCoordinator`, the
 *      same read-now/refresh-later shape `market-breadth.ts` uses.
 *
 * ===========================================================================
 * WHY A MAP OF COORDINATORS
 * ===========================================================================
 * `LastGoodSnapshotCoordinator` holds ONE snapshot and treats a different key
 * as "nothing stored". That is right for breadth, which is the same for every
 * reader, and wrong here, where two readers would evict each other on every
 * request. So there is one coordinator per reader, in a bounded map — bounded
 * because an unbounded per-user map on a long-lived server instance is a leak
 * with a slow fuse.
 *
 * ===========================================================================
 * A SLOW LOAD MUST NOT HOLD THE PAGE
 * ===========================================================================
 * {@link loadOverviewWatchlistView} answers from cache when it can and
 * otherwise waits no longer than {@link OVERVIEW_WATCHLIST_VIEW_DEADLINE_MS}.
 * Past the deadline it returns whatever last-good it has, or null — and null
 * means the two sections that read it render nothing while every other section
 * on the page renders normally.
 */

type Client = SupabaseClient<Database>;

/**
 * How many symbols get a trend on the overview.
 *
 * Twenty is above what the preview shows (five) and above what a typical list
 * holds, so in practice the cap never binds — it exists so that the one reader
 * with two hundred symbols cannot turn the front page into a two-hundred-symbol
 * fan-out.
 */
export const OVERVIEW_WATCHLIST_TREND_CAP = 20;

/** How long the page will wait for a cold load before rendering without it. */
export const OVERVIEW_WATCHLIST_VIEW_DEADLINE_MS = 2_500;

/** How many readers' last-good views one server instance keeps. */
const MAX_TRACKED_READERS = 200;

const viewCache = new SharedRequestCache();

/**
 * A minute fresh, ten minutes stale.
 *
 * The trend behind these rows is computed from daily candles and does not move
 * within a minute; the stale window is what keeps the column on screen when a
 * provider blips, which is the failure this page must survive rather than
 * report.
 */
const VIEW_POLICY = { freshMs: 60_000, staleMs: 10 * 60_000, errorMs: 30_000 } as const;

const coordinators = new Map<string, LastGoodSnapshotCoordinator<WatchlistView>>();

function coordinatorFor(reader: string): LastGoodSnapshotCoordinator<WatchlistView> {
  const existing = coordinators.get(reader);
  if (existing) {
    /* Refresh insertion order so the busiest readers are the last evicted. */
    coordinators.delete(reader);
    coordinators.set(reader, existing);
    return existing;
  }
  if (coordinators.size >= MAX_TRACKED_READERS) {
    const oldest = coordinators.keys().next();
    if (!oldest.done) coordinators.delete(oldest.value);
  }
  const created = new LastGoodSnapshotCoordinator<WatchlistView>({
    freshMs: VIEW_POLICY.freshMs,
    staleMs: VIEW_POLICY.staleMs,
  });
  coordinators.set(reader, created);
  return created;
}

export interface OverviewWatchlistViewInput {
  client: Client;
  /** The signed-in reader. The cache is per reader and never shared across them. */
  userId: string;
  watchlist: WatchlistRecord;
  tier: SubscriptionTier;
  now?: Date;
  /**
   * How many "สิ่งที่เปลี่ยนไป" items to keep. Passed straight through.
   *
   * Not part of the cache key, deliberately: the cap decides how many of the
   * detected items survive, never which ones are detected, so two callers
   * asking for different caps are asking for the same work.
   */
  whatChangedLimit?: number;
}

/** The trading date the view is filed under, so a completed session is not reused. */
function tradingDateOf(now: Date): string {
  const session = marketSession(now);
  const date = session === 'OPEN'
    ? exchangeSessionDate(now.toISOString(), US_EQUITY_TIMEZONE)
    : lastCompletedSessionDate(now);
  return date ?? 'unknown';
}

function keyOf(input: OverviewWatchlistViewInput, now: Date): string {
  return `${input.userId}:${input.watchlist.id}:${tradingDateOf(now)}`;
}

/** The list, cut to the ceiling. Never mutates the caller's record. */
function capped(watchlist: WatchlistRecord): WatchlistRecord {
  if (watchlist.items.length <= OVERVIEW_WATCHLIST_TREND_CAP) return watchlist;
  return { ...watchlist, items: watchlist.items.slice(0, OVERVIEW_WATCHLIST_TREND_CAP) };
}

/** The last good view for this reader, without waiting for anything. */
export function overviewWatchlistViewSnapshot(
  input: OverviewWatchlistViewInput,
): WatchlistView | null {
  const now = input.now ?? new Date();
  return coordinatorFor(input.userId).read(keyOf(input, now)).value;
}

/** Refresh in the background. Intended for `after()`. */
export function warmOverviewWatchlistView(
  input: OverviewWatchlistViewInput,
): Promise<WatchlistView | null> {
  const now = input.now ?? new Date();
  const key = keyOf(input, now);
  return coordinatorFor(input.userId).refresh(key, () => viewCache.resolve(
    `ov-watchlist-view:${key}`,
    () => loadWatchlistView({
      client: input.client,
      watchlist: capped(input.watchlist),
      tier: input.tier,
      now,
      whatChangedLimit: input.whatChangedLimit,
    }),
    VIEW_POLICY,
  ).then((resolution) => resolution.value));
}

/**
 * The view, from cache when possible and otherwise within the deadline.
 *
 * Null is a supported answer and means the two sections that read it draw
 * nothing this render. It is never an exception: a failure here must cost the
 * trend column, not the page.
 */
export async function loadOverviewWatchlistView(
  input: OverviewWatchlistViewInput,
): Promise<WatchlistView | null> {
  const cached = overviewWatchlistViewSnapshot(input);
  if (cached) return cached;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      warmOverviewWatchlistView(input).catch(() => null),
      new Promise<WatchlistView | null>((resolve) => {
        timer = setTimeout(
          () => resolve(overviewWatchlistViewSnapshot(input)),
          OVERVIEW_WATCHLIST_VIEW_DEADLINE_MS,
        );
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test seam. The map is module state and would otherwise leak between cases. */
export function resetOverviewWatchlistViewCacheForTests(): void {
  coordinators.clear();
}
