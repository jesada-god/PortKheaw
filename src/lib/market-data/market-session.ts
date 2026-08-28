import closureData from './us-market-closures.json';
import { US_EQUITY_TIMEZONE, exchangeSessionDate } from './session';
import {
  isUsMarketEarlyClose,
  isUsTradingDay,
  usSessionCloseMinute,
} from './us-market-calendar';
import { resolveCurrentMarketSession, type MarketSessionPhase } from './current-session';

/**
 * The four-state market session, in the vocabulary the day-P&L rules are
 * written in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FACADE AND NOT A SECOND CALENDAR
 * ---------------------------------------------------------------------------
 * The exchange calendar and the session resolver already exist, are tested, and
 * are the authority the header and the quote cache are clamped against
 * (`us-market-calendar.ts`, `current-session.ts`). Deriving these four states
 * from a fresh copy of the US holiday list would put two answers to "was the
 * market open on Thanksgiving" in the tree, and nothing would notice when they
 * stopped agreeing — the header would say ปิดตลาด while the portfolio card
 * computed a live day move, or the reverse.
 *
 * So this module owns exactly one thing: the COARSER four-state shape, and the
 * "which completed session does a closed-market figure belong to" question that
 * follows from it. Everything underneath is delegated.
 *
 * The one piece of data that genuinely cannot be derived lives beside this file
 * as `us-market-closures.json`: the unscheduled closures — a national day of
 * mourning, a hurricane — which no formula predicts. Those are fed into the
 * resolver through the `holidays` input it already accepts for exactly this, so
 * they refine the computed calendar instead of competing with it.
 */
export type MarketSession = 'PRE_MARKET' | 'OPEN' | 'AFTER_HOURS' | 'CLOSED';

interface ClosureEntry {
  date: string;
  reason: string;
}

const CLOSURES: readonly ClosureEntry[] = (closureData as { closures: ClosureEntry[] }).closures;

const CLOSURE_DATES: ReadonlySet<string> = new Set(CLOSURES.map((entry) => entry.date));

const CLOSURE_REASONS: ReadonlyMap<string, string> = new Map(
  CLOSURES.map((entry) => [entry.date, entry.reason]),
);

/** The unscheduled full-day closures, as the resolver's `holidays` input wants them. */
export function unscheduledUsClosures(): ReadonlySet<string> {
  return CLOSURE_DATES;
}

/** Why the exchange was shut on an unscheduled closure date, or null for any other date. */
export function unscheduledClosureReason(date: string): string | null {
  return CLOSURE_REASONS.get(date) ?? null;
}

/**
 * A trading date by BOTH tests: the computed calendar says it is one, and it is
 * not one of the declared unscheduled closures.
 */
export function isTradingDate(date: string): boolean {
  return isUsTradingDay(date) && !CLOSURE_DATES.has(date);
}

/**
 * The trading date immediately before `date`.
 *
 * The bounded walk is longer than the calendar module's, because an unscheduled
 * closure can extend a holiday weekend past anything the published calendar
 * produces on its own — the four consecutive shut days after 11 September 2001
 * ran into a weekend on both sides.
 */
export function previousTradingDate(date: string): string | null {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = new Date(parsed - step * 86_400_000).toISOString().slice(0, 10);
    if (isTradingDate(candidate)) return candidate;
  }
  return null;
}

function phaseToSession(phase: MarketSessionPhase): MarketSession {
  switch (phase) {
    case 'PRE': return 'PRE_MARKET';
    case 'REGULAR': return 'OPEN';
    case 'POST': return 'AFTER_HOURS';
    case 'CLOSED': return 'CLOSED';
  }
}

/**
 * Which session the US equity market is in at `now`.
 *
 * PRE_MARKET   04:00–09:30 ET on a trading day
 * OPEN         09:30–16:00 ET (09:30–13:00 on a published half-day)
 * AFTER_HOURS  16:00–20:00 ET (13:00–17:00 on a half-day)
 * CLOSED       every other hour, every weekend, every holiday, every
 *              unscheduled closure
 *
 * `now` is an instant. The reader's own time zone is never consulted — a phone
 * set to Asia/Bangkok and a server set to UTC resolve the same session for the
 * same moment, which is the only way the card and the header can agree.
 *
 * An unparseable instant resolves to CLOSED, because the rule CLOSED selects —
 * show the last completed session — is the only one that is safe without a
 * usable clock.
 */
export function marketSession(now: Date | string): MarketSession {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.valueOf())) return 'CLOSED';
  return phaseToSession(resolveCurrentMarketSession({
    now: instant,
    holidays: CLOSURE_DATES,
  }).phase);
}

/**
 * The trading date whose REGULAR CLOSE is the most recent completed one at
 * `now`, or null when no clock is available.
 *
 * This is the date a closed-market day figure is ABOUT, and it is a different
 * question from `marketSession`. During PRE_MARKET the last completed close is
 * yesterday's; from the closing bell onward — after-hours, the evening, the
 * whole weekend that follows — it is today's. Getting this wrong is how a
 * Monday morning ends up captioned with Monday's date over Friday's numbers.
 *
 * During OPEN this still answers "the last COMPLETED session", which is the
 * previous trading day; the live day figure does not use it.
 */
export function lastCompletedSessionDate(now: Date | string): string | null {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.valueOf())) return null;
  const date = exchangeSessionDate(instant.toISOString(), US_EQUITY_TIMEZONE);
  if (!date) return null;
  if (isTradingDate(date)) {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: US_EQUITY_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(instant).map((part) => [part.type, part.value]),
    );
    const minute = Number(values.hour) * 60 + Number(values.minute);
    if (minute >= usSessionCloseMinute(date)) return date;
  }
  return previousTradingDate(date);
}

export interface MarketSessionDetail {
  session: MarketSession;
  /** Exchange-local date of `now` itself, which may not be a trading date at all. */
  exchangeDate: string | null;
  /** The trading date whose regular close has most recently finished. */
  lastCompletedSessionDate: string | null;
  /** True on a published 13:00 ET half-day. */
  earlyClose: boolean;
  /** Set only when `now` falls on a declared unscheduled closure. */
  closureReason: string | null;
}

/** {@link marketSession} plus the dates a caption needs. One resolve, not four. */
export function marketSessionDetail(now: Date | string): MarketSessionDetail {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.valueOf())) {
    return {
      session: 'CLOSED',
      exchangeDate: null,
      lastCompletedSessionDate: null,
      earlyClose: false,
      closureReason: null,
    };
  }
  const exchangeDate = exchangeSessionDate(instant.toISOString(), US_EQUITY_TIMEZONE);
  return {
    session: marketSession(instant),
    exchangeDate,
    lastCompletedSessionDate: lastCompletedSessionDate(instant),
    earlyClose: exchangeDate !== null && isUsMarketEarlyClose(exchangeDate),
    closureReason: exchangeDate === null ? null : unscheduledClosureReason(exchangeDate),
  };
}
