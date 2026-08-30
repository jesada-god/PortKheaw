/**
 * THE MACRO CALENDAR, AS A TWELVE-MONTH WINDOW.
 *
 * ===========================================================================
 * NO NEW DATA FILE, AND NO INVENTED DATES
 * ===========================================================================
 * The rows come from `src/data/market-events-2026.json`, which already ships
 * with the product and was transcribed from four agencies' published schedules.
 * Nothing here adds a row. A twelve-month window over a file that currently
 * holds four months' worth is honest and reports itself as such
 * ({@link OvEventWindow.coversThrough}); a twelve-month window filled in by
 * guessing when the next CPI print lands would be neither, and a wrong release
 * date on a calendar is worse than a missing one because a reader plans around
 * it.
 *
 * The file is read, not imported through `src/lib/market-events` — this module
 * owns `OvMarketEvent`, validates the rows against its own schema, and shares
 * no type with the existing calendar. See the header of `types.ts` for why
 * `MarketEvent` in particular could not be reused under its own name.
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
import calendarFile from '@/src/data/market-events-2026.json';
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

/** How many months forward the window reaches. */
export const OV_EVENT_WINDOW_MONTHS = 12;

export interface OvEventWindow {
  /** Events inside the window, soonest first. Empty is a legitimate answer. */
  events: OvMarketEvent[];
  /** Bangkok day the window opens on — today. */
  fromDayKey: string;
  /** Bangkok day the window closes on. */
  toDayKey: string;
  /**
   * Whether the shipped calendar actually reaches the end of the window.
   *
   * FALSE IS THE COMMON CASE and must be rendered, not swallowed. Past the last
   * row the window is still perfectly drawable — a run of empty months — and a
   * reader would take that to mean nothing is scheduled, which is the opposite
   * of what is true. `lastDayKey` names the date the file actually reaches so
   * the sentence a card prints is checkable.
   */
  coversThrough: boolean;
  /** Bangkok day of the last row in the file. Null when the file is empty. */
  lastDayKey: string | null;
}

/**
 * The next twelve months of the calendar.
 *
 * Filters on the Bangkok DAY KEY rather than on the instant, so an event
 * happening late tonight Bangkok time is inside "today" and not excluded by a
 * comparison against the current clock. `YYYY-MM-DD` sorts lexicographically
 * exactly as it sorts chronologically, which is what makes the comparison
 * below both correct and cheap.
 */
export function ovEventWindow({
  now = new Date(),
  months = OV_EVENT_WINDOW_MONTHS,
  events = OV_MARKET_EVENTS,
}: {
  now?: string | Date;
  months?: number;
  events?: readonly OvMarketEvent[];
} = {}): OvEventWindow | null {
  const fromDayKey = ovBangkokDayKey(now);
  if (fromDayKey === null) return null;
  const toDayKey = addMonths(fromDayKey, months);

  const inWindow = events.filter((event) => {
    const dayKey = ovBangkokDayKey(event.startsAtUtc);
    return dayKey !== null && dayKey >= fromDayKey && dayKey <= toDayKey;
  });

  const lastDayKey = events.length === 0
    ? null
    : ovBangkokDayKey(events[events.length - 1]!.startsAtUtc);

  return {
    events: [...inWindow].sort(compareOvEvents),
    fromDayKey,
    toDayKey,
    coversThrough: lastDayKey !== null && lastDayKey >= toDayKey,
    lastDayKey,
  };
}

/**
 * The same day-of-month `months` later, clamped to the end of a shorter month.
 *
 * 31 January plus one month is 28 February, not 3 March. `Date.UTC` would roll
 * the overflow forward, which for a window boundary means silently including
 * two or three extra days once a year.
 */
function addMonths(dayKey: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return dayKey;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1 + months;
  const day = Number(match[3]);
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clamped = Math.min(day, lastDay);
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(clamped)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

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
