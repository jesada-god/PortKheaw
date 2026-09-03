import { describe, expect, it } from 'vitest';
import { monthRangeOf, MARKET_EVENTS } from './calendar';
import { buildMarketEventsMonthView, resolveMonthKey, MARK_LEGEND_TH } from './month-view';
import type { MarketEvent } from './types';

/**
 * THE PAGE'S VIEW MODEL, PROVED AGAINST WRITTEN-OUT ANSWERS.
 *
 * The discipline is `time.test.ts`'s and it is the same trap: a test that
 * derives its expectation the way the code derives its actual passes whenever
 * the two agree, INCLUDING when they are both wrong. So the month keys, the
 * boundary answers and the Thai labels below are constants somebody worked out,
 * not values read back out of the module under test.
 *
 * The fixture is deliberately NOT the shipped file. `market-events.json` gains
 * rows — that is the whole point of the design — and a test that pinned
 * "September is the first month" would fail the day somebody added an August
 * date, which is the correct edit. The one place the shipped file is asserted
 * about is the boundary test at the bottom, and it asserts a RELATIONSHIP
 * rather than a date.
 */

const TIME_ZONES = ['UTC', 'Asia/Bangkok'] as const;

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

/*
 * A three-month fixture — October to December 2026 — worked out on paper.
 *
 *   2026-10-15T12:30Z  +7 = 2026-10-15 19:30   (Thursday 15 October)
 *   2026-11-10T13:30Z  +7 = 2026-11-10 20:30   (Tuesday 10 November)
 *   2026-11-25T13:30Z  +7 = 2026-11-25 20:30   (Wednesday 25 November)
 *   2026-12-09T19:00Z  +7 = 2026-12-10 02:00   (Thursday 10 December — NEXT DAY)
 *   2026-12-10T13:30Z  +7 = 2026-12-10 20:30   (also Thursday 10 December)
 *
 * The last pair is the point of a Bangkok calendar: an FOMC statement issued in
 * New York on Wednesday the 9th shares a Thai cell with Thursday's CPI.
 */
const EVENTS: MarketEvent[] = [
  event({ id: 'ppi-oct', at: '2026-10-15T12:30:00.000Z', kind: 'PPI', shortTh: 'PPI', importance: 'medium' }),
  event({ id: 'cpi-nov', at: '2026-11-10T13:30:00.000Z' }),
  event({
    id: 'claims-nov',
    at: '2026-11-25T13:30:00.000Z',
    kind: 'JOBLESS_CLAIMS',
    shortTh: 'ว่างงาน',
    titleTh: 'ยอดขอรับสวัสดิการว่างงาน',
    importance: 'low',
    source: 'DOL',
  }),
  event({
    id: 'fomc-dec',
    at: '2026-12-09T19:00:00.000Z',
    kind: 'FOMC',
    shortTh: 'FOMC',
    titleTh: 'ผลการประชุม Fed (FOMC)',
    source: 'FED',
    etDisplay: '2:00 p.m. ET',
  }),
  event({
    id: 'cpi-dec',
    at: '2026-12-10T13:30:00.000Z',
    importance: 'medium',
  }),
];

function view(over: Parameters<typeof buildMarketEventsMonthView>[0]) {
  const built = buildMarketEventsMonthView({ events: EVENTS, ...over });
  if (!built) throw new Error('the view should build for a valid instant');
  return built;
}

const cellOf = (built: ReturnType<typeof view>, dayKey: string) =>
  built.weeks.flat().find((cell) => cell.dayKey === dayKey && cell.inMonth);



