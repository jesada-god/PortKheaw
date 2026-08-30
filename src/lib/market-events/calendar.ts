import calendarFile from '@/src/data/market-events.json';
import { bangkokDayKey } from './time';
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
