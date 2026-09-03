import { describe, expect, it } from 'vitest';
import { MARKET_EVENTS } from './calendar';
import { releaseTimingOf } from './release-timing';
import { bangkokDayKey, newYorkDayKey } from './time';
import { usEarlyCloseDates } from '@/src/lib/market-data/us-market-calendar';

/**
 * WHERE A RELEASE SITS IN THE TRADING DAY, worked out on paper.
 *
 * Every expectation is a written-out constant. New York is UTC−4 while daylight
 * saving holds and UTC−5 after it ends on Sunday 1 November 2026, so each row
 * below is `at + 4h` or `at + 5h` done by hand:
 *
 *   2026-09-11T12:30Z  −4 = 08:30   before the 09:30 bell
 *   2026-11-10T13:30Z  −5 = 08:30   the same wall clock, the other side of DST
 *   2026-09-16T18:00Z  −4 = 14:00   four and a half hours into the session
 *   2026-12-09T19:00Z  −5 = 14:00   the same, after DST ends
 *   2026-11-27T17:30Z  −5 = 12:30   a HALF DAY that closes at 13:00
 *   2026-11-27T18:30Z  −5 = 13:30   the same half day, after the close
 */
const TIME_ZONES = ['UTC', 'Asia/Bangkok', 'America/New_York'] as const;

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

describe('releaseTimingOf', () => {
  it('files an 8:30 a.m. print before the open, on both sides of the DST change', () => {
    expect(releaseTimingOf('2026-09-11T12:30:00.000Z')).toBe('beforeOpen');
    expect(releaseTimingOf('2026-11-10T13:30:00.000Z')).toBe('beforeOpen');
  });

  it('files a 2:00 p.m. statement inside the session, on both sides of it', () => {
    expect(releaseTimingOf('2026-09-16T18:00:00.000Z')).toBe('intraday');
    expect(releaseTimingOf('2026-12-09T19:00:00.000Z')).toBe('intraday');
  });

  it('files anything past the closing bell after it', () => {
    // 2026-12-09T21:30Z −5 = 16:30, half an hour after a regular close.
    expect(releaseTimingOf('2026-12-09T21:30:00.000Z')).toBe('afterClose');
  });

  /*
   * THE CASE A HARD-CODED 16:00 GETS WRONG. The Friday after Thanksgiving
   * closes at 1:00 p.m. ET, so 1:30 p.m. that day is after the close, and a
   * close-to-close comparison against that session would be measuring a window
   * that had already ended before the release.
   */
  it('respects a published half-day close rather than assuming 16:00', () => {
    expect(usEarlyCloseDates(2026).has('2026-11-27')).toBe(true);
    expect(releaseTimingOf('2026-11-27T17:30:00.000Z')).toBe('intraday'); // 12:30 ET
    expect(releaseTimingOf('2026-11-27T18:30:00.000Z')).toBe('afterClose'); // 13:30 ET
  });

  it('answers null for an instant it cannot read, rather than defaulting', () => {
    expect(releaseTimingOf('not-an-instant')).toBeNull();
  });

  it('answers identically whatever the host clock is set to', () => {
    for (const at of [
      '2026-09-11T12:30:00.000Z',
      '2026-12-09T19:00:00.000Z',
      '2026-11-27T18:30:00.000Z',
    ]) {
      const answers = TIME_ZONES.map((zone) => underTimeZone(zone, () => releaseTimingOf(at)));
      expect(new Set(answers).size, at).toBe(1);
    }
  });
});

describe('the shipped calendar, classified', () => {
  it('classifies every row — none is left without a measurement it belongs to', () => {
    for (const event of MARKET_EVENTS) {
      expect(releaseTimingOf(event.at), event.id).not.toBeNull();
    }
  });

  /*
   * Asserted as a RELATIONSHIP rather than as a list of ids. The point is not
   * that these three rows are intraday, it is that the FOMC statement is the
   * release whose measurement differs — and a 10:00 a.m. release added later
   * should become intraday too without this test needing an edit.
   */
  it('puts every FOMC statement inside the session and every 8:30 print before it', () => {
    const fomc = MARKET_EVENTS.filter((event) => event.kind === 'FOMC');
    expect(fomc.length).toBeGreaterThan(0);
    for (const event of fomc) {
      expect(releaseTimingOf(event.at), event.id).toBe('intraday');
    }
    for (const event of MARKET_EVENTS.filter((event) => event.kind !== 'FOMC')) {
      expect(releaseTimingOf(event.at), event.id).toBe('beforeOpen');
    }
  });

  /*
   * ===========================================================================
   * WHY THE JOIN CANNOT USE THE BANGKOK KEY — shown, not asserted in prose.
   * ===========================================================================
   * The two keys agree for every 8:30 print and disagree for every FOMC
   * statement, because 2:00 p.m. in New York is the small hours of the next day
   * in Bangkok. A reaction joined on the Bangkok key would therefore match each
   * statement to the session AFTER the one it landed in — a plausible number
   * about the wrong day, on exactly the rows a reader is most likely to check.
   */
  it('disagrees with the Bangkok key on exactly the rows whose timing differs', () => {
    const disagreeing = MARKET_EVENTS
      .filter((event) => newYorkDayKey(event.at) !== bangkokDayKey(event.at))
      .map((event) => event.kind);
    expect(disagreeing.length).toBeGreaterThan(0);
    expect(new Set(disagreeing)).toEqual(new Set(['FOMC']));
    for (const event of MARKET_EVENTS) {
      const agrees = newYorkDayKey(event.at) === bangkokDayKey(event.at);
      expect(agrees, event.id).toBe(releaseTimingOf(event.at) === 'beforeOpen');
    }
  });
});
