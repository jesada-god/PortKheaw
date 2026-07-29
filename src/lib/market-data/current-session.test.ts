import { describe, expect, it } from 'vitest';
import {
  applySymbolHalt,
  canonicalRegularTradingDateAt,
  currentSessionPresentation,
  resolveCurrentMarketSession,
  sessionPhaseOf,
  type CurrentMarketSession,
  type MarketStatusReport,
} from './current-session';

/**
 * Calendar anchors. All instants are UTC; the resolver converts them to
 * America/New_York itself (EDT = UTC-4 on these dates).
 *
 *   2026-07-24 Friday · 2026-07-25 Saturday · 2026-07-26 Sunday · 2026-07-27 Monday
 */
const FRIDAY_REGULAR = '2026-07-24T17:00:00.000Z'; // 13:00 ET
const FRIDAY_PREMARKET = '2026-07-24T12:00:00.000Z'; // 08:00 ET
const FRIDAY_AFTER_HOURS = '2026-07-24T21:00:00.000Z'; // 17:00 ET
const FRIDAY_OVERNIGHT = '2026-07-25T02:00:00.000Z'; // Fri 22:00 ET
const SUNDAY = '2026-07-26T17:00:00.000Z'; // Sun 13:00 ET
const MONDAY_REGULAR = '2026-07-27T17:00:00.000Z'; // 13:00 ET

describe('canonical regular trading date', () => {
  it('uses the New York trading date when Bangkok has already crossed midnight', () => {
    // 01:00 on 28/07 in Bangkok is still 14:00 on 27/07 in New York.
    expect(canonicalRegularTradingDateAt('2026-07-27T18:00:00.000Z')).toBe('2026-07-27');
  });

  it('moves from the prior close in PRE to today after the regular close', () => {
    expect(canonicalRegularTradingDateAt('2026-07-27T12:00:00.000Z')).toBe('2026-07-24');
    expect(canonicalRegularTradingDateAt('2026-07-27T21:00:00.000Z')).toBe('2026-07-27');
  });

  it('uses the most recent finalized session on weekends and holidays', () => {
    expect(canonicalRegularTradingDateAt(SUNDAY)).toBe('2026-07-24');
    expect(canonicalRegularTradingDateAt('2026-07-03T17:00:00.000Z')).toBe('2026-07-02');
  });
});

function report(overrides: Partial<MarketStatusReport> = {}): MarketStatusReport {
  return {
    status: 'open',
    asOf: FRIDAY_REGULAR,
    source: 'polygon-market-status',
    stale: false,
    maxAgeSeconds: 30,
    ...overrides,
  };
}

describe('current market session — exchange calendar', () => {
  it.each([
    [FRIDAY_PREMARKET, 'PREMARKET'],
    [FRIDAY_REGULAR, 'REGULAR'],
    [FRIDAY_AFTER_HOURS, 'AFTER_HOURS'],
    [FRIDAY_OVERNIGHT, 'CLOSED'],
    [SUNDAY, 'CLOSED'],
  ] as const)('classifies %s as %s from the New York clock alone', (now, expected) => {
    const result = resolveCurrentMarketSession({ now });
    expect(result.session).toBe(expected);
    expect(result.source).toBe('exchange-calendar');
    expect(result.provider.accepted).toBe(false);
  });

  it('reports the evaluation instant and exchange date separately from any price', () => {
    const result = resolveCurrentMarketSession({ now: FRIDAY_AFTER_HOURS });
    expect(result.evaluatedAt).toBe(FRIDAY_AFTER_HOURS);
    expect(result.exchangeDate).toBe('2026-07-24');
  });

  it('treats a verified holiday as closed, never as regular', () => {
    const result = resolveCurrentMarketSession({
      now: MONDAY_REGULAR,
      holidays: new Set(['2026-07-27']),
    });
    expect(result.session).toBe('HOLIDAY');
  });

  it('resolves UNKNOWN rather than guessing when the instant is unusable', () => {
    expect(resolveCurrentMarketSession({ now: 'not-a-date' }).session).toBe('UNKNOWN');
  });

  it('resolves the Bangkok-to-ET date crossing as REGULAR', () => {
    // 2026-07-28 02:22 Asia/Bangkok = 2026-07-27 15:22 America/New_York.
    const result = resolveCurrentMarketSession({
      now: '2026-07-27T19:22:00.000Z',
      marketStatus: report({
        status: 'closed',
        asOf: '2026-07-27T19:22:00.000Z',
      }),
    });
    expect(result.exchangeDate).toBe('2026-07-27');
    expect(result.session).toBe('REGULAR');
    expect(result.provider.rejection).toBe('contradicts-calendar');
  });

  it('uses the built-in US exchange holiday calendar', () => {
    // Thanksgiving 2026 at 13:00 ET.
    expect(resolveCurrentMarketSession({ now: '2026-11-26T18:00:00.000Z' }).session).toBe('HOLIDAY');
  });
});

