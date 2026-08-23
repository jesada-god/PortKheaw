/**
 * Sessions as instants, and distances measured in sessions.
 *
 * The holiday and previous-trading-day rules this module already had are
 * exercised by their callers; what is new — and what needs its own pinning — is
 * the ability to answer "which session is this instant's data FROM" and "how
 * many sessions separate these two". A freshness flag was being decided on
 * subtraction of wall-clock timestamps, and every weekend it said the sources
 * had drifted a day and a half apart when they were two views of one Friday.
 */

import { describe, expect, it } from 'vitest';
import { lastUsSessionClose, usSessionCloseMinute, usTradingSessionsBetween } from './us-market-calendar';

describe('lastUsSessionClose', () => {
  it('maps a Saturday-night instant back to the Friday session', () => {
    // 2026-08-22 is a Saturday; 03:11Z is 23:11 ET on the Friday evening.
    const resolved = lastUsSessionClose('2026-08-22T03:11:00.000Z');
    expect(resolved?.date).toBe('2026-08-21');
    expect(resolved?.closeAt).toBe('2026-08-21T20:00:00.000Z');
  });

  it('maps a Sunday instant back to the Friday session too', () => {
    expect(lastUsSessionClose('2026-08-23T18:00:00.000Z')?.date).toBe('2026-08-21');
  });

  it('stays on the current day once that day has closed', () => {
    // 20:00Z is exactly 16:00 ET on a Wednesday: the close has happened.
    expect(lastUsSessionClose('2026-08-19T20:00:00.000Z')?.date).toBe('2026-08-19');
  });

  it('falls back to the previous session while the current one is still open', () => {
    // 15:30 ET on a Wednesday. Wednesday has not closed, so the last CLOSED
    // session is Tuesday, and a chain pulled now is not yet Wednesday's record.
    expect(lastUsSessionClose('2026-08-19T19:30:00.000Z')?.date).toBe('2026-08-18');
  });

  it('skips a holiday rather than treating it as a session', () => {
    // 2026-07-03 is the observed Independence Day holiday (July 4 is a Saturday),
    // so a Saturday-morning instant resolves back past it to Thursday.
    expect(usSessionCloseMinute('2026-07-02')).toBe(16 * 60);
    const resolved = lastUsSessionClose('2026-07-04T12:00:00.000Z');
    expect(resolved?.date).toBe('2026-07-02');
  });

  it('closes a published half-day at 13:00 ET, not 16:00', () => {
    // The day after Thanksgiving 2026.
    expect(usSessionCloseMinute('2026-11-27')).toBe(13 * 60);
    const resolved = lastUsSessionClose('2026-11-27T19:00:00.000Z');
    expect(resolved?.date).toBe('2026-11-27');
    expect(resolved?.closeAt).toBe('2026-11-27T18:00:00.000Z');
  });

  it('returns null rather than guessing at an unparseable instant', () => {
    expect(lastUsSessionClose('not-a-date')).toBeNull();
  });
});

describe('usTradingSessionsBetween', () => {
  it('counts a weekend as no session at all', () => {
    expect(usTradingSessionsBetween('2026-08-21', '2026-08-21')).toBe(0);
    // Friday to Monday is ONE session apart, not three days.
    expect(usTradingSessionsBetween('2026-08-21', '2026-08-24')).toBe(1);
  });

  it('counts consecutive weekdays as one session each', () => {
    expect(usTradingSessionsBetween('2026-08-19', '2026-08-20')).toBe(1);
    expect(usTradingSessionsBetween('2026-08-19', '2026-08-21')).toBe(2);
  });

  it('is symmetric in its arguments', () => {
    expect(usTradingSessionsBetween('2026-08-21', '2026-08-19'))
      .toBe(usTradingSessionsBetween('2026-08-19', '2026-08-21'));
  });

  it('does not count a holiday as a session', () => {
    // 2026-07-02 (Thu) to 2026-07-06 (Mon), with Friday the 3rd observed as the
    // Independence Day holiday: one session, not two.
    expect(usTradingSessionsBetween('2026-07-02', '2026-07-06')).toBe(1);
  });

  it('caps the walk instead of spinning on a wildly distant date', () => {
    expect(usTradingSessionsBetween('2020-01-02', '2026-08-21', 10)).toBe(10);
  });

  it('returns null for an unparseable date', () => {
    expect(usTradingSessionsBetween('nope', '2026-08-21')).toBeNull();
  });
});
