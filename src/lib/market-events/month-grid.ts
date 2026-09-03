import { eventsOnDay, MARKET_EVENTS } from './calendar';
import { addDays, monthKeyOf, weekdayIndexOf } from './time';
import type { MarketEvent } from './types';

/**
 * The month grid, built as data so the card can be a dumb renderer.
 *
 * Seven columns, MONDAY FIRST, because that is how a Thai wall calendar reads
 * and the reader is not being asked to translate a layout as well as a time
 * zone. Every day key in here was resolved through `bangkokDayKey`, so a cell
 * holds the events that fall on that day IN BANGKOK — which is not the same set
 * a New York calendar would put there, and is the whole point.
 */
export interface CalendarCell {
  dayKey: string;
  dayNumber: number;
  /** False for the leading/trailing days that only exist to square the grid. */
  inMonth: boolean;
  isToday: boolean;
  /**
   * The one event whose name the cell prints, or null for a quiet day.
   *
   * "Most important" is `importanceRank`, ties broken by the earlier instant —
   * a total order, so the same day draws the same name on every machine.
   */
  lead: MarketEvent | null;
  /** How many events the cell could not name. Rendered as "+N", zero means no badge. */
  extraCount: number;
  total: number;
  /**
   * EVERY event on the day, most important first — `lead` is `events[0]`.
   *
   * The overview card never reads this: one name and a count is all a 50px cell
   * in a dashboard panel can carry, and `card-view.ts` maps it away so the JSON
   * stays out of the client bundle. The calendar PAGE does read it, because its
   * cells draw one mark per event and its detail panel lists the day. Building
   * it here rather than calling `eventsOnDay` a second time keeps one pass over
   * the month and one answer to "what is on this day".
   */
  events: MarketEvent[];
}

export interface MonthGrid {
  monthKey: string;
  weeks: CalendarCell[][];
  /** Every event in the drawn month, for a card that wants to count them. */
  total: number;
}

/** Monday-first column headers, matching `weekdayIndexOf`. */
export const WEEKDAY_HEADINGS_TH = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'] as const;

export function buildMonthGrid({
  monthKey,
  todayKey,
  events = MARKET_EVENTS,
}: {
  /** `YYYY-MM`, already resolved to Bangkok by the caller. */
  monthKey: string;
  /** `YYYY-MM-DD` in Bangkok, or null when the caller has no clock to offer. */
  todayKey: string | null;
  events?: readonly MarketEvent[];
}): MonthGrid {
  const firstOfMonth = `${monthKey}-01`;
  /*
   * Back up to the Monday on or before the 1st, then run forward in whole
   * weeks. Doing it this way — rather than computing an offset and slicing —
   * means the grid is correct for a month that starts on a Sunday without a
   * special case, which is the shape that usually breaks these.
   */
  let cursor = addDays(firstOfMonth, -weekdayIndexOf(firstOfMonth));
  const weeks: CalendarCell[][] = [];
  let total = 0;

  // Whole weeks until the cursor has passed the end of the month.
  while (monthKeyOf(cursor) <= monthKey || weeks.length === 0) {
    const week: CalendarCell[] = [];
    for (let column = 0; column < 7; column += 1) {
      const inMonth = monthKeyOf(cursor) === monthKey;
      const dayEvents = inMonth ? eventsOnDay(cursor, events) : [];
      if (inMonth) total += dayEvents.length;
      week.push({
        dayKey: cursor,
        dayNumber: Number(cursor.slice(8, 10)),
        inMonth,
        isToday: todayKey === cursor,
        lead: dayEvents[0] ?? null,
        extraCount: Math.max(0, dayEvents.length - 1),
        total: dayEvents.length,
        events: dayEvents,
      });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
    /*
     * The loop condition is checked on the cursor, which now points at the
     * Monday AFTER the week just written. A trailing week made entirely of the
     * next month is therefore never drawn.
     */
    if (monthKeyOf(cursor) > monthKey) break;
  }

  return { monthKey, weeks, total };
}
