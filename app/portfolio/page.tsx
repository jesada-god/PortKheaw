import Header from '@/src/components/layout/Header';
import { PortfolioClient } from '@/src/components/portfolio/PortfolioClient';
import { InstrumentLogoProvider } from '@/src/components/instruments/InstrumentLogoProvider';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { loadPortfolioPrices } from '@/src/lib/overview/service';
import { marketSession } from '@/src/lib/market-data/market-session';
import { loadDailySnapshots } from '@/src/lib/market-data/daily-snapshot';
import type { DaySnapshotInput } from '@/src/lib/portfolio/day-change';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { calculateOptionLedger } from '@/src/lib/portfolio/options/calculations';
import { OptionTargetRepository } from '@/src/lib/portfolio/options/target-repository';
import { loadPortfolioOptionQuotes } from '@/src/lib/portfolio/options/quote-pipeline';
import { optionPositionTitle } from '@/src/lib/portfolio/options/presentation';
import { optionMarketDate } from '@/src/lib/portfolio/options/settlement';
import { resolvePageEntitlement } from '@/src/lib/subscription/page-entitlement';
import { recordBetaFunnelEvent } from '@/src/lib/beta/beta-server';

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
  // Which surfaces are genuinely used, once per account per day, per surface.
  void recordBetaFunnelEvent({ event: 'feature_used', featureKey: 'portfolio' }).catch(() => {});
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
  /*
   * The instrument master's `sector`, read off the very same snapshot as the
   * logo, the asset type and the company name above. It is a label, never an
   * input to a valuation: the daily insight uses it only to group today's
   * already-calculated per-holding change, and a symbol with no sector simply
   * takes no part in that grouping.
   */
  const instrumentSectors = Object.fromEntries(stockSymbols.map((symbol) => [
    symbol,
    canonicalPrices.get(symbol)?.display.instrument.sector ?? null,
  ]));
  /*
   * The captured closes behind the day figure. Same read the overview does, for
   * the same reason: outside the regular session a live quote no longer carries
   * a previous close, and without these the tracker prints a dash beside every
   * position all evening. Failure degrades to live-only rather than failing the
   * page.
   */
  const portfolioSession = marketSession(new Date());
  const daySnapshots = await loadDailySnapshots(
    client,
    [...stockSymbols, ...[...optionPreviews.values()].flatMap((preview) =>
      preview.positions.filter((item) => item.status === 'open').map((item) => item.contractSymbol))],
  ).catch(() => new Map<string, DaySnapshotInput>());

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
      daySnapshot: daySnapshots.get(symbol) ?? null,
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
  /*
   * The contract quotes are keyed by ledger position key; the snapshots are
   * keyed by OCC contract symbol, because that is what identifies a contract to
   * everything outside this ledger. The positions carry both, so the join is
   * done here once rather than by teaching either side about the other's key.
   *
   * A contract quote is where the missing previous close was most visible: the
   * options detail rows showed "—" with "ไม่มีราคาปิดวันก่อน" under them for
   * most of every day.
   */
  const contractSymbolByKey = new Map([...optionPreviews.values()]
    .flatMap((preview) => preview.positions.map((item) => [item.key, item.contractSymbol] as const)));
  for (const [key, quote] of Object.entries(optionQuotes)) {
    if (!quote) continue;
    const contractSymbol = contractSymbolByKey.get(key);
    if (contractSymbol) quote.daySnapshot = daySnapshots.get(contractSymbol.toUpperCase()) ?? null;
  }

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
        /*
          Resolved on the server for the same reason `marketDate` is: the session
          decides whether the day figure is a live number or a named day's close,
          and a client resolving it from the browser clock would caption the
          hydrated render differently from the HTML it replaced.
        */
        session={portfolioSession}
        effectiveTier={effectiveTier}
        assetTypes={instrumentAssetTypes}
        companyNames={instrumentNames}
        sectors={instrumentSectors}
      />
    </InstrumentLogoProvider>
  </div>;
}
