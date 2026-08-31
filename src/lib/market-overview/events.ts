/**
 * THE MACRO CALENDAR — EVERY ROW THE FILE HAS, AND NOTHING ELSE.
 *
 * ===========================================================================
 * THE FILE IS THE CALENDAR. THE CODE HAS NO OPINION ABOUT HOW FAR IT REACHES.
 * ===========================================================================
 * Adding an event is editing `src/data/market-events.json` and nothing else.
 * No constant to bump, no window to widen, no release to make: a row dated
 * January 2027 appears the moment it is in the file, and so does one dated
 * 2030.
 *
 * This module used to cut the list at a twelve-month horizon, which meant the
 * calendar had a ceiling written in TypeScript — a number that would have had
 * to be found and raised by somebody who only wanted to add a date. The
 * horizon is gone. What is left is one filter that is about the reader rather
 * than about the data: a release that already happened is not something coming
 * up, so the list starts at today.
 *
 * Nothing here adds a row, and nothing extrapolates one. A wrong release date
 * on a calendar is worse than a missing one, because a reader plans around it —
 * so where the file stops, the list stops, and {@link OvEventCalendar.lastDayKey}
 * says where that is.
 *
 * The file is read, not imported through `src/lib/market-events` — this module
 * owns `OvMarketEvent`, validates the rows against its own schema, and shares
 * no type with the existing calendar. See the header of `types.ts` for why
 * `MarketEvent` in particular could not be reused under its own name. Both
 * modules read the SAME file, so one edit feeds both surfaces.
 *
 * ===========================================================================
 * THE INSTANT IS THE VALUE; EVERY THAI STRING GOES THROUGH datetime.ts
 * ===========================================================================
 * `startsAtUtc` is an ISO instant ending in `Z` and is the only field ever
 * computed with. Every human-readable string this module produces is built by
 * `src/lib/presentation/datetime.ts` — the product's single Bangkok formatter —
 * and the one thing that module does not expose, a `YYYY-MM-DD` Bangkok day
 * key, is derived here from its exported `BANGKOK_TIME_ZONE` rather than from a
 * second zone name written out again. There is exactly one string
 * `'Asia/Bangkok'` in the product and it is not in this file.
 *
 * Host-local date methods are never used. `getDate()` answers in the machine's
 * own zone, so an 8:30 a.m. ET release is the 11th on a UTC server and the 11th
 * or 12th on a reader's handset depending on the hour — the calendar bug that
 * `src/lib/market-events/time.ts` exists to prevent, and that
 * `eslint-rules/no-host-local-time.mjs` makes a build error there.
 */

import { z } from 'zod';
import calendarFile from '@/src/data/market-events.json';
import {
  BANGKOK_TIME_ZONE,
  formatBangkokDateTime,
  formatThaiDateOnly,
} from '@/src/lib/presentation/datetime';

/** The macro releases the shipped calendar knows about. */
export const ovEventCodeSchema = z.enum([
  'CPI', 'PPI', 'PCE', 'NFP', 'GDP', 'FOMC', 'JOBLESS_CLAIMS',
]);

/**
 * How widely a release is watched.
 *
 * An EDITORIAL ranking and nothing more. It is not measured, not back-tested,
 * and says nothing about how any symbol responds to anything — the same caveat
 * the shipped calendar states about its own field, restated here because this
 * module hands the value to a different surface.
 */
export const ovEventImportanceSchema = z.enum(['high', 'medium', 'low']);

export type OvEventCode = z.infer<typeof ovEventCodeSchema>;
export type OvEventImportance = z.infer<typeof ovEventImportanceSchema>;

export const ovMarketEventSchema = z.object({
  /**
   * Kept although the contract does not name it.
   *
   * A list rendered without a stable identity keys on its index, and an index
   * key over a filtered window reassigns every row the moment the window moves.
   */
  id: z.string().min(1),
  code: ovEventCodeSchema,
  titleTh: z.string().min(1),
  importance: ovEventImportanceSchema,
  /*
   * Z or it does not load. An offset form like `2026-09-11T08:30:00-04:00`
   * parses correctly today and is the shape that invites somebody to store a
   * local time with a zone name beside it later, which re-derives a DST offset
   * on every machine that draws it.
   */
  startsAtUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
});

