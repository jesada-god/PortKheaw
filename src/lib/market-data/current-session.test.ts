import { describe, expect, it } from 'vitest';
import {
  applySymbolHalt,
  currentSessionPresentation,
  isRegularSession,
  resolveCurrentMarketSession,
  usesLatestRegularClose,
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
    ['PREMARKET', '🌅', 'ก่อนตลาดเปิด'],
    ['REGULAR', '☀️', 'ตลาดเปิด'],
    ['AFTER_HOURS', '🌙', 'หลังเวลาทำการ'],
    ['CLOSED', '🌙', 'ตลาดปิด'],
    ['HOLIDAY', '🌙', 'ตลาดปิด · วันหยุดตลาด'],
    ['EARLY_CLOSE', '⏱️', 'ตลาดปิดเร็ว'],
    ['HALTED', '⏸️', 'หยุดซื้อขายชั่วคราว'],
    ['UNKNOWN', '⚠️', 'ไม่ทราบสถานะตลาด'],
  ] as const)('maps %s to a stable emoji and Thai label', (session, emoji, label) => {
    expect(currentSessionPresentation(session)).toEqual(expect.objectContaining({ emoji, label }));
  });

  it('A: only REGULAR is ever labelled ตลาดเปิด', () => {
    const sessions: CurrentMarketSession[] = [
      'PREMARKET', 'REGULAR', 'AFTER_HOURS', 'CLOSED', 'HOLIDAY', 'EARLY_CLOSE', 'HALTED', 'UNKNOWN',
    ];
    for (const session of sessions) {
      expect(currentSessionPresentation(session).label === 'ตลาดเปิด').toBe(session === 'REGULAR');
      expect(isRegularSession(session)).toBe(session === 'REGULAR');
    }
  });

  it('uses the latest completed regular close outside REGULAR and HALTED', () => {
    expect(usesLatestRegularClose('REGULAR')).toBe(false);
    expect(usesLatestRegularClose('HALTED')).toBe(false);
    expect(usesLatestRegularClose('PREMARKET')).toBe(true);
    expect(usesLatestRegularClose('AFTER_HOURS')).toBe(true);
    expect(usesLatestRegularClose('CLOSED')).toBe(true);
    expect(usesLatestRegularClose('HOLIDAY')).toBe(true);
  });
});
