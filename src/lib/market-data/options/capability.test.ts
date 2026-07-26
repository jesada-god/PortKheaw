import { describe, expect, it } from 'vitest';
import { MarketDataError } from '../errors';
import {
  ENTITLEMENT_TTL_MS,
  ENTITLED_TTL_MS,
  OptionsCapabilityCache,
  isEntitlementFailure,
} from './capability';

function clock(start = 1_000_000) {
  const state = { now: start };
  return { state, read: () => state.now, advance: (ms: number) => { state.now += ms; } };
}

describe('options capability cache', () => {
  it('separates permanent entitlement refusals from temporary throttles', () => {
    expect(isEntitlementFailure(new MarketDataError('forbidden', 'x'))).toBe(true);
    expect(isEntitlementFailure(new MarketDataError('provider-unauthorized', 'x'))).toBe(true);
    expect(isEntitlementFailure(new MarketDataError('provider-not-configured', 'x'))).toBe(true);
    expect(isEntitlementFailure(new MarketDataError('unsupported', 'x'))).toBe(true);
    expect(isEntitlementFailure(new MarketDataError('rate-limited', 'x'))).toBe(false);
    expect(isEntitlementFailure(new MarketDataError('provider-unavailable', 'x'))).toBe(false);
  });

  it('blocks a refused provider for the full negative-entitlement window', () => {
    const time = clock();
    const cache = new OptionsCapabilityCache(time.read);
    cache.markEntitlementUnavailable('alpha-vantage', 'premium endpoint');

    expect(cache.isBlocked('alpha-vantage')).toBe(true);
    expect(cache.status('alpha-vantage')).toBe('entitlement-unavailable');

    time.advance(ENTITLEMENT_TTL_MS - 1);
    expect(cache.isBlocked('alpha-vantage')).toBe(true);

    time.advance(2);
    expect(cache.isBlocked('alpha-vantage')).toBe(false);
    expect(cache.status('alpha-vantage')).toBe('unknown');
  });

  it('honours a provider Retry-After for a throttle and then clears itself', () => {
    const time = clock();
    const cache = new OptionsCapabilityCache(time.read);
    cache.markCoolingDown('alpaca', 45, 'throttled');

    expect(cache.isBlocked('alpaca')).toBe(true);
    expect(cache.report('alpaca')).toMatchObject({ status: 'cooling-down', retryAfterSeconds: 45 });

    time.advance(45_000);
    expect(cache.isBlocked('alpaca')).toBe(false);
  });

  it('never blocks an entitled provider and re-verifies it after its window', () => {
    const time = clock();
    const cache = new OptionsCapabilityCache(time.read);
    cache.markEntitled('alpaca');

    expect(cache.isBlocked('alpaca')).toBe(false);
    expect(cache.report('alpaca')).toMatchObject({ status: 'entitled', retryAfterSeconds: null });

    time.advance(ENTITLED_TTL_MS + 1);
    expect(cache.status('alpaca')).toBe('unknown');
  });

  it('lets a manual retry clear a throttle but never an entitlement refusal', () => {
    const time = clock();
    const cache = new OptionsCapabilityCache(time.read);
    cache.markCoolingDown('alpaca', 60, 'throttled');
    cache.markEntitlementUnavailable('alpha-vantage', 'premium endpoint');

    cache.resetRetryable();

    expect(cache.isBlocked('alpaca')).toBe(false);
    // The Retry button must not be able to re-arm a provider that is known refused.
    expect(cache.isEntitlementUnavailable('alpha-vantage')).toBe(true);
    expect(cache.isBlocked('alpha-vantage')).toBe(true);
  });

  it('reports a secret-free capability row for diagnostics', () => {
    const cache = new OptionsCapabilityCache(clock().read);
    cache.markEntitlementUnavailable('alpha-vantage', 'plan does not authorize this operation');
    const report = cache.report('alpha-vantage');
    expect(report.provider).toBe('alpha-vantage');
    expect(JSON.stringify(report)).not.toMatch(/apikey|api_key|secret/i);
  });
});
