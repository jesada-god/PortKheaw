import 'server-only';

import { loadPortfolioPrices } from '@/src/lib/overview/service';
import { loadEarningsSchedule } from '@/src/lib/analytics/earnings/service';
import { mapWithConcurrency } from '@/src/lib/overview/service';
import type { OvAlertQuote } from './evaluate';
import type { OvAlertQuoteLoader } from './run';
import { OV_ALERT_UNIT } from './types';

/**
 * THE READINGS THE SWEEP JUDGES RULES AGAINST.
 *
 * ===========================================================================
 * THE SAME PIPELINE THE REST OF THE PRODUCT USES
 * ===========================================================================
 * `loadPortfolioPrices` is what the existing background pass already calls for
 * `price_alerts`, and what the Overview calls for its own rows. Using it here
 * means the sweep and the page cannot disagree about what a symbol is worth,
 * and it means the sweep pays nothing extra when the two run in the same
 * process minutes apart — the quote cache is shared.
 *
 * ===========================================================================
 * EARNINGS COSTS NOTHING WHEN NOBODY ASKS
 * ===========================================================================
 * The calendar is a provider call per symbol, so it is made ONLY for symbols
 * that actually carry an `earnings` rule. A deployment where nobody has one
 * spends nothing on it, and a deployment where three people watch NVDA spends
 * one call — the schedule is cached for twelve hours behind
 * `loadEarningsSchedule`, which is the same read the Overview performs.
 *
 * A symbol the calendar cannot answer for gets no `earningsDays`, and
 * `ovAlertMatches` reads that as silence rather than as "far away".
 */

/** Matches the concurrency the rest of the earnings loading uses. */
const EARNINGS_CONCURRENCY = 3;

/**
 * The loader the sweep runs with.
 *
 * It reads the RULES to decide what to fetch: prices for every symbol, and a
 * calendar lookup only for the symbols an `earnings` rule actually names.
 */
export function ovAlertSweepQuotes(now: Date = new Date()): OvAlertQuoteLoader {
  return async (rules) => {
    const symbols = [...new Set(rules.map((rule) => rule.symbol.trim().toUpperCase()))];
    const needsEarnings = new Set(
      rules
        .filter((rule) => OV_ALERT_UNIT[rule.kind] === 'days')
        .map((rule) => rule.symbol.trim().toUpperCase()),
    );
    const prices = await loadPortfolioPrices(symbols, now);

    const earnings = new Map<string, number | null>();
    const wanted = symbols.filter((symbol) => needsEarnings.has(symbol));
    if (wanted.length > 0) {
      const loaded = await mapWithConcurrency(
        wanted,
        EARNINGS_CONCURRENCY,
        async (symbol) => {
          try {
            const schedule = await loadEarningsSchedule(symbol);
            return [
              symbol,
              schedule.status === 'available' ? schedule.daysToEarnings : null,
            ] as const;
          } catch {
            /* A calendar that could not answer is silence, not a distant date. */
            return [symbol, null] as const;
          }
        },
      );
      for (const [symbol, days] of loaded) earnings.set(symbol, days);
    }

    const quotes = new Map<string, OvAlertQuote>();
    for (const symbol of symbols) {
      const display = prices.get(symbol)?.display;
      quotes.set(symbol, {
        price: display?.price ?? null,
        changePercent: display?.changePercent ?? null,
        earningsDays: earnings.get(symbol) ?? null,
      });
    }
    return quotes;
  };
}
