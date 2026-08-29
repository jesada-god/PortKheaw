import { describe, expect, it } from 'vitest';
import { NEVER_SAY } from '@/src/lib/presentation/banned-copy';
import { watchlistDayChange, watchlistDayChangeUnavailableCopy } from './day-change';

/*
 * 2026-08-28 was a Friday. The dates below are exchange-local trading dates,
 * which is what every basis and every caption in this product is keyed on.
 */
const FRIDAY = '2026-08-28';
const SNAPSHOT = { date: FRIDAY, close: 110, prevClose: 100, source: 'test' };

describe('watchlist day figure — which two prices', () => {
  it('uses the live price against the previous close while the market is open', () => {
    const day = watchlistDayChange({
      session: 'OPEN', price: 105, previousClose: 100, snapshot: SNAPSHOT,
    });
    expect(day.source).toBe('live');
    expect(day.change).toBeCloseTo(5);
    expect(day.changePercent).toBeCloseTo(5);
    expect(day.sessionDate).toBeNull();
  });

  it('uses the completed close once the market is shut', () => {
    const day = watchlistDayChange({
      session: 'CLOSED', price: 999, previousClose: 100, snapshot: SNAPSHOT,
    });
    expect(day.source).toBe('snapshot');
    expect(day.changePercent).toBeCloseTo(10);
    expect(day.sessionDate).toBe(FRIDAY);
  });

  it('treats pre-market and after-hours as the same fact as a closed market', () => {
    for (const session of ['PRE_MARKET', 'AFTER_HOURS', 'CLOSED'] as const) {
      const day = watchlistDayChange({ session, price: 999, snapshot: SNAPSHOT });
      expect(day.source, session).toBe('snapshot');
      expect(day.sessionDate, session).toBe(FRIDAY);
    }
  });

  it('computes the percentage against the earlier price, not the later one', () => {
    const day = watchlistDayChange({
      session: 'CLOSED', price: null, snapshot: { date: FRIDAY, close: 50, prevClose: 40 },
    });
    expect(day.change).toBeCloseTo(10);
    expect(day.changePercent).toBeCloseTo(25);
  });
});

describe('watchlist day figure — the words that date it', () => {
  it('says the number is moving while the market is open', () => {
    const day = watchlistDayChange({ session: 'OPEN', price: 105, previousClose: 100 });
    expect(day.copy.label).toBe('วันนี้');
    expect(day.copy.caption).toContain('ตลาดกำลังซื้อขายอยู่');
  });

  /*
   * The distinction that matters is not open-versus-closed. A completed close
   * that IS today's keeps the วันนี้ label — the market shutting for the evening
   * does not move today's move to another day — and only says so in the caption.
   */
  it('keeps today as today after the bell, and says the market has closed', () => {
    const day = watchlistDayChange({
      session: 'AFTER_HOURS', price: null, snapshot: SNAPSHOT, todayExchangeDate: FRIDAY,
    });
    expect(day.copy.label).toBe('วันนี้');
    expect(day.copy.caption).toContain('ตลาดปิดแล้ว');
  });

  it('names the weekday once the figure belongs to an earlier session', () => {
    const day = watchlistDayChange({
      session: 'CLOSED', price: null, snapshot: SNAPSHOT, todayExchangeDate: '2026-08-30',
    });
    expect(day.copy.label).toBe('วันศุกร์');
    expect(day.copy.caption).toContain('ราคาปิดของ');
    expect(day.copy.caption).toContain('ศุกร์');
  });

  it('carries a caption in every state, so its presence is not a warning', () => {
    const states = [
      watchlistDayChange({ session: 'OPEN', price: 105, previousClose: 100 }),
      watchlistDayChange({ session: 'CLOSED', price: null, snapshot: SNAPSHOT }),
      watchlistDayChange({ session: 'CLOSED', price: null }),
    ];
    for (const day of states) expect(day.copy.caption.length).toBeGreaterThan(0);
  });
});

describe('watchlist day figure — when it cannot be computed', () => {
  it('is null rather than zero, because zero is a claim about the market', () => {
    const day = watchlistDayChange({ session: 'CLOSED', price: null, snapshot: null });
    expect(day.change).toBeNull();
    expect(day.changePercent).toBeNull();
    expect(day.source).toBeNull();
  });

  it('says which part is missing and implies the wait', () => {
    const copy = watchlistDayChangeUnavailableCopy();
    expect(copy.caption).toContain('ยังไม่ได้ราคาปิด');
    expect(copy.caption).toContain('ระบบจะอัปเดต');
    // The phrase the whole day-change module exists to stop printing.
    expect(copy.caption).not.toBe('ไม่มีข้อมูล');
  });

  it("does not borrow the portfolio's sentence, which would name a portfolio", () => {
    expect(watchlistDayChangeUnavailableCopy().caption).not.toContain('ในพอร์ต');
  });

  it('refuses a non-positive base rather than producing a huge percentage', () => {
    const day = watchlistDayChange({
      session: 'CLOSED', price: null, snapshot: { date: FRIDAY, close: 10, prevClose: 0 },
    });
    expect(day.changePercent).toBeNull();
  });

  it('says nothing from the product-wide banned list', () => {
    const captions = [
      watchlistDayChangeUnavailableCopy().caption,
      watchlistDayChange({ session: 'OPEN', price: 105, previousClose: 100 }).copy.caption,
    ].join(' ');
    for (const phrase of NEVER_SAY) expect(captions, phrase).not.toContain(phrase);
  });
});
