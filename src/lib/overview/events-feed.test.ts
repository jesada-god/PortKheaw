import { describe, expect, it } from 'vitest';
import { buildOverviewEvents, OVERVIEW_EVENTS_GROUP_LIMIT } from './events-feed';
import type { OverviewEventsView } from './events-feed';
import type { OvEventCalendar, OvMarketEvent } from '@/src/lib/market-overview/events';
import type { UpcomingFeed } from '@/src/lib/upcoming/types';

/**
 * The claim under test is that the merge LOSES NOTHING.
 *
 * Merging earnings alone would have silently dropped the two other kinds the
 * Upcoming card carried — option expiries and alert proximity — and a
 * contract's expiry disappearing off a page is not a formatting decision. Half
 * of these cases exist to pin that.
 */

const NOW = '2026-09-11T00:00:00.000Z'; // 07:00 in Bangkok on the 11th.

/*
  Both groups, for the assertions that are about the merge LOSING NOTHING rather
  than about where a row landed. The two are deliberately separate on the view —
  see `OverviewEventsView` — so a test that wants "did this row survive at all"
  has to say so explicitly instead of reading one list and assuming.
*/
function allRows(view: OverviewEventsView) {
  return [...view.calendar.rows, ...view.holdings.rows];
}

function macro(id: string, startsAtUtc: string, importance: OvMarketEvent['importance'] = 'high'): OvMarketEvent {
  return { id, code: 'CPI', titleTh: `เงินเฟ้อ ${id}`, importance, startsAtUtc };
}

function windowOf(events: OvMarketEvent[], extra: Partial<OvEventCalendar> = {}): OvEventCalendar {
  return {
    events,
    fromDayKey: '2026-09-11',
    coversThrough: true,
    lastDayKey: events.length ? '2026-12-31' : null,
    ...extra,
  };
}

const UPCOMING: UpcomingFeed = {
  events: [
    {
      id: 'earnings:NVDA:2026-09-16',
      kind: 'earnings',
      symbol: 'NVDA',
      days: 5,
      reportDate: '2026-09-16',
      text: 'NVDA · ประกาศผลประกอบการในอีก 5 วัน',
    },
    {
      id: 'expiry:AAPL-C',
      kind: 'option-expiry',
      symbol: 'AAPL',
      days: 2,
      contractSymbol: 'AAPL260918C00200000',
      expirationDate: '2026-09-18',
      text: 'AAPL · Call หมดอายุในอีก 2 วัน',
    },
    {
      id: 'alert:RKLB',
      kind: 'alert',
      symbol: 'RKLB',
      days: null,
      distancePercent: 3.2,
      text: 'RKLB · ใกล้ราคาที่ตั้งแจ้งเตือนไว้',
    },
  ],
  total: 3,
};