describe('the month the page draws', () => {
  it('draws the reader’s own month when nothing was asked for', () => {
    expect(view({ now: '2026-11-10T04:00:00.000Z' }).monthKey).toBe('2026-11');
    expect(view({ now: '2026-11-10T04:00:00.000Z' }).monthLabelTh).toBe('พฤศจิกายน 2569');
  });

  it('draws the month that was asked for', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2026-10' });
    expect(built.monthKey).toBe('2026-10');
    expect(built.monthLabelTh).toBe('ตุลาคม 2569');
  });

  /*
   * The Bangkok dateline again, on the parameter that decides the whole page: a
   * reader opening this at 04:00 UTC on 31 October is already in November.
   */
  it('resolves “this month” in Bangkok', () => {
    expect(view({ now: '2026-10-31T18:00:00.000Z' }).monthKey).toBe('2026-11');
  });

  it('falls back to the current month for a value that is not a month', () => {
    for (const raw of ['banana', '2026-13', '2026-00', '2026', '2026-1', '2026-01-01', '']) {
      expect(resolveMonthKey(raw, '2026-11-10'), raw).toBe('2026-11');
    }
    expect(resolveMonthKey(null, '2026-11-10')).toBe('2026-11');
    expect(resolveMonthKey(undefined, '2026-11-10')).toBe('2026-11');
  });

  it('keeps a well-formed month that the calendar does not reach, rather than correcting it', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2027-03' });
    expect(built.monthKey).toBe('2027-03');
    expect(built.monthLabelTh).toBe('มีนาคม 2570');
  });

  it('counts what is in the month it drew', () => {
    expect(view({ now: '2026-11-10T04:00:00.000Z' }).totalInMonth).toBe(2);
    expect(view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2026-12' }).totalInMonth).toBe(2);
    expect(view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2027-03' }).totalInMonth).toBe(0);
  });

  it('lays out seven Monday-first columns', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z' });
    expect(built.weekdayHeadingsTh).toEqual(['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.']);
    for (const week of built.weeks) expect(week).toHaveLength(7);
  });
});

describe('the month buttons', () => {
  it('offers a step in each direction from the middle of the calendar', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z' });
    expect(built.prevMonthKey).toBe('2026-10');
    expect(built.nextMonthKey).toBe('2026-12');
  });

  it('is dead going back at the first month the file has', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2026-10' });
    expect(built.prevMonthKey).toBeNull();
    expect(built.nextMonthKey).toBe('2026-11');
  });

  it('is dead going forward at the last month the file has', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2026-12' });
    expect(built.prevMonthKey).toBe('2026-11');
    expect(built.nextMonthKey).toBeNull();
  });

  /*
   * A reader who typed their way outside the file keeps the arrow that walks
   * back toward it. Hiding both would strand them on an empty month with no way
   * out but the address bar.
   */
  it('still walks back toward the calendar from a month past the end of it', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2027-03' });
    expect(built.prevMonthKey).toBe('2027-02');
    expect(built.nextMonthKey).toBeNull();
  });

  it('still walks forward toward the calendar from a month before the start of it', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2026-06' });
    expect(built.prevMonthKey).toBeNull();
    expect(built.nextMonthKey).toBe('2026-07');
  });

  it('offers no step at all when the file is empty', () => {
    const built = buildMarketEventsMonthView({ now: '2026-11-10T04:00:00.000Z', events: [] });
    expect(built?.prevMonthKey).toBeNull();
    expect(built?.nextMonthKey).toBeNull();
  });

  /*
   * ASSERTED AS A RELATIONSHIP, NOT AS A DATE. The shipped file is meant to
   * grow by being edited, so pinning "December" here would make the correct
   * edit fail the build. What must hold is that the buttons stop where the DATA
   * stops, whatever the data currently is.
   */
  it('stops where the shipped file stops, whatever the shipped file currently says', () => {
    const range = monthRangeOf(MARKET_EVENTS);
    expect(range).not.toBeNull();
    const last = buildMarketEventsMonthView({
      now: '2026-11-10T04:00:00.000Z', monthParam: range!.lastMonthKey,
    });
    const first = buildMarketEventsMonthView({
      now: '2026-11-10T04:00:00.000Z', monthParam: range!.firstMonthKey,
    });
    expect(last?.nextMonthKey).toBeNull();
    expect(first?.prevMonthKey).toBeNull();
  });
});

