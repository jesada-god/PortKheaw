import Header from '@/src/components/layout/Header';
import { PortfolioClient } from '@/src/components/portfolio/PortfolioClient';
import { InstrumentLogoProvider } from '@/src/components/instruments/InstrumentLogoProvider';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { loadPortfolioPrices } from '@/src/lib/overview/service';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { calculateOptionLedger } from '@/src/lib/portfolio/options/calculations';
import { OptionTargetRepository } from '@/src/lib/portfolio/options/target-repository';
import { loadPortfolioOptionQuotes } from '@/src/lib/portfolio/options/quote-pipeline';
import { optionPositionTitle } from '@/src/lib/portfolio/options/presentation';
import { optionMarketDate } from '@/src/lib/portfolio/options/settlement';
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
  const [portfolios, aggregateGoal, timezone, entitlement, recentlyDeleted] = await Promise.all([
    portfolioRepository.getAll(),
    portfolioRepository.getAggregateGoal(),
    portfolioRepository.getTimeZone(),
    resolvePageEntitlement(),
    // The recovery window. The only read on this page that returns a deleted
    // portfolio, and it deliberately carries no ledger with it.
    portfolioRepository.getRecentlyDeleted(),
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
  /*
   * The same resolver every other surface reads, so a holding shows the logo the
   * watchlist and Stock Detail show — and shows it from the instrument master,
   * without a provider round trip per row.
   */
  const instrumentLogos = Object.fromEntries(stockSymbols.map((symbol) => [
    symbol,
    canonicalPrices.get(symbol)?.display.instrument.logoUrl ?? null,
  ]));
  /*
   * The same snapshot, read twice more for two labels rather than a price: the
   * instrument master's `asset_type`, which is what sorts a holding into หุ้น or
   * ETF on the asset view, and its company name, which is what a row shows under
   * the symbol. Both are already loaded — this adds no query and no provider
   * call — and neither takes part in any valuation.
   */
  const instrumentAssetTypes = Object.fromEntries(stockSymbols.map((symbol) => [
    symbol,
    canonicalPrices.get(symbol)?.display.instrument.assetType ?? null,
  ]));
  const instrumentNames = Object.fromEntries(stockSymbols.map((symbol) => [
    symbol,
    canonicalPrices.get(symbol)?.display.instrument.companyName ?? null,
  ]));
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
    <InstrumentLogoProvider logos={instrumentLogos}>
      <PortfolioClient
        portfolios={portfolios}
        aggregateGoal={aggregateGoal}
        marketPrices={Object.fromEntries(quotes)}
        optionQuotes={optionQuotes}
        optionTargets={targets}
        recentlyDeleted={recentlyDeleted}
        fx={fx}
        timezone={timezone}
        /*
          Resolved here, on the server, because it decides whether an option's
          "หมดอายุ" button is available — and a contract expires on the exchange's
          day, not the reader's. Reading a clock inside the client component
          would also put a different answer into the hydrated render than the one
          in the server HTML.
        */
        marketDate={optionMarketDate()}
        effectiveTier={effectiveTier}
        assetTypes={instrumentAssetTypes}
        companyNames={instrumentNames}
      />
    </InstrumentLogoProvider>
  </div>;
}
