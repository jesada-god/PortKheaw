import { describe, expect, it } from 'vitest';
import { isDailySummaryDue, isQuietTime, zonedClock } from './schedule';

describe('account notification schedules', () => {
  it('uses Asia/Bangkok local date and time independently of the server timezone', () => {
    const now = new Date('2026-08-02T11:00:00.000Z');
    expect(zonedClock(now, 'Asia/Bangkok')).toEqual({
      date: '2026-08-02',
      time: '18:00',
    });
    expect(isDailySummaryDue({
      now,
      timeZone: 'Asia/Bangkok',
      summaryTime: '18:00',
      lastLocalDate: null,
    })).toBe(true);
  });

  it('deduplicates a daily summary by account-local date', () => {
    expect(isDailySummaryDue({
      now: new Date('2026-08-02T14:00:00.000Z'),
      timeZone: 'Asia/Bangkok',
      summaryTime: '18:00',
      lastLocalDate: '2026-08-02',
    })).toBe(false);
  });

  it('supports quiet hours that cross midnight', () => {
    expect(isQuietTime({
      now: new Date('2026-08-02T16:00:00.000Z'),
      timeZone: 'Asia/Bangkok',
      start: '22:00',
      end: '07:00',
    })).toBe(true);
    expect(isQuietTime({
      now: new Date('2026-08-02T01:00:00.000Z'),
      timeZone: 'Asia/Bangkok',
      start: '22:00',
      end: '07:00',
    })).toBe(false);
  });
});