describe('the cells', () => {
  it('marks one mark per event on the day, most important first', () => {
    const built = view({ now: '2026-12-10T04:00:00.000Z' });
    expect(cellOf(built, '2026-12-10')?.marks).toEqual(['high', 'medium']);
    expect(cellOf(built, '2026-12-09')?.marks).toEqual([]);
  });

  it('files a New York Wednesday evening under the Thai Thursday', () => {
    const built = view({ now: '2026-12-10T04:00:00.000Z' });
    expect(cellOf(built, '2026-12-10')?.total).toBe(2);
    expect(cellOf(built, '2026-12-09')?.total).toBe(0);
  });

  it('names the most watched event and counts the rest', () => {
    const built = view({ now: '2026-12-10T04:00:00.000Z' });
    expect(cellOf(built, '2026-12-10')?.leadShortTh).toBe('FOMC');
    expect(cellOf(built, '2026-12-10')?.extraCount).toBe(1);
  });

  /*
   * The dots are colour, and colour is never allowed to be the only channel.
   * The label carries the date, the count and every importance in words.
   */
  it('says the date, the count and every importance in words for a reader who cannot see the dots', () => {
    const built = view({ now: '2026-12-10T04:00:00.000Z' });
    expect(cellOf(built, '2026-12-10')?.ariaLabelTh)
      .toBe('10 ธ.ค. 2569 2 รายการ: สำคัญมาก, สำคัญปานกลาง');
    expect(cellOf(built, '2026-12-09')?.ariaLabelTh).toBe('9 ธ.ค. 2569 ไม่มีรายการ');
  });

  it('offers a legend naming every mark it draws', () => {
    expect(MARK_LEGEND_TH.map((entry) => entry.importance)).toEqual(['high', 'medium', 'low']);
    expect(MARK_LEGEND_TH.map((entry) => entry.labelTh))
      .toEqual(['สำคัญมาก', 'สำคัญปานกลาง', 'ติดตามได้']);
  });

  it('marks exactly one day as today, and only in the month today is in', () => {
    const here = view({ now: '2026-11-10T04:00:00.000Z' });
    expect(here.weeks.flat().filter((cell) => cell.isToday).map((cell) => cell.dayKey))
      .toEqual(['2026-11-10']);
    const elsewhere = view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2026-12' });
    expect(elsewhere.weeks.flat().filter((cell) => cell.isToday)).toHaveLength(0);
  });

  it('marks exactly one day as selected', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', dayParam: '2026-11-25' });
    expect(built.weeks.flat().filter((cell) => cell.isSelected).map((cell) => cell.dayKey))
      .toEqual(['2026-11-25']);
  });
});

describe('the day the panel opens on', () => {
  it('opens on the day that was asked for', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', dayParam: '2026-11-25' });
    expect(built.selected?.dayKey).toBe('2026-11-25');
    expect(built.selected?.items.map((item) => item.id)).toEqual(['claims-nov']);
  });

  /*
   * A quiet day is an ANSWER. Redirecting to the nearest day with something on
   * it would leave a reader who tapped the 14th believing they mis-tapped.
   */
  it('opens on a quiet day that was asked for, and says it is quiet', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', dayParam: '2026-11-14' });
    expect(built.selected?.dayKey).toBe('2026-11-14');
    expect(built.selected?.count).toBe(0);
    expect(built.selected?.items).toEqual([]);
  });

  it('opens on today when today is in the month on screen', () => {
    expect(view({ now: '2026-11-10T04:00:00.000Z' }).selected?.dayKey).toBe('2026-11-10');
  });

  it('opens on the first day that has something when today is elsewhere', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2026-12' });
    expect(built.selected?.dayKey).toBe('2026-12-10');
  });

  it('opens on nothing at all in a month the calendar does not reach', () => {
    expect(view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2027-03' }).selected).toBeNull();
  });

  /*
   * The case a failing test found. On a month past the end of the file, "วันนี้
   * · ไม่มีรายการ" is a claim that today is QUIET, while the note two lines
   * above says the calendar cannot speak for this month at all. Two answers on
   * one screen, and the reader picks. So the panel stays shut.
   */
  it('opens on nothing even for today, once the month is past the end of the calendar', () => {
    const built = view({ now: '2027-03-04T04:00:00.000Z' });
    expect(built.monthKey).toBe('2027-03');
    expect(built.coverage).toBe('exhausted');
    expect(built.selected).toBeNull();
  });

  it('opens on nothing even for a day that was explicitly asked for, outside the calendar', () => {
    expect(view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2027-03', dayParam: '2027-03-04' }).selected)
      .toBeNull();
  });

  it('ignores a day that belongs to another month', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', dayParam: '2026-12-10' });
    expect(built.selected?.dayKey).toBe('2026-11-10');
  });

  /*
   * `2026-02-30` matches the shape and is not a date. A regex alone would let
   * the panel head a section with a day nobody has lived through.
   */
  it('ignores a well-formed day that does not exist', () => {
    const built = view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2026-11', dayParam: '2026-11-31' });
    expect(built.selected?.dayKey).toBe('2026-11-10');
  });

  it('ignores a day that is not a day', () => {
    for (const raw of ['banana', '2026-11', '', '2026-11-1']) {
      expect(view({ now: '2026-11-10T04:00:00.000Z', dayParam: raw }).selected?.dayKey, raw)
        .toBe('2026-11-10');
    }
  });
});

