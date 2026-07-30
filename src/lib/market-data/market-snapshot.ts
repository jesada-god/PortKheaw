import {
  canonicalRegularTradingDateAt,
  sessionPhaseOf,
  type CurrentMarketSessionResult,
  type MarketCloseReason,
  type MarketSessionPhase,
} from './current-session';
import {
  REGULAR_SESSION_CLOSE_MINUTE,
  US_EQUITY_TIMEZONE,
  classifyUsEquitySession,
  exchangeSessionDate,
  isRegularSessionCloseInstant,
} from './session';
import { EARLY_CLOSE_MINUTE, isUsMarketEarlyClose, previousUsTradingDate } from './us-market-calendar';
import type { DataFreshness, Quote } from './types';

/**
 * THE canonical market price snapshot.
 *
 * One resolver, one answer: which price is the main line right now, what it is
 * compared against, which values are real and where each of them came from. Every
 * consumer reads this — the header renders it directly and holds no second opinion.
 *
 * The rule that orders everything below is **semantic correctness before
 * freshness**. A newer value with the wrong meaning never beats an older value with
 * the right one, because that inversion is the production defect this module exists
 * to end: an after-hours print at 10.42 arrived newer than the 16:00 close and took
 * the main price row, while NVTS's official regular close was 9.735.
 *
 * The four phases, their main line and their second row:
 *
 *   PRE      main: the PREVIOUS regular close (the latest completed one)
 *            row 2: today's pre-market print, compared against that close
 *   REGULAR  main: the live regular-session price, compared against the previous close
 *            row 2: none — an extended row while the market trades is a contradiction
 *   POST     main: TODAY'S OFFICIAL REGULAR CLOSE
 *            row 2: today's after-hours print, compared against that close
 *   CLOSED   main: the latest COMPLETED regular close, and nothing else — ever
 *            row 2: none. Both extended windows are over, so any print still in the
 *            pipeline belongs to a finished session and would be a stale value
 *            dressed up as a current one.
 *
 * The main line is therefore a REGULAR-domain value in every phase. An extended
 * print is confined to the second row and can never occupy the main row, which is
 * the single invariant every rule below is arranged to protect.
 *
 * Things this resolver structurally cannot do:
 *
 *  - promote an extended print into the main line, in ANY phase;
 *  - use `previousRegularClose` as `regularClose` (or the reverse) — the two are
 *    resolved from distinct provider fields and never substitute for each other;
 *  - present a regular close as an extended print, or an extended print as a close;
 *  - accept a value whose trading date is not the one the session calls for;
 *  - show an extended print from a session other than the one in progress;
 *  - report an extended change of 0.00% when there is no extended print;
 *  - read the reader's clock. `session` arrives already resolved from the exchange
 *    calendar in America/New_York, and every date here is exchange-local.
 */

/**
 * Which semantic slot a resolved price occupies. Never a guess.
 *
 * Both members are REGULAR-domain values by construction: there is deliberately no
 * extended role here, because no extended print may ever reach the main line.
 */
export type MainPriceRole =
  /** A live/last print executed inside the regular session. */
  | 'regular'
  /** The finalized regular-session close of a completed trading day. */
  | 'regular-close';

export type ExtendedSessionKind = 'premarket' | 'after-hours';

/** What the main line's change is measured against. */
export type ComparisonBaseKind = 'previous-regular-close' | 'regular-close';

/**
 * A value the resolver refused, or a condition a consumer should be able to see.
 * Flags are diagnostics: they never change a price, they record why one was chosen.
 */
export type MarketSnapshotFlag =
  /** The main price is older than its session's freshness budget. */
  | 'stale-main-price'
  /** A candidate was rejected for a timestamp implausibly in the future. */
  | 'future-timestamp-rejected'
  /** A candidate's exchange trading date was not the one this session requires. */
  | 'trading-date-mismatch'
  /** A candidate's own session did not match the slot it was offered for. */
  | 'session-mismatch'
  /** An extended print tried to occupy the main line and was refused. */
  | 'extended-overwrite-rejected'
  /** An extended print was offered but failed validation. */
  | 'extended-print-rejected'
  /**
   * A print was offered for a session whose window has ENDED (the market is
   * CLOSED). Distinct from a failed validation: the value may be perfectly valid
   * for the session it printed in — that session is simply over.
   */
  | 'extended-window-closed'
  /** No real regular close could be established. */
  | 'regular-close-unavailable'
  /** No real previous regular close could be established, so no main change. */
  | 'previous-close-unavailable'
  /** There is genuinely no extended print for this session. */
  | 'extended-unavailable'
  /** The current session itself could not be resolved; CLOSED rules were applied. */
  | 'session-unresolved';