describe('current market session — provider status freshness', () => {
  it('accepts a fresh same-trading-date provider report', () => {
    const result = resolveCurrentMarketSession({
      now: FRIDAY_AFTER_HOURS,
      marketStatus: report({ status: 'after-hours', asOf: FRIDAY_AFTER_HOURS }),
    });
    expect(result.session).toBe('AFTER_HOURS');
    expect(result.source).toBe('market-status-provider');
    expect(result.provider.accepted).toBe(true);
  });

  it('rejects a status the pipeline already flagged as stale', () => {
    const result = resolveCurrentMarketSession({
      now: FRIDAY_AFTER_HOURS,
      marketStatus: report({ asOf: FRIDAY_AFTER_HOURS, stale: true }),
    });
    expect(result.session).toBe('AFTER_HOURS');
    expect(result.provider.rejection).toBe('stale');
  });

  it('rejects an "open" status carried over from a previous trading day', () => {
    // The production defect: Friday's cached market-status=open replayed later.
    const result = resolveCurrentMarketSession({
      now: MONDAY_REGULAR,
      marketStatus: report({ status: 'open', asOf: FRIDAY_REGULAR, maxAgeSeconds: null }),
    });
    expect(result.provider.rejection).toBe('older-trading-date');
    expect(result.source).toBe('exchange-calendar');
  });

  it('rejects a status older than its own declared max age', () => {
    const result = resolveCurrentMarketSession({
      now: '2026-07-24T17:30:00.000Z',
      marketStatus: report({ asOf: FRIDAY_REGULAR, maxAgeSeconds: 30 }),
    });
    expect(result.provider.rejection).toBe('past-max-age');
  });

  it('rejects a status timestamped in the future', () => {
    const result = resolveCurrentMarketSession({
      now: FRIDAY_PREMARKET,
      marketStatus: report({ asOf: FRIDAY_AFTER_HOURS }),
    });
    expect(result.provider.rejection).toBe('future-timestamp');
  });

  it('falls back to the calendar when the provider status is unknown', () => {
    const result = resolveCurrentMarketSession({
      now: FRIDAY_REGULAR,
      marketStatus: report({ status: 'unknown' }),
    });
    expect(result.session).toBe('REGULAR');
    expect(result.provider.rejection).toBe('unknown-status');
    expect(result.source).toBe('exchange-calendar');
  });

  it('lets the provider declare an early close inside a trading day', () => {
    const result = resolveCurrentMarketSession({
      now: FRIDAY_REGULAR,
      marketStatus: report({ status: 'early-close' }),
    });
    expect(result.session).toBe('EARLY_CLOSE');
  });
});

describe('current market session — invariants', () => {
  it('G: a weekend can never resolve to REGULAR, even with a fresh provider "open"', () => {
    const result = resolveCurrentMarketSession({
      now: SUNDAY,
      marketStatus: report({ status: 'open', asOf: SUNDAY }),
    });
    expect(result.session).toBe('CLOSED');
    expect(result.provider.rejection).toBe('contradicts-calendar');
  });

  it('H: a verified holiday can never resolve to REGULAR', () => {
    const result = resolveCurrentMarketSession({
      now: MONDAY_REGULAR,
      holidays: new Set(['2026-07-27']),
      marketStatus: report({ status: 'open', asOf: MONDAY_REGULAR }),
    });
    expect(result.session).toBe('HOLIDAY');
    expect(result.provider.rejection).toBe('contradicts-calendar');
  });

  it('E: a price/quote timestamp is not an accepted input at all', () => {
    // The only timestamps the resolver reads are `now` and the status `asOf`.
    // Feeding Friday's regular-session print as `now` cannot make Sunday open,
    // because Sunday is what the caller passes as `now`.
    const result = resolveCurrentMarketSession({ now: SUNDAY, marketStatus: null });
    expect(result.session).toBe('CLOSED');
    expect(result.provider.status).toBeNull();
    expect(result.provider.rejection).toBe('missing');
  });

  it('a symbol halt replaces REGULAR only, and never fabricates CLOSED', () => {
    expect(applySymbolHalt('REGULAR', true)).toBe('HALTED');
    expect(applySymbolHalt('REGULAR', false)).toBe('REGULAR');
    expect(applySymbolHalt('CLOSED', true)).toBe('CLOSED');
    expect(applySymbolHalt('AFTER_HOURS', true)).toBe('AFTER_HOURS');
  });
});

