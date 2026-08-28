import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
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
import { AlertsRepository } from '@/src/lib/alerts/repository';
import { buildUpcomingFeed, UPCOMING_CARD_LIMIT, type UpcomingAlertInput } from '@/src/lib/upcoming/build';
import { loadUpcomingEarnings, upcomingEarningsSymbols } from '@/src/lib/upcoming/service';
import { resolveOnboardingView, type OnboardingView } from '@/src/lib/onboarding/onboarding';
import type { PortfolioGoal, PortfolioRecord } from '@/src/lib/portfolio/types';
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
        breadth,
        industryData: {
          state: industryResult.state,
          classificationUpdatedAt: industryResult.classificationUpdatedAt,
          quotesUpdatedAt: industryResult.quotesUpdatedAt,
          candidateCount: industryResult.candidateCount,
          completedCount: industryResult.completedCount,
          deadlineReached: industryResult.deadlineReached,
        },
        newsContext: { portfolioSymbols: [], watchlistSymbols: [], industryNames: [] },
        upcoming,
        limitations,
      }}
    />
  );
}