/** A resolved value plus the provider/field it came from. */
export interface SourcedValue {
  value: number;
  /** ISO instant the value printed, when the provider states one. */
  asOf: string | null;
  /** Exchange-local trading date the value belongs to. */
  tradingDate: string | null;
  /** `provider.field` provenance, e.g. `yahoo-finance-chart.regularClose`. */
  source: string | null;
}

export interface CanonicalMarketSnapshot {
  symbol: string;
  session: MarketSessionPhase;
  closeReason: MarketCloseReason | null;
  /** The raw resolved session, kept for the provenance detail. */
  sessionLabel: CurrentMarketSessionResult['session'];
  /** How the session was resolved. Never from a price timestamp. */
  sessionSource: string;
  /** The instant the session was resolved — NOT when any price printed. */
  evaluatedAt: string;
  /**
   * The trading date this snapshot's canonical regular price belongs to: today
   * during PRE/REGULAR/POST, and the latest completed trading day when CLOSED.
   */
  tradingDate: string | null;

  /** THE main line. */
  mainPrice: number | null;
  mainPriceRole: MainPriceRole | null;
  mainPriceTimestamp: string | null;
  mainPriceSource: string | null;
  mainPriceFreshness: DataFreshness | null;
  mainPriceProvider: string | null;

  /** What the main line's change is measured against, and the value itself. */
  comparisonBase: number | null;
  comparisonBaseKind: ComparisonBaseKind | null;

  regularClose: number | null;
  regularCloseTimestamp: string | null;
  regularCloseSource: string | null;

  previousRegularClose: number | null;
  previousRegularCloseSource: string | null;

  extendedPrice: number | null;
  extendedSession: ExtendedSessionKind | null;
  extendedPriceTimestamp: string | null;
  extendedPriceTradingDate: string | null;
  extendedPriceSource: string | null;
  extendedPriceProvider: string | null;
  extendedPriceFreshness: DataFreshness | null;

  flags: MarketSnapshotFlag[];
}

/** A quote resource in exactly the shape the pipeline already produces. */
export interface SnapshotQuoteInput {
  data: Quote | null;
  freshness: DataFreshness;
  provider: string | null;
}

/** An extended-hours print offered for the secondary row. */
export interface SnapshotExtendedInput {
  session: ExtendedSessionKind;
  price: number;
  asOf: string;
  tradingDate: string | null;
  provider: string | null;
  freshness: DataFreshness;
}

export interface CanonicalMarketSnapshotInput {
  symbol: string;
  /** Already resolved by {@link resolveCurrentMarketSession}. The only session input. */
  session: CurrentMarketSessionResult;
  /** The accepted (live/REST) quote currently in the pipeline. */
  quote: SnapshotQuoteInput | null;
  /**
   * The server-rendered quote. Its `regularClose` was verified against the
   * canonical trading date server-side, so it is the fallback whenever the live
   * pipeline's own quote cannot supply one.
   */
  initialQuote?: SnapshotQuoteInput | null;
  extended?: SnapshotExtendedInput | null;
  /**
   * Human-readable provenance for HOW the session was resolved, shown in the ⓘ
   * detail (e.g. `exchange-calendar · provider older-trading-date`). Defaults to the
   * resolver's own machine-readable `source`.
   */
  sessionSourceLabel?: string;
  /** The instant to evaluate against. Never the reader's clock as a zone. */
  now: Date | string;
}

/** A provider clock may run slightly ahead of ours; beyond this it is rejected. */
const FUTURE_TOLERANCE_MS = 60_000;

/**
 * How old a LIVE main price may be before it is flagged stale.
 *
 * Only PRE/REGULAR/POST use it. A completed close is not "stale" at 3am — it is
 * final, which is why an ageing rule applied to it produced the opposite bug
 * (a correct close blanked out overnight).
 */
