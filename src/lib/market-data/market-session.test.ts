import { describe, expect, it } from 'vitest';
import {
  isTradingDate,
  lastCompletedSessionDate,
  marketSession,
  marketSessionDetail,
  previousTradingDate,
  unscheduledClosureReason,
  unscheduledUsClosures,
} from './market-session';

/**
 * Every instant here is written as a UTC `Z` timestamp with the ET wall clock it
 * corresponds to spelled out beside it.
 *
 * That is deliberate and it is the only honest way to test this: writing the
 * cases as local strings would make them pass or fail on the machine's own time
 * zone, and the bug this module exists to prevent IS a time-zone bug. The offset
 * used in each case (−04:00 in EDT, −05:00 in EST) is part of what is being
 * asserted — if the DST arithmetic were wrong, these timestamps would land in a
 * different session than the comment claims.
 */

describe('marketSession — the four states at their boundaries', () => {
  /*
    Wednesday 20 August 2025, an ordinary EDT trading day (UTC−4).

    Each boundary is probed on BOTH sides at one-minute resolution, because
    every one of these windows is half-open and an off-by-one minute is the
    failure that would never be noticed: it mislabels exactly one minute a day.
  */
  it('is CLOSED before the pre-market window opens', () => {
    expect(marketSession('2025-08-20T07:59:00Z')).toBe('CLOSED'); // 03:59 ET
  });

  it('opens PRE_MARKET at 04:00 ET exactly', () => {
    expect(marketSession('2025-08-20T08:00:00Z')).toBe('PRE_MARKET'); // 04:00 ET
    expect(marketSession('2025-08-20T13:29:00Z')).toBe('PRE_MARKET'); // 09:29 ET
  });

  it('opens OPEN at 09:30 ET exactly', () => {
    expect(marketSession('2025-08-20T13:30:00Z')).toBe('OPEN'); // 09:30 ET
    expect(marketSession('2025-08-20T18:00:00Z')).toBe('OPEN'); // 14:00 ET
    expect(marketSession('2025-08-20T19:59:00Z')).toBe('OPEN'); // 15:59 ET
  });

  it('turns AFTER_HOURS at 16:00 ET exactly, not at 16:01', () => {
    // The closing minute belongs to after-hours: the regular window is
    // half-open at 16:00, so a print stamped 16:00:00 is already past it.
    expect(marketSession('2025-08-20T20:00:00Z')).toBe('AFTER_HOURS'); // 16:00 ET
    expect(marketSession('2025-08-20T23:59:00Z')).toBe('AFTER_HOURS'); // 19:59 ET
  });

  it('returns to CLOSED at 20:00 ET', () => {
    expect(marketSession('2025-08-21T00:00:00Z')).toBe('CLOSED'); // 20:00 ET Wed
    expect(marketSession('2025-08-21T03:00:00Z')).toBe('CLOSED'); // 23:00 ET Wed
  });

  it('accepts a Date and an ISO string identically', () => {
    const instant = '2025-08-20T18:00:00Z';
    expect(marketSession(new Date(instant))).toBe(marketSession(instant));
  });

  it('resolves CLOSED for an unusable instant rather than guessing a live session', () => {
    // CLOSED selects "show the last completed close", which is the only rule
    // that is safe with no clock. Any other answer would claim a session.
    expect(marketSession('not-a-date')).toBe('CLOSED');
    expect(marketSession(new Date(Number.NaN))).toBe('CLOSED');
  });
});

describe('marketSession — weekends', () => {
  it('is CLOSED all weekend, including during what would be trading hours', () => {
    // Saturday 23 August 2025, 14:00 ET — squarely inside a weekday's regular
    // window. The hour is not evidence of a session; the calendar is.
    expect(marketSession('2025-08-23T18:00:00Z')).toBe('CLOSED');
    expect(marketSession('2025-08-24T18:00:00Z')).toBe('CLOSED'); // Sunday
  });

  it('is CLOSED on a Friday evening and stays CLOSED into Monday pre-market', () => {
    expect(marketSession('2025-08-23T01:00:00Z')).toBe('CLOSED'); // Fri 21:00 ET
    expect(marketSession('2025-08-25T08:30:00Z')).toBe('PRE_MARKET'); // Mon 04:30 ET
  });
});

