import { exchangeSessionDate, US_EQUITY_TIMEZONE } from './session';
import type { DataFreshness } from './types';

/**
 * Selection of the pre-market / after-hours print shown in the header's
 * secondary row.
 *
 * Where the data comes from: the SAME Yahoo chart response the quote pipeline
 * already uses, requested with `includePrePost=true`. Nothing new is polled from
 * the browser, and no additional provider is introduced.
 *
 * Why this is not "deriving a price from an arbitrary candle": Yahoo states the
 * session boundaries itself in `meta.currentTradingPeriod` (`pre`, `regular`,
 * `post`). A candidate is only accepted when it falls strictly inside one of
 * those PROVIDER-DECLARED extended windows and belongs to the same exchange
 * trading date as the regular session it is compared against. A bucket outside
 * those windows, from an older session, or without a finite close is rejected.
 *
 * Two invariants this module exists to guarantee:
 *
 *  1. **An extended print never becomes the main price.** It is returned as a
 *     separate value; the caller keeps the regular close in the primary row.
 *  2. **A stale extended print is rejected, but the latest completed session is
 *     not.** Friday's after-hours print is legitimate to show on a Sunday, dated
 *     as Friday. A print from any EARLIER session is not, and is dropped.
 */

export type ExtendedSession = 'premarket' | 'after-hours';

/** Provider-declared session window, in epoch seconds. */
export interface TradingWindow {
  start: number;
  end: number;
}

export interface ExtendedHoursCandidateInput {
  /** Buckets from the extended-session request: `[epochSeconds, close]`. */
  buckets: readonly (readonly [number, number | null | undefined])[];
  /** Yahoo's own `currentTradingPeriod.pre`, when present. */
  preWindow: TradingWindow | null;
  /** Yahoo's own `currentTradingPeriod.post`, when present. */
  postWindow: TradingWindow | null;
  /** Timestamp of the regular-session price the extended row is compared against. */
  regularMarketTimeSeconds: number;
  provider: string;
  timeZone?: string;
}

export interface ExtendedHoursQuoteData {
  session: ExtendedSession;
  price: number;
  /** ISO instant of the accepted extended print. */
  asOf: string;
  /** Exchange-local trading date (YYYY-MM-DD) the print belongs to. */
  tradingDate: string;
  provider: string;
  freshness: DataFreshness;
}

function lastBucketInWindow(
  buckets: ExtendedHoursCandidateInput['buckets'],
  window: TradingWindow | null,
  afterSeconds: number,
): { time: number; price: number } | null {
  if (!window || !Number.isFinite(window.start) || !Number.isFinite(window.end) || window.end <= window.start) {
    return null;
  }
  let best: { time: number; price: number } | null = null;
  for (const [time, close] of buckets) {
    if (!Number.isFinite(time) || time < window.start || time >= window.end) continue;
    // The one invariant that makes an extended print current: it must be NEWER
    // than the regular price it is displayed beside. This is what rejects a
    // completed session's own pre-market prints (Friday 04:00-09:30 seen on a
    // Sunday) while accepting Monday's pre-market beside Friday's close.
    if (time <= afterSeconds) continue;
    if (close === null || close === undefined || !Number.isFinite(close) || close <= 0) continue;
    if (!best || time > best.time) best = { time, price: close };
  }
  return best;
}

/**
 * Pick the newest valid extended print, or null.
 *
 * A candidate must satisfy both conditions: it lies inside one of the provider's
 * own declared extended windows, AND it is newer than the regular price it will
 * be displayed beside. The second condition is what rejects a completed
 * session's own pre-market prints — Friday's 04:00–09:30 prints must not
 * resurface on a Sunday as "ก่อนตลาดเปิด" — without needing to compare against
 * window boundaries, which the closing auction can overshoot by a second or two.
 *
 * When both windows yield a candidate the newer timestamp wins, which is what
 * makes a fresh pre-market print supersede the previous session's after-hours
 * print automatically.
 */
export function selectExtendedHoursQuote(input: ExtendedHoursCandidateInput): ExtendedHoursQuoteData | null {
  const { buckets, preWindow, postWindow, regularMarketTimeSeconds, provider } = input;
  const timeZone = input.timeZone ?? US_EQUITY_TIMEZONE;
  if (!Number.isFinite(regularMarketTimeSeconds) || regularMarketTimeSeconds <= 0) return null;

  const candidates: { session: ExtendedSession; time: number; price: number }[] = [];
  const pre = lastBucketInWindow(buckets, preWindow, regularMarketTimeSeconds);
  if (pre) candidates.push({ session: 'premarket', ...pre });
  const post = lastBucketInWindow(buckets, postWindow, regularMarketTimeSeconds);
  if (post) candidates.push({ session: 'after-hours', ...post });

  const winner = candidates.sort((left, right) => right.time - left.time)[0];
  if (!winner) return null;

  const asOf = new Date(winner.time * 1_000).toISOString();
  const tradingDate = exchangeSessionDate(asOf, timeZone);
  if (!tradingDate) return null;

  return {
    session: winner.session,
    price: winner.price,
    asOf,
    tradingDate,
    provider,
    freshness: {
      // Extended-hours prints are never claimed as real-time: the source is a
      // delayed consolidated feed and the print may be from a prior session.
      status: 'delayed',
      asOf,
      maxAgeSeconds: null,
    },
  };
}

/**
 * Reject an extended print that does not belong to the SAME trading date as the
 * regular price it is displayed next to.
 *
 * This is the guard that lets Friday's after-hours print appear on a Sunday —
 * because the primary row is also Friday's close — while still dropping a print
 * left over from any older session.
 */
export function extendedQuoteMatchesRegularSession(
  extended: ExtendedHoursQuoteData | null,
  regularAsOf: string | null,
  timeZone = US_EQUITY_TIMEZONE,
): boolean {
  if (!extended) return false;
  if (!regularAsOf) return false;
  const regularDate = exchangeSessionDate(regularAsOf, timeZone);
  return regularDate !== null && regularDate === extended.tradingDate;
}
