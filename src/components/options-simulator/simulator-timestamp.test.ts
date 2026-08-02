import { afterEach, describe, expect, it } from 'vitest';
import { formatTimestamp } from './simulator-ux';

const original = process.env.TZ;
afterEach(() => { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; });

describe('simulator timestamps', () => {
  it('reads the same in every host locale rather than following the runtime default', () => {
    // A bare toLocaleString() printed "8/2/2026, 2:58:54 AM" on a US-defaulted
    // runtime and a Buddhist-era year in a th-TH one, for the very same instant.
    process.env.TZ = 'Asia/Bangkok';
    expect(formatTimestamp('2026-08-01T19:58:54.000Z')).toBe('2 ส.ค. 2026 02:58');
  });

  it('renders the instant in the reader\'s own zone', () => {
    process.env.TZ = 'America/New_York';
    expect(formatTimestamp('2026-08-01T19:58:54.000Z')).toBe('1 ส.ค. 2026 15:58');
  });

  it('never prints an invalid date or a raw null', () => {
    expect(formatTimestamp(null)).toBe('ไม่มีข้อมูล');
    expect(formatTimestamp(undefined)).toBe('ไม่มีข้อมูล');
    expect(formatTimestamp('')).toBe('ไม่มีข้อมูล');
    expect(formatTimestamp('not-a-date')).toBe('ไม่มีข้อมูล');
    expect(formatTimestamp(null, 'ไม่มีเวลาข้อมูล')).toBe('ไม่มีเวลาข้อมูล');
  });
});
