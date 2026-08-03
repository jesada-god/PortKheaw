import Header from '@/src/components/layout/Header';
import { PortfolioClient } from '@/src/components/portfolio/PortfolioClient';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { loadPortfolioPrices } from '@/src/lib/overview/service';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { calculateOptionLedger } from '@/src/lib/portfolio/options/calculations';
import { OptionTargetRepository } from '@/src/lib/portfolio/options/target-repository';
import { loadPortfolioOptionQuotes } from '@/src/lib/portfolio/options/quote-pipeline';
import { optionPositionTitle } from '@/src/lib/portfolio/options/presentation';
import { resolvePageEntitlement } from '@/src/lib/subscription/page-entitlement';

export default async function PortfolioPage() {
  const client = await createClient();
  if (!client) return null;
  const portfolioRepository = new PortfolioRepository(client);
  /*
   * The *access* tier, not the subscription tier.
   *
   * This page used to read the subscription snapshot directly, which meant the
   * portfolio surface was the one place that judged a reader by what they had
   * paid for rather than by what they may open. An administrator — whose plan is
   * Basic and whose access is Elite — saw Options locked here while every other
   * gate on the site let them through, and an administrator previewing Pro saw
   * their real access rather than the plan under test. `resolvePageEntitlement`
   * is the same resolver the root layout and every API guard read, and it is
   * request-cached, so agreeing with them costs no extra round trip.
   */
  const [portfolios, aggregateGoal, timezone, entitlement] = await Promise.all([
    portfolioRepository.getAll(),
    portfolioRepository.getAggregateGoal(),
    portfolioRepository.getTimeZone(),
    resolvePageEntitlement(),
  ]);
  const effectiveTier = entitlement.effectiveAccessTier;
  const targetRepository = new OptionTargetRepository(client);
  const [targets, fx] = await Promise.all([
    targetRepository.getAll(),
    (async () => {
      try { return await getFxRate('USD', 'THB'); }
      catch { return { quote: null, unavailable: true }; }
    })(),
  ]);

  const optionPreviews = new Map(portfolios.map((portfolio) => [
    portfolio.id,
    calculateOptionLedger(portfolio.transactions),
  ]));
  const stockSymbols = [...new Set(portfolios.flatMap((portfolio) => portfolio.transactions)
    .filter((item) => item.type === 'acquisition' || item.type === 'disposal' || item.type === 'initial_position')
    .map((item) => item.symbol)
    .filter((value): value is string => Boolean(value)))];
  const canonicalPrices = await loadPortfolioPrices(stockSymbols);
  const quotes = stockSymbols.map((symbol) => {
    const item = canonicalPrices.get(symbol)?.display;
    if (!item || item.price === null) return [symbol, null] as const;
    return [symbol, {
      price: item.price,
      previousClose: item.change === null ? null : item.price - item.change,
      cached: item.status === 'saved',
      stale: item.freshness?.status === 'stale',
      source: 'canonical-market-snapshot',
      asOf: item.asOf,
    }] as const;
  });

  let optionService: ReturnType<typeof getOptionsMarketDataService> | null = null;
  try { optionService = getOptionsMarketDataService(); } catch { optionService = null; }
  const optionQuotes = await loadPortfolioOptionQuotes(
    [...optionPreviews.values()].flatMap((preview) => preview.positions.filter((item) => item.status === 'open')),
    optionService
      ? async (underlying, expiration) => (await optionService!.getChain(underlying, expiration)).data
      : undefined,
  );

  await Promise.allSettled(targets.filter((target) => target.enabled && !target.triggeredAt).map(async (target) => {
    const position = optionPreviews.get(target.portfolioId)?.positions
      .find((item) => item.contractSymbol === target.contractSymbol && item.status === 'open');
    const quote = position ? optionQuotes[position.key] : null;
    if (!position || !quote || quote.mark === null || quote.freshness === 'stale' || quote.freshness === 'missing' || !quote.asOf) return;
    await targetRepository.evaluate(target, quote.mark, quote.asOf, optionPositionTitle(position));
  }));

  return <div className="min-w-0">
    <Header title="พอร์ตโฟลิโอจำลอง" subtitle="คำนวณใหม่จาก Transaction Ledger ทุกครั้ง โดยไม่ส่งคำสั่งซื้อขายจริง" />
    <PortfolioClient
      portfolios={portfolios}
      aggregateGoal={aggregateGoal}
      marketPrices={Object.fromEntries(quotes)}
      optionQuotes={optionQuotes}
      optionTargets={targets}
      fx={fx}
      timezone={timezone}
      effectiveTier={effectiveTier}
    />
  </div>;
}
