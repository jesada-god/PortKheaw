import calendarFile from '@/src/data/market-events.json';
import { bangkokDayKey, monthKeyOf } from './time';
import { marketEventFileSchema, type MarketEvent, type MarketEventImportance } from './types';

/**
 * The shipped calendar, validated once and sorted by the instant it happens.
 *
 * A file this small is parsed at module load rather than on demand: it is a
 * static import, it costs nothing after the first evaluation, and a malformed
 * row should fail the build's first render rather than the one page view that
 * happens to touch it.
 */
const parsed = marketEventFileSchema.safeParse(calendarFile);

/** The ranking the "+N" cell and the feed both order by. */
const IMPORTANCE_RANK: Record<MarketEventImportance, number> = {
  high: 0, medium: 1, low: 2,
};

export function importanceRank(importance: MarketEventImportance): number {
  return IMPORTANCE_RANK[importance];
}

function compareEvents(left: MarketEvent, right: MarketEvent): number {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  const byImportance = importanceRank(left.importance) - importanceRank(right.importance);
  if (byImportance) return byImportance;
  // Ties broken by id so the order is total, and identical on every machine.
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}


/*
 * A file that does not parse yields NO events, never a partial list.
 *
 * The difference matters on the card. An empty calendar is a state this feature
 * already has to render honestly — `coverageOf` reports it and the card says the
 * period is not covered — whereas half a calendar looks exactly like a complete
 * one and quietly tells a reader that nothing happens the week the schema
 * changed under it.
 */
export const MARKET_EVENTS: readonly MarketEvent[] = parsed.success
  ? [...parsed.data.events].sort(compareEvents)
  : [];

/**
 * Whether the file still covers the day being looked at.
 *
 * ===========================================================================
 * A CALENDAR THAT HAS RUN OUT MUST SAY SO
 * ===========================================================================
 * The events in this file were transcribed from four agencies' published
 * schedules, and those schedules end. When the reader's day passes the last
 * row, the honest answer is "this calendar does not reach here" — NOT a
 * correctly drawn, entirely empty December, which is indistinguishable from a
 * month in which nothing is scheduled and tells the reader the opposite of the
 * truth.
 *
 * `before` is the mirror case and exists for the same reason: a calendar that
 * starts in September has nothing to say about July, and should not imply that
 * July was quiet.
 */
export type CalendarCoverage =
  | { state: 'covered'; firstDayKey: string; lastDayKey: string }
  | { state: 'exhausted'; firstDayKey: string; lastDayKey: string }
  | { state: 'before'; firstDayKey: string; lastDayKey: string }
  | { state: 'empty'; firstDayKey: null; lastDayKey: null };

export function coverageOf(
  now: string | Date,
  events: readonly MarketEvent[] = MARKET_EVENTS,
): CalendarCoverage {
  if (events.length === 0) return { state: 'empty', firstDayKey: null, lastDayKey: null };
  const firstDayKey = bangkokDayKey(events[0].at);
  const lastDayKey = bangkokDayKey(events[events.length - 1].at);
  const today = bangkokDayKey(now);
  if (!firstDayKey || !lastDayKey || !today) {
    return { state: 'empty', firstDayKey: null, lastDayKey: null };
  }
  /*
   * Compared as day KEYS, which is a string comparison that happens to be the
   * right one: `YYYY-MM-DD` sorts lexicographically exactly as it sorts
   * chronologically, and both sides were resolved to Bangkok by the same util.
   * Comparing instants instead would put a reader whose Thai day has started
   * but whose last event has not yet fired into the wrong bucket.
   */
  if (today > lastDayKey) return { state: 'exhausted', firstDayKey, lastDayKey };
  if (today < firstDayKey) return { state: 'before', firstDayKey, lastDayKey };
  return { state: 'covered', firstDayKey, lastDayKey };
}

