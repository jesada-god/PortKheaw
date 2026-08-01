import { describe, expect, it } from 'vitest';
import type { OverviewPrice } from '@/src/lib/overview/types';
import { targetObservation } from './observation';

const base = {
  symbol: 'AAPL',
  price: 200,
  change: 2,
  changePercent: 1,
  session: 'REGULAR',
  status: 'live',
  asOf: '2026-08-02T14:00:00.000Z',
  source: 'canonical-test',
  freshness: {
    status: 'realtime',
    asOf: '2026-08-02T14:00:00.000Z',
    maxAgeSeconds: 60,
  },
} as unknown as OverviewPrice;

describe('canonical target observations', () => {
  it('retains the accepted price, session, source and timestamp', () => {
    expect(targetObservation(base)).toEqual({
      price: 200,
      changePercent: 1,
      observedAt: '2026-08-02T14:00:00.000Z',
      session: 'regular',
      source: 'canonical-test',
    });
  });

  it('rejects stale and unavailable prices', () => {
    expect(targetObservation({
      ...base,
      freshness: { ...base.freshness!, status: 'stale' },
    })).toBeNull();
    expect(targetObservation({ ...base, status: 'unavailable' })).toBeNull();
  });

  it('keeps regular and extended sessions separate and rejects closed prices', () => {
    expect(targetObservation({ ...base, session: 'PRE' })?.session).toBe('pre-market');
    expect(targetObservation({ ...base, session: 'POST' })?.session).toBe('after-hours');
    expect(targetObservation({ ...base, session: 'CLOSED' })).toBeNull();
  });
});
