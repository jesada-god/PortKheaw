import type { MarketSession } from '@/src/lib/market-data/market-session';

/**
 * Choosing WHICH two prices the day figure is the difference of.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS REPLACES
 * ---------------------------------------------------------------------------
 * The day figure used to be `quantity × (livePrice − liveQuote.previousClose)`
 * and nothing else. That expression has no answer outside the regular session,
 * because most providers stop publishing a previous close once their live feed
 * goes quiet — so the figure went null every evening and all weekend, and the
 * card responded by deleting its own row. A Thai reader opening the app at
 * 21:00 ICT, which is 10:00 ET on a good day and a dead market on a Saturday,
 * saw a portfolio with no day figure at all and no explanation.
 *
 * Worse, the blank was ambiguous in a way nobody could resolve from the screen:
 * "we could not compute this" and "the market is closed" are different facts
 * and they looked identical.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 * The session decides the source, and the source is always named:
 *
 *   OPEN      the live price against the last completed session's close. That
 *             IS today's move, and it is the only state in which a moving
 *             number is the right answer.
 *
 *   otherwise the captured snapshot: one finished session's close against the
 *             one before it. Pre-market, after-hours, the evening, the weekend
 *             and every holiday are the same fact — the last thing that
 *             happened was a close — so they share one rule.
 *
 * A basis always carries the trading date it is ABOUT, so the caller can say so
 * in words. That is the half of this change that matters: a figure captioned
 * "ราคาปิดวันศุกร์" is a different and far more useful statement than the same
 * number with no caption, and it is the reason the row can now stay on screen
 * instead of vanishing.
 *
 * When neither source can produce two prices the answer is genuinely unknown
 * and this returns null. The card must then say what is missing in words. It
 * must NOT print a zero: "did not move" is a claim about the market, and this
 * is an absence of information about it.
 */

/** One captured row of {@link daily_snapshot}, in the shape a calculator wants. */
export interface DaySnapshotInput {
  /** Exchange-local trading date whose regular session closed at `close`. */
  date: string;
  close: number;
  /** Close of the session before `date`; null when that session has no verified close. */
  prevClose?: number | null;
  source?: string | null;
}

export type DayChangeSource = 'live' | 'snapshot';

export interface DayChangeBasis {
  /** The later of the two prices — a live price, or a session's close. */
  close: number;
  /** The earlier of the two: the close of the session before it. */
  prevClose: number;
  /**
   * The completed trading date the figure is about, or null while it is live.
   *
   * Null is not "unknown" here — it is "this is happening now", which is
   * precisely the case that needs no date on it.
   */
  sessionDate: string | null;
  source: DayChangeSource;
  /** Provider the snapshot came from; null for a live basis. */
  provider: string | null;
}

function usable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The two prices the day figure for one instrument is the difference of, or
 * null when no pair of them exists.
 *
 * Both directions of fallback are deliberate, and they are not symmetric:
 *
 *  - OPEN with no live previous close falls back to the SNAPSHOT'S CLOSE as the
 *    previous close — not to the whole snapshot pair. The live price is still
 *    the right later half; only the earlier half was missing, and the snapshot
 *    holds exactly that number for exactly that session. Swapping in the full
 *    snapshot instead would replace a live figure with a stale one during the
 *    session, which is the opposite of what a reader watching an open market
 *    wants.
 *
 *  - Closed with no usable snapshot falls back to the live pair, when the quote
 *    happens to carry one. An after-hours quote that still reports a previous
 *    close describes the session that just ended; refusing it because the
 *    capture job has not run yet would blank the figure for the ten minutes
 *    after the bell, which is the same bug in a smaller window.
 */
export function resolveDayChangeBasis(input: {
  session: MarketSession;
  /** Current market price of the instrument. */
  price: number | null | undefined;
  /** Previous close as the live quote reported it, if it reported one. */
  previousClose?: number | null;
  /** Most recent captured snapshot for this instrument. */
  snapshot?: DaySnapshotInput | null;
}): DayChangeBasis | null {
  const { session, price, previousClose, snapshot } = input;

  const snapshotPair = snapshot && usable(snapshot.close) && usable(snapshot.prevClose)
    ? {
      close: snapshot.close,
      prevClose: snapshot.prevClose,
      sessionDate: snapshot.date,
      source: 'snapshot' as const,
      provider: snapshot.source ?? null,
    }
    : null;

  const livePair = (fallbackPrevClose: number | null): DayChangeBasis | null => {
    const earlier = usable(previousClose) ? previousClose : fallbackPrevClose;
    if (!usable(price) || !usable(earlier)) return null;
    return { close: price, prevClose: earlier, sessionDate: null, source: 'live', provider: null };
  };

  if (session === 'OPEN') {
    return livePair(usable(snapshot?.close) ? snapshot!.close : null) ?? snapshotPair;
  }
  return snapshotPair ?? livePair(null);
}

/** The signed move of one basis, per unit. */
export function dayChangePerUnit(basis: DayChangeBasis): number {
  return basis.close - basis.prevClose;
}

/**
 * Reconcile the bases of many instruments into the one a whole portfolio's
 * figure is attributed to.
 *
 * A portfolio can straddle sources — an equity whose snapshot landed and an
 * option contract whose did not, so one half is a completed close and the other
 * is a live tick. The combined figure is then not purely either, and the
 * caption has to be the WEAKER of the two claims rather than the more flattering
 * one:
 *
 *  - any live basis in the mix makes the total live, because part of it is
 *    still moving;
 *  - otherwise the total is a snapshot, dated at the OLDEST session present, so
 *    a caption can never claim a session more recent than some component of the
 *    number actually came from.
 *
 * Returns null for an empty list — a portfolio with nothing priced has no
 * source to name.
 */
export function combineDayChangeSources(
  bases: readonly (DayChangeBasis | null)[],
): { source: DayChangeSource; sessionDate: string | null } | null {
  const present = bases.filter((basis): basis is DayChangeBasis => basis !== null);
  if (present.length === 0) return null;
  if (present.some((basis) => basis.source === 'live')) {
    return { source: 'live', sessionDate: null };
  }
  const dates = present
    .map((basis) => basis.sessionDate)
    .filter((date): date is string => date !== null)
    .sort();
  return { source: 'snapshot', sessionDate: dates[0] ?? null };
}
