import { describe, expect, it } from 'vitest';
import {
  dayChangeCopy,
  dayChangeUnavailableCopy,
  thaiSessionDate,
  thaiSessionWeekday,
} from './day-change-label';

/**
 * The phrase this whole change exists to delete. Asserted as a literal in one
 * place so that a future edit reintroducing it fails here rather than shipping.
 */
const BANNED = 'ไม่มีข้อมูล';

/** English trading shorthand the copy is not allowed to fall back to. */
const JARGON = ['P&L', 'pre-market', 'Pre-market', 'after-hours', 'After-hours', 'session', 'Session'];

describe('thaiSessionDate', () => {
  it('names the weekday and the date, with a Gregorian year', () => {
    // The locale and calendar are pinned; a bare toLocaleDateString would print
    // a Buddhist year in a th-TH browser and a US format on the server, so the
    // same date would render two ways for one number.
    expect(thaiSessionDate('2025-08-29')).toBe('วันศุกร์ที่ 29 ส.ค. 2025');
    expect(thaiSessionWeekday('2025-08-29')).toBe('วันศุกร์');
  });

  it('reads the date as given rather than re-interpreting it in a local zone', () => {
    // 2025-08-25 is a Monday everywhere. A reader in Bangkok must not see this
    // shift to Sunday because the string was parsed as a local midnight.
    expect(thaiSessionWeekday('2025-08-25')).toBe('วันจันทร์');
    expect(thaiSessionWeekday('2025-08-24')).toBe('วันอาทิตย์');
  });

  it('is null for anything that is not a bare YYYY-MM-DD', () => {
    expect(thaiSessionDate('2025-08-29T00:00:00Z')).toBeNull();
    expect(thaiSessionDate('nope')).toBeNull();
    expect(thaiSessionWeekday('')).toBeNull();
  });
});

describe('dayChangeCopy', () => {
  it('says the market is trading when the figure is live', () => {
    const copy = dayChangeCopy({ source: 'live', sessionDate: null });
    expect(copy.label).toBe('วันนี้');
    expect(copy.caption).toContain('ตลาดกำลังซื้อขายอยู่');
  });

  it('keeps the label "วันนี้" when the captured close IS today’s', () => {
    /*
      The after-hours and evening case, which is most of a Thai reader's waking
      day. The market having shut does not move today's move to another day, and
      relabelling it would read as the number having been swapped for a
      different one.
    */
    const copy = dayChangeCopy({
      source: 'snapshot', sessionDate: '2025-08-29', todayExchangeDate: '2025-08-29',
    });
    expect(copy.label).toBe('วันนี้');
    expect(copy.caption).toBe('ตลาดปิดแล้ว ตัวเลขนี้คือราคาปิดของวันศุกร์ที่ 29 ส.ค. 2025');
  });

  it('names the weekday when the close belongs to an earlier day', () => {
    // Saturday, reading Friday's close. Labelling this "วันนี้" would be a
    // false statement, which the old blank at least did not make.
    const copy = dayChangeCopy({
      source: 'snapshot', sessionDate: '2025-08-29', todayExchangeDate: '2025-08-30',
    });
    expect(copy.label).toBe('วันศุกร์');
    expect(copy.caption).toBe('ตลาดยังไม่เปิด ตัวเลขนี้คือราคาปิดของวันศุกร์ที่ 29 ส.ค. 2025');
  });

  it('names the weekday when there is no "today" to compare against', () => {
    const copy = dayChangeCopy({ source: 'snapshot', sessionDate: '2025-08-29' });
    expect(copy.label).toBe('วันศุกร์');
    expect(copy.caption).toContain('29 ส.ค. 2025');
  });

  it('states the uncertainty rather than guessing when a snapshot has no date', () => {
    const copy = dayChangeCopy({ source: 'snapshot', sessionDate: null });
    expect(copy.label).toBe('ครั้งล่าสุด');
    expect(copy.caption).toContain('ยังระบุวันที่ไม่ได้');
    // Specifically NOT "วันนี้": an undated close is not evidence of today.
    expect(copy.label).not.toBe('วันนี้');
  });

  it('states the uncertainty for a malformed date too', () => {
    expect(dayChangeCopy({ source: 'snapshot', sessionDate: 'garbage' }).label).toBe('ครั้งล่าสุด');
  });
});

describe('dayChangeUnavailableCopy', () => {
  it('names what is missing and that it will resolve, instead of a dead end', () => {
    const copy = dayChangeUnavailableCopy();
    expect(copy.caption).toContain('ยังไม่ได้ราคาปิดของบางรายการ');
    expect(copy.caption).toContain('ระบบจะอัปเดตให้');
  });
});

describe('the copy contract', () => {
  const every = [
    dayChangeCopy({ source: 'live', sessionDate: null }),
    dayChangeCopy({ source: 'snapshot', sessionDate: '2025-08-29', todayExchangeDate: '2025-08-29' }),
    dayChangeCopy({ source: 'snapshot', sessionDate: '2025-08-29', todayExchangeDate: '2025-08-30' }),
    dayChangeCopy({ source: 'snapshot', sessionDate: null }),
    dayChangeUnavailableCopy(),
  ];

  it('never prints "ไม่มีข้อมูล" in any state', () => {
    for (const copy of every) {
      expect(copy.label).not.toContain(BANNED);
      expect(copy.caption).not.toContain(BANNED);
    }
  });

  it('never falls back to English trading shorthand', () => {
    for (const copy of every) {
      for (const term of JARGON) {
        expect(`${copy.label} ${copy.caption}`).not.toContain(term);
      }
    }
  });

  it('always produces both a label and a caption — a blank is never a state', () => {
    for (const copy of every) {
      expect(copy.label.trim().length).toBeGreaterThan(0);
      expect(copy.caption.trim().length).toBeGreaterThan(0);
    }
  });
});
