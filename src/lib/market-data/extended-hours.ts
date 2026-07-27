import { classifyUsEquitySession, exchangeSessionDate, US_EQUITY_TIMEZONE } from './session';
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
 *
 * One caveat about `currentTradingPeriod` that this module has to absorb: Yahoo
 * reports the CURRENT/next trading day's windows, not the windows the last print
 * was executed in. Verified live on 2026-07-27 04:27 ET, where the response
 * carried Monday's pre/regular/post windows while the newest completed extended
 * print was Friday 19:55 ET. Accepting only provider-declared windows therefore
 * erases the whole row every time those windows roll over — overnight, over a
 * weekend and over a holiday. So a bucket is also accepted when OUR OWN exchange
 * calendar (`classifyUsEquitySession`, the same authority the header uses) places
 * it inside an extended window. That is still a real provider bucket at a real
 * timestamp; only the window ATTRIBUTION falls back, never the price.
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

/**
 * How long an extended print may still be presented as a current delayed quote.
 *
 * Yahoo's extended-hours consolidated data is a delayed feed on a 5-minute grid,
 * so a print stops being "the delayed current price" and becomes a record of a
 * finished window well inside a quarter hour. Past this the header degrades the
 * row's LABEL to "ข้อมูลอาจล่าช้า" — the row itself, and the price in it, stay.
 */
const EXTENDED_PRINT_MAX_AGE_SECONDS = 15 * 60;

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
 * Newest bucket that OUR exchange calendar places inside an extended window.
 *
 * The safety net for a rolled-over `currentTradingPeriod`: it keeps the same
 * "strictly newer than the regular close" rule, and still refuses every bucket
 * the calendar classifies as regular-session or outside trading hours entirely.
 */
function lastBucketInCalendarWindow(
  buckets: ExtendedHoursCandidateInput['buckets'],
  afterSeconds: number,
  timeZone: string,
): { session: ExtendedSession; time: number; price: number } | null {
  let best: { session: ExtendedSession; time: number; price: number } | null = null;
  for (const [time, close] of buckets) {
    if (!Number.isFinite(time) || time <= afterSeconds) continue;
    if (close === null || close === undefined || !Number.isFinite(close) || close <= 0) continue;
    if (best && time <= best.time) continue;
    const classified = classifyUsEquitySession(new Date(time * 1_000).toISOString(), timeZone);
    if (classified !== 'premarket' && classified !== 'afterhours') continue;
    best = { session: classified === 'premarket' ? 'premarket' : 'after-hours', time, price: close };
  }
  return best;
}

/**
 * Pick the newest valid extended print, or null.
 *
 * A candidate must satisfy both conditions: it lies inside an extended window —
 * one the provider declared, or failing that one our own exchange calendar
 * resolves — AND it is newer than the regular price it will be displayed beside.
 * The second condition is what rejects a completed session's own pre-market
 * prints — Friday's 04:00–09:30 prints must not resurface on a Sunday as
 * "ก่อนตลาดเปิด" — without needing to compare against window boundaries, which
 * the closing auction can overshoot by a second or two.
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

  // Only when the provider's declared windows yield nothing — the rolled-over
  // `currentTradingPeriod` case — is the exchange calendar consulted. A print
  // that is still inside a declared window therefore always wins on its own.
  const winner = candidates.sort((left, right) => right.time - left.time)[0]
    ?? lastBucketInCalendarWindow(buckets, regularMarketTimeSeconds, timeZone);
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
      // A real bound, so a print from a finished window ages truthfully into
      // "ข้อมูลอาจล่าช้า" instead of claiming "ราคาล่าช้า" forever. Ageing only
      // ever changes the row's label — never whether the row is rendered.
      maxAgeSeconds: EXTENDED_PRINT_MAX_AGE_SECONDS,
    },
  };
}

/**
 * Whether an extended print legitimately BELONGS BESIDE a given regular price:
 * it must have printed AFTER it.
 *
 * This guard originally demanded that both share one exchange trading date. That
 * is not a stricter form of the rule but a wrong one, because the two extended
 * windows sit on opposite sides of the regular session:
 *
 *  - **after-hours** follows the close it is compared against and does share its
 *    trading date (Friday 19:55 beside Friday's close);
 *  - **pre-market** precedes the session that has not opened yet, so it can NEVER
 *    share a date with the completed close above it (Monday 04:25 beside Friday's
 *    close) — verified live on 2026-07-27, where exactly that print was discarded.
 *
 * Ordering by instant covers both, and is the same rule
 * {@link selectExtendedHoursQuote} applies when choosing the print in the first
 * place. It still rejects what this guard exists for: a print left over from a
 * session older than the regular price beside it (Friday's after-hours print
 * once Monday's close is in the row above), and a morning's pre-market print
 * once the regular session has traded past it.
 */
export function extendedQuoteFollowsRegularClose(
  extendedAsOf: string | null,
  regularAsOf: string | null,
): boolean {
  const extendedMs = extendedAsOf ? Date.parse(extendedAsOf) : Number.NaN;
  const regularMs = regularAsOf ? Date.parse(regularAsOf) : Number.NaN;
  if (!Number.isFinite(extendedMs) || !Number.isFinite(regularMs)) return false;
  return extendedMs > regularMs;
}

export function extendedQuoteMatchesRegularSession(
  extended: ExtendedHoursQuoteData | null,
  regularAsOf: string | null,
): boolean {
  return extended ? extendedQuoteFollowsRegularClose(extended.asOf, regularAsOf) : false;
}