const LIVE_PRICE_MAX_AGE_MS = 15 * 60_000;

function positive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function instantMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function tradingDateOf(asOf: string | null | undefined): string | null {
  return asOf ? exchangeSessionDate(asOf, US_EQUITY_TIMEZONE) : null;
}

/**
 * The exchange-local trading date a quote's own price belongs to.
 *
 * The instant wins over `latestTradingDay`: several providers derive that field by
 * slicing a UTC timestamp, which lands on the NEXT calendar day for any after-hours
 * print (20:30 ET is already tomorrow in UTC).
 */
function quoteTradingDate(quote: Quote, asOf: string | null): string | null {
  return tradingDateOf(asOf ?? quote.quoteTimestamp)
    ?? (quote.latestTradingDay && /^\d{4}-\d{2}-\d{2}$/.test(quote.latestTradingDay)
      ? quote.latestTradingDay
      : null);
}

/**
 * The US trading date whose regular-session price is canonical at `now`.
 *
 * {@link canonicalRegularTradingDateAt} is the calendar authority and answers every
 * ordinary case: today during REGULAR/POST and after 20:00 ET, the previous
 * finalized trading day during PRE, over a weekend, on a published holiday and
 * before 04:00 ET.
 *
 * The one case it cannot know is an UNSCHEDULED closure — an exchange event on a day
 * its calendar considers a normal trading day. That day has no regular close of its
 * own, so the canonical date steps back to the previous trading day; without this,
 * every close would be rejected for a trading-date mismatch and the header would go
 * blank on exactly the day a reader most wants the last real price.
 */
function canonicalTradingDate(input: {
  now: Date | string;
  phase: MarketSessionPhase;
  closeReason: MarketCloseReason | null;
  exchangeDate: string | null;
}): string | null {
  const { phase, closeReason, exchangeDate } = input;
  if (phase === 'CLOSED' && closeReason === 'EVENT' && exchangeDate) {
    return previousUsTradingDate(exchangeDate);
  }
  return canonicalRegularTradingDateAt(input.now) ?? exchangeDate;
}

/**
 * The trading dates a regular close may belong to in the current phase.
 */
interface AcceptableCloseDates {
  /** The date this session's close must belong to. */
  canonical: string | null;
  /**
   * The trading day before the canonical one. Admitted during REGULAR only:
   * today's session has not finished, so the latest COMPLETED close is genuinely
   * yesterday's, and the row states that date.
   */
  previous: string | null;
  /**
   * The session in progress. Admitted during PRE only, and only as a CARRIER for
   * an explicit `regularClose` field: a quote stamped in this morning's pre-market
   * still reports the previous session's close in that field, because that is what
   * the field means. The value is canonical even though the quote is not, so it is
   * labelled with the canonical date and never with this one.
   */
  currentSession: string | null;
}

/** Whether a close from a given trading date is usable, and how to date it. */
type CloseDateVerdict =
  | { accepted: false }
  | {
    accepted: true;
    /** The trading date the close should be LABELLED with. */
    tradingDate: string | null;
    /** Whether the candidate's own instant describes the canonical session. */
    datedAtCanonical: boolean;
  };

/**
 * Judge a candidate close's trading date against the dates this phase allows.
 *
 * A date OLDER than the canonical one means the real close is missing and the
 * candidate is a leftover from a finished session — the one case that must be
 * refused outright, since showing it would be a wrong number rather than a stale
 * one. The two admitted exceptions are stated on {@link AcceptableCloseDates}.
 */
function judgeCloseDate(
  tradingDate: string | null,
  acceptable: AcceptableCloseDates,
  options: { allowCurrentSessionCarrier: boolean },
): CloseDateVerdict {
  const { canonical } = acceptable;
  if (tradingDate === canonical) return { accepted: true, tradingDate, datedAtCanonical: true };
  // Without both dates there is nothing to compare; the value keeps whichever
  // date is known and never claims to be stamped at the canonical session.
  if (!canonical || !tradingDate) {
    return { accepted: true, tradingDate: tradingDate ?? canonical, datedAtCanonical: false };
  }
  if (acceptable.previous !== null && tradingDate === acceptable.previous) {
    return { accepted: true, tradingDate, datedAtCanonical: false };
  }
  if (
    options.allowCurrentSessionCarrier
    && acceptable.currentSession !== null
    && tradingDate === acceptable.currentSession
  ) {
    return { accepted: true, tradingDate: canonical, datedAtCanonical: false };
  }
  return { accepted: false };
}

