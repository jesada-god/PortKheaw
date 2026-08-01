import { describe, expect, it } from 'vitest';
import {
  currentDateTimeLocal,
  formatDateTimeLocal,
  maximumTransactionDateTimeLocal,
  resolveTransactionTimeZone,
  transactionDateTimeToUtcIso,
  validateTransactionDateTime,
} from './transaction-datetime';

const BANGKOK = 'Asia/Bangkok';
const NOW = Date.parse('2026-08-01T00:00:00.000Z');

describe('portfolio transaction wall-time contract', () => {
  it('uses the preferred time zone with the Bangkok fallback', () => {
    expect(resolveTransactionTimeZone('America/New_York')).toBe('America/New_York');
    expect(resolveTransactionTimeZone('not/a-zone')).toBe(BANGKOK);
    expect(resolveTransactionTimeZone(null)).toBe(BANGKOK);
  });

  it('accepts now, one minute ago, one day ago, and clock skew through two minutes', () => {
    expect(currentDateTimeLocal(BANGKOK, NOW)).toBe('2026-08-01T07:00');
    expect(validateTransactionDateTime('2026-08-01T07:00', BANGKOK, NOW).ok).toBe(true);
    expect(validateTransactionDateTime('2026-08-01T06:59', BANGKOK, NOW).ok).toBe(true);
    expect(validateTransactionDateTime('2026-07-31T07:00', BANGKOK, NOW).ok).toBe(true);
    expect(validateTransactionDateTime('2026-08-01T07:02', BANGKOK, NOW).ok).toBe(true);
    expect(maximumTransactionDateTimeLocal(BANGKOK, NOW)).toBe('2026-08-01T07:02');
  });

  it('rejects a future wall time beyond the two-minute tolerance', () => {
    expect(validateTransactionDateTime('2026-08-01T07:03', BANGKOK, NOW)).toEqual({
      ok: false,
      message: 'วันและเวลารายการอยู่ในอนาคตเกิน 2 นาที',
    });
  });

  it('round-trips before and after Bangkok midnight without shifting seven hours', () => {
    for (const wallTime of ['2026-07-31T23:59', '2026-08-01T00:01']) {
      const utc = transactionDateTimeToUtcIso(wallTime, BANGKOK);
      expect(formatDateTimeLocal(utc, BANGKOK)).toBe(wallTime);
    }
    expect(transactionDateTimeToUtcIso('2026-08-01T06:23', BANGKOK))
      .toBe('2026-07-31T23:23:00.000Z');
  });

  it('is independent of the client and server host time zones', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const fromUtcServer = transactionDateTimeToUtcIso('2026-08-01T06:23', BANGKOK);
      process.env.TZ = 'America/New_York';
      const fromNewYorkServer = transactionDateTimeToUtcIso('2026-08-01T06:23', BANGKOK);
      expect(fromUtcServer).toBe(fromNewYorkServer);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('supports DST zones and rejects a nonexistent local wall time', () => {
    expect(transactionDateTimeToUtcIso('2026-11-01T01:30', 'America/New_York'))
      .toBe('2026-11-01T05:30:00.000Z');
    expect(validateTransactionDateTime(
      '2026-03-08T02:30',
      'America/New_York',
      Date.parse('2026-03-09T00:00:00.000Z'),
    ).ok).toBe(false);
  });
});
