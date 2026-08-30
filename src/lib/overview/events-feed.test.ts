import { describe, expect, it } from 'vitest';
import { buildOverviewEvents, OVERVIEW_EVENTS_LIMIT } from './events-feed';
import type { OvEventWindow, OvMarketEvent } from '@/src/lib/market-overview/events';
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

function macro(id: string, startsAtUtc: string, importance: OvMarketEvent['importance'] = 'high'): OvMarketEvent {
  return { id, code: 'CPI', titleTh: `เงินเฟ้อ ${id}`, importance, startsAtUtc };
}

function windowOf(events: OvMarketEvent[], extra: Partial<OvEventWindow> = {}): OvEventWindow {
  return {
    events,
    fromDayKey: '2026-09-11',
    toDayKey: '2027-09-11',
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
    expect(view.rows.map((row) => row.kind).sort())
      .toEqual(['alert', 'earnings', 'option-expiry']);
  });

  it('keeps the sentence each builder already wrote', () => {
    const view = buildOverviewEvents({ window: windowOf([]), upcoming: UPCOMING, now: NOW });
    expect(view.rows.map((row) => row.titleTh))
      .toContain('AAPL · Call หมดอายุในอีก 2 วัน');
  });

  it('merges macro and upcoming into one list, soonest first', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')]),
      upcoming: UPCOMING,
      now: NOW,
    });
    // One day, two days, five days — and the source each came from is not part
    // of the ordering.
    expect(view.rows.map((row) => row.id).slice(0, 3))
      .toEqual(['cpi', 'expiry:AAPL-C', 'earnings:NVDA:2026-09-16']);
  });

  it('sorts an undated row last rather than as day zero', () => {
    // An alert is "close", not "in zero days". Letting null read as 0 would put
    // it above a release happening this morning.
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-11T12:30:00.000Z')]),
      upcoming: UPCOMING,
      now: NOW,
    });
    expect(view.rows[view.rows.length - 1]!.id).toBe('alert:RKLB');
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
    expect(view.rows.map((row) => row.id)).toEqual(['high', 'low']);
  });

  it('drops a release that already happened', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('yesterday', '2026-09-10T12:30:00.000Z')]),
      upcoming: null,
      now: NOW,
    });
    expect(view.rows).toEqual([]);
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
    expect(view.rows.map((row) => row.countdownText)).toEqual(['วันนี้', 'อีก 5 วัน']);
  });

  it('gives macro rows a date and a Bangkok time, and the others neither', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')]),
      upcoming: UPCOMING,
      now: NOW,
    });
    const cpi = view.rows.find((row) => row.id === 'cpi')!;
    const expiry = view.rows.find((row) => row.kind === 'option-expiry')!;
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
    expect(view.rows.find((row) => row.id === 'cpi')!.importance).toBe('high');
    for (const row of view.rows.filter((item) => item.kind !== 'macro')) {
      expect(row.importance, row.id).toBeNull();
    }
  });

  it('attaches the reader\'s own symbols to a macro row and nobody else\'s', () => {
    const view = buildOverviewEvents({
      window: windowOf([macro('cpi', '2026-09-12T12:30:00.000Z')]),
      upcoming: null,
      portfolioSymbols: ['AAPL'],
      watchlistSymbols: ['msft', 'AAPL'],
      now: NOW,
    });
    expect(view.rows[0]!.symbols).toEqual(['AAPL', 'MSFT']);
  });

  it('names the symbol an upcoming row is about', () => {
    const view = buildOverviewEvents({ window: windowOf([]), upcoming: UPCOMING, now: NOW });
    expect(view.rows.find((row) => row.kind === 'earnings')!.symbols).toEqual(['NVDA']);
  });

  it('caps the rows and reports how many there were', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      macro(`m${index}`, `2026-09-${String(12 + index).padStart(2, '0')}T12:30:00.000Z`));
    const view = buildOverviewEvents({ window: windowOf(many), upcoming: null, now: NOW });
    expect(view.rows).toHaveLength(OVERVIEW_EVENTS_LIMIT);
    expect(view.total).toBe(10);
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
    expect(view.rows).toEqual([]);
    expect(view.coverageNoteTh).toContain('ปฏิทินถึง');
  });

  it('survives a calendar that could not be read at all', () => {
    const view = buildOverviewEvents({ window: null, upcoming: UPCOMING, now: NOW });
    expect(view.rows).toHaveLength(3);
    expect(view.coverageNoteTh).toBeNull();
  });

  it('is empty and quiet for a signed-out visitor with no calendar', () => {
    const view = buildOverviewEvents({ window: null, upcoming: null, now: NOW });
    expect(view).toEqual({ rows: [], total: 0, coverageNoteTh: null });
  });
});