interface CloseCandidate {
  quote: Quote;
  asOf: string | null;
  provider: string | null;
  freshness: DataFreshness;
  /** `initial` is the server-verified resource; `accepted` is the live pipeline's. */
  origin: 'accepted' | 'initial';
}

function sourceLabel(candidate: CloseCandidate, field: string): string {
  return `${candidate.provider ?? 'unknown-provider'}.${field}`;
}

/**
 * Resolve the official regular-session close.
 *
 * Precedence is by SEMANTIC EXPLICITNESS, not recency:
 *
 *  1. a provider's explicit `regularClose` field — the only value that states it IS
 *     the regular close, and the one that stays correct while the provider reports
 *     PRE/POST/CLOSED;
 *  2. a quote whose own `price` printed inside the regular session on the canonical
 *     trading date — a live regular price is that session's close-so-far.
 *
 * `previousClose` is deliberately absent. Falling back to it — which the previous
 * implementation did — silently relabels YESTERDAY'S close as today's, and then
 * computes a change of exactly zero against itself. That is the "swapped roles"
 * failure, and there is no arrangement of it that is truthful.
 */
function resolveRegularClose(
  candidates: readonly CloseCandidate[],
  acceptable: AcceptableCloseDates,
  nowMs: number,
  flags: Set<MarketSnapshotFlag>,
): SourcedValue | null {
  const notFutureDated = (asOf: string | null): boolean => {
    const asOfMs = instantMs(asOf);
    if (asOfMs === null) return true;
    if (asOfMs - nowMs > FUTURE_TOLERANCE_MS) {
      flags.add('future-timestamp-rejected');
      return false;
    }
    return true;
  };

  for (const candidate of candidates) {
    const { quote } = candidate;
    if (!positive(quote.regularClose)) continue;
    const tradingDate = quoteTradingDate(quote, candidate.asOf);
    // The explicit field states what it IS, so a quote stamped in the session
    // currently in progress may still carry the canonical close (see the
    // `currentSession` carrier rule).
    const verdict = judgeCloseDate(tradingDate, acceptable, { allowCurrentSessionCarrier: true });
    if (!verdict.accepted) {
      flags.add('trading-date-mismatch');
      continue;
    }
    if (!notFutureDated(candidate.asOf)) continue;
    /**
     * The close's own instant — claimed ONLY when the candidate's timestamp could
     * actually be one.
     *
     * A quote fetched at 16:41 ET still reports the correct `regularClose`, but
     * 16:41 is not when that close printed: it is when the response was stamped.
     * Copying it here would publish an after-hours instant as `regularCloseTimestamp`
     * and, worse, make every genuine after-hours print look OLDER than "the close" it
     * followed — silently emptying the second row. Without a usable instant we
     * report the value and its trading date, and no time at all.
     */
    const closeMinute = verdict.tradingDate && isUsMarketEarlyClose(verdict.tradingDate)
      ? EARLY_CLOSE_MINUTE
      : REGULAR_SESSION_CLOSE_MINUTE;
    const printedInRegularSession = candidate.asOf !== null && (
      classifyUsEquitySession(candidate.asOf) === 'regular'
      || isRegularSessionCloseInstant(candidate.asOf, closeMinute)
    );
    return {
      value: quote.regularClose,
      asOf: verdict.datedAtCanonical && printedInRegularSession ? candidate.asOf : null,
      tradingDate: verdict.tradingDate,
      source: sourceLabel(candidate, 'regularClose'),
    };
  }
  for (const candidate of candidates) {
    const { quote } = candidate;
    if (!positive(quote.price)) continue;
    const tradingDate = quoteTradingDate(quote, candidate.asOf);
    if (!candidate.asOf) continue;
    // Inside the session, or the closing minute itself. The second case is not a
    // tolerance: an end-of-day row is stamped exactly at the bell (16:00:00, or
    // 16:00:01 for Yahoo), which classifies as `afterhours` and would otherwise be
    // refused — see {@link isRegularSessionCloseInstant}.
    const closeMinute = tradingDate && isUsMarketEarlyClose(tradingDate)
      ? EARLY_CLOSE_MINUTE
      : REGULAR_SESSION_CLOSE_MINUTE;
    const isRegularValue = classifyUsEquitySession(candidate.asOf) === 'regular'
      || isRegularSessionCloseInstant(candidate.asOf, closeMinute);
    if (!isRegularValue) continue;
    // A last-trade price is defined by WHEN it printed, so the carrier rule — which
    // exists for a contract field — must not apply to it.
    const verdict = judgeCloseDate(tradingDate, acceptable, { allowCurrentSessionCarrier: false });
    if (!verdict.accepted) {
      flags.add('trading-date-mismatch');
      continue;
    }
    if (!notFutureDated(candidate.asOf)) continue;
    return {
      value: quote.price,
      asOf: candidate.asOf,
      tradingDate: verdict.tradingDate,
      source: quote.priceSource ?? sourceLabel(candidate, 'price'),
    };
  }
  /**
   * A provider-declared END-OF-DAY row.
   *
   * Such a row's `price` IS the completed regular close — the provider says so with
   * `status: 'end-of-day'` — but its timestamp is routinely a date stamp
   * (`2026-07-17T00:00:00Z` for the 17th's session), which is midnight UTC and
   * therefore 20:00 ET the PREVIOUS day. Classifying that instant answers a question
   * about the wrong day and rejects a perfectly good close, so this pass takes the
   * provider's own `latestTradingDay` as the date and reports no closing instant
   * rather than inventing one from a date stamp.
   */
  for (const candidate of candidates) {
    const { quote } = candidate;
    if (candidate.freshness.status !== 'end-of-day' || !positive(quote.price)) continue;
    const tradingDate = quote.latestTradingDay && /^\d{4}-\d{2}-\d{2}$/.test(quote.latestTradingDay)
      ? quote.latestTradingDay
      : null;
    if (!tradingDate) continue;
    const verdict = judgeCloseDate(tradingDate, acceptable, { allowCurrentSessionCarrier: false });
    if (!verdict.accepted) {
      flags.add('trading-date-mismatch');
      continue;
    }
    return {
      value: quote.price,
      asOf: null,
      tradingDate: verdict.tradingDate,
      source: quote.priceSource ?? sourceLabel(candidate, 'price (end-of-day)'),
    };
  }

  flags.add('regular-close-unavailable');
  return null;
}

