import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import { isQuietHour, nextQuietHoursEnd } from './quiet-hours';
import { classifyPushFailure, retryDelayMs } from './service';

describe('push quiet hours', () => {
  const bangkokNoon = new Date('2026-07-18T05:00:00.000Z');
  const bangkokLate = new Date('2026-07-18T16:30:00.000Z');
  it('supports quiet windows that cross midnight', () => {
    expect(isQuietHour(bangkokLate, 'Asia/Bangkok', '22:00', '07:00')).toBe(true);
    expect(isQuietHour(bangkokNoon, 'Asia/Bangkok', '22:00', '07:00')).toBe(false);
  });
  it('supports same-day windows and treats equal endpoints as all day', () => {
    expect(isQuietHour(bangkokNoon, 'Asia/Bangkok', '11:00', '13:00')).toBe(true);
    expect(isQuietHour(bangkokNoon, 'Asia/Bangkok', '08:00', '08:00')).toBe(true);
  });
  it('fails open for an invalid timezone so notifications are not stuck forever', () => {
    expect(isQuietHour(bangkokNoon, 'Not/AZone', '00:00', '23:59')).toBe(false);
  });

  it('releases a deferred notification at the first minute after quiet hours', () => {
    expect(nextQuietHoursEnd(
      bangkokLate,
      'Asia/Bangkok',
      '22:00',
      '07:00',
    ).toISOString()).toBe('2026-07-19T00:00:00.000Z');
  });
});

describe('push provider retry policy', () => {
  it('cleans up expired provider endpoints without retrying them', () => {
    expect(classifyPushFailure({ statusCode: 404 })).toEqual({
      code: 'subscription-gone',
      gone: true,
      transient: false,
      statusCode: 404,
    });
    expect(classifyPushFailure({ statusCode: 410 }).gone).toBe(true);
  });

  it('bounds exponential backoff to three delivery attempts', () => {
    expect(classifyPushFailure({ statusCode: 503 }).transient).toBe(true);
    expect(classifyPushFailure({ statusCode: 400 }).transient).toBe(false);
    expect([1, 2, 3].map(retryDelayMs)).toEqual([
      5 * 60_000,
      10 * 60_000,
      20 * 60_000,
    ]);
  });
});
