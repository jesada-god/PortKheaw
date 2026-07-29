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
 * The four phases and their main line:
 *
 *   PRE      the latest pre-market print, compared against the previous regular close
 *   REGULAR  the live regular-session price, compared against the previous regular close
 *   POST     TODAY'S OFFICIAL REGULAR CLOSE, with the post-market print in the second row
 *   CLOSED   the latest COMPLETED regular close, and nothing else — ever
 *
 * Things this resolver structurally cannot do:
 *
 *  - promote an extended print into the main line during POST or CLOSED;
 *  - use `previousRegularClose` as `regularClose` (or the reverse) — the two are
 *    resolved from distinct provider fields and never substitute for each other;
 *  - present a regular close as an extended print, or an extended print as a close;
 *  - accept a value whose trading date is not the one the session calls for;
 *  - report an extended change of 0.00% when there is no extended print;
 *  - read the reader's clock. `session` arrives already resolved from the exchange
 *    calendar in America/New_York, and every date here is exchange-local.
 */

/** Which semantic slot a resolved price occupies. Never a guess. */
export type MainPriceRole =
  /** A live/last print executed inside the regular session. */
  | 'regular'
  /** The finalized regular-session close of a completed trading day. */
  | 'regular-close'
  /** A pre-market print (main line during PRE only). */
  | 'premarket';

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
 *
 * `canonical` is the date this session's close must have. `previous` is admitted
 * only during PRE/REGULAR — sessions in which today's close does not exist yet, so
 * the latest COMPLETED close is legitimately the previous trading day's.
 */