export type OvMarketEvent = z.infer<typeof ovMarketEventSchema>;

/** The shipped file's row shape, read leniently and narrowed to what is needed. */
const sourceRowSchema = z.object({
  id: z.string().min(1),
  kind: ovEventCodeSchema,
  titleTh: z.string().min(1),
  importance: ovEventImportanceSchema,
  at: z.string().min(1),
}).passthrough();

const sourceFileSchema = z.object({ events: z.array(sourceRowSchema) });

function loadShippedEvents(): OvMarketEvent[] {
  const parsed = sourceFileSchema.safeParse(calendarFile);
  /*
    A file that does not parse yields NO events, never a partial list. Half a
    calendar looks exactly like a complete one and tells a reader that nothing
    is scheduled the week the schema changed underneath it.
  */
  if (!parsed.success) return [];
  const rows = parsed.data.events.flatMap((row) => {
    const event = ovMarketEventSchema.safeParse({
      id: row.id,
      code: row.kind,
      titleTh: row.titleTh,
      importance: row.importance,
      startsAtUtc: row.at,
    });
    return event.success ? [event.data] : [];
  });
  return rows.sort(compareOvEvents);
}

const IMPORTANCE_RANK: Readonly<Record<OvEventImportance, number>> = {
  high: 0, medium: 1, low: 2,
};

export function ovEventImportanceRank(importance: OvEventImportance): number {
  return IMPORTANCE_RANK[importance];
}

/** Soonest first, then most-watched, then by id so the order is total. */
export function compareOvEvents(left: OvMarketEvent, right: OvMarketEvent): number {
  if (left.startsAtUtc !== right.startsAtUtc) {
    return left.startsAtUtc < right.startsAtUtc ? -1 : 1;
  }
  const byImportance = ovEventImportanceRank(left.importance) - ovEventImportanceRank(right.importance);
  if (byImportance !== 0) return byImportance;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Every shipped row, validated once at module load and sorted. */
export const OV_MARKET_EVENTS: readonly OvMarketEvent[] = loadShippedEvents();

/**
 * A `YYYY-MM-DD` Bangkok day key.
 *
 * `en-CA` because its short date format IS `YYYY-MM-DD`, so the key needs no
 * reassembly from parts. The zone comes from `datetime.ts` — this module never
 * writes the zone name itself.
 */
const BANGKOK_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: BANGKOK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function ovBangkokDayKey(instant: string | Date): string | null {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.valueOf())) return null;
  return BANGKOK_DAY.format(date);
}

/**
 * Whole days from `now` to the event, counted in BANGKOK DAYS.
 *
 * Day count, not elapsed hours. A release at 19:30 Bangkok tonight and one at
 * 07:00 tomorrow are eleven and a half hours apart and are "วันนี้" and
 * "พรุ่งนี้" — a reader plans by the calendar, not by the stopwatch, and a
 * countdown built from `(then - now) / 86_400_000` would call both of them 0.
 *
 * Negative for an event that has passed. Null when either instant is
 * unreadable, which the caller must render as no countdown rather than as 0.
 */
export function ovEventCountdownDays(
  startsAtUtc: string,
  now: string | Date = new Date(),
): number | null {
  const from = ovBangkokDayKey(now);
  const to = ovBangkokDayKey(startsAtUtc);
  if (from === null || to === null) return null;
  return dayKeyDifference(from, to);
}

/**
 * Difference in days between two `YYYY-MM-DD` keys.
 *
 * Arithmetic on the KEY through `Date.UTC`, never on the original instants. A
 * key has already had its zone resolved away; re-parsing it in a local zone
 * would apply a second offset, and subtracting timestamps would be wrong across
 * a DST boundary in any zone that observes one. Bangkok does not, and this must
 * not silently depend on that staying true.
 */
function dayKeyDifference(from: string, to: string): number {
  const start = utcMidnight(from);
  const end = utcMidnight(to);
  if (start === null || end === null) return 0;
  return Math.round((end - start) / 86_400_000);
}

