import 'server-only';

import { getYahooChartProvider } from '@/src/lib/market-data/candles';
import {
  lastCompletedSessionDate,
  marketSession,
  type MarketSession,
} from '@/src/lib/market-data/market-session';
import { resolveDayChangeBasis } from '@/src/lib/portfolio/day-change';
import { MARKET_STATUS_INPUTS } from '@/src/config/market-status';
import { evaluateMarketStatus, type MarketStatusEvaluation, type MarketStatusReading } from './rules';

/**
 * Loading the six readings the card is built from.
 *
 * ===========================================================================
 * THE SESSION DECIDES WHICH TWO PRICES, AND IT IS NOT DECIDED HERE
 * ===========================================================================
 * Once the closing bell has rung there is no "today's move" left in a moving
 * price, and the honest figure is the one the session ended with. That rule
 * already exists — `resolveDayChangeBasis` in `src/lib/portfolio/day-change.ts`
 * — and it is the same rule for the same reason, so this module calls it rather
 * than re-deriving it. Duplicating it would give the product two answers to
 * "what is today's move", and they would disagree on the first day one of them
 * was fixed.
 *
 * What that buys, concretely: when the market is shut the card shows each
 * instrument's completed close against the close before it, and the label says
 * which day those numbers are from — the same behaviour, from the same code, as
 * the portfolio day figure.
 *
 * The one difference is the snapshot store. The portfolio reads captured closes
 * out of `daily_snapshot` because it must answer for whatever a reader holds.
 * These six symbols are fixed and public, and the provider already returns a
 * `previousClose` for each, so the quote itself carries both halves of the pair
 * and no table is needed. The basis resolver handles that shape natively.
 */

export interface MarketStatusResult {
  evaluation: MarketStatusEvaluation;
  session: MarketSession;
  /**
   * The completed trading date the readings are about, or null while the market
   * is open and the numbers are live. Drives the card's "which day" line.
   */
  sessionDate: string | null;
  evaluatedAt: string;
}

/** One provider read, degraded to an unreadable input rather than a thrown page. */
async function readInput(symbol: string): Promise<{ price: number | null; previousClose: number | null }> {
  try {
    const { data } = await getYahooChartProvider().getQuote(symbol);
    return { price: data.price, previousClose: data.previousClose ?? null };
  } catch {
    /*
      A failed instrument becomes a missing reading, which the rule table already
      knows how to handle — and handles by withholding rather than by guessing.
      Throwing here would take down a card over one flaky symbol.
    */
    return { price: null, previousClose: null };
  }
}

export async function loadMarketStatus(
  now: Date = new Date(),
  history: Parameters<typeof evaluateMarketStatus>[1] = [],
): Promise<MarketStatusResult> {
  const session = marketSession(now);
  const sessionDate = session === 'OPEN' ? null : lastCompletedSessionDate(now);

  const quotes = await Promise.all(
    MARKET_STATUS_INPUTS.map(async (input) => ({ input, quote: await readInput(input.symbol) })),
  );

  const readings: MarketStatusReading[] = quotes.map(({ input, quote }) => {
    /*
      The shared resolver picks the pair. With no captured snapshot to offer it,
      an OPEN market gets the live price against the reported previous close, and
      a shut one gets the same pair — which for these instruments IS the completed
      session, because the provider's `regularMarketPrice` after the bell is that
      session's close. What the session actually changes is what the card SAYS
      about the numbers, which is `sessionDate` above.
    */
    const basis = resolveDayChangeBasis({
      session,
      price: quote.price,
      previousClose: quote.previousClose,
      snapshot: null,
    });
    return {
      key: input.key,
      value: basis === null ? null : basis.close,
      comparisonClose: basis === null ? null : basis.prevClose,
    };
  });

  return {
    evaluation: evaluateMarketStatus(readings, history),
    session,
    sessionDate,
    evaluatedAt: now.toISOString(),
  };
}