/**
 * Resolve the finalized regular close of the trading day BEFORE the canonical one.
 *
 * `previousRegularClose` is the canonical field; the legacy `previousClose` is
 * accepted after it. Neither is ever allowed to stand in for `regularClose`, and a
 * value equal to the resolved `regularClose` from the SAME quote is still valid —
 * an unchanged close is a real market outcome, not evidence of a swap.
 */
function resolvePreviousRegularClose(
  candidates: readonly CloseCandidate[],
  flags: Set<MarketSnapshotFlag>,
): Omit<SourcedValue, 'asOf' | 'tradingDate'> | null {
  for (const candidate of candidates) {
    const { quote } = candidate;
    if (positive(quote.previousRegularClose)) {
      return {
        value: quote.previousRegularClose,
        source: quote.previousCloseSource ?? sourceLabel(candidate, 'previousRegularClose'),
      };
    }
    if (positive(quote.previousClose)) {
      return {
        value: quote.previousClose,
        source: quote.previousCloseSource ?? sourceLabel(candidate, 'previousClose'),
      };
    }
  }
  flags.add('previous-close-unavailable');
  return null;
}

/**
 * Validate an offered extended-hours print for the SECOND row.
 *
 * The row exists only while its own window is open, and only for a print executed
 * in that window today. Every test below has admitted a wrong value in production
 * when absent:
 *
 *  - only PRE and POST have a second row at all. REGULAR contradicts it outright,
 *    and once the market is CLOSED both extended windows are over, so whatever the
 *    pipeline is still holding belongs to a finished session — that is precisely
 *    the stale value the row must never show;
 *  - the print must be tradeable and not stamped in the future;
 *  - it must have been executed in the window it CLAIMS (an "after-hours" print
 *    stamped 11:00 ET is not an after-hours print), and that window must be the one
 *    the phase is currently in;
 *  - it must belong to the trading date of the session IN PROGRESS. This is what
 *    stops yesterday's pre-market print from reappearing beside this morning's, and
 *    it is a calendar fact rather than an age heuristic;
 *  - the provider must not already have declared the value stale or unavailable —
 *    the pipeline's own freshness verdict, reused rather than re-derived;
 *  - it must have printed AFTER the regular close it is displayed beside, so a
 *    leftover print from a session older than that close cannot slip in.
 */
