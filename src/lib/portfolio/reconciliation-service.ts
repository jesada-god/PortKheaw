import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { loadPortfolioPrices } from '@/src/lib/overview/service';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { calculatePortfolio } from './calculations';
import { calculateOptionLedger } from './options/calculations';
import { loadPortfolioOptionQuotes } from './options/quote-pipeline';
import { PortfolioRepository } from './repository';
import type { MarketPriceInput, PortfolioRecord, PortfolioSummary } from './types';

/**
 * Recomputes one portfolio from its own ledger and live prices.
 *
 * The reconciliation action decides how much cash to move from this, never
 * from a total the browser reports — the browser's copy is a render of the
 * same ledger, but it is not evidence.
 */
export async function loadPortfolioReconciliationSnapshot(
  client: SupabaseClient<Database>,
  portfolioId: string,
): Promise<{ portfolio: PortfolioRecord; summary: PortfolioSummary } | null> {
  const repository = new PortfolioRepository(client);
  const portfolio = await repository.getById(portfolioId);
  if (!portfolio) return null;

  const stockSymbols = [...new Set(portfolio.transactions
    .filter((item) => item.type === 'acquisition' || item.type === 'disposal' || item.type === 'initial_position')
    .map((item) => item.symbol)
    .filter((value): value is string => Boolean(value)))];

  const canonical = await loadPortfolioPrices(stockSymbols);
  const prices: Record<string, MarketPriceInput> = {};
  for (const symbol of stockSymbols) {
    const item = canonical.get(symbol)?.display;
    if (!item || item.price === null) continue;
    prices[symbol] = {
      price: item.price,
      previousClose: item.change === null ? null : item.price - item.change,
      cached: item.status === 'saved',
      stale: item.freshness?.status === 'stale',
      source: 'canonical-market-snapshot',
      asOf: item.asOf,
    };
  }

  let optionService: ReturnType<typeof getOptionsMarketDataService> | null = null;
  try { optionService = getOptionsMarketDataService(); } catch { optionService = null; }
  const openOptions = calculateOptionLedger(portfolio.transactions).positions
    .filter((item) => item.status === 'open');
  const optionQuotes = await loadPortfolioOptionQuotes(
    openOptions,
    optionService
      ? async (underlying, expiration) => (await optionService!.getChain(underlying, expiration)).data
      : undefined,
  );

  return { portfolio, summary: calculatePortfolio(portfolio.transactions, prices, optionQuotes) };
}
