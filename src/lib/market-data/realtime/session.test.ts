import { describe, expect, it } from 'vitest';
import { classifyUsEquityTimestamp } from './session';

describe('US equity session classification', () => {
  it('uses America/New_York DST rules at the spring transition', () => {
    expect(classifyUsEquityTimestamp(Date.UTC(2026, 2, 9, 13, 29, 59))).toBe('pre-market');
    expect(classifyUsEquityTimestamp(Date.UTC(2026, 2, 9, 13, 30))).toBe('regular');
  });

  it('uses the post-fall-back UTC offset', () => {
    expect(classifyUsEquityTimestamp(Date.UTC(2026, 10, 2, 14, 30))).toBe('regular');
    expect(classifyUsEquityTimestamp(Date.UTC(2026, 10, 2, 21, 0))).toBe('after-hours');
  });

  it('classifies extended hours and weekends explicitly', () => {
    expect(classifyUsEquityTimestamp(Date.UTC(2026, 6, 24, 8, 0))).toBe('pre-market');
    expect(classifyUsEquityTimestamp(Date.UTC(2026, 6, 24, 20, 0))).toBe('after-hours');
    expect(classifyUsEquityTimestamp(Date.UTC(2026, 6, 25, 15, 0))).toBe('closed');
  });
});
