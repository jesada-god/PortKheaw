import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * THE CONVERSION, CHECKED AGAINST A TABLE SOMEBODY WORKED OUT BY HAND.
 *
 * ===========================================================================
 * WHY THE EXPECTATIONS ARE LITERALS AND NOT COMPUTED
 * ===========================================================================
 * A test that derives its expected value the way the code derives its actual
 * one passes whenever the two agree — including when they are both wrong. If
 * `bangkokDayKey` gained an off-by-one, a test that checked it against
 * `bangkokParts` would move with it and stay green.
 *
 * So every expectation below is a written-out constant. Bangkok is UTC+7 and
 * observes no daylight saving, so each row is `at + 7h`, done on paper:
 *
 *     2026-09-16T18:00Z  +7 = 2026-09-17 01:00   (next day)
 *     2026-09-11T12:30Z  +7 = 2026-09-11 19:30   (same day)
 *     2026-11-10T13:30Z  +7 = 2026-11-10 20:30   (same day)
 *     2026-12-09T19:00Z  +7 = 2026-12-10 02:00   (next day)
 *     2026-09-30T18:00Z  +7 = 2026-10-01 01:00   (next MONTH)
 *     2026-12-31T18:00Z  +7 = 2027-01-01 01:00   (next YEAR)
 *
 * The weekdays are anchored to facts established OUTSIDE this codebase rather
 * than to anything the grid computes: BLS publishes the Employment Situation on
 * a Friday (4 Sep, 2 Oct, 6 Nov, 4 Dec 2026), and DOL publishes the one
 * off-Thursday claims report of the quarter on Wednesday 25 November 2026.
 * Every other weekday here is counted forward from one of those.
 *
 * ===========================================================================
 * THE DST PAIR IS THE POINT OF THE 8:30 ROWS
 * ===========================================================================
 * A BLS release is 8:30 a.m. in NEW YORK all year. US daylight saving ends on
 * Sunday 1 November 2026, so the identical wall clock is a DIFFERENT instant
 * either side of it — 12:30Z in October, 13:30Z in November — and therefore a
 * different Bangkok clock time: 19:30 before, 20:30 after. A calendar that
 * stored "08:30 America/New_York" and re-derived the offset at render time
 * would have to get that right on every machine that drew it. This one stores
 * the instant, so there is no offset left to get wrong.
 */

const TIME_ZONES = ['UTC', 'Asia/Bangkok'] as const;

/**
 * The module, re-imported with the host clock set to `timeZone`.
 *
 * The re-import matters: `time.ts` builds its `Intl.DateTimeFormat` instances
 * at module scope, so importing once would only ever test the formatters built
 * under whichever zone happened to load first.
 */
async function loadUnder(timeZone: string) {
  process.env.TZ = timeZone;
  vi.resetModules();
  return import('./time');
}

const originalTimeZone = process.env.TZ;
afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
  vi.resetModules();
});

interface Row {
  name: string;
  at: string;
  bangkokDay: string;
  bangkokTime: string;
  /** Monday = 0. */
  weekdayIndex: number;
  /** The ET calendar day, for the "same event, other dateline" note. */
  newYorkDay: string;
  thaiDay: string;
}

const FIXTURES: Row[] = [
  {
    name: 'FOMC statement crosses into the next Thai day (EDT)',
    at: '2026-09-16T18:00:00.000Z',
    bangkokDay: '2026-09-17',
    bangkokTime: '01:00',
    weekdayIndex: 3, // Thursday
    newYorkDay: '2026-09-16',
    thaiDay: 'วันพฤหัสบดีที่ 17 กันยายน 2569',
  },
  {
    name: 'CPI before the DST change stays on the same Thai day',
    at: '2026-09-11T12:30:00.000Z',
    bangkokDay: '2026-09-11',
    bangkokTime: '19:30',
    weekdayIndex: 4, // Friday — BLS publishes CPI 11 Sep 2026
    newYorkDay: '2026-09-11',
    thaiDay: 'วันศุกร์ที่ 11 กันยายน 2569',
  },
  {
    name: 'CPI in October — 8:30 ET is still 19:30 Bangkok while EDT holds',
    at: '2026-10-14T12:30:00.000Z',
    bangkokDay: '2026-10-14',
    bangkokTime: '19:30',
    weekdayIndex: 2, // Wednesday
    newYorkDay: '2026-10-14',
    thaiDay: 'วันพุธที่ 14 ตุลาคม 2569',
  },
  {
    name: 'CPI in November — the same 8:30 ET is 20:30 Bangkok after DST ends',
    at: '2026-11-10T13:30:00.000Z',
    bangkokDay: '2026-11-10',
    bangkokTime: '20:30',
    weekdayIndex: 1, // Tuesday
    newYorkDay: '2026-11-10',
    thaiDay: 'วันอังคารที่ 10 พฤศจิกายน 2569',
  },
  {
    name: 'FOMC statement crosses into the next Thai day (EST)',
    at: '2026-12-09T19:00:00.000Z',
    bangkokDay: '2026-12-10',
    bangkokTime: '02:00',
    weekdayIndex: 3, // Thursday
    newYorkDay: '2026-12-09',
    thaiDay: 'วันพฤหัสบดีที่ 10 ธันวาคม 2569',
  },
  {
    name: 'an evening ET instant crosses into the next Thai MONTH',
    at: '2026-09-30T18:00:00.000Z',
    bangkokDay: '2026-10-01',
    bangkokTime: '01:00',
    weekdayIndex: 3, // Thursday — 2 Oct 2026 is a Friday, so the 1st is a Thursday
    newYorkDay: '2026-09-30',
    thaiDay: 'วันพฤหัสบดีที่ 1 ตุลาคม 2569',
  },
  {
    name: 'an evening ET instant crosses into the next Thai YEAR',
    at: '2026-12-31T18:00:00.000Z',
    bangkokDay: '2027-01-01',
    bangkokTime: '01:00',
    weekdayIndex: 4, // Friday
    newYorkDay: '2026-12-31',
    thaiDay: 'วันศุกร์ที่ 1 มกราคม 2570',
  },
  {
    name: 'the one off-Thursday jobless claims report DOL publishes this quarter',
    at: '2026-11-25T13:30:00.000Z',
    bangkokDay: '2026-11-25',
    bangkokTime: '20:30',
    weekdayIndex: 2, // Wednesday, per DOL
    newYorkDay: '2026-11-25',
    thaiDay: 'วันพุธที่ 25 พฤศจิกายน 2569',
  },
];

