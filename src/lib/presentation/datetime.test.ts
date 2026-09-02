import { describe, expect, it } from 'vitest';
import {
  BANGKOK_TIME_ZONE,
  THAI_LOCALE,
  formatBangkokDateTime,
  formatBangkokTimeOnly,
  formatMarketDataAsOf,
  formatThaiDateOnly,
} from './datetime';

describe('shared Stock Detail date/time presentation', () => {
  it('pins Thai locale and Bangkok time zone independently of the host', () => {
    expect(THAI_LOCALE).toBe('th-TH');
    expect(BANGKOK_TIME_ZONE).toBe('Asia/Bangkok');
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const server = formatBangkokDateTime('2026-07-20T04:00:00.000Z');
      process.env.TZ = 'America/New_York';
      const client = formatBangkokDateTime('2026-07-20T04:00:00.000Z');
      expect(client).toBe(server);
      expect(client).toContain('11:00');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('renders a live intraday timestamp with HH:mm:ss when seconds are requested', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      expect(formatBangkokDateTime('2026-07-20T04:00:05.000Z')).toContain('11:00');
      expect(formatBangkokDateTime('2026-07-20T04:00:05.000Z')).not.toContain('11:00:05');
      const withSeconds = formatBangkokDateTime('2026-07-20T04:00:05.000Z', { withSeconds: true });
      expect(withSeconds).toContain('11:00:05');
      expect(formatMarketDataAsOf('2026-07-20T04:00:05.000Z', { withSeconds: true })).toContain('11:00:05');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('ignores seconds for a date-only provider value even when requested', () => {
    const label = formatMarketDataAsOf('2026-07-17', { withSeconds: true });
    expect(label).toBe('ข้อมูล ณ 17 ก.ค. 2569');
    expect(label).not.toContain(':');
  });

  it('renders date-only provider values as a date without a fabricated midnight', () => {
    expect(formatThaiDateOnly('2026-07-17')).toBe('17 ก.ค. 2569');
    const label = formatMarketDataAsOf('2026-07-17T00:00:00.000Z', {
      dateOnly: true,
    });
    expect(label).toBe('ข้อมูล ณ 17 ก.ค. 2569');
    expect(label).not.toContain('00:00');
  });
});

describe('the Bangkok wall clock, alone', () => {
  /*
    Every other formatter in this module carries a `dateStyle`, which is how
    "Bangkok wall clock" came to mean "3 ก.ย. 2569 19:30" in the one caller that
    wanted a time — `ovEventTimeLabel` — and how the Events row printed its day
    twice. The assertion is that there is NO DATE in the string, stated as the
    absence of each part a Thai medium date is made of, because asserting the
    exact time would only pin the formatter against itself.
  */
  it('prints the minute and no part of the date', () => {
    const label = formatBangkokTimeOnly('2026-09-03T12:30:00.000Z');
    expect(label).toContain(':');
    expect(label).not.toContain('2569');
    expect(label).not.toContain('ก.ย.');
    expect(label).not.toContain('3 ');
  });

  it('resolves the instant in Bangkok, not in the runner timezone', () => {
    // 12:30 UTC is 19:30 ICT the same day.
    expect(formatBangkokTimeOnly('2026-09-03T12:30:00.000Z')).toBe('19:30');
    // And an instant that crosses midnight westward keeps the Bangkok clock.
    expect(formatBangkokTimeOnly('2026-09-03T18:00:00.000Z')).toBe('01:00');
  });

  it('never prints seconds, because a published release time is a minute', () => {
    expect(formatBangkokTimeOnly('2026-09-03T12:30:45.000Z')).toBe('19:30');
  });

  it('answers an em dash for nothing and for an unparseable value', () => {
    expect(formatBangkokTimeOnly(null)).toBe('—');
    expect(formatBangkokTimeOnly(undefined)).toBe('—');
    expect(formatBangkokTimeOnly('')).toBe('—');
    expect(formatBangkokTimeOnly('not a date')).toBe('—');
  });
});
