import { describe, expect, it } from 'vitest';
import { coverageOf, coverageOfMonth, eventsOnDay, groupByBangkokDay, monthRangeOf, MARKET_EVENTS } from './calendar';
import { buildEventFeed } from './feed';
import { buildMarketEventsCardView } from './card-view';
import { buildMarketEventsMonthView } from './month-view';
import { ovEventCalendar, OV_MARKET_EVENTS } from '@/src/lib/market-overview/events';
import { buildOverviewEvents } from '@/src/lib/overview/events-feed';
import type { MarketEvent } from './types';

/**
 * WHAT A ROW DATED IN THE PAST DOES TO EVERY SURFACE THAT READS THIS FILE.
 *
 * ===========================================================================
 * WHY THIS EXISTS BEFORE THERE IS ANY HISTORY TO READ
 * ===========================================================================
 * `market-events.json` holds no row dated before its first forward date and
 * never has: it was transcribed from four agencies' FORWARD schedules. The
 * market-reaction work needs the opposite — releases that have already
 * happened — and the honest way to find out what that breaks is to hand every
 * consumer a file that has some, rather than to reason about it.
 *
 * There are seven consumers and they are not all in this folder. Two modules
 * read the same JSON on purpose (`src/lib/market-events` and
 * `src/lib/market-overview/events.ts`, which share the file and no types), and
 * two more read those. A past row is either invisible or wrong in each, and
 * "invisible" is what almost all of them promise:
 *
 *   the detail feed          — must EXCLUDE it (it is not "coming up")
 *   the overview event list  — must EXCLUDE it, for the same reason
 *   the overview card grid   — must SHOW it: a card drawn for October shows
 *                              the whole of October, including the days of it
 *                              that have gone by, and always has
 *   the calendar page grid   — the same, and that is the entire point of being
 *                              able to walk backwards
 *   coverage and the range   — must WIDEN, so the back arrow reaches it
 *
 * ===========================================================================
 * NOTHING HERE IS A FABRICATED RELEASE DATE
 * ===========================================================================
 * The fixture below is a TEST fixture and says so: ids like `past-cpi` against
 * a `referencePeriod` of `ทดสอบ`, which is the same shape `calendar.test.ts`
 * uses. Not one of these instants is offered as a real BLS or BEA publication
 * date, and none of them is in the shipped file. Backfilling that file means
 * reading dates off the agencies' archives one at a time — see
 * `docs/market-events-backfill.md`.
 */

function event(over: Partial<MarketEvent> & Pick<MarketEvent, 'id' | 'at'>): MarketEvent {
  return {
    kind: 'CPI',
    titleTh: 'เงินเฟ้อผู้บริโภค (CPI)',
    shortTh: 'CPI',
    importance: 'high',
    source: 'BLS',
    referencePeriod: 'ทดสอบ',
    etDisplay: '8:30 a.m. ET',
    ...over,
  };
}

/*
 * Three past releases and two future ones, read against a clock of
 * 2026-11-10T04:00Z — which is 11:00 on Tuesday 10 November in Bangkok.
 *
 *   2026-08-12T12:30Z  +7 = 2026-08-12 19:30   PAST, and in a month the file
 *                                              would otherwise not reach
 *   2026-10-15T12:30Z  +7 = 2026-10-15 19:30   PAST, previous month
 *   2026-11-06T12:30Z  +7 = 2026-11-06 19:30   PAST, same month as "today"
 *   2026-11-10T13:30Z  +7 = 2026-11-10 20:30   TODAY, later this evening
 *   2026-12-09T19:00Z  +7 = 2026-12-10 02:00   FUTURE, and the NEXT Thai day
 */
const NOW = '2026-11-10T04:00:00.000Z';
const TODAY_KEY = '2026-11-10';

const MIXED: MarketEvent[] = [
  event({ id: 'past-aug', at: '2026-08-12T12:30:00.000Z' }),
  event({ id: 'past-oct', at: '2026-10-15T12:30:00.000Z', kind: 'PPI', shortTh: 'PPI', importance: 'medium' }),
  event({ id: 'past-nov', at: '2026-11-06T12:30:00.000Z', kind: 'NFP', shortTh: 'NFP' }),
  event({ id: 'today-nov', at: '2026-11-10T13:30:00.000Z' }),
  event({ id: 'future-dec', at: '2026-12-09T19:00:00.000Z', kind: 'FOMC', shortTh: 'FOMC' }),
];

/** The same rows in the overview module's own shape, which shares no type. */
const MIXED_OV = MIXED.map((row) => ({
  id: row.id,
  code: row.kind,
  titleTh: row.titleTh,
  importance: row.importance,
  startsAtUtc: row.at,
}));

describe('a calendar that holds releases which have already happened', () => {
  it('loads them: nothing about the row shape says a release must be in the future', () => {
    const grouped = groupByBangkokDay(MIXED);
    expect(grouped.map((day) => day.dayKey))
      .toEqual(['2026-08-12', '2026-10-15', '2026-11-06', '2026-11-10', '2026-12-10']);
  });

  it('finds a past day by its key like any other day', () => {
    expect(eventsOnDay('2026-11-06', MIXED).map((row) => row.id)).toEqual(['past-nov']);
  });
});

describe('the range and the coverage widen backwards', () => {
  it('reaches back to the earliest row rather than to the earliest FUTURE row', () => {
    expect(monthRangeOf(MIXED)).toEqual({ firstMonthKey: '2026-08', lastMonthKey: '2026-12' });
  });

  it('covers a past month, so the grid can be walked into it', () => {
    expect(coverageOfMonth('2026-08', MIXED).state).toBe('covered');
    expect(coverageOfMonth('2026-07', MIXED).state).toBe('before');
  });

  /*
   * `coverageOf` asks about the READER and is untouched by history: the file
   * still reaches 10 December, which is still ahead of today.
   */
  it('leaves the reader-facing coverage exactly where it was', () => {
    expect(coverageOf(NOW, MIXED)).toEqual({
      state: 'covered', firstDayKey: '2026-08-12', lastDayKey: '2026-12-10',
    });
  });
});