describe.each(TIME_ZONES)('Bangkok conversion under TZ=%s', (timeZone) => {
  it.each(FIXTURES)('$name', async (row) => {
    const time = await loadUnder(timeZone);

    expect(time.bangkokDayKey(row.at)).toBe(row.bangkokDay);
    expect(time.bangkokTimeLabel(row.at)).toBe(row.bangkokTime);
    expect(time.bangkokParts(row.at)?.weekdayIndex).toBe(row.weekdayIndex);
    expect(time.newYorkDayKey(row.at)).toBe(row.newYorkDay);
    expect(time.thaiDayLabel(row.bangkokDay)).toBe(row.thaiDay);
    // The weekday the grid places the cell in must agree with the clock's own.
    expect(time.weekdayIndexOf(row.bangkokDay)).toBe(row.weekdayIndex);
  });

  it('accepts a Date as readily as an ISO string', async () => {
    const time = await loadUnder(timeZone);
    expect(time.bangkokDayKey(new Date('2026-09-16T18:00:00.000Z'))).toBe('2026-09-17');
  });

  it('answers null for an unreadable instant instead of a plausible wrong day', async () => {
    const time = await loadUnder(timeZone);
    expect(time.bangkokDayKey('not-a-date')).toBeNull();
    expect(time.bangkokTimeLabel('not-a-date')).toBeNull();
    expect(time.bangkokParts('not-a-date')).toBeNull();
  });
});

/**
 * The two host zones must agree EXACTLY, case for case.
 *
 * The loop above runs the same table twice, which catches a zone-dependent
 * answer only if the fixture happens to pin the field that moved. This compares
 * the two runs against each other across every field at once, which is the
 * assertion that actually says "the host clock does not participate".
 */
it('produces byte-identical output under UTC and Asia/Bangkok', async () => {
  const render = async (timeZone: string) => {
    const time = await loadUnder(timeZone);
    return FIXTURES.map((row) => [
      time.bangkokDayKey(row.at),
      time.bangkokTimeLabel(row.at),
      time.bangkokParts(row.at)?.weekdayIndex,
      time.newYorkDayKey(row.at),
      time.thaiDayLabel(row.bangkokDay),
      time.thaiShortDayLabel(row.bangkokDay),
      time.thaiMonthLabel(row.bangkokDay.slice(0, 7)),
      time.weekdayIndexOf(row.bangkokDay),
    ].join('|'));
  };
  expect(await render('UTC')).toEqual(await render('Asia/Bangkok'));
});

describe('day-key arithmetic', () => {
  it('steps across a month and a year boundary', async () => {
    const time = await loadUnder('UTC');
    expect(time.addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(time.addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(time.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(time.addDays('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('reads Monday as column zero', async () => {
    const time = await loadUnder('UTC');
    // 2026-09-04 is a Friday (BLS Employment Situation), so the 7th is a Monday.
    expect(time.weekdayIndexOf('2026-09-07')).toBe(0);
    expect(time.weekdayIndexOf('2026-09-13')).toBe(6); // the Sunday before it
  });

  it('labels a month in the Buddhist era', async () => {
    const time = await loadUnder('UTC');
    expect(time.thaiMonthLabel('2026-09')).toBe('กันยายน 2569');
    expect(time.thaiMonthLabel('2027-01')).toBe('มกราคม 2570');
  });
});

describe('month-key arithmetic', () => {
  it('steps forward and back on the label, worked out by hand', async () => {
    const time = await loadUnder('UTC');
    expect(time.addMonths('2026-09', 1)).toBe('2026-10');
    expect(time.addMonths('2026-10', -1)).toBe('2026-09');
    expect(time.addMonths('2026-01', -1)).toBe('2025-12');
    expect(time.addMonths('2026-12', 1)).toBe('2027-01');
    expect(time.addMonths('2026-06', 7)).toBe('2027-01');
    expect(time.addMonths('2026-03', -14)).toBe('2025-01');
  });

  /*
   * The failure this rules out: stepping a month by adding days, which lands on
   * the 1st of the month AFTER the one intended whenever the source month is
   * longer than the target. `addMonths` steps from the 1st for exactly this
   * reason, and February is where a day-based version breaks first.
   */
  it('does not slide when a month is shorter than the one before it', async () => {
    const time = await loadUnder('UTC');
    expect(time.addMonths('2026-01', 1)).toBe('2026-02');
    expect(time.addMonths('2026-03', -1)).toBe('2026-02');
    expect(time.addMonths('2026-08', 1)).toBe('2026-09');
  });

  it('answers the same under a host clock in Bangkok as under one in UTC', async () => {
    for (const timeZone of TIME_ZONES) {
      const time = await loadUnder(timeZone);
      expect(time.addMonths('2026-12', 1), timeZone).toBe('2027-01');
      expect(time.addMonths('2026-01', -1), timeZone).toBe('2025-12');
    }
  });
});