interface AcceptableCloseDates {
  canonical: string | null;
  previous: string | null;
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
  /**
   * Whether a close from `tradingDate` is one this session may show.
   *
   * POST and CLOSED demand exactly the canonical date: their canonical date IS the
   * latest completed session, so an older close means the real one is missing and
   * showing the older value would be a wrong number rather than a stale one.
   *
   * REGULAR and PRE also accept the PREVIOUS trading day's close, because today's
   * session has not finished: at 09:31 ET the "latest completed regular close" is
   * genuinely yesterday's, and the row states its own trading date and role. A live
   * quote's own `regularClose` (today's close-so-far) is accepted by the same rule.
   */
  const dateAccepted = (tradingDate: string | null): boolean => {
    if (!acceptable.canonical || !tradingDate) return true;
    if (tradingDate === acceptable.canonical) return true;
    return acceptable.previous !== null && tradingDate === acceptable.previous;
  };
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
    if (!dateAccepted(tradingDate)) {
      flags.add('trading-date-mismatch');
      continue;
    }
    if (!notFutureDated(candidate.asOf)) continue;
    return {
      value: quote.regularClose,
      // The close's own instant, but only when the quote genuinely describes the
      // canonical trading date — otherwise we know the value, not when it printed.
      asOf: tradingDate === acceptable.canonical ? candidate.asOf : null,
      tradingDate: tradingDate ?? acceptable.canonical,
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
    if (!dateAccepted(tradingDate)) {
      flags.add('trading-date-mismatch');
      continue;
    }
    if (!notFutureDated(candidate.asOf)) continue;
    return {
      value: quote.price,
      asOf: candidate.asOf,
      tradingDate: tradingDate ?? acceptable.canonical,
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
    if (!dateAccepted(tradingDate)) {
      flags.add('trading-date-mismatch');
      continue;
    }
    return {
      value: quote.price,
      asOf: null,
      tradingDate,
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
 * Validate an offered extended-hours print.
 *
 * Five independent tests, each of which has admitted a wrong value in production
 * when absent. The print must be tradeable, must not be stamped in the future, must
 * have been executed in the window it CLAIMS (an after-hours print stamped 11:00 ET
 * is not an after-hours print), must belong to a window the current phase can show,
 * and must have printed AFTER the regular close it is displayed beside.
 *
 * That last rule is what admits both real shapes — Friday's after-hours row seen on
 * a Sunday, and Monday's pre-market row beside Friday's close — while rejecting a
 * leftover print from a session older than the close above it.
 */
function resolveExtendedPrint(
  input: SnapshotExtendedInput | null | undefined,
  phase: MarketSessionPhase,
  regularClose: SourcedValue | null,
  nowMs: number,
  flags: Set<MarketSnapshotFlag>,
): SnapshotExtendedInput | null {
  if (phase === 'REGULAR') {
    // An extended row while the market is trading is a contradiction, not data:
    // "ตลาดเปิด" and "หลังปิดตลาด" can never be true at the same instant.
    if (input) flags.add('extended-print-rejected');
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

  // A print that did not follow the close beside it is from an older session.
  const closeMs = instantMs(regularClose?.asOf);
  if (closeMs !== null && asOfMs <= closeMs) return reject('extended-print-rejected');

  const tradingDate = input.tradingDate ?? tradingDateOf(input.asOf);
  if (!tradingDate) return reject('extended-print-rejected');
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
  // previous session, and POST/CLOSED's is already the latest completed one.
  const acceptableCloseDates: AcceptableCloseDates = {
    canonical: canonicalDate,
    previous: phase === 'REGULAR' && canonicalDate ? previousUsTradingDate(canonicalDate) : null,
  };
  const regularClose = resolveRegularClose(candidates, acceptableCloseDates, nowMs, flags);
  const previousRegularClose = resolvePreviousRegularClose(candidates, flags);
  const extended = resolveExtendedPrint(input.extended, phase, regularClose, nowMs, flags);

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
   * The main line, per phase. The two rules that must never bend:
   *
   *  - POST and CLOSED read `regularClose` and nothing else. If an extended print
   *    exists it stays in the second row, and the attempt is recorded.
   *  - PRE reads the pre-market print. With no pre-market print at all, the latest
   *    completed close is the only truthful value left — and `extended-unavailable`
   *    already says why the row is not a pre-market price.
   */
  const main = ((): { value: SourcedValue; role: MainPriceRole } | null => {
    if (phase === 'REGULAR') {
      if (liveRegular) return { value: liveRegular, role: 'regular' };
      return regularClose ? { value: regularClose, role: 'regular-close' } : null;
    }
    if (phase === 'PRE' && extended) {
      return {
        value: {
          value: extended.price,
          asOf: extended.asOf,
          tradingDate: extended.tradingDate,
          source: `${extended.provider ?? 'unknown-provider'}.preMarketPrice`,
        },
        role: 'premarket',
      };
    }
    return regularClose ? { value: regularClose, role: 'regular-close' } : null;
  })();

  /**
   * Record the defect this module was built to stop, when it is actually attempted:
   * the accepted pipeline handed us a quote whose own `price` is an extended-hours
   * print (its timestamp falls in a pre/post window and it differs from the regular
   * close), and the main line refused it.
   *
   * Deliberately NOT raised merely because a valid extended print exists — that is
   * the normal POST/CLOSED state, and a flag that is always on tells nobody anything.
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
   * Every main line above is either a regular-session value or a pre-market print
   * that precedes one, so the base is always the PREVIOUS regular close. The
   * secondary extended row is compared against `regularClose` instead — that
   * projection belongs to the row, and lives in the header model.
   */
  const comparisonBase = previousRegularClose && main ? previousRegularClose.value : null;

  // Staleness applies to a LIVE main price only. A finalized close is not stale.
  const mainAsOfMs = instantMs(main?.value.asOf);
  if (
    main
    && (main.role === 'regular' || main.role === 'premarket')
    && mainAsOfMs !== null
    && nowMs - mainAsOfMs > LIVE_PRICE_MAX_AGE_MS
  ) {
    flags.add('stale-main-price');
  }

  const mainOrigin = main?.role === 'premarket'
    ? null
    : candidates.find((candidate) => candidate.origin === 'accepted') ?? candidates[0] ?? null;

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
    mainPriceFreshness: main?.role === 'premarket'
      ? extended?.freshness ?? null
      : mainOrigin?.freshness ?? null,
    mainPriceProvider: main?.role === 'premarket'
      ? extended?.provider ?? null
      : mainOrigin?.provider ?? null,

    comparisonBase,
    comparisonBaseKind: comparisonBase === null ? null : 'previous-regular-close',

    regularClose: regularClose?.value ?? null,
    regularCloseTimestamp: regularClose?.asOf ?? null,
    regularCloseSource: regularClose?.source ?? null,

    previousRegularClose: previousRegularClose?.value ?? null,
    previousRegularCloseSource: previousRegularClose?.source ?? null,

    // During PRE the print is the MAIN line, so it is not also a secondary row.
    ...(phase === 'PRE' && main?.role === 'premarket'
      ? {
        extendedPrice: null,
        extendedSession: null,
        extendedPriceTimestamp: null,
        extendedPriceTradingDate: null,
        extendedPriceSource: null,
        extendedPriceProvider: null,
        extendedPriceFreshness: null,
      }
      : {
        extendedPrice: extended?.price ?? null,
        extendedSession: extended?.session ?? null,
        extendedPriceTimestamp: extended?.asOf ?? null,
        extendedPriceTradingDate: extended?.tradingDate ?? null,
        extendedPriceSource: extended
          ? `${extended.provider ?? 'unknown-provider'}.${extended.session === 'premarket' ? 'preMarketPrice' : 'postMarketPrice'}`
          : null,
        extendedPriceProvider: extended?.provider ?? null,
        extendedPriceFreshness: extended?.freshness ?? null,
      }),

    flags: [...flags],
  };
}
