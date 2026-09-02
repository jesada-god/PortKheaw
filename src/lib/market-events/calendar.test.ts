import { describe, expect, it } from 'vitest';
import {
  coverageOf,
  coverageOfMonth,
  eventsOnDay,
  groupByBangkokDay,
  MARKET_EVENTS,
  monthRangeOf,
} from './calendar';
import { buildMonthGrid, WEEKDAY_HEADINGS_TH } from './month-grid';
import { buildEventFeed, exposureNoteTh } from './feed';
import type { MarketEvent } from './types';

const TIME_ZONES = ['UTC', 'Asia/Bangkok'] as const;

/** Run a block under a fixed host clock, then put the host clock back. */
function underTimeZone<T>(timeZone: string, run: () => T): T {
  const original = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

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

describe('the shipped calendar file', () => {
  it('loads, and every row is a UTC instant rather than a local time with a zone beside it', () => {
    expect(MARKET_EVENTS.length).toBeGreaterThan(0);
    for (const row of MARKET_EVENTS) {
      expect(row.at.endsWith('Z'), `${row.id} must be a UTC instant`).toBe(true);
    }
  });

  it('is sorted, and every id is unique', () => {
    const ats = MARKET_EVENTS.map((row) => row.at);
    expect([...ats].sort()).toEqual(ats);
    expect(new Set(MARKET_EVENTS.map((row) => row.id)).size).toBe(MARKET_EVENTS.length);
  });

  /*
   * The gap this feature knows it has, asserted so it cannot be closed by
   * accident. The Federal Reserve publishes no forward schedule of speeches,
   * so a "Fed Speech" row could only ever have been invented — and an invented
   * date on a calendar is worse than a missing one, because a reader cannot
   * tell it apart from a real one.
   */
  it('contains no Fed speech rows, because no published schedule exists to take them from', () => {
    for (const row of MARKET_EVENTS) {
      expect(row.kind).not.toBe('FED_SPEECH');
      expect(row.titleTh).not.toContain('สุนทรพจน์');
    }
  });

  it('carries only macro releases — earnings belong to the Upcoming feed', () => {
    const kinds = new Set(MARKET_EVENTS.map((row) => row.kind));
    expect(kinds.has('CPI' as const)).toBe(true);
    for (const kind of kinds) {
      expect(['CPI', 'PPI', 'PCE', 'NFP', 'GDP', 'FOMC', 'JOBLESS_CLAIMS']).toContain(kind);
    }
  });
});

describe.each(TIME_ZONES)('coverage under TZ=%s', (timeZone) => {
  const events = [
    event({ id: 'first', at: '2026-09-11T12:30:00.000Z' }),
    event({ id: 'last', at: '2026-12-10T13:30:00.000Z' }),
  ];

  it('reports the period as covered while the reader is inside it', () => {
    underTimeZone(timeZone, () => {
      expect(coverageOf('2026-10-14T09:00:00.000Z', events).state).toBe('covered');
    });
  });

  /*
   * REQUIREMENT: A CALENDAR THAT HAS RUN OUT SAYS SO.
   *
   * The failure being prevented is a silently empty month. Past the last row
   * the grid would draw January perfectly — 31 numbered, eventless cells — and
   * a reader would conclude that nothing is scheduled, which is the opposite of
   * what is true. `exhausted` is what lets the card say the period is not
   * covered instead.
   */
  it('reports the calendar exhausted once the Thai day passes the last row', () => {
    underTimeZone(timeZone, () => {
      const coverage = coverageOf('2026-12-11T01:00:00.000Z', events);
      expect(coverage.state).toBe('exhausted');
      expect(coverage.lastDayKey).toBe('2026-12-10');
    });
  });

  it('does not call the calendar exhausted on the last day itself', () => {
    underTimeZone(timeZone, () => {
      // 2026-12-10T23:00Z is already the 11th in Bangkok; 13:00Z is still the 10th.
      expect(coverageOf('2026-12-10T13:00:00.000Z', events).state).toBe('covered');
      expect(coverageOf('2026-12-10T23:00:00.000Z', events).state).toBe('exhausted');
    });
  });

  it('reports a reader who is earlier than the file as before it, not as a quiet month', () => {
    underTimeZone(timeZone, () => {
      expect(coverageOf('2026-07-01T00:00:00.000Z', events).state).toBe('before');
    });
  });

  it('reports an empty file as empty rather than as a covered, silent period', () => {
    underTimeZone(timeZone, () => {
      expect(coverageOf('2026-10-14T09:00:00.000Z', []).state).toBe('empty');
    });
  });
});

describe.each(TIME_ZONES)('grouping under TZ=%s', (timeZone) => {
  it('files an instant on the Thai day it lands on, not the American one', () => {
    underTimeZone(timeZone, () => {
      // The December FOMC statement: 9 Dec in New York, 10 Dec in Bangkok.
      const fomc = MARKET_EVENTS.find((row) => row.id === 'fomc-2026-12-09');
      expect(fomc).toBeDefined();
      expect(eventsOnDay('2026-12-10').map((row) => row.id)).toContain('fomc-2026-12-09');
      expect(eventsOnDay('2026-12-09').map((row) => row.id)).not.toContain('fomc-2026-12-09');
    });
  });

  it('orders a day most-important-first, breaking ties on the earlier instant', () => {
    underTimeZone(timeZone, () => {
      const day = eventsOnDay('2026-12-10');
      // CPI and the FOMC statement are both `high`; the statement fires first.
      expect(day.map((row) => row.kind)).toEqual(['FOMC', 'CPI', 'JOBLESS_CLAIMS']);
    });
  });

  it('groups every day in ascending order', () => {
    underTimeZone(timeZone, () => {
      const days = groupByBangkokDay().map((group) => group.dayKey);
      expect([...days].sort()).toEqual(days);
    });
  });
});

describe.each(TIME_ZONES)('the month grid under TZ=%s', (timeZone) => {
  it('is seven columns wide, Monday first', () => {
    underTimeZone(timeZone, () => {
      expect(WEEKDAY_HEADINGS_TH).toHaveLength(7);
      expect(WEEKDAY_HEADINGS_TH[0]).toBe('จ.');
      expect(WEEKDAY_HEADINGS_TH[6]).toBe('อา.');
      const grid = buildMonthGrid({ monthKey: '2026-12', todayKey: '2026-12-10' });
      for (const week of grid.weeks) expect(week).toHaveLength(7);
    });
  });

  it('starts each week on a Monday', () => {
    underTimeZone(timeZone, () => {
      const grid = buildMonthGrid({ monthKey: '2026-11', todayKey: null });
      // 2026-11-25 is a Wednesday (DOL), so the Monday of that week is the 23rd.
      const week = grid.weeks.find((row) => row.some((cell) => cell.dayKey === '2026-11-25'));
      expect(week?.[0].dayKey).toBe('2026-11-23');
      expect(week?.[2].dayKey).toBe('2026-11-25');
    });
  });

  it('names the most important event and counts the rest as +N', () => {
    underTimeZone(timeZone, () => {
      const grid = buildMonthGrid({ monthKey: '2026-11', todayKey: null });
      const cell = grid.weeks.flat().find((item) => item.dayKey === '2026-11-25');
      // GDP (medium), PCE (high) and the moved jobless claims (low) share the day.
      expect(cell?.total).toBe(3);
      expect(cell?.lead?.kind).toBe('PCE');
      expect(cell?.extraCount).toBe(2);
    });
  });

  it('leaves a quiet day empty rather than drawing a placeholder', () => {
    underTimeZone(timeZone, () => {
      const grid = buildMonthGrid({ monthKey: '2026-12', todayKey: null });
      const cell = grid.weeks.flat().find((item) => item.dayKey === '2026-12-01');
      expect(cell?.total).toBe(0);
      expect(cell?.lead).toBeNull();
      expect(cell?.extraCount).toBe(0);
    });
  });

  it('marks today, and only today', () => {
    underTimeZone(timeZone, () => {
      const grid = buildMonthGrid({ monthKey: '2026-12', todayKey: '2026-12-10' });
      const marked = grid.weeks.flat().filter((cell) => cell.isToday);
      expect(marked).toHaveLength(1);
      expect(marked[0].dayKey).toBe('2026-12-10');
    });
  });

  it('holds no events in the padding days that only square the grid', () => {
    underTimeZone(timeZone, () => {
      const grid = buildMonthGrid({ monthKey: '2026-10', todayKey: null });
      for (const cell of grid.weeks.flat()) {
        if (!cell.inMonth) {
          expect(cell.total).toBe(0);
          expect(cell.lead).toBeNull();
        }
      }
    });
  });

  it('draws every day of the month exactly once', () => {
    underTimeZone(timeZone, () => {
      for (const monthKey of ['2026-09', '2026-10', '2026-11', '2026-12']) {
        const grid = buildMonthGrid({ monthKey, todayKey: null });
        const inMonth = grid.weeks.flat().filter((cell) => cell.inMonth).map((cell) => cell.dayKey);
        expect(new Set(inMonth).size).toBe(inMonth.length);
        expect(inMonth[0]).toBe(`${monthKey}-01`);
      }
    });
  });
});

describe.each(TIME_ZONES)('the detail feed under TZ=%s', (timeZone) => {
  const events = [
    event({ id: 'today-a', at: '2026-12-10T13:30:00.000Z' }),
    event({ id: 'today-b', at: '2026-12-09T19:00:00.000Z', kind: 'FOMC', importance: 'high', titleTh: 'ผลการประชุม Fed (FOMC)' }),
    event({ id: 'tomorrow', at: '2026-12-11T13:30:00.000Z', importance: 'low' }),
    event({ id: 'later', at: '2026-12-15T13:30:00.000Z', importance: 'medium' }),
  ];

  it('heads the first two days in words and the rest with a Buddhist-era date', () => {
    underTimeZone(timeZone, () => {
      const feed = buildEventFeed({ now: '2026-12-10T04:00:00.000Z', events });
      expect(feed.map((day) => day.headingTh)).toEqual([
        'วันนี้',
        'พรุ่งนี้',
        'วันอังคารที่ 15 ธันวาคม 2569',
      ]);
    });
  });

  it('counts the rows on each day', () => {
    underTimeZone(timeZone, () => {
      const feed = buildEventFeed({ now: '2026-12-10T04:00:00.000Z', events });
      expect(feed[0].count).toBe(2);
      expect(feed[1].count).toBe(1);
    });
  });

  it('prints Thai clock times', () => {
    underTimeZone(timeZone, () => {
      const feed = buildEventFeed({ now: '2026-12-10T04:00:00.000Z', events });
      expect(feed[0].items.map((item) => item.timeLabel)).toEqual(['02:00', '20:30']);
    });
  });

  /*
   * The ET note appears only where the two datelines actually disagree. It is
   * how a reader ties this row to an American headline filed the day before.
   */
  it('notes the American date only on rows whose ET day differs', () => {
    underTimeZone(timeZone, () => {
      const feed = buildEventFeed({ now: '2026-12-10T04:00:00.000Z', events });
      const [fomc, cpi] = feed[0].items;
      expect(fomc.etNoteTh).toBe('ตามเวลาสหรัฐคือ 9 ธ.ค. 2569');
      expect(cpi.etNoteTh).toBeNull();
    });
  });

  it('drops days that have already passed', () => {
    underTimeZone(timeZone, () => {
      const feed = buildEventFeed({ now: '2026-12-11T04:00:00.000Z', events });
      expect(feed.map((day) => day.dayKey)).toEqual(['2026-12-11', '2026-12-15']);
    });
  });

  /*
   * A macro release lands on the whole market, so the only quantity this
   * product can honestly state is how many symbols the reader holds. Nothing
   * here may imply that one release moves one kind of holding more than another
   * — that is a correlation nobody computed.
   */
  it('states exposure as a count and never as a relationship', () => {
    expect(exposureNoteTh(7)).toBe('กระทบทั้งตลาด — คุณถือหุ้นอยู่ 7 ตัว');
    expect(exposureNoteTh(0)).toBe('ยังไม่มีหุ้นในพอร์ต');
    for (const count of [0, 1, 7]) {
      expect(exposureNoteTh(count)).not.toMatch(/มัก|มักจะ|แนวโน้มว่า|น่าจะ|เทค|กลุ่มเทคโนโลยี/);
    }
  });
});

/**
 * THE SECOND COVERAGE QUESTION — asked about the month on screen.
 *
 * `coverageOf(now)` above answers about the READER: has their own day run past
 * the end of the file. That was the only question a card fixed to the current
 * month could have. The calendar page can be walked forwards, so it needs the
 * other axis, and the two must not be confused: a reader sitting inside the
 * window is `covered` by the first and can still be looking at a month the file
 * has never heard of.
 */
describe('the months the file speaks for', () => {
  const RANGE: MarketEvent[] = [
    event({ id: 'oct', at: '2026-10-15T12:30:00.000Z' }),
    event({ id: 'nov', at: '2026-11-10T13:30:00.000Z' }),
    event({ id: 'dec', at: '2026-12-09T19:00:00.000Z' }),
  ];

  it('reads the first and last month off the events, not off a constant', () => {
    expect(monthRangeOf(RANGE)).toEqual({ firstMonthKey: '2026-10', lastMonthKey: '2026-12' });
  });

  /*
   * 30 September 18:00Z is 1 October in Bangkok. A range computed in UTC would
   * call September the first month and be wrong about the whole page.
   */
  it('takes the month a row falls in IN BANGKOK', () => {
    for (const timeZone of TIME_ZONES) {
      expect(underTimeZone(timeZone, () =>
        monthRangeOf([event({ id: 'edge', at: '2026-09-30T18:00:00.000Z' })])), timeZone)
        .toEqual({ firstMonthKey: '2026-10', lastMonthKey: '2026-10' });
    }
  });

  it('has no range at all when there are no events', () => {
    expect(monthRangeOf([])).toBeNull();
  });

  it('covers every month between the first and the last, inclusive', () => {
    for (const monthKey of ['2026-10', '2026-11', '2026-12']) {
      expect(coverageOfMonth(monthKey, RANGE).state, monthKey).toBe('covered');
    }
  });

  it('says a month before the calendar begins is before it', () => {
    expect(coverageOfMonth('2026-09', RANGE)).toEqual({
      state: 'before', firstMonthKey: '2026-10', lastMonthKey: '2026-12',
    });
  });

  it('says a month past the last row is past it', () => {
    expect(coverageOfMonth('2027-03', RANGE)).toEqual({
      state: 'exhausted', firstMonthKey: '2026-10', lastMonthKey: '2026-12',
    });
  });

  it('says an empty file is empty rather than uncovered', () => {
    expect(coverageOfMonth('2026-11', [])).toEqual({
      state: 'empty', firstMonthKey: null, lastMonthKey: null,
    });
  });

  /*
   * The two functions on the same data, disagreeing correctly. The reader's day
   * is inside the window; the month in front of them is three months past the
   * last row. Both answers are right, about different questions.
   */
  it('disagrees with coverageOf when the reader is inside the window and the month is not', () => {
    expect(coverageOf('2026-11-10T04:00:00.000Z', RANGE).state).toBe('covered');
    expect(coverageOfMonth('2027-03', RANGE).state).toBe('exhausted');
  });
});