describe('marketSession — exchange holidays', () => {
  it('is CLOSED on Thanksgiving, a weekday inside regular hours', () => {
    // Thursday 27 November 2025, 11:00 ET. The original header bug read this
    // as "ตลาดเปิด" because it asked the clock and not the calendar.
    expect(marketSession('2025-11-27T16:00:00Z')).toBe('CLOSED');
  });

  it('is CLOSED on Good Friday, which no fixed-date rule produces', () => {
    // 18 April 2025, 11:00 ET — derived from the Easter computus.
    expect(marketSession('2025-04-18T15:00:00Z')).toBe('CLOSED');
  });

  it('is CLOSED on Juneteenth from 2022 and OPEN on the same date in 2021', () => {
    // The exchanges adopted Juneteenth in 2022, not when the federal law
    // passed — so 2021-06-18 (the Friday observance) was a normal session.
    expect(marketSession('2022-06-20T15:00:00Z')).toBe('CLOSED'); // Mon 11:00 ET
    expect(marketSession('2021-06-18T15:00:00Z')).toBe('OPEN'); // Fri 11:00 ET
  });

  it('is OPEN on a half-day morning and CLOSED after its 13:00 ET close', () => {
    // Friday 28 November 2025, the published half-day after Thanksgiving.
    expect(marketSession('2025-11-28T15:00:00Z')).toBe('OPEN'); // 10:00 ET
    expect(marketSession('2025-11-28T17:59:00Z')).toBe('OPEN'); // 12:59 ET
    // 13:00 ET starts the shortened after-hours window, which runs to 17:00 ET.
    expect(marketSession('2025-11-28T18:00:00Z')).toBe('AFTER_HOURS'); // 13:00 ET
    expect(marketSession('2025-11-28T21:59:00Z')).toBe('AFTER_HOURS'); // 16:59 ET
    expect(marketSession('2025-11-28T22:00:00Z')).toBe('CLOSED'); // 17:00 ET
  });

  it('is CLOSED on a declared unscheduled closure', () => {
    // 9 January 2025 — the national day of mourning for President Carter. No
    // formula produces this date; it comes from the JSON beside the module.
    expect(marketSession('2025-01-09T15:00:00Z')).toBe('CLOSED'); // 10:00 ET
    expect(unscheduledClosureReason('2025-01-09')).toContain('Carter');
    expect(unscheduledUsClosures().has('2025-01-09')).toBe(true);
    // The day before and after were ordinary sessions.
    expect(marketSession('2025-01-08T15:00:00Z')).toBe('OPEN');
    expect(marketSession('2025-01-10T15:00:00Z')).toBe('OPEN');
  });

  it('reports no closure reason for an ordinary date', () => {
    expect(unscheduledClosureReason('2025-08-20')).toBeNull();
  });
});

describe('marketSession — daylight saving transitions', () => {
  /*
    The exchange opens at 09:30 ET on both sides of a DST change, which is
    13:30 UTC in summer and 14:30 UTC in winter. A module that had hardcoded a
    UTC offset — or that had done its date arithmetic on local midnights — would
    be exactly one hour wrong for half the year, and would pass any test written
    only in one season. Both seasons are asserted, and so are the two transition
    days themselves.
  */
  it('opens at 13:30 UTC under EDT and 14:30 UTC under EST', () => {
    expect(marketSession('2025-08-20T13:30:00Z')).toBe('OPEN'); // summer, 09:30 ET
    expect(marketSession('2025-08-20T14:30:00Z')).toBe('OPEN'); // summer, 10:30 ET

    expect(marketSession('2025-01-15T13:30:00Z')).toBe('PRE_MARKET'); // winter, 08:30 ET
    expect(marketSession('2025-01-15T14:30:00Z')).toBe('OPEN'); // winter, 09:30 ET
  });

  it('closes at 20:00 UTC under EDT and 21:00 UTC under EST', () => {
    expect(marketSession('2025-08-20T19:59:00Z')).toBe('OPEN'); // summer, 15:59 ET
    expect(marketSession('2025-08-20T20:00:00Z')).toBe('AFTER_HOURS');

    expect(marketSession('2025-01-15T20:59:00Z')).toBe('OPEN'); // winter, 15:59 ET
    expect(marketSession('2025-01-15T21:00:00Z')).toBe('AFTER_HOURS');
  });

  it('handles the spring-forward day, when 02:00–03:00 ET does not exist', () => {
    // Sunday 9 March 2025 is the transition; Monday 10 March is the first EDT
    // session. 13:30 UTC is 09:30 EDT — the open — and would have been 08:30
    // EST the previous week.
    expect(marketSession('2025-03-10T13:30:00Z')).toBe('OPEN');
    expect(marketSession('2025-03-07T13:30:00Z')).toBe('PRE_MARKET'); // prior Friday, EST
  });

  it('handles the fall-back day, when 01:00–02:00 ET happens twice', () => {
    // Sunday 2 November 2025 is the transition; Monday 3 November is the first
    // EST session. 14:30 UTC is 09:30 EST.
    expect(marketSession('2025-11-03T14:30:00Z')).toBe('OPEN');
    expect(marketSession('2025-11-03T13:30:00Z')).toBe('PRE_MARKET'); // 08:30 EST
    expect(marketSession('2025-10-31T13:30:00Z')).toBe('OPEN'); // prior Friday, EDT
  });

  it('keeps the transition Sunday itself CLOSED in both directions', () => {
    expect(marketSession('2025-03-09T14:00:00Z')).toBe('CLOSED');
    expect(marketSession('2025-11-02T14:00:00Z')).toBe('CLOSED');
  });
});

