/**
 * The US equity (NYSE / Nasdaq) trading calendar, derived from the exchanges'
 * published rules rather than from any provider payload.
 *
 * Two independent bugs need this module:
 *
 *  1. the CURRENT SESSION resolver has to know that a weekday can still be a
 *     non-trading day, otherwise Thanksgiving reads as "ตลาดเปิด";
 *  2. the header's canonical previous close has to know which date is the
 *     *immediately preceding trading day*, otherwise a Friday snapshot beside a
 *     Monday live price is silently treated as "yesterday" or, worse, its own
 *     previous close (two sessions back) is used as the comparison base.
 *
 * Every date here is an EXCHANGE-LOCAL `YYYY-MM-DD` in America/New_York. The
 * reader's time zone is never involved, and no value is fetched, cached from a
 * provider or guessed: the holiday set is the rule set the exchanges publish
 * (fixed-date holidays with the standard weekend observance shift, floating
 * Monday/Thursday holidays, and Good Friday from the Gregorian Easter formula).
 *
 * Arithmetic runs on UTC midnights so a DST transition can never move a date.
 */

import {
  REGULAR_SESSION_CLOSE_MINUTE,
  zonedLocalToUtc,
  zonedParts,
} from './session';

export const US_MARKET_TIMEZONE = 'America/New_York';

/** 13:00 ET — the published half-day close. */
export const EARLY_CLOSE_MINUTE = 13 * 60;

/** Martin Luther King Jr. Day became an exchange holiday in 1998. */
const MLK_FIRST_YEAR = 1998;
/** Juneteenth became an exchange holiday in 2022, not when the federal law passed. */
const JUNETEENTH_FIRST_YEAR = 2022;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function utcMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Parses an exchange-local `YYYY-MM-DD`, rejecting anything else. */
function parseDate(date: string): Date | null {
  if (!DATE_PATTERN.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = utcMidnight(year, month, day);
  return isoDate(parsed) === date ? parsed : null;
}

/** 0 = Sunday … 6 = Saturday, in exchange-local terms. */
function weekdayIndex(date: Date): number {
  return date.getUTCDay();
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): string {
  const first = utcMidnight(year, month, 1);
  const offset = (weekday - weekdayIndex(first) + 7) % 7;
  return isoDate(utcMidnight(year, month, 1 + offset + (nth - 1) * 7));
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (weekdayIndex(last) - weekday + 7) % 7;
  return isoDate(new Date(last.valueOf() - offset * 86_400_000));
}

/**
 * The exchanges' weekend observance rule for a FIXED-DATE holiday: a Saturday
 * holiday is observed on the preceding Friday, a Sunday holiday on the following
 * Monday. (New Year's Day is the one exception — see {@link usMarketHolidays}.)
 */
function observedFixedHoliday(year: number, month: number, day: number): string {
  const date = utcMidnight(year, month, day);
  const weekday = weekdayIndex(date);
  if (weekday === 6) return isoDate(new Date(date.valueOf() - 86_400_000));
  if (weekday === 0) return isoDate(new Date(date.valueOf() + 86_400_000));
  return isoDate(date);
}

/** Gregorian Easter Sunday (anonymous computus). */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcMidnight(year, month, day);
}

function goodFriday(year: number): string {
  return isoDate(new Date(easterSunday(year).valueOf() - 2 * 86_400_000));
}

const holidayCache = new Map<number, ReadonlySet<string>>();
const earlyCloseCache = new Map<number, ReadonlySet<string>>();

/**
 * Full-day exchange holidays for a calendar year.
 *
 * New Year's Day is deliberately not shifted backwards: when 1 January falls on
 * a Saturday the exchanges do NOT close the preceding 31 December, so only the
 * Sunday → Monday shift applies.
 */
export function usMarketHolidays(year: number): ReadonlySet<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const newYear = utcMidnight(year, 1, 1);
  const dates: string[] = [];
  if (weekdayIndex(newYear) === 0) dates.push(isoDate(utcMidnight(year, 1, 2)));
  else if (weekdayIndex(newYear) !== 6) dates.push(isoDate(newYear));

  if (year >= MLK_FIRST_YEAR) dates.push(nthWeekdayOfMonth(year, 1, 1, 3)); // MLK Jr. Day
  dates.push(nthWeekdayOfMonth(year, 2, 1, 3)); // Washington's Birthday
  dates.push(goodFriday(year));
  dates.push(lastWeekdayOfMonth(year, 5, 1)); // Memorial Day
  if (year >= JUNETEENTH_FIRST_YEAR) dates.push(observedFixedHoliday(year, 6, 19));
  dates.push(observedFixedHoliday(year, 7, 4)); // Independence Day
  dates.push(nthWeekdayOfMonth(year, 9, 1, 1)); // Labor Day
  dates.push(nthWeekdayOfMonth(year, 11, 4, 4)); // Thanksgiving
  dates.push(observedFixedHoliday(year, 12, 25)); // Christmas

  const resolved: ReadonlySet<string> = new Set(dates);
  holidayCache.set(year, resolved);
  return resolved;
}

/**
 * Published 13:00 ET half-days: 3 July when Independence Day itself falls on a
 * weekday after Monday, the Friday after Thanksgiving, and 24 December when
 * Christmas Day falls on a weekday after Monday. A candidate that is itself a
 * full holiday or a weekend is dropped.
 */
