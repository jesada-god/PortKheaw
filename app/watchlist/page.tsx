import Header from '@/src/components/layout/Header';
import { WatchlistClient } from '@/src/components/watchlist/WatchlistClient';
import { WatchlistV2Client } from '@/src/components/watchlist/WatchlistV2Client';
import { createClient } from '@/src/lib/supabase/server';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
import type { WatchlistQuote } from '@/src/lib/watchlist/types';
import { getInstrumentPresentationMetadata } from '@/src/lib/instruments/presentation';
import { loadOverviewPrice, mapWithConcurrency } from '@/src/lib/overview/service';
import { loadUpcomingEarnings, upcomingEarningsSymbols } from '@/src/lib/upcoming/service';
import { recordBetaFunnelEvent } from '@/src/lib/beta/beta-server';
import { watchlistV2Enabled } from '@/src/config/features';
import { resolvePageEntitlement } from '@/src/lib/subscription/page-entitlement';
import { loadWatchlistView } from '@/src/lib/watchlist/service';

const unavailable: WatchlistQuote = {
  quote: null,
  freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
};

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string }>;
}) {
  const client = await createClient();
  if (!client) return null;
  const repository = new WatchlistRepository(client);
  void recordBetaFunnelEvent({ event: 'feature_used', featureKey: 'watchlist' }).catch(() => {});

  /*
   * The flag decides which SCREEN is rendered, and it decides it here rather
   * than inside a component. The two versions load different things — v2 runs
   * the signal engine per symbol and reads the captured closes — so a branch
   * further down would pay for both and show one.
   */
  if (watchlistV2Enabled()) {
    const requested = (await searchParams).list ?? null;
    const [lists, watchlist, entitlement] = await Promise.all([
      repository.listAll(),
      repository.getForRequest(requested),
      resolvePageEntitlement(),
    ]);
    const view = await loadWatchlistView({
      client,
      watchlist,
      tier: entitlement.effectiveAccessTier,
    });
    return (
      <div className="min-w-0">
        <Header title="รายการติดตาม" subtitle="ติดตามหุ้นที่คุณสนใจ พร้อมราคาและแนวโน้มล่าสุด" />
        <div className="mx-auto w-full max-w-5xl p-4 md:p-8">
          <WatchlistV2Client
            watchlist={{ id: watchlist.id, name: watchlist.name }}
            lists={lists}
            rows={view.rows}
          />
        </div>
      </div>
    );
  }

  const watchlist = await repository.getDefault();
  const metadata = await getInstrumentPresentationMetadata(
    watchlist.items.map((item) => item.symbol),
  );
  const entries = await mapWithConcurrency(watchlist.items, 4, async (item) => {
    const result = await loadOverviewPrice(metadata.get(item.symbol)!);
    const value = result.display;
    if (value.price === null) return [item.symbol, unavailable] as const;
    return [item.symbol, {
      quote: {
        symbol: item.symbol,
        currency: value.currency,
        price: value.price,
        open: null,
        high: null,
        low: null,
        previousClose: value.change === null ? null : value.price - value.change,
        regularClose: value.price,
        previousRegularClose: value.change === null ? null : value.price - value.change,
        change: value.change,
        changePercent: value.changePercent,
        volume: null,
        latestTradingDay: value.tradingDate,
        quoteTimestamp: value.asOf,
        session: value.session === 'PRE' ? 'pre-market'
          : value.session === 'REGULAR' ? 'regular'
            : value.session === 'POST' ? 'after-hours' : 'closed',
      },
      freshness: value.freshness ?? unavailable.freshness,
    }] as const;
  });

  /*
   * The same capped, deadlined, twelve-hour-cached calendar loader Home uses.
   * A reader arriving from Home usually pays nothing for it, and a symbol the
   * calendar cannot answer for simply carries no earnings note.
   */
  const schedules = await loadUpcomingEarnings(
    upcomingEarningsSymbols([], watchlist.items.map((item) => item.symbol)),
  );
  const earningsDays = Object.fromEntries(schedules
    .filter((schedule) => schedule.status === 'available')
    .map((schedule) => [schedule.symbol, schedule.daysToEarnings]));

  return (
    <div className="min-w-0">
      <Header title="รายการติดตาม" subtitle="ติดตามหุ้นที่คุณสนใจ พร้อมราคาและสถานะข้อมูลล่าสุด" />
      <div className="mx-auto w-full max-w-5xl p-4 md:p-8">
        <WatchlistClient
          watchlist={watchlist}
          initialQuotes={Object.fromEntries(entries)}
          initialInstruments={Object.fromEntries(
            [...metadata].map(([symbol, instrument]) => [
              symbol,
              {
                companyName: instrument.companyName,
                logoUrl: instrument.logoUrl,
              },
            ]),
          )}
          earningsDays={earningsDays}
          renderedAt={new Date().toISOString()}
        />
      </div>
    </div>
  );
}
