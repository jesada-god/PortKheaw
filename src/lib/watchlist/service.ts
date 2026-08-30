import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { loadEntitledMarketSignal } from '@/src/lib/analytics/market-signal/entitled-service';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import { commodityMarketAsset } from '@/src/lib/overview/market-assets';
import { resolveAssetPresentationPolicy } from '@/src/lib/stock-detail/profile-presentation';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { getInstrumentPresentationMetadata } from '@/src/lib/instruments/presentation';
import { loadOverviewPrice, mapWithConcurrency } from '@/src/lib/overview/service';
import { loadUpcomingEarnings, upcomingEarningsSymbols } from '@/src/lib/upcoming/service';
import { loadDailySnapshots } from '@/src/lib/market-data/daily-snapshot';
import { US_EQUITY_TIMEZONE, exchangeSessionDate } from '@/src/lib/market-data/session';
import { marketSession } from '@/src/lib/market-data/market-session';
import { whatChangedCardEnabled } from '@/src/config/features';
import { watchlistDayChange } from './day-change';
import { loadWhatChanged, type WhatChangedSection } from './what-changed-service';
import { buildWatchlistRow, type WatchlistRow } from './rows';
import type { WatchlistRecord } from './types';

/**
 * Assembling the rows one watchlist screen is drawn from.
 *
 * ===========================================================================
 * EVERY INPUT COMES FROM A SERVICE THAT ALREADY EXISTS
 * ===========================================================================
 * Prices from `loadOverviewPrice`, captured closes from `loadDailySnapshots`,
 * the report calendar from `loadUpcomingEarnings`, the trend from
 * `loadEntitledMarketSignal`. Not one of them is re-implemented here, and the
 * two that carry rules — which prices a day figure is made of, and who is
 * allowed to see a trend — are called rather than re-decided.
 *
 * ===========================================================================
 * THE ENTITLEMENT IS THE SERVER'S, NOT THE COLUMN'S
 * ===========================================================================
 * The trend is the Market Signal, and the Market Signal is sold: Elite for
 * equities, Pro for the three commodity contracts. `loadEntitledMarketSignal`
 * is the boundary that enforces it, and it returns `null` WITHOUT running the
 * engine for a reader who has not bought it — so an unentitled session's page
 * contains no trend to be found in the payload, rather than a hidden one.
 *
 * `watchlistTrend(null)` is `unknown`, which is also what a symbol whose engine
 * could not read enough candles produces. That is deliberate and it is not
 * information leakage in the other direction either: the column says "no
 * reading" in both cases, and the page draws the padlock from the entitlement
 * it already resolved, never by inferring one from a blank cell.
 *
 * ===========================================================================
 * WHY THE SIGNAL WORK IS BOUNDED
 * ===========================================================================
 * The engine is the expensive input by a wide margin — five years of candles
 * per symbol, plus its own history read and write — and a watchlist can hold
 * far more symbols than a stock page holds. So the fan-out is capped at
 * `SIGNAL_CONCURRENCY` and a symbol whose signal throws becomes `null`, which
 * the column already renders honestly. A page that failed because one symbol's
 * provider was slow would be a worse answer than a page with one ⚪ on it.
 */

type Client = SupabaseClient<Database>;

/**
 * How many signals are computed at once.
 *
 * Four, matching `loadWatchlistPrices` and the page's own quote fan-out. The
 * candle service dedupes and caches underneath, so a reader refreshing does not
 * pay this again; the cap is about the first load on a long list.
 */
const SIGNAL_CONCURRENCY = 4;

export interface WatchlistViewInput {
  client: Client;
  watchlist: WatchlistRecord;
  tier: SubscriptionTier;
  now?: Date;
}

export interface WatchlistView {
  rows: WatchlistRow[];
  /** Which of the four session states the rows were read in. Drives the page caption. */
  session: ReturnType<typeof marketSession>;
  renderedAt: string;
  /**
   * What changed today, or null when the section is switched off.
   *
   * Null and an empty `items` are different facts and are kept apart: null is
   * "this reader does not have the section", an empty list is "they have it and
   * nothing happened". Both render nothing, and collapsing them would leave no
   * way to tell a quiet day from a disabled feature when one of them is wrong.
   */
  whatChanged: WhatChangedSection | null;
}

/**
 * Which row of the entitlement matrix pays for this symbol's trend.
 *
 * The same synchronous classification the stock page uses, for the same reason
 * it gives: a contract is the one instrument sold on a different row, and
 * waiting for a snapshot to learn its asset type would serialise a round trip
 * per symbol to answer something a registry lookup already knows.
 */
