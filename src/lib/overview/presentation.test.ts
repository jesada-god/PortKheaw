import { describe, expect, it } from 'vitest';
import { OVERVIEW_STATUS_COPY, overviewPriceStatus } from './presentation';

describe('Overview Thai status presentation', () => {
  it('never exposes raw cached or unavailable labels', () => {
    expect(OVERVIEW_STATUS_COPY.saved).toBe('ข้อมูลล่าสุดที่บันทึกไว้');
    expect(OVERVIEW_STATUS_COPY.unavailable).toBe('ข้อมูลยังไม่พร้อม');
    expect(Object.values(OVERVIEW_STATUS_COPY).join(' ')).not.toMatch(/\bcached\b|\bunavailable\b/i);
  });

  it('maps provider freshness without making stale data look live', () => {
    expect(overviewPriceStatus({ status: 'realtime', asOf: null, maxAgeSeconds: 15 }, false)).toBe('live');
    expect(overviewPriceStatus({ status: 'delayed', asOf: null, maxAgeSeconds: 900 }, false)).toBe('delayed');
    expect(overviewPriceStatus({ status: 'cached', asOf: null, maxAgeSeconds: 60 }, false)).toBe('saved');
    expect(overviewPriceStatus({ status: 'stale', asOf: null, maxAgeSeconds: 60 }, false)).toBe('saved');
    expect(overviewPriceStatus({ status: 'end-of-day', asOf: null, maxAgeSeconds: null }, true)).toBe('closed');
  });
});