function resolveExtendedPrint(
  input: SnapshotExtendedInput | null | undefined,
  phase: MarketSessionPhase,
  regularClose: SourcedValue | null,
  /** Exchange-local date of the session in progress, from the ET calendar. */
  exchangeDate: string | null,
  nowMs: number,
  flags: Set<MarketSnapshotFlag>,
): SnapshotExtendedInput | null {
  if (phase === 'REGULAR') {
    // An extended row while the market is trading is a contradiction, not data:
    // "ตลาดเปิด" and "หลังปิดตลาด" can never be true at the same instant.
    if (input) flags.add('extended-print-rejected');
    return null;
  }
  if (phase === 'CLOSED') {
    // Both extended windows have ended. A print from one of them is not current
    // data any more, whatever its provider freshness says, so CLOSED shows exactly
    // one row: the latest completed regular close.
    if (input) flags.add('extended-window-closed');
    flags.add('extended-unavailable');
    return null;
  }
  if (!input) {
    flags.add('extended-unavailable');
    return null;
  }
  const reject = (flag: MarketSnapshotFlag): null => {
    flags.add(flag);
    flags.add('extended-unavailable');
    return null;
  };
  if (!positive(input.price)) return reject('extended-print-rejected');
  const asOfMs = instantMs(input.asOf);
  if (asOfMs === null) return reject('extended-print-rejected');
  if (asOfMs - nowMs > FUTURE_TOLERANCE_MS) return reject('future-timestamp-rejected');
  // The existing freshness contract, applied to the row rather than re-invented:
  // a value the pipeline has already judged stale or unavailable is not evidence
  // of a current extended price, and hiding the row is the truthful outcome.
  if (input.freshness.status === 'stale' || input.freshness.status === 'unavailable') {
    return reject('extended-print-rejected');
  }

  const executedIn = classifyUsEquitySession(input.asOf);
  const claimed = input.session === 'premarket' ? 'premarket' : 'afterhours';
  if (executedIn !== claimed) return reject('session-mismatch');
  // A value stamped in the closing minute IS the regular close, whatever it is
  // offered as. Admitting it would dress the official close up as an extended
  // print and then compute a 0.00% "extended change" of the close against itself.
  const closeMinute = regularClose?.tradingDate && isUsMarketEarlyClose(regularClose.tradingDate)
    ? EARLY_CLOSE_MINUTE
    : REGULAR_SESSION_CLOSE_MINUTE;
  if (isRegularSessionCloseInstant(input.asOf, closeMinute)) return reject('session-mismatch');
  if (phase === 'PRE' && input.session !== 'premarket') return reject('session-mismatch');
  if (phase === 'POST' && input.session !== 'after-hours') return reject('session-mismatch');

  const tradingDate = input.tradingDate ?? tradingDateOf(input.asOf);
  if (!tradingDate) return reject('extended-print-rejected');
  // The print must belong to the session happening RIGHT NOW. Today's pre-market
  // window and today's after-hours window both carry today's exchange date, so a
  // print from any earlier session is refused on the calendar alone.
  if (exchangeDate !== null && tradingDate !== exchangeDate) {
    return reject('trading-date-mismatch');
  }

  // A print that did not follow the close beside it is from an older session.
  const closeMs = instantMs(regularClose?.asOf);
  if (closeMs !== null && asOfMs <= closeMs) return reject('extended-print-rejected');

  return { ...input, tradingDate };
}

/**
 * Resolve the ONE canonical market price snapshot.
 *
 * Pure and deterministic: no clock of its own beyond `now`, no network, no React.
 */