function capabilityFor(symbol: string) {
  return resolveAssetPresentationPolicy(
    commodityMarketAsset(symbol) ? 'commodity' : null,
  ).technicalOutlookCapability;
}

async function signalFor(symbol: string, tier: SubscriptionTier): Promise<MarketSignalResult | null> {
  try {
    return await loadEntitledMarketSignal(symbol, tier, capabilityFor(symbol));
  } catch {
    /*
      One symbol's engine failing is one ⚪ cell. Rethrowing would take down a
      page whose other eleven rows are complete, and the column has an honest
      rendering for "no reading" precisely so this does not have to.
    */
    return null;
  }
}

export async function loadWatchlistView(input: WatchlistViewInput): Promise<WatchlistView> {
  const now = input.now ?? new Date();
  const symbols = input.watchlist.items.map((item) => item.symbol);
  const session = marketSession(now);
  const todayExchangeDate = exchangeSessionDate(now.toISOString(), US_EQUITY_TIMEZONE);

  const metadata = await getInstrumentPresentationMetadata(symbols);

  /*
    The four loaders run together. `snapshots` and `earnings` are single
    round trips for the whole list; the other two fan out per symbol under their
    own caps. Nothing here depends on anything else here, so serialising them
    would only add latency.
  */
  const [prices, snapshots, earnings, signals] = await Promise.all([
    mapWithConcurrency(input.watchlist.items, 4, async (item) => {
      const instrument = metadata.get(item.symbol);
      if (!instrument) return [item.symbol, null] as const;
      /*
        The whole `LoadedPrice`, not just `display`. The expanded row wants the
        volume, and it is already on this result — a second quote request per
        symbol to fetch a number the first one returned would be pure cost.
      */
      const result = await loadOverviewPrice(instrument, now);
      return [item.symbol, result] as const;
    }),
    loadDailySnapshots(input.client, symbols, now).catch(() => new Map()),
    loadUpcomingEarnings(upcomingEarningsSymbols([], symbols)).catch(() => []),
    mapWithConcurrency(symbols, SIGNAL_CONCURRENCY, async (symbol) =>
      [symbol, await signalFor(symbol, input.tier)] as const),
  ]);

  const priceBySymbol = new Map(prices);
  const signalBySymbol = new Map(signals);
  /*
    `flatMap` rather than filter-then-map: the filter does not narrow the union
    for the map that follows, and an unavailable schedule carries no day count
    to read. A symbol the calendar could not answer for is simply absent, which
    the row renders as no earnings line rather than as a zero.
  */
  const earningsBySymbol = new Map(earnings.flatMap((schedule) =>
    schedule.status === 'available' ? [[schedule.symbol, schedule.daysToEarnings] as const] : []));

  const rows = input.watchlist.items.map((item) => {
    const loaded = priceBySymbol.get(item.symbol) ?? null;
    const price = loaded?.display ?? null;
    const instrument = metadata.get(item.symbol);
    return buildWatchlistRow({
      id: item.id,
      symbol: item.symbol,
      createdAt: item.createdAt,
      watchlistId: input.watchlist.id,
      pinned: item.pinned,
      companyName: instrument?.companyName ?? item.symbol,
      logoUrl: instrument?.logoUrl ?? null,
      price: price?.price ?? null,
      currency: price?.currency ?? 'USD',
      day: watchlistDayChange({
        session,
        price: price?.price ?? null,
        /*
          The overview price carries a change rather than a previous close, so
          the earlier half is reconstructed from the two it does carry. Null
          whenever either is missing — never zero, which would make the basis
          resolver read a flat day where there was no reading at all.
        */
        previousClose: price?.price != null && price.change != null
          ? price.price - price.change
          : null,
        snapshot: snapshots.get(item.symbol) ?? null,
        todayExchangeDate,
      }),
      signal: signalBySymbol.get(item.symbol) ?? null,
      volume: loaded?.volume ?? null,
      earningsDays: earningsBySymbol.get(item.symbol) ?? null,
    });
  });

  /*
    Last, and after the rows, because it reads what they already resolved — the
    day figure, the trend, support and resistance, the report date — and adds
    only the daily bars. Behind the flag so a reader with the section off pays
    for none of that load. See `what-changed-service.ts` for why the bar read is
    a cache hit rather than a second fan-out.
  */
  const whatChanged = whatChangedCardEnabled()
    ? await loadWhatChanged({ rows, signals: signalBySymbol, session, now })
    : null;

  return { rows, session, renderedAt: now.toISOString(), whatChanged };
}
