import { describe, expect, it } from 'vitest';
import { MarketDataError, mapProviderFailure } from './errors';

describe('market data provider error mapping', () => {
  it('maps HTTP 429 and preserves retry timing', () => {
    const error = mapProviderFailure({ status: 429, retryAfterSeconds: 30 });
    expect(error.code).toBe('rate-limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.retryable).toBe(true);
  });

  it('marks a missing-provider configuration fault as non-retryable', () => {
    const error = new MarketDataError('provider-not-configured', 'Set POLYGON_API_KEY');
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(false);
    expect(error.toApiError().retryable).toBe(false);
  });

  it('maps Alpha Vantage frequency payloads to rate limiting', () => {
    const error = mapProviderFailure({
      payload: { Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is limited.' },
    });
    expect(error.code).toBe('rate-limited');
  });

  it('maps Alpha Vantage Information quota responses to 429 even when they mention an API key', () => {
    const error = mapProviderFailure({ payload: { Information: 'Thank you for using Alpha Vantage! You have reached the 25 requests per day limit for your API key.' } });
    expect(error.code).toBe('rate-limited');
    expect(error.status).toBe(429);
  });

  it('keeps an invalid key distinct from quota exhaustion', () => {
    const error = mapProviderFailure({ payload: { Information: 'The API key is invalid. Please visit Alpha Vantage.' } });
    expect(error.code).toBe('provider-unauthorized');
    expect(error.status).toBe(502);
  });

  it('maps plan entitlements to forbidden before generic 403 handling', () => {
    const error = mapProviderFailure({ status: 403, payload: { message: 'Upgrade your current plan or subscription.' } });
    expect(error.code).toBe('forbidden');
    expect(error.status).toBe(403);
  });

  it('never exposes an unrecognized raw provider message', () => {
    const error = mapProviderFailure({ payload: { message: 'internal vendor detail with request token' } });
    expect(error.code).toBe('invalid-provider-response');
    expect(error.message).not.toContain('request token');
  });

  it('maps invalid symbols separately', () => {
    const error = mapProviderFailure({ payload: { 'Error Message': 'Invalid API call. Please retry or visit the documentation.' } });
    expect(error.code).toBe('invalid-symbol'); expect(error.status).toBe(404);
  });

  it('maps aborted requests to timeouts', () => {
    const cause = new Error('timed out');
    cause.name = 'TimeoutError';
    expect(mapProviderFailure({ cause }).code).toBe('timeout');
  });

  it('maps authentication and upstream failures', () => {
    expect(mapProviderFailure({ status: 401 }).code).toBe('provider-unauthorized');
    expect(mapProviderFailure({ status: 503 }).code).toBe('upstream-unavailable');
  });

  it('classifies a bare 403 as a non-retryable entitlement (forbidden), distinct from a 401 auth failure', () => {
    const entitlement = mapProviderFailure({ status: 403 });
    expect(entitlement.code).toBe('forbidden');
    expect(entitlement.status).toBe(403);
    expect(entitlement.retryable).toBe(false);

    const auth = mapProviderFailure({ status: 401 });
    expect(auth.code).toBe('provider-unauthorized');
    expect(auth.retryable).toBe(false);
  });

  it('maps a Polygon NOT_AUTHORIZED entitlement payload to forbidden', () => {
    const error = mapProviderFailure({
      status: 403,
      payload: { status: 'NOT_AUTHORIZED', message: 'You are not entitled to this data. Please upgrade your plan.' },
    });
    expect(error.code).toBe('forbidden');
    expect(error.retryable).toBe(false);
  });
});

/**
 * These payloads are the verbatim upstream responses captured while diagnosing the
 * production Options 429 loop. The defect they lock down: an entitlement refusal
 * that advertises paid tiers ("600 requests per minute") matched the quota regex
 * first, so a permanent block was retried forever as a temporary rate limit.
 */
describe('provider entitlement vs quota classification (captured upstream payloads)', () => {
  const ALPHA_VANTAGE_PREMIUM_REFUSAL = 'This is a premium endpoint. ***THE SAMPLE DATA SCHEMA BELOW IS ARTIFICIAL AND FOR ILLUSTRATION PURPOSES ONLY***. To access the actual data, please subscribe to either the 600 requests per minute or the 1200 requests per minute premium plan at https://www.alphavantage.co/premium/ if you would like to access realtime US options data for personal non-professional use. For professional/commercial use, please contact support at support@alphavantage.co.';
  const ALPHA_VANTAGE_QUOTA_NOTICE = 'Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day), raise the per-second burst limit, and instantly unlock all premium endpoints';

  it('classifies the Alpha Vantage REALTIME_OPTIONS refusal as a permanent entitlement, despite its "requests per minute" upsell', () => {
    // Note: the provider answers HTTP 200 here — the refusal is body-only.
    const error = mapProviderFailure({ status: 200, payload: { message: ALPHA_VANTAGE_PREMIUM_REFUSAL } });
    expect(error.code).toBe('forbidden');
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(403);
  });

  it('still classifies the free-tier quota notice as a retryable rate limit', () => {
    const error = mapProviderFailure({ payload: { Information: ALPHA_VANTAGE_QUOTA_NOTICE } });
    expect(error.code).toBe('rate-limited');
    expect(error.retryable).toBe(true);
  });

  it('never leaks the provider message into the surfaced error text', () => {
    for (const message of [ALPHA_VANTAGE_PREMIUM_REFUSAL, ALPHA_VANTAGE_QUOTA_NOTICE]) {
      expect(mapProviderFailure({ payload: { message } }).message).not.toContain('alphavantage.co');
    }
  });

  it.each([
    ['Finnhub option-chain', 403, { error: "You don't have access to this resource." }],
    ['FMP retired options endpoint', 403, { 'Error Message': 'Legacy Endpoint : Due to Legacy endpoints being no longer supported - This endpoint is only available for legacy users who have valid subscriptions prior August 31, 2025.' }],
    ['Alpaca OPRA feed', 403, { message: 'OPRA agreement is not signed' }],
    ['Polygon options snapshot', 403, { message: 'You are not entitled to this data. Please upgrade your plan at https://massive.com/pricing' }],
  ])('classifies the %s refusal as a non-retryable entitlement', (_label, status, payload) => {
    const error = mapProviderFailure({ status, payload });
    expect(error.code).toBe('forbidden');
    expect(error.retryable).toBe(false);
  });

  it('keeps a genuine 429 with Retry-After retryable', () => {
    const error = mapProviderFailure({ status: 429, retryAfterSeconds: 30 });
    expect(error.code).toBe('rate-limited');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(30);
  });
});
