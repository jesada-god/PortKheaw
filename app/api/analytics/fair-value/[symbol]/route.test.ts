import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkAnalyticsRateLimit: vi.fn(),
  loadFairValue: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/analytics/rate-limit', () => ({
  checkAnalyticsRateLimit: mocks.checkAnalyticsRateLimit,
}));
vi.mock('@/src/lib/analytics/valuation/orchestration', () => ({
  loadFairValue: mocks.loadFairValue,
}));

import { GET } from './route';
import { createDcfOnlyFairValueResult } from '@/src/test/fixtures/fair-value';

const unavailable = {
  status: 'unavailable' as const,
  failureKind: 'missing-field' as const,
  symbol: 'AAPL',
  currency: 'USD',
  provider: 'alpha-vantage',
  reason: 'Data Sufficiency Gate rejected the inputs',
  missingFields: ['historicalFinancials>=3Periods'],
  missingInputs: ['historicalFinancials>=3Periods'],
  staleInputs: [],
  asOf: '2026-07-20T00:00:00.000Z',
  calculatedAt: '2026-07-20T00:00:00.000Z',
  methodologyVersion: 'nexora-fv-v2' as const,
  limitations: [],
  diagnostics: [],
};

function request() {
  return GET(
    new Request('https://example.test/api/analytics/fair-value/AAPL'),
    { params: Promise.resolve({ symbol: 'AAPL' }) },
  );
}

describe('GET /api/analytics/fair-value/[symbol]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkAnalyticsRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.loadFairValue.mockResolvedValue(unavailable);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('allows an anonymous request and returns a typed unavailable result with missingFields', async () => {
    vi.stubEnv('FEATURE_FAIR_VALUE', 'true');

    const response = await request();

    expect(response.status).not.toBe(401);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: unavailable });
    expect(mocks.loadFairValue).toHaveBeenCalledWith('AAPL');
    expect(mocks.checkAnalyticsRateLimit).toHaveBeenCalledWith('fair-value:anonymous', 10);
  });

  it('serializes standalone DCF as overall available when Base is unavailable', async () => {
    vi.stubEnv('FEATURE_FAIR_VALUE', 'true');
    const dcfOnly = createDcfOnlyFairValueResult();
    mocks.loadFairValue.mockResolvedValue(dcfOnly);

    const response = await request();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      status: 'available',
      baseStatus: 'unavailable',
      fairValue: {
        type: 'dcf',
        label: 'DCF Fair Value',
        value: dcfOnly.fairValue.value,
      },
      modelResults: [
        expect.objectContaining({
          model: 'fcff-dcf',
          fairValue: dcfOnly.fairValue.value,
        }),
      ],
    });
  });

  it('returns a structured rate-limited unavailable response', async () => {
    vi.stubEnv('FEATURE_FAIR_VALUE', 'true');
    mocks.checkAnalyticsRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await request();
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(body.data).toMatchObject({
      status: 'unavailable',
      failureKind: 'provider-rate-limited',
      symbol: 'AAPL',
      provider: null,
      missingFields: [],
      reason: expect.any(String),
      asOf: expect.any(String),
      methodologyVersion: 'nexora-fv-v2',
    });
    expect(mocks.loadFairValue).not.toHaveBeenCalled();
  });

  it('stops before rate-limit/provider work when explicitly disabled', async () => {
    vi.stubEnv('FEATURE_FAIR_VALUE', 'false');
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const response = await request();
    const entry = JSON.parse(String(log.mock.calls[0]?.[0]));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'feature-disabled',
        message: 'Fair Value feature is disabled by FEATURE_FAIR_VALUE=false',
      },
    });
    expect(mocks.checkAnalyticsRateLimit).not.toHaveBeenCalled();
    expect(mocks.loadFairValue).not.toHaveBeenCalled();
    expect(entry).toEqual({
      event: 'fair_value_evaluation',
      status: 'disabled',
      failureKind: 'feature-disabled',
    });
  });
});