export function resolveCanonicalMarketSnapshot(
  input: CanonicalMarketSnapshotInput,
): CanonicalMarketSnapshot {
  const flags = new Set<MarketSnapshotFlag>();
  const { session: resolved } = input;
  const phase = resolved.phase ?? sessionPhaseOf(resolved.session);
  if (resolved.session === 'UNKNOWN') flags.add('session-unresolved');
  const nowMs = instantMs(input.now instanceof Date ? input.now.toISOString() : input.now)
    ?? instantMs(resolved.evaluatedAt)
    ?? 0;
  const canonicalDate = canonicalTradingDate({
    now: input.now,
    phase,
    closeReason: resolved.closeReason,
    exchangeDate: resolved.exchangeDate,
  });

  // The accepted (live) quote is consulted first for an explicit close, then the
  // server-rendered one, whose close was verified against the canonical date.
  const candidates: CloseCandidate[] = [];
  if (input.quote?.data) {
    candidates.push({
      quote: input.quote.data,
      asOf: input.quote.freshness.asOf ?? input.quote.data.quoteTimestamp ?? null,
      provider: input.quote.provider,
      freshness: input.quote.freshness,
      origin: 'accepted',
    });
  }
  if (input.initialQuote?.data) {
    candidates.push({
      quote: input.initialQuote.data,
      asOf: input.initialQuote.freshness.asOf ?? input.initialQuote.data.quoteTimestamp ?? null,
      provider: input.initialQuote.provider,
      freshness: input.initialQuote.freshness,
      origin: 'initial',
    });
  }

  // REGULAR is the one phase whose canonical date is a session still in progress,
  // so it also admits the previous session's close: at 09:31 ET the latest
  // COMPLETED close is genuinely yesterday's. PRE's canonical date is already the
  // previous session, and POST/CLOSED's is already the latest completed one — but
  // PRE is also the one phase whose quotes are routinely stamped in a LATER session
  // than the close they carry, which the carrier rule admits.
  const acceptableCloseDates: AcceptableCloseDates = {
    canonical: canonicalDate,
    previous: phase === 'REGULAR' && canonicalDate ? previousUsTradingDate(canonicalDate) : null,
    currentSession: phase === 'PRE' ? resolved.exchangeDate : null,
  };
  const regularClose = resolveRegularClose(candidates, acceptableCloseDates, nowMs, flags);
  const previousRegularClose = resolvePreviousRegularClose(candidates, flags);
  const extended = resolveExtendedPrint(
    input.extended,
    phase,
    regularClose,
    resolved.exchangeDate,
    nowMs,
    flags,
  );

  /**
   * A live regular-session price for the main line during REGULAR.
   *
   * It must have printed inside the regular session ON the canonical trading date.
   * A print from any other window or date is not a live regular price, and the
   * fallback is the completed close — never the extended print that was rejected.
   */
  const liveRegular = ((): SourcedValue | null => {
    if (phase !== 'REGULAR') return null;
    const accepted = candidates.find((candidate) => candidate.origin === 'accepted');
    if (!accepted || !positive(accepted.quote.price) || !accepted.asOf) return null;
    const asOfMs = instantMs(accepted.asOf);
    if (asOfMs === null) return null;
    if (asOfMs - nowMs > FUTURE_TOLERANCE_MS) {
      flags.add('future-timestamp-rejected');
      return null;
    }
    if (classifyUsEquitySession(accepted.asOf) !== 'regular') {
      flags.add('session-mismatch');
      return null;
    }
    const tradingDate = quoteTradingDate(accepted.quote, accepted.asOf);
    if (canonicalDate && tradingDate !== canonicalDate) {
      flags.add('trading-date-mismatch');
      return null;
    }
    return {
      value: accepted.quote.price,
      asOf: accepted.asOf,
      tradingDate,
      source: accepted.quote.priceSource ?? sourceLabel(accepted, 'price'),
    };
  })();

  /**
   * The main line: a REGULAR-domain value in every phase, without exception.
   *
   * REGULAR shows the live regular price, falling back to the completed close (never
   * to an extended print) when no live regular price can be established. PRE, POST
   * and CLOSED all show `regularClose` — the latest COMPLETED regular close, which
   * during PRE is the previous session's and during POST is today's.
   *
   * PRE deliberately does NOT promote the pre-market print here. That print is a
   * different domain: it belongs beside the close in the second row, compared
   * against it, not on top of it. Writing it into the main row is the exact defect
   * this resolver exists to prevent, and it is not made acceptable by the hour.
   */
  const main = ((): { value: SourcedValue; role: MainPriceRole } | null => {
    if (phase === 'REGULAR' && liveRegular) return { value: liveRegular, role: 'regular' };
    return regularClose ? { value: regularClose, role: 'regular-close' } : null;
  })();

  /**
   * Record the defect this module was built to stop, when it is actually attempted:
   * the accepted pipeline handed us a quote whose own `price` is an extended-hours
   * print (its timestamp falls in a pre/post window and it differs from the regular
   * close), and the main line refused it.
   *
   * Deliberately NOT raised merely because a valid extended print exists — that is
   * the normal PRE/POST state, and a flag that is always on tells nobody anything.
   */
  if (phase !== 'REGULAR' && main?.role === 'regular-close') {
    const accepted = candidates.find((candidate) => candidate.origin === 'accepted');
    const acceptedSession = accepted?.asOf ? classifyUsEquitySession(accepted.asOf) : null;
    if (
      accepted
      && positive(accepted.quote.price)
      && accepted.quote.price !== main.value.value
      && (acceptedSession === 'premarket' || acceptedSession === 'afterhours')
    ) {
      flags.add('extended-overwrite-rejected');
    }
  }

  /**
   * What the main line is compared against.
   *
   * Every main line above is a regular-session value, so the base is always the
   * PREVIOUS regular close — the close of the trading day before the one the main
   * price belongs to. The secondary extended row is compared against `regularClose`
   * instead: that projection belongs to the row, and lives in the header model.
   */
  const comparisonBase = previousRegularClose && main ? previousRegularClose.value : null;

  // Staleness applies to a LIVE main price only. A finalized close is not stale.
  const mainAsOfMs = instantMs(main?.value.asOf);
  if (
    main
    && main.role === 'regular'
    && mainAsOfMs !== null
    && nowMs - mainAsOfMs > LIVE_PRICE_MAX_AGE_MS
  ) {
    flags.add('stale-main-price');
  }

  const mainOrigin = candidates.find((candidate) => candidate.origin === 'accepted')
    ?? candidates[0]
    ?? null;

  return {
    symbol: input.symbol.toUpperCase(),
    session: phase,
    closeReason: resolved.closeReason,
    sessionLabel: resolved.session,
    sessionSource: input.sessionSourceLabel ?? resolved.source,
    evaluatedAt: resolved.evaluatedAt,
    tradingDate: main?.value.tradingDate ?? regularClose?.tradingDate ?? canonicalDate,

    mainPrice: main?.value.value ?? null,
    mainPriceRole: main?.role ?? null,
    mainPriceTimestamp: main?.value.asOf ?? null,
    mainPriceSource: main?.value.source ?? null,
    mainPriceFreshness: mainOrigin?.freshness ?? null,
    mainPriceProvider: mainOrigin?.provider ?? null,

    comparisonBase,
    comparisonBaseKind: comparisonBase === null ? null : 'previous-regular-close',

    regularClose: regularClose?.value ?? null,
    regularCloseTimestamp: regularClose?.asOf ?? null,
    regularCloseSource: regularClose?.source ?? null,

    previousRegularClose: previousRegularClose?.value ?? null,
    previousRegularCloseSource: previousRegularClose?.source ?? null,

    extendedPrice: extended?.price ?? null,
    extendedSession: extended?.session ?? null,
    extendedPriceTimestamp: extended?.asOf ?? null,
    extendedPriceTradingDate: extended?.tradingDate ?? null,
    extendedPriceSource: extended
      ? `${extended.provider ?? 'unknown-provider'}.${extended.session === 'premarket' ? 'preMarketPrice' : 'postMarketPrice'}`
      : null,
    extendedPriceProvider: extended?.provider ?? null,
    extendedPriceFreshness: extended?.freshness ?? null,

    flags: [...flags],
  };
}