export function usEarlyCloseDates(year: number): ReadonlySet<string> {
  const cached = earlyCloseCache.get(year);
  if (cached) return cached;

  const holidays = usMarketHolidays(year);
  const candidates: string[] = [];

  const independenceWeekday = weekdayIndex(utcMidnight(year, 7, 4));
  if (independenceWeekday >= 2 && independenceWeekday <= 5) candidates.push(isoDate(utcMidnight(year, 7, 3)));

  const thanksgiving = parseDate(nthWeekdayOfMonth(year, 11, 4, 4));
  if (thanksgiving) candidates.push(isoDate(new Date(thanksgiving.valueOf() + 86_400_000)));

  const christmasWeekday = weekdayIndex(utcMidnight(year, 12, 25));
  if (christmasWeekday >= 2 && christmasWeekday <= 5) candidates.push(isoDate(utcMidnight(year, 12, 24)));

  const resolved: ReadonlySet<string> = new Set(candidates.filter((date) => {
    const parsed = parseDate(date);
    if (!parsed || holidays.has(date)) return false;
    const weekday = weekdayIndex(parsed);
    return weekday !== 0 && weekday !== 6;
  }));
  earlyCloseCache.set(year, resolved);
  return resolved;
}

export function isUsMarketHoliday(date: string): boolean {
  const parsed = parseDate(date);
  return parsed !== null && usMarketHolidays(parsed.getUTCFullYear()).has(date);
}

export function isUsMarketEarlyClose(date: string): boolean {
  const parsed = parseDate(date);
  return parsed !== null && usEarlyCloseDates(parsed.getUTCFullYear()).has(date);
}

/** A weekday that is not a full-day exchange holiday. Half-days ARE trading days. */
export function isUsTradingDay(date: string): boolean {
  const parsed = parseDate(date);
  if (!parsed) return false;
  const weekday = weekdayIndex(parsed);
  if (weekday === 0 || weekday === 6) return false;
  return !usMarketHolidays(parsed.getUTCFullYear()).has(date);
}

/**
 * The trading date immediately before `date` — the ONLY date whose regular close
 * may be called "the previous close" for a price printed on `date`. Returns null
 * for an unparseable input. The bounded walk covers the longest possible run of
 * consecutive non-trading days (a holiday-extended weekend).
 */
export function previousUsTradingDate(date: string): string | null {
  const parsed = parseDate(date);
  if (!parsed) return null;
  for (let step = 1; step <= 10; step += 1) {
    const candidate = isoDate(new Date(parsed.valueOf() - step * 86_400_000));
    if (isUsTradingDay(candidate)) return candidate;
  }
  return null;
}

/** The trading date immediately after `date`, or null when unparseable. */
export function nextUsTradingDate(date: string): string | null {
  const parsed = parseDate(date);
  if (!parsed) return null;
  for (let step = 1; step <= 10; step += 1) {
    const candidate = isoDate(new Date(parsed.valueOf() + step * 86_400_000));
    if (isUsTradingDay(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sessions as instants, and distances measured in sessions
// ---------------------------------------------------------------------------

/**
 * The regular close of the latest trading session at or before `timestamp`.
 *
 * This is the answer to "which session is this data FROM", which is a different
 * question from "when was it fetched" — and confusing the two is what made
 * STALE-MIX fire on every weekend. A chain pulled at 23:11 on Saturday is a
 * snapshot of FRIDAY's session: nothing traded between the two, so it is exactly
 * as current as a Friday closing bar, and subtracting the two timestamps to get
 * 26.7 hours measures the gap between a clock read and a market event.
 *
 * Half-days close at 13:00 ET and are handled, because a Black Friday capture at
 * 14:00 belongs to that day's session and not to Wednesday's.
 *
 * Returns null for an unparseable instant, or when no trading day can be found
 * within the bounded walk.
 */
export function lastUsSessionClose(timestamp: string): { date: string; closeAt: string } | null {
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.valueOf())) return null;
  const parts = zonedParts(instant, US_MARKET_TIMEZONE);
  const localDate = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const minuteOfDay = parts.hour * 60 + parts.minute;

  const closedOn = isUsTradingDay(localDate) && minuteOfDay >= usSessionCloseMinute(localDate)
    ? localDate
    : previousUsTradingDate(localDate);
  if (closedOn === null) return null;
  const closeAt = sessionCloseInstant(closedOn);
  return closeAt === null ? null : { date: closedOn, closeAt };
}

/** 16:00 ET, or 13:00 ET on a published half-day. */
export function usSessionCloseMinute(date: string): number {
  return isUsMarketEarlyClose(date) ? EARLY_CLOSE_MINUTE : REGULAR_SESSION_CLOSE_MINUTE;
}

function sessionCloseInstant(date: string): string | null {
  const minute = usSessionCloseMinute(date);
  const clock = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
  return zonedLocalToUtc(`${date}T${clock}`, US_MARKET_TIMEZONE);
}

/**
 * How many trading SESSIONS separate two exchange-local dates.
 *
 * 0 when both fall in the same session — the property that makes a Friday bar
 * and a Saturday-night capture of the same Friday chain read as simultaneous,
 * which is what they are. 1 for consecutive sessions, whether that is Thursday
 * to Friday or Friday to Monday, because a weekend is not a session.
 *
 * The walk is bounded: beyond `limit` sessions the exact count stops mattering
 * and the cap is returned, so a wildly out-of-date source cannot spin here.
 */
export function usTradingSessionsBetween(from: string, to: string, limit = 400): number | null {
  if (parseDate(from) === null || parseDate(to) === null) return null;
  if (from === to) return 0;
  const [earlier, later] = from < to ? [from, to] : [to, from];
  let cursor = earlier;
  for (let sessions = 1; sessions <= limit; sessions += 1) {
    const next = nextUsTradingDate(cursor);
    if (next === null) return null;
    if (next >= later) return sessions;
    cursor = next;
  }
  return limit;
}