describe('buildOverviewEvents', () => {
  it('carries every kind Upcoming had, not only earnings', () => {
    const view = buildOverviewEvents({ window: windowOf([]), upcoming: UPCOMING, now: NOW });
    expect(view.holdings.rows.map((row) => row.kind).sort())
      .toEqual(['alert', 'earnings', 'option-expiry']);
    // And none of them leaked into the economic calendar.
    expect(view.calendar.rows).toEqual([]);
  });

  it('keeps the sentence each builder already wrote', () => {
    const view = buildOverviewEvents({ window: windowOf([]), upcoming: UPCOMING, now: NOW });
    expect(allRows(view).map((row) => row.titleTh))
      .toContain('AAPL · Call หมดอายุในอีก 2 วัน');
  });

  /*
    THE TWO GROUPS DO NOT INTERLEAVE, which is the whole point of splitting them.

    This test used to assert the opposite — one list reading `['cpi',
    'expiry:AAPL-C', 'earnings:NVDA:2026-09-16']` — and that ordering is exactly
    how "IREN Call · หมดอายุในอีก 2 วัน" came to sit between CPI and NFP.
    Soonest-first is still right WITHIN a group; it was never a reason to put a
    contract the reader owns in the middle of a publication schedule.
  */
  it('orders each group soonest first, and never across the two', () => {
    const view = buildOverviewEvents({
      window: windowOf([
        macro('cpi', '2026-09-12T12:30:00.000Z'),
        macro('nfp', '2026-09-14T12:30:00.000Z'),
      ]),
      upcoming: UPCOMING,
      now: NOW,
    });
    expect(view.calendar.rows.map((row) => row.id)).toEqual(['cpi', 'nfp']);
    expect(view.holdings.rows.map((row) => row.id).slice(0, 2))
      .toEqual(['expiry:AAPL-C', 'earnings:NVDA:2026-09-16']);
    // The expiry falls between the two releases by date and still is not there.
    expect(view.calendar.rows.every((row) => row.kind === 'macro')).toBe(true);
    expect(view.holdings.rows.every((row) => row.kind !== 'macro')).toBe(true);
  });

  it('sorts an undated row last rather than as day zero', () => {
    // An alert is "close", not "in zero days". Letting null read as 0 would put
    // it above a release happening this morning.
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-11T12:30:00.000Z')]),
      upcoming: UPCOMING,
      now: NOW,
    });
    expect(view.holdings.rows.at(-1)!.id).toBe('alert:RKLB');
  });

  it('breaks a same-day tie by how widely the release is watched', () => {
    const view = buildOverviewEvents({
      window: windowOf([
        macro('low', '2026-09-12T12:30:00.000Z', 'low'),
        macro('high', '2026-09-12T12:30:00.000Z', 'high'),
      ]),
      upcoming: null,
      now: NOW,
    });
    expect(view.calendar.rows.map((row) => row.id)).toEqual(['high', 'low']);
  });

  it('drops a release that already happened', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('yesterday', '2026-09-10T12:30:00.000Z')]),
      upcoming: null,
      now: NOW,
    });
    expect(view.calendar.rows).toEqual([]);
  });

  it('states the countdown in days, and says วันนี้ for today', () => {
    const view = buildOverviewEvents({
      window: windowOf([
        macro('today', '2026-09-11T12:30:00.000Z'),
        macro('soon', '2026-09-16T12:30:00.000Z'),
      ]),
      upcoming: null,
      now: NOW,
    });
    expect(view.calendar.rows.map((row) => row.countdownText))
      .toEqual(['วันนี้', 'อีก 5 วัน']);
  });

  it('gives macro rows a date and a Bangkok time, and the others neither', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')]),
      upcoming: UPCOMING,
      now: NOW,
    });
    const cpi = view.calendar.rows.find((row) => row.id === 'cpi')!;
    const expiry = view.holdings.rows.find((row) => row.kind === 'option-expiry')!;
    expect(cpi.dayLabel).not.toBeNull();
    expect(cpi.timeLabel).not.toBeNull();
    // A date and an expiry are DAYS. Printing 00:00 beside them would invent a
    // precision the source does not have.
    expect(expiry.dayLabel).toBeNull();
    expect(expiry.timeLabel).toBeNull();
  });

  it('gives importance to macro rows only', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')]),
      upcoming: UPCOMING,
      now: NOW,
    });
    expect(view.calendar.rows.find((row) => row.id === 'cpi')!.importance).toBe('high');
    for (const row of allRows(view).filter((item) => item.kind !== 'macro')) {
      expect(row.importance, row.id).toBeNull();
    }
  });

  /*
    A MACRO ROW COUNTS THE READER'S SYMBOLS AND NAMES NONE OF THEM.

    It used to carry `affectedSymbols` — the capped, alphabetical list that is
    IDENTICAL on every market-wide release, because all seven codes are one.
    Rendered as linked tickers it read as "these stocks are affected by CPI",
    which is the per-symbol claim `event-relevance.ts` states in its own header
    that it does not make. The count says the true part and cannot say the
    false one.
  */
  it('counts the symbols a macro row reaches and names none of them', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')]),
      upcoming: null,
      portfolioSymbols: ['AAPL'],
      watchlistSymbols: ['msft', 'AAPL'],
      now: NOW,
    });
    const row = view.calendar.rows[0]!;
    expect(row.symbols).toEqual([]);
    // Deduplicated across both lists: AAPL is in each and counts once.
    expect(row.affectedCount).toBe(2);
  });

  /*
    The count is the FULL total, not the display cap. `affectedSymbols` stops at
    eight; a reader with twenty is entitled to be told twenty, and the capped
    list is exactly what this row no longer prints.
  */
  it('counts past the cap the name list stopped at', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')]),
      upcoming: null,
      watchlistSymbols: Array.from({ length: 20 }, (_, index) => `SYM${index}`),
      now: NOW,
    });
    expect(view.calendar.rows[0]!.affectedCount).toBe(20);
  });

  /*
    Zero is a real answer — a signed-out reader, an empty watchlist — and the
    card must draw nothing for it rather than "0 ตัว".
  */
  it('reports a zero count rather than omitting it when nothing is held', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')]),
      upcoming: null,
      now: NOW,
    });
    expect(view.calendar.rows[0]!.affectedCount).toBe(0);
  });

  /*
    The other three kinds are about one company each, so they keep the link a
    reader opens. `affectedCount` is absent on them: it is a statement about a
    market-wide release, and they are not one.
  */
  it('leaves an upcoming row with its instrument and no breadth count', () => {
    const view = buildOverviewEvents({ window: windowOf([]), upcoming: UPCOMING, now: NOW });
    const earnings = view.holdings.rows.find((row) => row.kind === 'earnings')!;
    expect(earnings.symbols).toEqual(['NVDA']);
    expect(earnings.affectedCount).toBeUndefined();
  });

  it('names the symbol an upcoming row is about', () => {
    const view = buildOverviewEvents({ window: windowOf([]), upcoming: UPCOMING, now: NOW });
    expect(view.holdings.rows.find((row) => row.kind === 'earnings')!.symbols)
      .toEqual(['NVDA']);
  });

  /*
    THE BUDGET IS PER GROUP. One shared budget of six, spent soonest-first over a
    merged list, meant a September carrying five macro releases pushed every
    expiry and every earnings date off the section — a reader lost a contract
    expiry because the government publishes a lot that month, which is not a
    relationship those two facts have to each other.
  */
  it('caps each group on its own and reports each remainder separately', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      macro(`m${index}`, `2026-09-${String(12 + index).padStart(2, '0')}T12:30:00.000Z`));
    const view = buildOverviewEvents({ window: windowOf(many), upcoming: UPCOMING, now: NOW });
    expect(view.calendar.rows).toHaveLength(OVERVIEW_EVENTS_GROUP_LIMIT);
    expect(view.calendar.total).toBe(10);
    // Ten releases do not cost the reader a single one of their own rows.
    expect(view.holdings.rows).toHaveLength(3);
    expect(view.holdings.total).toBe(3);
  });

  it('says where the calendar stops, and only when it stops short', () => {
    const covered = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')]),
      upcoming: null,
      now: NOW,
    });
    expect(covered.coverageNoteTh).toBeNull();

    const short = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')], {
        coversThrough: false,
        lastDayKey: '2026-12-31',
      }),
      upcoming: null,
      now: NOW,
    });
    expect(short.coverageNoteTh).toContain('ปฏิทินถึง');
    expect(short.coverageNoteTh).toContain('เดือนถัดไปรอประกาศ');
  });

  it('still reports coverage when the window is empty', () => {
    /*
      The case the note exists for. A run of empty months is perfectly drawable
      and reads as "nothing is scheduled", which is the opposite of the truth.
    */
    const view = buildOverviewEvents({
      window: windowOf([], { coversThrough: false, lastDayKey: '2026-12-31' }),
      upcoming: null,
      now: NOW,
    });
    expect(view.calendar.rows).toEqual([]);
    expect(view.coverageNoteTh).toContain('ปฏิทินถึง');
  });

  it('survives a calendar that could not be read at all', () => {
    const view = buildOverviewEvents({ window: null, upcoming: UPCOMING, now: NOW });
    expect(view.calendar.rows).toEqual([]);
    expect(view.holdings.rows).toHaveLength(3);
    expect(view.coverageNoteTh).toBeNull();
  });

  it('is empty and quiet for a signed-out visitor with no calendar', () => {
    const view = buildOverviewEvents({ window: null, upcoming: null, now: NOW });
    expect(view).toEqual({
      calendar: { rows: [], total: 0 },
      holdings: { rows: [], total: 0 },
      coverageNoteTh: null,
    });
  });
});
