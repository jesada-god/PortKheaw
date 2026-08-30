import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
import {
  overviewPreview,
  previewHasMore,
  resolveOverviewWatchlist,
} from '@/src/lib/watchlist/overview-preview';
import type { WatchlistSummary } from '@/src/lib/watchlist/types';
import { calculateOptionLedger } from '@/src/lib/portfolio/options/calculations';
import { loadPortfolioOptionQuotes } from '@/src/lib/portfolio/options/quote-pipeline';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import {
  buildServiceStatus,
  loadIndustryDashboardSnapshot,
  loadMarketIndices,
  loadPortfolioPrices,
  loadWatchlistPrices,
  warmIndustryDashboard,
} from '@/src/lib/overview/service';
import {
  loadMarketBreadthSnapshot,
  warmMarketBreadth,
} from '@/src/lib/overview/market-breadth';
import { buildOverviewPortfolio } from '@/src/lib/overview/portfolio-summary';
import { marketSession } from '@/src/lib/market-data/market-session';
import { loadDailySnapshots } from '@/src/lib/market-data/daily-snapshot';
import type { DaySnapshotInput } from '@/src/lib/portfolio/day-change';
import { DashboardClient } from '@/src/components/dashboard/DashboardClient';
import {
  marketEventsCardEnabled,
  marketStatusCardEnabled,
  newsFilterEnabled,
  watchlistV2Enabled,
} from '@/src/config/features';
import { loadMarketStatus, loadMarketStatusWithHistory } from '@/src/lib/market-status/service';
import { AlertsRepository } from '@/src/lib/alerts/repository';
import { buildUpcomingFeed, UPCOMING_CARD_LIMIT, type UpcomingAlertInput } from '@/src/lib/upcoming/build';
import { loadUpcomingEarnings, upcomingEarningsSymbols } from '@/src/lib/upcoming/service';
import { resolveOnboardingView, type OnboardingView } from '@/src/lib/onboarding/onboarding';
import type { PortfolioGoal, PortfolioRecord } from '@/src/lib/portfolio/types';
import { buildMarketEventsCardView } from '@/src/lib/market-events/card-view';
import { overviewV2Enabled } from '@/src/config/features';
import { after } from 'next/server';

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default async function Home() {
  const generatedAt = new Date().toISOString();
  const client = await createClient();
  const user = client ? (await client.auth.getUser()).data.user : null;
  let portfolios: PortfolioRecord[] = [];
  let aggregateGoal: PortfolioGoal = { targetValueUsd: null, targetDate: null };
  let watchlistSymbols: string[] = [];
  /*
   * What the preview card needs to explain itself: every list the reader owns,
   * which one it is drawing from, and whether the "ดูทั้งหมด" link has more
   * behind it. Null while `WATCHLIST_V2` is off, which is what keeps the
   * existing card byte-identical.
   */
  let watchlistPreview: {
    lists: WatchlistSummary[];
    selectedId: string;
    hasMore: boolean;
  } | null = null;
  let onboarding: OnboardingView = { kind: 'none' };

  if (client && user) {
    const portfolioRepository = new PortfolioRepository(client);
    const [portfolioResult, goalResult, watchlistResult, onboardingResult] = await Promise.allSettled([
      portfolioRepository.getAll(),
      portfolioRepository.getAggregateGoal(),
      new WatchlistRepository(client).getDefault(),
      /*
       * Onboarding state lives on the preference row this account already has —
       * four nullable columns, read here in one select. A read that fails leaves
       * the view at `none`: nobody should meet a first-run question because a
       * query blipped.
       */
      client.from('user_settings')
        .select('onboarding_path, onboarding_chosen_at, onboarding_dismissed_at, onboarding_hint_done_at')
        .eq('user_id', user.id)
        .maybeSingle(),
    ]);
    portfolios = portfolioResult.status === 'fulfilled'
      ? portfolioResult.value
      : [];
    aggregateGoal = goalResult.status === 'fulfilled' ? goalResult.value : aggregateGoal;
    watchlistSymbols = watchlistResult.status === 'fulfilled'
      ? watchlistResult.value.items.map((item) => item.symbol)
      : [];

    /*
     * The preview, when the flag is on.
     *
     * `getDefault()` above already resolved the same list the database would —
     * `get_or_create_default_watchlist` returns the chosen one, or the oldest —
     * so this re-resolves only to hand the client the id it is showing and the
     * list of alternatives. The five symbols are chosen by `overviewPreview`,
     * whose order is stated: pinned first, then oldest, ties by symbol.
     *
     * The cut happens HERE, on the data, before a price is fetched. Rows six
     * and beyond are not loaded, not rendered and not in the payload — a wide
     * screen shows the same five as a phone.
     */
    if (watchlistV2Enabled() && watchlistResult.status === 'fulfilled') {
      const selected = watchlistResult.value;
      const lists = await new WatchlistRepository(client).listAll().catch(() => []);
      const preview = overviewPreview(selected.items);
      watchlistSymbols = preview.map((item) => item.symbol);
      watchlistPreview = {
        lists,
        selectedId: resolveOverviewWatchlist(lists, selected.id)?.id ?? selected.id,
        hasMore: previewHasMore(selected.items.length),
      };
    }

    /*
     * A read that FAILED and a row that does not exist are deliberately
     * different answers here. No row means a genuinely new account, which is
     * the one state that should meet the question; a failed read — a blipped
     * query, or a deployment that landed ahead of its migration — means the
     * product knows nothing, and the safe thing to know nothing about is
     * whether somebody has already been onboarded. Collapsing the two would
     * show every existing reader a first-run question they have already
     * answered.
     */
    const readable = onboardingResult.status === 'fulfilled' && !onboardingResult.value.error;
    const settings = readable ? onboardingResult.value.data : null;
    const chosenPath = settings?.onboarding_path ?? null;
    /*
     * Whether the hint's job is already done, answered from state this render
     * already holds. Only two of the four paths have an observable outcome; the
     * other two are dismissed by the reader, which is why the hint carries its
     * own dismiss control.
     */
    const achieved = chosenPath === 'watchlist'
      ? watchlistSymbols.length > 0
      : chosenPath === 'portfolio'
        ? portfolios.some((portfolio) => portfolio.transactions.length > 0)
        : undefined;
    onboarding = !readable ? { kind: 'none' } : resolveOnboardingView({
      state: settings === null ? null : {
        path: settings.onboarding_path,
        chosenAt: settings.onboarding_chosen_at,
        dismissedAt: settings.onboarding_dismissed_at,
        hintDoneAt: settings.onboarding_hint_done_at,
      },
      authenticated: true,
      achieved,
    });
  }

  const portfolioSymbols = [...new Set(portfolios.flatMap((portfolio) => portfolio.transactions)
    .filter((item) =>
      item.type === 'acquisition'
      || item.type === 'disposal'
      || item.type === 'initial_position')
    .map((item) => item.symbol)
    .filter((value): value is string => Boolean(value)))];
  /*
   * Contract symbols come off the ledger directly rather than out of the option
   * preview, because the snapshots are loaded before the preview is replayed
   * and a contract that is fully closed costs nothing to look up. This set only
   * decides which snapshot rows to ask for; what is OPEN is still decided by
   * the ledger replay below.
   */
  const portfolioContractSymbols = [...new Set(portfolios
    .flatMap((portfolio) => portfolio.transactions)
    .map((item) => item.contractSymbol)
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toUpperCase()))];

  const overviewNow = new Date(generatedAt);
  const industryResult = loadIndustryDashboardSnapshot(overviewNow);
  const breadth = loadMarketBreadthSnapshot(overviewNow);
  after(async () => {
    await Promise.allSettled([
      warmIndustryDashboard(overviewNow),
      warmMarketBreadth(overviewNow),
    ]);
  });

  const [indices, watchlist, portfolioPriceMap, fxResult] = await Promise.all([
    loadMarketIndices(new Date(generatedAt)),
    loadWatchlistPrices(watchlistSymbols, new Date(generatedAt)),
    loadPortfolioPrices(portfolioSymbols, new Date(generatedAt)),
    settleWithin(
      getFxRate('USD', 'THB').catch(() => ({ quote: null, unavailable: true })),
      1_500,
      { quote: null, unavailable: true },
    ),
  ]);

  /*
   * The captured closes for everything this reader holds.
   *
   * Loaded unconditionally rather than only when the market is shut: the
   * session governs which pair of prices the day figure USES, and asking for
   * the snapshots only in some sessions would mean the fallback is missing on
   * exactly the render where the session flips mid-request. One indexed read
   * of at most a few dozen rows, and a failure degrades to the old live-only
   * behaviour instead of failing the page.
   */
  const portfolioSession = marketSession(overviewNow);
  const daySnapshots = client
    ? await loadDailySnapshots(client, [...portfolioSymbols, ...portfolioContractSymbols], overviewNow)
      .catch(() => new Map<string, DaySnapshotInput>())
    : new Map<string, DaySnapshotInput>();

  const marketPrices = Object.fromEntries(
    [...portfolioPriceMap].flatMap(([symbol, loaded]) => {
      const price = loaded.display.price;
      if (price === null) return [];
      return [[symbol, {
        price,
        previousClose: loaded.display.change === null
          ? null
          : price - loaded.display.change,
        cached: loaded.display.status === 'saved',
        stale: loaded.display.freshness?.status === 'stale',
        asOf: loaded.display.asOf,
        daySnapshot: daySnapshots.get(symbol) ?? null,
      }]];
    }),
  );
  const optionPreviews = new Map(portfolios.map((portfolio) => [
    portfolio.id,
    calculateOptionLedger(portfolio.transactions),
  ]));
  let optionService: ReturnType<typeof getOptionsMarketDataService> | null = null;
  try { optionService = getOptionsMarketDataService(); } catch { optionService = null; }
  const optionQuotes = await loadPortfolioOptionQuotes(
    [...optionPreviews.values()]
      .flatMap((preview) => preview.positions.filter((position) => position.status === 'open')),
    optionService
      ? async (underlying, expiration) =>
        (await optionService!.getChain(underlying, expiration)).data
      : undefined,
  );
  /*
   * Snapshots joined onto the contract quotes by OCC symbol — see the same join
   * on `/portfolio`, which does it for the detail rows. Without it a portfolio
   * holding one open contract has a null options day figure outside the
   * session, and a null there nulls the whole card's figure.
   */
  const contractSymbolByKey = new Map([...optionPreviews.values()]
    .flatMap((preview) => preview.positions.map((item) => [item.key, item.contractSymbol] as const)));
  for (const [key, quote] of Object.entries(optionQuotes)) {
    if (!quote) continue;
    const contractSymbol = contractSymbolByKey.get(key);
    if (contractSymbol) quote.daySnapshot = daySnapshots.get(contractSymbol.toUpperCase()) ?? null;
  }

  const portfolioOverview = buildOverviewPortfolio({
    authenticated: Boolean(user),
    portfolios,
    aggregateGoal,
    marketPrices,
    optionQuotes,
    evaluatedAt: generatedAt,
    session: portfolioSession,
  });
  /*
   * "สิ่งที่ควรรู้เร็ว ๆ นี้" — assembled from state this render already has.
   *
   * The contracts come from the option ledger that was just replayed above, the
   * prices from the two quote maps already loaded, and only the earnings
   * calendar costs anything new — capped, deadlined and cached inside its own
   * service. A signed-out visitor has none of these, so nothing is asked for.
   */
  const alerts = client && user
    ? await new AlertsRepository(client, user.id).list().catch(() => [])
    : [];
  const quoteBySymbol = new Map<string, { price: number | null; changePercent: number | null }>([
    ...[...portfolioPriceMap].map(([symbol, loaded]) => [
      symbol,
      { price: loaded.display.price, changePercent: loaded.display.changePercent },
    ] as const),
    ...watchlist.map((item) => [
      item.symbol,
      { price: item.price, changePercent: item.changePercent },
    ] as const),
  ]);
  const alertInputs: UpcomingAlertInput[] = alerts.map((alert) => ({
    id: alert.id,
    symbol: alert.symbol,
    condition: alert.condition,
    targetValue: alert.targetValue,
    enabled: alert.enabled,
    price: quoteBySymbol.get(alert.symbol)?.price ?? null,
    changePercent: quoteBySymbol.get(alert.symbol)?.changePercent ?? null,
  }));
  const openOptionPositions = portfolioOverview.summary?.optionPositions ?? [];
  const earnings = user
    ? await loadUpcomingEarnings(upcomingEarningsSymbols(portfolioSymbols, watchlistSymbols))
    : [];
  const upcoming = buildUpcomingFeed({
    earnings,
    positions: openOptionPositions,
    alerts: alertInputs,
    limit: UPCOMING_CARD_LIMIT,
  });

  const serviceStatus = buildServiceStatus({
    checkedAt: generatedAt,
    indices,
    watchlist,
    industryCandidateCount: industryResult.candidateCount,
    industries: industryResult.industries.length,
    breadthAvailable: Boolean(breadth),
    industryRefreshing: industryResult.state === 'refreshing',
  });
  const limitations = industryResult.state === 'refreshing'
    ? ['กำลังรวบรวมราคาช่วงตลาดปกติ ระบบจะแสดงเฉพาะกลุ่มที่มีข้อมูลจริงอย่างน้อย 5 บริษัท']
    : industryResult.candidateCount === 0
      ? ['ข้อมูลราคายังไม่เพียงพอสำหรับจัดอันดับอุตสาหกรรม']
      : [];

  /*
   * The Market Status card, behind `MARKET_STATUS_CARD` and OFF by default.
   *
   * Loaded only when the flag is on, so a reader with the flag unset pays for
   * none of the six provider calls — the flag is a shipping switch, not a render
   * switch. A failure degrades to `undefined`, which the overview renders as no
   * card at all: this is an addition to the page and must never be able to take
   * the rest of it down.
   *
   * No history is passed yet, so the hold rule publishes today's reading
   * immediately. That is the correct behaviour for a first render rather than a
   * degraded one — persisting the sequence is its own change, with its own
   * table, and the rule is already written to accept it.
   */
  const marketStatus = marketStatusCardEnabled()
    ? await (client
      /*
        With a client, the hold rule gets its memory: previous raw labels are
        read back and today's reading is recorded. Without one — a signed-out
        visitor, or Supabase not configured — the card falls back to the
        un-persisted path, which publishes immediately. That is the same
        first-render behaviour the rule already defines, not a degraded mode.
      */
      ? loadMarketStatusWithHistory(client, overviewNow)
      : loadMarketStatus(overviewNow))
      .then((result) => ({ evaluation: result.evaluation, sessionDate: result.sessionDate }))
      .catch(() => undefined)
    : undefined;

  return (
    <DashboardClient
      onboarding={onboarding}
      data={{
        generatedAt,
        serviceStatus,
        portfolio: portfolioOverview,
        usdThbRate: fxResult.quote?.rate ?? null,
        indices,
        industries: industryResult.industries,
        watchlist,
        watchlistPreview,
        breadth,
        industryData: {
          state: industryResult.state,
          classificationUpdatedAt: industryResult.classificationUpdatedAt,
          quotesUpdatedAt: industryResult.quotesUpdatedAt,
          candidateCount: industryResult.candidateCount,
          completedCount: industryResult.completedCount,
          deadlineReached: industryResult.deadlineReached,
        },
        /*
         * THE READER'S OWN SYMBOLS, AND ONLY WHEN THE FILTER IS ON.
         *
         * With `NEWS_FILTER` off these stay empty and the overview renders the
         * market-wide feed exactly as it shipped — one request, no tabs. With
         * it on the same component asks for the PERSONALIZED feed instead,
         * which is a different request to the same endpoint rather than an
         * additional one, and is what makes the tagger attach these symbols to
         * an article. Filtering a market-wide payload would leave พอร์ต and
         * Watchlist permanently empty, because market-wide stories carry no
         * symbols by design.
         *
         * Both lists were computed above for the quote loads. Passing them
         * here costs nothing new.
         */
        newsContext: newsFilterEnabled()
          ? { portfolioSymbols, watchlistSymbols, industryNames: [] }
          : { portfolioSymbols: [], watchlistSymbols: [], industryNames: [] },
        upcoming,
        marketStatus,
        /*
         * The calendar card, behind `MARKET_EVENTS_CARD` and OFF by default.
         *
         * Costs NO provider call in either state — the calendar is a static
         * JSON file in the bundle — so this is a pure render switch, unlike
         * `marketStatus` above where the flag is also a spending switch.
         *
         * Built here rather than in the client so the file and the Intl
         * formatters stay server-side, and so "today" is resolved once, from
         * the same `generatedAt` every other figure on this page is built
         * against.
         */
        marketEvents: marketEventsCardEnabled()
          ? buildMarketEventsCardView({ now: generatedAt })
          : null,
        overviewV2: overviewV2Enabled(),
        limitations,
      }}
    />
  );
}