describe('what the panel says about a day', () => {
  it('heads today and tomorrow in words, and keeps the checkable date beside them', () => {
    const today = view({ now: '2026-11-10T04:00:00.000Z' }).selected;
    expect(today?.relative).toBe('today');
    expect(today?.headingTh).toBe('วันนี้');
    expect(today?.dateLabelTh).toBe('วันอังคารที่ 10 พฤศจิกายน 2569');

    const tomorrow = view({ now: '2026-11-10T04:00:00.000Z', dayParam: '2026-11-11' }).selected;
    expect(tomorrow?.relative).toBe('tomorrow');
    expect(tomorrow?.headingTh).toBe('พรุ่งนี้');
  });

  it('heads any other day with its Buddhist-era date', () => {
    const later = view({ now: '2026-11-10T04:00:00.000Z', dayParam: '2026-11-25' }).selected;
    expect(later?.relative).toBe('other');
    expect(later?.headingTh).toBe('วันพุธที่ 25 พฤศจิกายน 2569');
  });

  /*
   * The panel row and the feed row are the SAME builder. This is the assertion
   * that keeps the ET note — the rule this feature is least able to notice
   * getting wrong — from drifting into a second version.
   */
  it('builds its rows the way the feed builds its rows, ET note included', () => {
    const built = view({ now: '2026-12-10T04:00:00.000Z' });
    const [fomc, cpi] = built.selected!.items;
    expect(fomc.id).toBe('fomc-dec');
    expect(fomc.timeLabel).toBe('02:00');
    expect(fomc.etNoteTh).toBe('ตามเวลาสหรัฐคือ 9 ธ.ค. 2569');
    expect(fomc.importanceLabelTh).toBe('สำคัญมาก');
    expect(cpi.timeLabel).toBe('20:30');
    expect(cpi.etNoteTh).toBeNull();
  });

  it('counts the rows on the day it opened', () => {
    expect(view({ now: '2026-12-10T04:00:00.000Z' }).selected?.count).toBe(2);
  });
});

describe('the whole view', () => {
  it('answers identically under a host clock in Bangkok and one in UTC', () => {
    const [utc, bangkok] = TIME_ZONES.map((timeZone) => underTimeZone(timeZone, () =>
      view({ now: '2026-12-09T20:00:00.000Z', dayParam: '2026-12-10' })));
    expect(utc).toEqual(bangkok);
  });

  it('carries no coverage note while the file covers the month', () => {
    expect(view({ now: '2026-11-10T04:00:00.000Z' }).coverageNoteTh).toBeNull();
  });

  it('names the month the calendar starts at when the reader is before it', () => {
    expect(view({ now: '2026-11-10T04:00:00.000Z', monthParam: '2026-06' }).coverageNoteTh)
      .toBe('ปฏิทินนี้เริ่มบันทึกตั้งแต่เดือน ตุลาคม 2569');
  });

  it('says an empty calendar is empty', () => {
    const built = buildMarketEventsMonthView({ now: '2026-11-10T04:00:00.000Z', events: [] });
    expect(built?.coverage).toBe('empty');
    expect(built?.coverageNoteTh).toBe('ยังไม่มีข้อมูลปฏิทินเศรษฐกิจในระบบ');
    expect(built?.selected).toBeNull();
  });

  it('returns nothing at all for an instant it cannot read, rather than guessing one', () => {
    expect(buildMarketEventsMonthView({ now: 'not-an-instant', events: EVENTS })).toBeNull();
  });
});