describe('trading dates', () => {
  it('counts a half-day as a trading date and a holiday as not one', () => {
    expect(isTradingDate('2025-11-28')).toBe(true); // half-day
    expect(isTradingDate('2025-11-27')).toBe(false); // Thanksgiving
    expect(isTradingDate('2025-08-23')).toBe(false); // Saturday
    expect(isTradingDate('2025-01-09')).toBe(false); // unscheduled closure
  });

  it('walks back over a weekend and over a holiday-extended one', () => {
    expect(previousTradingDate('2025-08-25')).toBe('2025-08-22'); // Mon -> Fri
    expect(previousTradingDate('2025-11-28')).toBe('2025-11-26'); // skips Thanksgiving
    expect(previousTradingDate('2025-01-10')).toBe('2025-01-08'); // skips the closure
  });

  it('rejects an unparseable date rather than returning a plausible one', () => {
    expect(previousTradingDate('not-a-date')).toBeNull();
  });
});

describe('lastCompletedSessionDate — which day a closed-market figure is about', () => {
  it('is yesterday during pre-market and today from the closing bell onward', () => {
    // The distinction that decides whether Monday morning is captioned Friday
    // or Monday. Before the open nothing has finished today.
    expect(lastCompletedSessionDate('2025-08-20T12:00:00Z')).toBe('2025-08-19'); // 08:00 ET
    expect(lastCompletedSessionDate('2025-08-20T19:59:00Z')).toBe('2025-08-19'); // 15:59 ET
    expect(lastCompletedSessionDate('2025-08-20T20:00:00Z')).toBe('2025-08-20'); // 16:00 ET
    expect(lastCompletedSessionDate('2025-08-21T02:00:00Z')).toBe('2025-08-20'); // 22:00 ET
  });

  it('holds Friday across the whole weekend', () => {
    expect(lastCompletedSessionDate('2025-08-23T18:00:00Z')).toBe('2025-08-22'); // Sat
    expect(lastCompletedSessionDate('2025-08-24T18:00:00Z')).toBe('2025-08-22'); // Sun
    expect(lastCompletedSessionDate('2025-08-25T12:00:00Z')).toBe('2025-08-22'); // Mon pre
  });

  it('uses the 13:00 ET bell on a half-day, not 16:00', () => {
    expect(lastCompletedSessionDate('2025-11-28T17:59:00Z')).toBe('2025-11-26'); // 12:59 ET
    expect(lastCompletedSessionDate('2025-11-28T18:00:00Z')).toBe('2025-11-28'); // 13:00 ET
  });

  it('skips a holiday entirely', () => {
    // Thanksgiving afternoon: the last thing that finished was Wednesday.
    expect(lastCompletedSessionDate('2025-11-27T20:00:00Z')).toBe('2025-11-26');
  });

  it('is null for an unusable instant', () => {
    expect(lastCompletedSessionDate('not-a-date')).toBeNull();
  });
});

describe('marketSessionDetail', () => {
  it('reports the session, both dates and the half-day flag together', () => {
    expect(marketSessionDetail('2025-11-28T18:30:00Z')).toEqual({
      session: 'AFTER_HOURS',
      exchangeDate: '2025-11-28',
      lastCompletedSessionDate: '2025-11-28',
      earlyClose: true,
      closureReason: null,
    });
  });

  it('names the reason on an unscheduled closure', () => {
    const detail = marketSessionDetail('2025-01-09T15:00:00Z');
    expect(detail.session).toBe('CLOSED');
    expect(detail.exchangeDate).toBe('2025-01-09');
    expect(detail.lastCompletedSessionDate).toBe('2025-01-08');
    expect(detail.closureReason).toContain('Carter');
  });

  it('degrades to CLOSED with null dates for an unusable instant', () => {
    expect(marketSessionDetail('not-a-date')).toEqual({
      session: 'CLOSED',
      exchangeDate: null,
      lastCompletedSessionDate: null,
      earlyClose: false,
      closureReason: null,
    });
  });
});
