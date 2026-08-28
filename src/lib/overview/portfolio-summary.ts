import { aggregatePortfolioSummaries, portfolioValuationCoverage } from '@/src/lib/portfolio/aggregate';
import { calculatePortfolio } from '@/src/lib/portfolio/calculations';
import type {
  MarketPriceInput,
  PortfolioGoal,
  PortfolioRecord,
  PortfolioSummary,
} from '@/src/lib/portfolio/types';
import type { OptionQuoteInput } from '@/src/lib/portfolio/options/types';
import type { MarketSession } from '@/src/lib/market-data/market-session';
import { US_EQUITY_TIMEZONE, exchangeSessionDate } from '@/src/lib/market-data/session';
import type { PortfolioOverview } from './types';

export function latestPortfolioValuationAt(summary: PortfolioSummary): string | null {
  return [
    ...summary.holdings.map((holding) => holding.priceAsOf),
    ...summary.optionPositions.map((position) => position.quoteAsOf),
  ].filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
}

/**
 * Overview and Portfolio intentionally share the same ledger calculators. Each
 * ledger is calculated in isolation first, then combined exactly once.
 */
export function buildOverviewPortfolio(input: {
  authenticated: boolean;
  portfolios: readonly PortfolioRecord[];
  aggregateGoal: PortfolioGoal;
  marketPrices: Record<string, MarketPriceInput>;
  optionQuotes: Record<string, OptionQuoteInput | null>;
  evaluatedAt: string;
  /*
    Which prices the day figure is the difference of. Resolved once, on the
    server, from `evaluatedAt` — never per portfolio and never in the browser,
    so every card in one render is captioned with the same session and a reader
    in Bangkok sees the exchange's answer rather than their own clock's.
  */
  session?: MarketSession;
}): PortfolioOverview {
  const summaries = input.portfolios.map((portfolio) =>
    calculatePortfolio(portfolio.transactions, input.marketPrices, input.optionQuotes, undefined, input.session));
  const aggregate = summaries.length ? aggregatePortfolioSummaries(summaries) : null;
  const preferred = input.portfolios.find((portfolio) => !portfolio.archivedAt)
    ?? input.portfolios[0]
    ?? null;

  return {
    authenticated: input.authenticated,
    portfolioCount: input.portfolios.filter((portfolio) => !portfolio.archivedAt).length,
    totalPortfolioCount: input.portfolios.length,
    portfolioName: aggregate ? 'รวมทุกพอร์ต' : null,
    summary: aggregate,
    baseCurrency: preferred?.baseCurrency ?? 'USD',
    targetValueUsd: input.aggregateGoal.targetValueUsd,
    targetDate: input.aggregateGoal.targetDate,
    valuedAt: aggregate ? latestPortfolioValuationAt(aggregate) ?? input.evaluatedAt : null,
    todayExchangeDate: exchangeSessionDate(input.evaluatedAt, US_EQUITY_TIMEZONE),
    coverage: aggregate ? portfolioValuationCoverage(aggregate) : null,
    portfolios: input.portfolios.map((portfolio, index) => ({
      id: portfolio.id,
      name: portfolio.name,
      archived: Boolean(portfolio.archivedAt),
      summary: summaries[index]!,
      baseCurrency: portfolio.baseCurrency,
      targetValueUsd: portfolio.targetValueUsd,
      targetDate: portfolio.targetDate,
      valuedAt: latestPortfolioValuationAt(summaries[index]!) ?? input.evaluatedAt,
      coverage: portfolioValuationCoverage(summaries[index]!),
    })),
  };
}