describe('the detail feed', () => {
  it('shows nothing that has already happened', () => {
    const days = buildEventFeed({ now: NOW, events: MIXED });
    expect(days.map((day) => day.dayKey)).toEqual(['2026-11-10', '2026-12-10']);
    for (const day of days) expect(day.dayKey >= TODAY_KEY).toBe(true);
  });

  it('still has the door for a caller that wants the past, and it stays shut by default', () => {
    const all = buildEventFeed({ now: NOW, events: MIXED, includePast: true });
    expect(all.map((day) => day.dayKey))
      .toEqual(['2026-08-12', '2026-10-15', '2026-11-06', '2026-11-10', '2026-12-10']);
  });

  it('does not head a past day "วันนี้" or "พรุ่งนี้" when one is asked for', () => {
    const all = buildEventFeed({ now: NOW, events: MIXED, includePast: true });
    const past = all.filter((day) => day.dayKey < TODAY_KEY);
    expect(past).toHaveLength(3);
    for (const day of past) expect(day.relative).toBe('other');
  });
});

describe('the overview card', () => {
  /*
   * The card draws the reader's own month and always has drawn the whole of
   * it, the elapsed days included. A November backfill row appears there for
   * the same reason the 6th appears at all — this is not new behaviour, it is
   * behaviour that had nothing to exercise it.
   */
  it('draws a past day of the current month exactly like any other day', () => {
    const view = buildMarketEventsCardView({ now: NOW, events: MIXED });
    const cell = view?.weeks.flat().find((item) => item.dayKey === '2026-11-06');
    expect(cell?.total).toBe(1);
    expect(cell?.leadShortTh).toBe('NFP');
    expect(cell?.isToday).toBe(false);
  });

  it('counts a past release in the month total, because it happened in the month', () => {
    expect(buildMarketEventsCardView({ now: NOW, events: MIXED })?.totalInMonth).toBe(2);
  });
});

describe('the calendar page', () => {
  it('walks back into a month that exists only because of history', () => {
    const view = buildMarketEventsMonthView({ now: NOW, monthParam: '2026-08', events: MIXED });
    expect(view?.coverage).toBe('covered');
    expect(view?.coverageNoteTh).toBeNull();
    expect(view?.totalInMonth).toBe(1);
    expect(view?.selected?.dayKey).toBe('2026-08-12');
  });

  it('lets the back arrow reach the earliest month the file holds, and stop there', () => {
    const august = buildMarketEventsMonthView({ now: NOW, monthParam: '2026-08', events: MIXED });
    expect(august?.prevMonthKey).toBeNull();
    expect(august?.nextMonthKey).toBe('2026-09');
    const november = buildMarketEventsMonthView({ now: NOW, events: MIXED });
    expect(november?.prevMonthKey).toBe('2026-10');
  });

  it('opens the panel on a past day and heads it with its date, not with a countdown', () => {
    const view = buildMarketEventsMonthView({ now: NOW, dayParam: '2026-11-06', events: MIXED });
    expect(view?.selected?.relative).toBe('other');
    expect(view?.selected?.headingTh).toBe('วันศุกร์ที่ 6 พฤศจิกายน 2569');
    expect(view?.selected?.items.map((item) => item.id)).toEqual(['past-nov']);
  });
});

describe('the overview module, which reads the same file and shares no type with it', () => {
  it('drops every release that has already happened', () => {
    const calendar = ovEventCalendar({ now: NOW, events: MIXED_OV });
    expect(calendar?.events.map((row) => row.id)).toEqual(['today-nov', 'future-dec']);
  });

  it('keeps saying how far the FILE reaches, which history does not change', () => {
    const calendar = ovEventCalendar({ now: NOW, events: MIXED_OV });
    expect(calendar?.lastDayKey).toBe('2026-12-10');
    expect(calendar?.coversThrough).toBe(true);
  });

  it('lets no past release reach the overview events section', () => {
    const calendar = ovEventCalendar({ now: NOW, events: MIXED_OV });
    const view = buildOverviewEvents({
      window: calendar!,
      upcoming: { events: [], total: 0 },
      portfolioSymbols: [],
      watchlistSymbols: [],
      now: NOW,
    });
    const ids = view.calendar.rows.map((row) => row.id);
    expect(ids).toEqual(['today-nov', 'future-dec']);
    for (const row of view.calendar.rows) {
      expect(row.countdownDays === null || row.countdownDays >= 0, row.id).toBe(true);
    }
  });
});

describe('the shipped file', () => {
  /*
   * A PROPERTY, not a date. It holds today with no history in the file and it
   * must still hold after somebody backfills a hundred rows — which is the
   * point of asserting it rather than asserting the file has no past.
   */
  it('never emits a day that has gone by, whatever it currently holds', () => {
    for (const now of ['2026-09-03T04:00:00.000Z', '2026-11-25T04:00:00.000Z']) {
      const todayKey = now.slice(0, 10);
      for (const day of buildEventFeed({ now })) {
        expect(day.dayKey >= todayKey, `${day.dayKey} is behind ${todayKey}`).toBe(true);
      }
    }
  });

  it('is read by both modules, and both of them can see all of it', () => {
    expect(MARKET_EVENTS.length).toBe(OV_MARKET_EVENTS.length);
    expect(MARKET_EVENTS.length).toBeGreaterThan(0);
  });
});