function utcMidnight(dayKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export interface OvEventCalendar {
  /**
   * Every row in the file dated today or later, soonest first.
   *
   * NOT cut to a horizon. The file decides how far this reaches, so a row added
   * for 2027 or 2030 shows up with no code change — that is the whole point of
   * this module and the reason the twelve-month window was removed.
   *
   * Empty is a legitimate answer and means the file has run out, which
   * {@link lastDayKey} then explains.
   */
  events: OvMarketEvent[];
  /** Bangkok day the list opens on — today. */
  fromDayKey: string;
  /**
   * The last Bangkok day the FILE reaches, whether or not it is in the future.
   *
   * Read off the data, never a constant: it is the last row's own day. A file
   * extended by one line moves this by itself.
   *
   * Null only when the file holds no readable row at all.
   */
  lastDayKey: string | null;
  /**
   * Whether the calendar still has anything to say.
   *
   * FALSE means the file has run out — every row it holds is in the past — and
   * it must be rendered, not swallowed. An empty list is perfectly drawable and
   * reads as "nothing is scheduled", which is the opposite of what is true.
   *
   * Derived from {@link lastDayKey} against today. There is no horizon in this
   * comparison and no number to keep in step with the data.
   */
  coversThrough: boolean;
}

/**
 * The calendar, from today forward.
 *
 * Filters on the Bangkok DAY KEY rather than on the instant, so an event
 * happening late tonight Bangkok time is inside "today" and not excluded by a
 * comparison against the current clock. `YYYY-MM-DD` sorts lexicographically
 * exactly as it sorts chronologically, which is what makes the comparison both
 * correct and cheap.
 *
 * `events` is accepted so a test can hand in its own rows. Every caller in the
 * product uses the default, which is the shipped file.
 */
export function ovEventCalendar({
  now = new Date(),
  events = OV_MARKET_EVENTS,
}: {
  now?: string | Date;
  events?: readonly OvMarketEvent[];
} = {}): OvEventCalendar | null {
  const fromDayKey = ovBangkokDayKey(now);
  if (fromDayKey === null) return null;

  const dated = events.flatMap((event) => {
    const dayKey = ovBangkokDayKey(event.startsAtUtc);
    return dayKey === null ? [] : [{ event, dayKey }];
  });

  /*
    The last day the FILE reaches, taken by scanning rather than by trusting the
    input to be sorted. `OV_MARKET_EVENTS` is sorted at load, but a test — or a
    future caller assembling rows from two places — is under no such obligation,
    and a `lastDayKey` that silently depended on input order would be wrong in
    exactly the case somebody is debugging.
  */
  const lastDayKey = dated.reduce<string | null>(
    (latest, item) => (latest === null || item.dayKey > latest ? item.dayKey : latest),
    null,
  );

  return {
    events: dated
      .filter((item) => item.dayKey >= fromDayKey)
      .map((item) => item.event)
      .sort(compareOvEvents),
    fromDayKey,
    lastDayKey,
    coversThrough: lastDayKey !== null && lastDayKey >= fromDayKey,
  };
}

/**
 * @deprecated Use {@link ovEventCalendar}. Kept because `app/page.tsx` names it
 * and this change is not allowed to touch that file; the behaviour is the new
 * one, so the only thing left of the "window" is the word.
 */
export const ovEventWindow = ovEventCalendar;

/** @deprecated Use {@link OvEventCalendar}. */
export type OvEventWindow = OvEventCalendar;

/**
 * The Thai date a card prints for one event, from the shared formatter.
 *
 * The day key is handed to `formatThaiDateOnly` rather than the instant: the
 * key has already been resolved to Bangkok, and passing the raw instant would
 * let the formatter resolve it a second time.
 */
export function ovEventDayLabel(event: OvMarketEvent): string {
  const dayKey = ovBangkokDayKey(event.startsAtUtc);
  return dayKey === null ? '—' : formatThaiDateOnly(dayKey);
}

/** Date and Bangkok wall-clock time, for the row a reader opens. */
export function ovEventTimeLabel(event: OvMarketEvent): string {
  return formatBangkokDateTime(event.startsAtUtc);
}