describe('current market session — presentation', () => {
  it.each([
    ['PREMARKET', 'ก่อนเปิดตลาด', 'Pre-market Session'],
    ['REGULAR', 'ตลาดเปิด', 'Regular Market Session'],
    ['AFTER_HOURS', 'หลังปิดตลาด', 'After-hours Session'],
    ['CLOSED', 'ปิดตลาด', 'Market Closed'],
    ['HOLIDAY', 'ตลาดปิด (วันหยุด)', 'Market Holiday'],
    ['EARLY_CLOSE', 'ปิดตลาด (ปิดเร็วกว่าปกติ)', 'Early Close Session'],
    ['HALTED', 'หยุดซื้อขายชั่วคราว', 'Trading Halt'],
    ['UNKNOWN', 'ไม่ทราบสถานะตลาด', 'Unknown Market Session'],
  ] as const)('names %s in Thai and English for the provenance detail', (session, label, fullName) => {
    expect(currentSessionPresentation(session)).toEqual({ label, fullName });
  });

  it('carries no emoji: session icons are Material Symbols glyphs, not text', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    const sessions: CurrentMarketSession[] = [
      'PREMARKET', 'REGULAR', 'AFTER_HOURS', 'CLOSED', 'HOLIDAY', 'EARLY_CLOSE', 'HALTED', 'UNKNOWN',
    ];
    for (const session of sessions) {
      expect(currentSessionPresentation(session).label).not.toMatch(emoji);
    }
  });

  it('A: only REGULAR is ever labelled exactly ตลาดเปิด', () => {
    const sessions: CurrentMarketSession[] = [
      'PREMARKET', 'REGULAR', 'AFTER_HOURS', 'CLOSED', 'HOLIDAY', 'EARLY_CLOSE', 'HALTED', 'UNKNOWN',
    ];
    for (const session of sessions) {
      expect(currentSessionPresentation(session).label === 'ตลาดเปิด').toBe(session === 'REGULAR');
    }
  });
});

/**
 * The phase is what every PRICE rule is written against, so which sessions collapse
 * into which phase is a load-bearing contract, not a naming detail.
 */
describe('session phase mapping', () => {
  it('shows a live regular price only in REGULAR and HALTED', () => {
    expect(sessionPhaseOf('REGULAR')).toBe('REGULAR');
    // A halt is symbol-level: the market is still in its regular session, and
    // downgrading the phase would swap the live price for a completed close.
    expect(sessionPhaseOf('HALTED')).toBe('REGULAR');
  });

  it('uses the latest completed regular close in every other phase', () => {
    expect(sessionPhaseOf('PREMARKET')).toBe('PRE');
    expect(sessionPhaseOf('AFTER_HOURS')).toBe('POST');
    expect(sessionPhaseOf('CLOSED')).toBe('CLOSED');
    expect(sessionPhaseOf('HOLIDAY')).toBe('CLOSED');
    expect(sessionPhaseOf('EARLY_CLOSE')).toBe('CLOSED');
  });

  it('treats an unresolved session as CLOSED, the only safe default', () => {
    // With no established session, a live or extended value would be a claim about
    // a session we cannot prove we are in.
    expect(sessionPhaseOf('UNKNOWN')).toBe('CLOSED');
  });
});

describe('close reason', () => {
  it('is null whenever the market is open in some window', () => {
    // Wednesday 2026-07-29: 11:00 ET, 08:30 ET and 16:30 ET.
    for (const now of ['2026-07-29T15:00:00.000Z', '2026-07-29T12:30:00.000Z', '2026-07-29T20:30:00.000Z']) {
      expect(resolveCurrentMarketSession({ now }).closeReason).toBeNull();
    }
  });

  it('reports WEEKEND on a Saturday and a Sunday', () => {
    expect(resolveCurrentMarketSession({ now: '2026-07-25T17:00:00.000Z' }).closeReason).toBe('WEEKEND');
    expect(resolveCurrentMarketSession({ now: '2026-07-26T17:00:00.000Z' }).closeReason).toBe('WEEKEND');
  });

  it('reports NORMAL after a full trading day has ended', () => {
    // Wednesday 2026-07-29, 21:00 ET — past the after-hours window.
    const resolved = resolveCurrentMarketSession({ now: '2026-07-30T01:00:00.000Z' });
    expect(resolved.session).toBe('CLOSED');
    expect(resolved.closeReason).toBe('NORMAL');
  });

  it('reports HOLIDAY for a published exchange holiday', () => {
    // Independence Day 2026 falls on a Saturday and is observed Friday the 3rd.
    const resolved = resolveCurrentMarketSession({ now: '2026-07-03T17:00:00.000Z' });
    expect(resolved.session).toBe('HOLIDAY');
    expect(resolved.closeReason).toBe('HOLIDAY');
  });

  it('reports EVENT for a closure the calendar does not know about', () => {
    const resolved = resolveCurrentMarketSession({
      now: '2026-07-29T17:00:00.000Z',
      marketStatus: {
        status: 'holiday', asOf: '2026-07-29T17:00:00.000Z',
        source: 'polygon-market-status', stale: false, maxAgeSeconds: 30,
      },
    });
    expect(resolved.session).toBe('HOLIDAY');
    expect(resolved.closeReason).toBe('EVENT');
  });

  it('reports EARLY_CLOSE only once a published half-day has actually ended', () => {
    // 2026-11-27, the Friday after Thanksgiving: a published 13:00 ET half-day.
    // 17:30 ET, past the shifted after-hours window.
    expect(resolveCurrentMarketSession({ now: '2026-11-27T22:30:00.000Z' }).closeReason).toBe('EARLY_CLOSE');
    // 03:00 ET the same morning: the session has not opened, let alone closed early.
    expect(resolveCurrentMarketSession({ now: '2026-11-27T08:00:00.000Z' }).closeReason).toBe('NORMAL');
  });
});
