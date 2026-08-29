import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { getYahooChartProvider } from '@/src/lib/market-data/candles';
import { US_EQUITY_TIMEZONE, exchangeSessionDate } from '@/src/lib/market-data/session';
import {
  MARKET_STATUS_KEY,
  loadLabelHistory,
  recordLabel,
} from '@/src/lib/analytics/label-history';
import {
  lastCompletedSessionDate,
  marketSession,
  type MarketSession,
} from '@/src/lib/market-data/market-session';
import { resolveDayChangeBasis } from '@/src/lib/portfolio/day-change';
import { MARKET_STATUS_INPUTS } from '@/src/config/market-status';
import { evaluateMarketStatus, type MarketStatusEvaluation, type MarketStatusReading } from './rules';
import type { MarketStatusLabel } from '@/src/config/market-status';

type Client = SupabaseClient<Database>;

const MARKET_STATUS_LABELS: readonly string[] = ['UPTREND', 'WEAK', 'SIDEWAYS'];

/** A stored label this card can actually read. See the filter at the call site. */
function isMarketStatusLabel(value: string): value is MarketStatusLabel {
  return MARKET_STATUS_LABELS.includes(value);
}

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

/**
 * The trading date an evaluation is filed under.
 *
 * The last completed session while the market is shut, and today's exchange date
 * while it is open — so a reading taken at 11:00 ET is Tuesday's, not Monday's.
 * Filing an open-market reading under the previous session would overwrite a
 * finished day with an unfinished one.
 */
function historyDateFor(now: Date, sessionDate: string | null): string | null {
  return sessionDate ?? exchangeSessionDate(now.toISOString(), US_EQUITY_TIMEZONE);
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

/**
 * {@link loadMarketStatus} with the hold rule's memory attached.
 *
 * Read the previous raw labels, evaluate against them, record what was
 * published. Without this the card passes `[]` on every render and
 * `minDurationBars: 2` does nothing at all.
 *
 * Every persistence step degrades to the un-persisted behaviour rather than
 * failing the card:
 *
 *   * a failed READ becomes an empty history, which is the first-render case
 *     the rule already handles by publishing immediately;
 *   * a failed WRITE loses tomorrow's hold, which is strictly better than
 *     failing the render in front of a reader now;
 *   * an INSUFFICIENT evaluation is not recorded at all, because "we could not
 *     read the market" is not a label and writing one would put a reading into
 *     the sequence that was never published.
 */
export async function loadMarketStatusWithHistory(
  client: Client,
  now: Date = new Date(),
): Promise<MarketStatusResult> {
  const session = marketSession(now);
  const sessionDate = session === 'OPEN' ? null : lastCompletedSessionDate(now);
  const date = historyDateFor(now, sessionDate);
  if (date === null) return loadMarketStatus(now, []);

  const history = await loadLabelHistory(client, 'market-status', MARKET_STATUS_KEY, date)
    .catch(() => [] as string[]);

  /*
    The stored labels are validated against this card's own vocabulary before
    they reach the rule. `label_history` deliberately does not constrain the
    label to an enum — two engines with different vocabularies share the table —
    so the reader is what keeps a `market-signal` value, or a label from a
    vocabulary this card has since changed, out of the sequence.
  */
  const result = await loadMarketStatus(now, history.filter(isMarketStatusLabel));

  if (result.evaluation.status === 'available' && result.evaluation.rawLabel && result.evaluation.label) {
    await recordLabel(client, {
      scope: 'market-status',
      key: MARKET_STATUS_KEY,
      date,
      rawLabel: result.evaluation.rawLabel,
      heldLabel: result.evaluation.label,
    }).catch(() => false);
  }

  return result;
}
