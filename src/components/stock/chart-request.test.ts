import { describe, expect, it } from 'vitest';
import { chartRequestKey, planChartRequest, shouldApplyResponse } from './chart-request';

describe('chartRequestKey', () => {
  const base = { symbol: 'aapl', interval: '5m', range: '1m', adjusted: false, session: 'extended' };

  it('changes when the timeframe changes', () => {
    expect(chartRequestKey(base)).not.toBe(chartRequestKey({ ...base, interval: '10m' }));
  });

  it('changes when the opened symbol changes and canonicalizes symbol casing', () => {
    expect(chartRequestKey(base)).toBe('AAPL:5m:1m:false:extended');
    expect(chartRequestKey(base)).not.toBe(chartRequestKey({ ...base, symbol: 'MSFT' }));
  });
});

describe('planChartRequest', () => {
  const base = { force: false, hasCache: false, hasInflight: false, now: 1_000, cooldownUntil: 0 };

  it('fetches once on an initial load with no cache, no in-flight, no cooldown', () => {
    expect(planChartRequest(base)).toBe('fetch');
  });

  it('serves the cache for an unforced load when the key is already resolved', () => {
    expect(planChartRequest({ ...base, hasCache: true })).toBe('serve-cache');
  });

  it('collapses concurrent identical loads onto the single in-flight request', () => {
    // Second identical load while the first is still pending -> one network fetch.
    expect(planChartRequest({ ...base, hasInflight: true })).toBe('join-inflight');
  });

  it('joins the in-flight request even when forced, so Refresh on top of a load makes no extra request', () => {
    expect(planChartRequest({ ...base, force: true, hasCache: true, hasInflight: true })).toBe('join-inflight');
  });

  it('makes exactly one new request when Refresh runs with nothing in flight', () => {
    // Forced refresh bypasses the cache but, with no in-flight request, issues one fetch.
    expect(planChartRequest({ ...base, force: true, hasCache: true, hasInflight: false })).toBe('fetch');
  });

  it('waits out an active cooldown instead of hitting the provider', () => {
    expect(planChartRequest({ ...base, force: true, now: 1_000, cooldownUntil: 5_000 })).toBe('wait-cooldown');
  });

  it('leaves cooldown once it has elapsed', () => {
    expect(planChartRequest({ ...base, force: true, now: 6_000, cooldownUntil: 5_000 })).toBe('fetch');
  });
});

describe('shouldApplyResponse', () => {
  it('applies a response from the current, un-aborted generation', () => {
    expect(shouldApplyResponse(3, 3, false)).toBe(true);
  });

  it('ignores a stale response after the interval/range changed and bumped the generation', () => {
    expect(shouldApplyResponse(4, 3, false)).toBe(false);
  });

  it('ignores an aborted response even within the same generation', () => {
    expect(shouldApplyResponse(3, 3, true)).toBe(false);
  });
});
