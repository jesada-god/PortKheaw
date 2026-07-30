import Header from '@/src/components/layout/Header';
import { PortfolioClient } from '@/src/components/portfolio/PortfolioClient';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { getMarketDataProvider } from '@/src/lib/market-data';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { resolveQuote } from '@/src/lib/market-data/quote-cache';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { validMidpoint } from '@/src/lib/market-data/quote-model';
import { calculateOptionLedger } from '@/src/lib/portfolio/options/calculations';
import { OptionTargetRepository } from '@/src/lib/portfolio/options/target-repository';
import type { OptionQuoteFreshness, OptionQuoteInput } from '@/src/lib/portfolio/options/types';

function optionFreshness(status: string): OptionQuoteFreshness {
  if (status === 'live') return 'live';
  if (status === 'cached') return 'cached';
  if (status === 'stale') return 'stale';
  return 'delayed';
}

export default async function PortfolioPage() {
  const client = await createClient();
  if (!client) return null;
  const portfolio = await new PortfolioRepository(client).getDefault();
  const targetRepository = new OptionTargetRepository(client);
  const [targets, fx] = await Promise.all([
    targetRepository.getAll(portfolio.id),
    (async () => {
      try { return await getFxRate('USD', 'THB'); }
      catch { return { quote: null, unavailable: true }; }
    })(),
  ]);

  const optionPreview = calculateOptionLedger(portfolio.transactions);
  const stockSymbols = [...new Set(portfolio.transactions
    .filter((item) => item.type === 'acquisition' || item.type === 'disposal' || item.type === 'initial_position')
    .map((item) => item.symbol)
    .filter((value): value is string => Boolean(value)))];
  let provider: ReturnType<typeof getMarketDataProvider> | null = null;
  try { provider = getMarketDataProvider(); } catch { provider = null; }
  const quotes = await Promise.all(stockSymbols.map(async (symbol) => {
    if (!provider) return [symbol, null] as const;
    return [symbol, await resolveQuote(symbol, () => provider!.getQuote(symbol))] as const;
  }));

  const optionQuotes: Record<string, OptionQuoteInput | null> = {};
  const openGroups = new Map<string, typeof optionPreview.positions>();
  for (const position of optionPreview.positions.filter((item) => item.status === 'open')) {
    const groupKey = `${position.underlyingSymbol}:${position.expirationDate}`;
    openGroups.set(groupKey, [...(openGroups.get(groupKey) ?? []), position]);
  }
  let optionService: ReturnType<typeof getOptionsMarketDataService> | null = null;
  try { optionService = getOptionsMarketDataService(); } catch { optionService = null; }
  await Promise.all([...openGroups.entries()].map(async ([groupKey, positions]) => {
    if (!optionService) {
      for (const position of positions) optionQuotes[position.key] = null;
      return;
    }
    const separator = groupKey.lastIndexOf(':');
    const underlying = groupKey.slice(0, separator);
    const expiration = groupKey.slice(separator + 1);
    try {
      const result = await optionService.getChain(underlying, expiration);
      const contracts = [...result.data.calls, ...result.data.puts];
      for (const position of positions) {
        const contract = contracts.find((item) =>
          item.contractSymbol.toUpperCase() === position.contractSymbol.toUpperCase());
        if (!contract) {
          optionQuotes[position.key] = null;
          continue;
        }
        optionQuotes[position.key] = {
          bid: contract.bid,
          ask: contract.ask,
          mark: contract.mark ?? validMidpoint(contract.bid, contract.ask),
          previousClose: null,
          underlyingPrice: result.data.spot,
          impliedVolatility: contract.impliedVolatility,
          delta: contract.delta,
          theta: contract.theta,
          source: contract.marketDataProvider ?? contract.provider,
          asOf: contract.asOf,
          freshness: optionFreshness(contract.status),
        };
      }
    } catch {
      for (const position of positions) optionQuotes[position.key] = null;
    }
  }));

  await Promise.allSettled(targets.filter((target) => target.enabled && !target.triggeredAt).map(async (target) => {
    const position = optionPreview.positions.find((item) => item.contractSymbol === target.contractSymbol && item.status === 'open');
    const quote = position ? optionQuotes[position.key] : null;
    if (!quote || quote.mark === null || quote.freshness === 'stale' || quote.freshness === 'missing' || !quote.asOf) return;
    await targetRepository.evaluate(target, quote.mark, quote.asOf);
  }));

  return <div className="min-w-0">
    <Header title="พอร์ตโฟลิโอจำลอง" subtitle="คำนวณใหม่จาก Transaction Ledger ทุกครั้ง โดยไม่ส่งคำสั่งซื้อขายจริง" />
    <PortfolioClient
      portfolio={portfolio}
      marketPrices={Object.fromEntries(quotes)}
      optionQuotes={optionQuotes}
      optionTargets={targets}
      fx={fx}
    />
  </div>;
}
