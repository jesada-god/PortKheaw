import { describe, expect, it } from 'vitest';
import {
  isCommodityMarketOpen,
  resolveCommoditySession,
  COMMODITY_SESSION_CLOSED_LABEL,
  COMMODITY_SESSION_OPEN_LABEL,
} from './commodity-session';

/**
 * Every instant below is written in UTC and asserted against the Chicago wall
 * clock the CME schedule is published in. In August, America/Chicago is UTC-5
 * (CDT), so 16:00 CT is 21:00 UTC and 17:00 CT is 22:00 UTC.
 *
 * 2026-08-17 is a Monday, which anchors the weekday arithmetic below.
 */
const at = (iso: string) => new Date(iso);

describe('commodity (CME Globex) session', () => {
  it('is open during a mid-week trading afternoon', () => {
    // Monday 10:00 CT
    expect(isCommodityMarketOpen(at('2026-08-17T15:00:00.000Z'))).toBe(true);
  });

  it('closes for the daily 16:00–17:00 CT maintenance halt', () => {
    // Monday 15:59 CT — still trading.
    expect(isCommodityMarketOpen(at('2026-08-17T20:59:00.000Z'))).toBe(true);
    // Monday 16:00 CT — the halt begins the moment the close lands.
    expect(isCommodityMarketOpen(at('2026-08-17T21:00:00.000Z'))).toBe(false);
    // Monday 16:59 CT — still halted.
    expect(isCommodityMarketOpen(at('2026-08-17T21:59:00.000Z'))).toBe(false);
    // Monday 17:00 CT — the next trading day opens.
    expect(isCommodityMarketOpen(at('2026-08-17T22:00:00.000Z'))).toBe(true);
  });

  it('reports the daily halt as a scheduled break, not a weekend or a holiday', () => {
    const session = resolveCommoditySession(at('2026-08-17T21:30:00.000Z'));
    expect(session.state).toBe('closed');
    expect(session.closeReason).toBe('NORMAL');
    expect(session.label).toBe(COMMODITY_SESSION_CLOSED_LABEL);
  });

  it('closes the week at Friday 16:00 CT and does not reopen until Sunday 17:00 CT', () => {
    // Friday 15:59 CT — trading.
    expect(isCommodityMarketOpen(at('2026-08-21T20:59:00.000Z'))).toBe(true);
    // Friday 16:00 CT — the week is over.
    expect(isCommodityMarketOpen(at('2026-08-21T21:00:00.000Z'))).toBe(false);
    // Saturday, any hour.
    expect(isCommodityMarketOpen(at('2026-08-22T18:00:00.000Z'))).toBe(false);
    // Sunday 16:59 CT — still shut.
    expect(isCommodityMarketOpen(at('2026-08-23T21:59:00.000Z'))).toBe(false);
    // Sunday 17:00 CT — the new week opens.
    expect(isCommodityMarketOpen(at('2026-08-23T22:00:00.000Z'))).toBe(true);
  });

  it('calls the weekend a weekend', () => {
    expect(resolveCommoditySession(at('2026-08-22T18:00:00.000Z')).closeReason).toBe('WEEKEND');
    expect(resolveCommoditySession(at('2026-08-21T21:00:00.000Z')).closeReason).toBe('WEEKEND');
  });

  it('is NOT the 24/7 model: a Saturday is closed rather than trading', () => {
    const session = resolveCommoditySession(at('2026-08-22T12:00:00.000Z'));
    expect(session.state).toBe('closed');
    expect(session.label).not.toBe(COMMODITY_SESSION_OPEN_LABEL);
  });

  it('is NOT the equity model: it trades outside 09:30–16:00 New York', () => {
    // Monday 20:00 CT — long after the equity close, and Globex is trading.
    expect(isCommodityMarketOpen(at('2026-08-18T01:00:00.000Z'))).toBe(true);
    // Monday 03:00 CT — hours before the equity open, and Globex is trading.
    expect(isCommodityMarketOpen(at('2026-08-17T08:00:00.000Z'))).toBe(true);
  });

  it('closes on a full-day exchange holiday whatever the clock says', () => {
    // Christmas Day 2026 falls on a Friday; 10:00 CT would otherwise be trading.
    const session = resolveCommoditySession(at('2026-12-25T16:00:00.000Z'));
    expect(session.state).toBe('closed');
    expect(session.closeReason).toBe('HOLIDAY');
  });

  it('reports the exchange-local trading date', () => {
    // Monday 22:30 CT is still 2026-08-17 in Chicago.
    expect(resolveCommoditySession(at('2026-08-18T03:30:00.000Z')).tradingDate).toBe('2026-08-17');
  });

  it('labels an open market with the open label', () => {
    const session = resolveCommoditySession(at('2026-08-17T15:00:00.000Z'));
    expect(session.state).toBe('open');
    expect(session.closeReason).toBeNull();
    expect(session.label).toBe(COMMODITY_SESSION_OPEN_LABEL);
  });
});
