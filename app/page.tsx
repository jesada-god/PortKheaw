import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
import { calculatePortfolio } from '@/src/lib/portfolio/calculations';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import {
  buildServiceStatus,
  loadIndustryDashboardSnapshot,
  loadMarketIndices,
  loadPortfolioPrices,
  loadWatchlistPrices,
  warmIndustryDashboard,
} from '@/src/lib/overview/service';
import { DashboardClient } from '@/src/components/dashboard/DashboardClient';
import type { PortfolioRecord } from '@/src/lib/portfolio/types';
import { rankIndustries } from '@/src/lib/overview/industry-ranking';
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
  let watchlistSymbols: string[] = [];
  let targetValueUsd: number | null = null;

  if (client && user) {
    const portfolioRepository = new PortfolioRepository(client);
    const [portfolioResult, watchlistResult, goalResult] = await Promise.allSettled([
      portfolioRepository.getAll(),
      new WatchlistRepository(client).getDefault(),
      portfolioRepository.getAggregateGoal(),
    ]);
    portfolios = portfolioResult.status === 'fulfilled'
      ? portfolioResult.value.filter((portfolio) => !portfolio.archivedAt)
      : [];
    watchlistSymbols = watchlistResult.status === 'fulfilled'
      ? watchlistResult.value.items.map((item) => item.symbol)
      : [];
    targetValueUsd = goalResult.status === 'fulfilled'
      ? goalResult.value.targetValueUsd
      : null;
  }

  const transactions = portfolios.flatMap((portfolio) => portfolio.transactions);
  const portfolioSymbols = [...new Set(transactions.flatMap((row) => [
    row.symbol,
    row.underlyingSymbol,
  ]).filter((value): value is string => Boolean(value)))];

  const overviewNow = new Date(generatedAt);
  const industryResult = loadIndustryDashboardSnapshot(overviewNow);
  after(async () => {
    await warmIndustryDashboard(overviewNow);
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
      }]];
    }),
  );
  const hasPortfolioActivity = transactions.length > 0;
  const summary = hasPortfolioActivity
    ? calculatePortfolio(transactions, marketPrices)
    : null;
  const serviceStatus = buildServiceStatus({
    checkedAt: generatedAt,
    indices,
    watchlist,
    industryCandidateCount: industryResult.candidateCount,
    industries: industryResult.industries.length,
    breadthAvailable: Boolean(industryResult.breadth),
    industryRefreshing: industryResult.state === 'refreshing',
  });
  const limitations = industryResult.state === 'refreshing'
    ? ['กำลังรวบรวมราคาช่วงตลาดปกติ ระบบจะแสดงเฉพาะกลุ่มที่มีข้อมูลจริงอย่างน้อย 5 บริษัท']
    : industryResult.candidateCount === 0
      ? ['ข้อมูลราคายังไม่เพียงพอสำหรับจัดอันดับอุตสาหกรรม']
      : [];

  return (
    <DashboardClient
      data={{
        generatedAt,
        serviceStatus,
        portfolio: {
          authenticated: Boolean(user),
          portfolioCount: portfolios.length,
          summary,
          baseCurrency: portfolios[0]?.baseCurrency ?? 'USD',
          targetValueUsd,
        },
        usdThbRate: fxResult.quote?.rate ?? null,
        indices,
        industries: industryResult.industries,
        watchlist,
        breadth: industryResult.breadth,
        industryData: {
          state: industryResult.state,
          classificationUpdatedAt: industryResult.classificationUpdatedAt,
          quotesUpdatedAt: industryResult.quotesUpdatedAt,
          candidateCount: industryResult.candidateCount,
          completedCount: industryResult.completedCount,
          deadlineReached: industryResult.deadlineReached,
        },
        newsContext: {
          portfolioSymbols: portfolioSymbols.slice(0, 6),
          watchlistSymbols: watchlistSymbols.slice(0, 6),
          industryNames: rankIndustries(
            industryResult.industries,
            'gainers',
            8,
          ).map((industry) => industry.name),
        },
        limitations,
      }}
    />
  );
}