/** Every event on one Bangkok day, most important first. */
export function eventsOnDay(
  dayKey: string,
  events: readonly MarketEvent[] = MARKET_EVENTS,
): MarketEvent[] {
  return events
    .filter((event) => bangkokDayKey(event.at) === dayKey)
    .sort((left, right) =>
      importanceRank(left.importance) - importanceRank(right.importance)
      || (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
}

/** Events grouped by Bangkok day, in day order, each group most-important-first. */
export function groupByBangkokDay(
  events: readonly MarketEvent[] = MARKET_EVENTS,
): Array<{ dayKey: string; events: MarketEvent[] }> {
  const byDay = new Map<string, MarketEvent[]>();
  for (const event of events) {
    const dayKey = bangkokDayKey(event.at);
    if (!dayKey) continue;
    const bucket = byDay.get(dayKey);
    if (bucket) bucket.push(event);
    else byDay.set(dayKey, [event]);
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([dayKey, group]) => ({
      dayKey,
      events: group.sort((left, right) =>
        importanceRank(left.importance) - importanceRank(right.importance)
        || (left.at < right.at ? -1 : left.at > right.at ? 1 : 0)),
    }));
}

/**
 * The months the file actually speaks for, READ OFF THE FILE.
 *
 * ===========================================================================
 * WHY THIS IS DERIVED AND NEVER WRITTEN DOWN
 * ===========================================================================
 * "Sep–Dec 2026" is true today and will be false the first time somebody adds a
 * January row — which, per the header of `market-overview/events.ts`, is meant
 * to be an edit to `market-events.json` AND NOTHING ELSE. A constant here would
 * quietly become a second calendar: the file would reach February and the month
 * navigation would still stop at December, with nothing failing and nobody
 * looking.
 *
 * So the range is a scan. Forty rows, once per render, and it cannot disagree
 * with the data it was computed from.
 *
 * The scan takes a MIN and a MAX rather than reading the first and last rows of
 * a sorted list. `MARKET_EVENTS` is sorted by instant and Bangkok is a fixed
 * +7 with no daylight saving, so the two answers agree today — but they agree
 * because of a property of a time zone, not because of anything this function
 * arranged, and a scan needs no such argument.
 */
export interface CalendarMonthRange {
  /** `YYYY-MM` of the earliest event, in Bangkok. */
  firstMonthKey: string;
  /** `YYYY-MM` of the latest. */
  lastMonthKey: string;
}

export function monthRangeOf(
  events: readonly MarketEvent[] = MARKET_EVENTS,
): CalendarMonthRange | null {
  let firstMonthKey: string | null = null;
  let lastMonthKey: string | null = null;
  for (const event of events) {
    const dayKey = bangkokDayKey(event.at);
    if (!dayKey) continue;
    const monthKey = monthKeyOf(dayKey);
    if (firstMonthKey === null || monthKey < firstMonthKey) firstMonthKey = monthKey;
    if (lastMonthKey === null || monthKey > lastMonthKey) lastMonthKey = monthKey;
  }
  if (firstMonthKey === null || lastMonthKey === null) return null;
  return { firstMonthKey, lastMonthKey };
}

/**
 * Whether the calendar reaches THE MONTH ON SCREEN — not the month the reader
 * happens to be living in.
 *
 * ===========================================================================
 * THE AXIS THIS ASKS ON, AND WHY `coverageOf` COULD NOT BE REUSED
 * ===========================================================================
 * `coverageOf(now)` answers a question about the READER: has their own day run
 * past the end of the file. That was the only question a card fixed to the
 * current month could have. Once the grid can be walked forwards, it stops
 * being the right one — a reader on 3 September paging to March 2027 is still
 * "covered" by that test, because *they* are inside the window even though the
 * month in front of them is a hundred days past the last row.
 *
 * Both functions stay. They answer different questions and the words they
 * answer in are deliberately the same, so a reader of either call site is not
 * learning a second vocabulary:
 *
 *   `covered`   — the month is inside the range the file speaks for
 *   `before`    — the month is earlier than anything in the file
 *   `exhausted` — the month is later than the last row
 *   `empty`     — the file has no rows at all
 *
 * A `covered` month with nothing in it is a real and honest answer: the
 * calendar reaches that month and there is nothing scheduled. That is the one
 * case where a blank grid tells the truth, and it is the reason this returns a
 * range check rather than a count.
 */
export type MonthCoverageState = CalendarCoverage['state'];

export type MonthCoverage =
  | { state: 'covered' | 'before' | 'exhausted'; firstMonthKey: string; lastMonthKey: string }
  | { state: 'empty'; firstMonthKey: null; lastMonthKey: null };

export function coverageOfMonth(
  monthKey: string,
  events: readonly MarketEvent[] = MARKET_EVENTS,
): MonthCoverage {
  const range = monthRangeOf(events);
  if (!range) return { state: 'empty', firstMonthKey: null, lastMonthKey: null };
  /*
   * `YYYY-MM` sorts lexicographically exactly as it sorts chronologically, and
   * every key on both sides of these comparisons was produced by `monthKeyOf`
   * over a Bangkok day key. There is no second zone left in the comparison.
   */
  if (monthKey < range.firstMonthKey) return { state: 'before', ...range };
  if (monthKey > range.lastMonthKey) return { state: 'exhausted', ...range };
  return { state: 'covered', ...range };
}
