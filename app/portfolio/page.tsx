import Header from '@/src/components/layout/Header';
import { PortfolioClient } from '@/src/components/portfolio/PortfolioClient';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { getMarketDataProvider } from '@/src/lib/market-data';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { resolveQuote } from '@/src/lib/market-data/quote-cache';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { calculateOptionLedger } from '@/src/lib/portfolio/options/calculations';
import { OptionTargetRepository } from '@/src/lib/portfolio/options/target-repository';
import { loadPortfolioOptionQuotes } from '@/src/lib/portfolio/options/quote-pipeline';
import { optionPositionTitle } from '@/src/lib/portfolio/options/presentation';

export default async function PortfolioPage() {
  const client = await createClient();
  if (!client) return null;
  const portfolioRepository = new PortfolioRepository(client);
  const [portfolios, aggregateGoal] = await Promise.all([
    portfolioRepository.getAll(),
    portfolioRepository.getAggregateGoal(),
  ]);
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
  let provider: ReturnType<typeof getMarketDataProvider> | null = null;
  try { provider = getMarketDataProvider(); } catch { provider = null; }
  const quotes = await Promise.all(stockSymbols.map(async (symbol) => {
    if (!provider) return [symbol, null] as const;
    return [symbol, await resolveQuote(symbol, () => provider!.getQuote(symbol))] as const;
  }));

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
    />
  </div>;
}
