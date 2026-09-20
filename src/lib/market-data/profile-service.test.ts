import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { MarketDataError } from './errors';
import {
  CompanyProfileService,
  PROFILE_CACHE_POLICY,
  type CompanyProfileProvider,
} from './profile-service';
import type {
  CompanyProfileSnapshot,
  CompanyProfileSnapshotRepository,
} from './profile-snapshot-repository';
import type { CompanyProfile, ProviderResult } from './types';

vi.mock('server-only', () => ({}));

function profile(symbol: string): CompanyProfile {
  return {
    symbol,
    name: symbol === 'RKLB' ? 'Rocket Lab USA, Inc.' : `${symbol} Company`,
    description: 'Public company description.',
    exchange: 'NASDAQ',
    currency: 'USD',
    country: 'US',
    sector: 'Industrials',
    industry: 'Aerospace & Defense',
    website: null,
    logoUrl: `https://logos.example.test/${symbol}.png`,
    marketCapitalization: null,
    employees: null,
    fiscalYearEnd: null,
    latestQuarter: null,
  };
}

function result(symbol: string, provider: string): ProviderResult<CompanyProfile> {
  return {
    data: profile(symbol),
    provider,
    freshness: {
      status: 'cached',
      asOf: null,
      maxAgeSeconds: 86_400,
    },
  };
}

function provider(
  id: string,
  operation: CompanyProfileProvider['getCompanyProfile'],
): CompanyProfileProvider {
  return { id, getCompanyProfile: vi.fn(operation) };
}

describe('Company Profile fallback service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the secondary provider after a primary 429', async () => {
    const primary = provider('alpha-vantage', async () => {
      throw new MarketDataError('rate-limited', 'quota', 45);
    });
    const secondary = provider(
      'financial-modeling-prep',
      async (symbol) => result(symbol, 'financial-modeling-prep'),
    );
    const service = new CompanyProfileService(primary, secondary);

    const resolved = await service.getCompanyProfile('RKLB');

    expect(resolved).toMatchObject({
      providerUsed: 'financial-modeling-prep',
      fallbackUsed: true,
      profileStatus: 'fresh',
      retryAfterSeconds: 45,
      reasonCode: 'PRIMARY_RATE_LIMITED',
    });
    expect(primary.getCompanyProfile).toHaveBeenCalledTimes(1);
    expect(secondary.getCompanyProfile).toHaveBeenCalledTimes(1);
  });

  it('supplements a successful primary profile with the secondary logo', async () => {
    const primary = provider('alpha-vantage', async (symbol) => ({
      ...result(symbol, 'alpha-vantage'),
      data: { ...profile(symbol), logoUrl: null },
    }));
    const secondary = provider(
      'financial-modeling-prep',
      async (symbol) => result(symbol, 'financial-modeling-prep'),
    );
    const service = new CompanyProfileService(primary, secondary);

    const resolved = await service.getCompanyProfile('NVTS');

    expect(resolved).toMatchObject({
      providerUsed: 'alpha-vantage+financial-modeling-prep',
      fallbackUsed: true,
      reasonCode: 'PRIMARY_LOGO_MISSING',
      data: {
        name: 'NVTS Company',
        logoUrl: 'https://logos.example.test/NVTS.png',
      },
    });
    expect(primary.getCompanyProfile).toHaveBeenCalledTimes(1);
    expect(secondary.getCompanyProfile).toHaveBeenCalledTimes(1);
  });

  it('skips Alpha Vantage during Retry-After cooldown without a retry loop', async () => {
    const primary = provider('alpha-vantage', async () => {
      throw new MarketDataError('rate-limited', 'quota');
    });
    const secondary = provider(
      'financial-modeling-prep',
      async (symbol) => result(symbol, 'financial-modeling-prep'),
    );
    const service = new CompanyProfileService(primary, secondary);

    await service.getCompanyProfile('RKLB');
    vi.advanceTimersByTime(59_000);
    const second = await service.getCompanyProfile('AAPL');

    expect(second.reasonCode).toBe('PRIMARY_RATE_LIMITED');
    expect(second.retryAfterSeconds).toBe(1);
    expect(primary.getCompanyProfile).toHaveBeenCalledTimes(1);
    expect(secondary.getCompanyProfile).toHaveBeenCalledTimes(2);
  });

  it('serves fresh cache first and stale cache after both providers fail', async () => {
    const primary = provider(
      'alpha-vantage',
      vi.fn()
        .mockResolvedValueOnce(result('RKLB', 'alpha-vantage'))
        .mockRejectedValueOnce(new MarketDataError(
          'invalid-provider-response',
          'empty response',
        )),
    );
    const secondary = provider('financial-modeling-prep', async () => {
      throw new MarketDataError('upstream-unavailable', 'secondary down');
    });
    const service = new CompanyProfileService(
      primary,
      secondary,
      new SharedRequestCache(),
    );

    const first = await service.getCompanyProfile('RKLB');
    const cached = await service.getCompanyProfile('RKLB');
    expect(first.profileStatus).toBe('fresh');
    expect(cached.profileStatus).toBe('cached');
    expect(primary.getCompanyProfile).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PROFILE_CACHE_POLICY.freshMs + 1);
    const stale = await service.getCompanyProfile('RKLB');
    expect(stale.profileStatus).toBe('stale');
    expect(stale.data.name).toBe('Rocket Lab USA, Inc.');
    expect(stale.reasonCode).toBe(
      'PRIMARY_INVALID_PROVIDER_RESPONSE; SECONDARY_UPSTREAM_UNAVAILABLE',
    );
  });

  it('deduplicates concurrent profile loads', async () => {
    let complete!: (value: ProviderResult<CompanyProfile>) => void;
    const primary = provider(
      'alpha-vantage',
      () => new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const secondary = provider(
      'financial-modeling-prep',
      async (symbol) => result(symbol, 'financial-modeling-prep'),
    );
    const service = new CompanyProfileService(primary, secondary);

    const first = service.getCompanyProfile('RKLB');
    const second = service.getCompanyProfile('RKLB');
    expect(primary.getCompanyProfile).toHaveBeenCalledTimes(1);
    complete(result('RKLB', 'alpha-vantage'));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(secondary.getCompanyProfile).not.toHaveBeenCalled();
  });

  it('returns rate-limited only when both providers are rate-limited', async () => {
    const service = new CompanyProfileService(
      provider('alpha-vantage', async () => {
        throw new MarketDataError('rate-limited', 'primary quota', 45);
      }),
      provider('financial-modeling-prep', async () => {
        throw new MarketDataError('rate-limited', 'secondary quota', 20);
      }),
    );

    await expect(service.getCompanyProfile('RKLB')).rejects.toMatchObject({
      code: 'rate-limited',
      status: 429,
      retryAfterSeconds: 20,
    });
  });

  it('keeps unavailable failures at 503-compatible upstream semantics', async () => {
    const service = new CompanyProfileService(
      provider('alpha-vantage', async () => {
        throw new MarketDataError('timeout', 'primary timeout');
      }),
      provider('financial-modeling-prep', async () => {
        throw new MarketDataError('invalid-provider-response', 'empty');
      }),
    );

    await expect(service.getCompanyProfile('RKLB')).rejects.toMatchObject({
      code: 'upstream-unavailable',
    });
  });
});

/**
 * The shared snapshot, exercised through the seam the real repository
 * implements.
 *
 * A `Map` standing in for the table is the right double here precisely because
 * the property under test is not "does Postgres work" — it is "do two service
 * instances that share ONE store make one provider call between them". A
 * per-instance fake would pass while proving nothing, which is exactly the bug
 * being fixed: the old `SharedRequestCache` was a per-instance store.
 */
function sharedSnapshotStore() {
  const rows = new Map<string, CompanyProfileSnapshot>();
  return {
    rows,
    repository: {
      get: vi.fn(async (symbol: string) => rows.get(symbol) ?? null),
      upsert: vi.fn(async (snapshot: CompanyProfileSnapshot) => {
        rows.set(snapshot.symbol, snapshot);
      }),
    } satisfies CompanyProfileSnapshotRepository,
  };
}

describe('Company Profile database snapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls the provider once for two instances reading the same symbol', async () => {
    const store = sharedSnapshotStore();
    const primary = provider('alpha-vantage', async (symbol) => result(symbol, 'alpha-vantage'));
    const secondary = provider('financial-modeling-prep', async (symbol) => result(symbol, 'financial-modeling-prep'));

    // Two services with SEPARATE in-process caches: the shape of two serverless
    // instances, or of one instance either side of a redeploy.
    const instanceA = new CompanyProfileService(primary, secondary, new SharedRequestCache(), Date.now, store.repository);
    const instanceB = new CompanyProfileService(primary, secondary, new SharedRequestCache(), Date.now, store.repository);

    const fromA = await instanceA.getCompanyProfile('RKLB');
    const fromB = await instanceB.getCompanyProfile('RKLB');

    expect(primary.getCompanyProfile).toHaveBeenCalledTimes(1);
    expect(fromA.data.name).toBe('Rocket Lab USA, Inc.');
    expect(fromB.data.name).toBe('Rocket Lab USA, Inc.');
    // The second reader is told the truth about where it came from.
    expect(fromA.profileStatus).toBe('fresh');
    expect(fromB.profileStatus).toBe('cached');
  });

  it('survives a process restart without touching the provider', async () => {
    const store = sharedSnapshotStore();
    const primary = provider('alpha-vantage', async (symbol) => result(symbol, 'alpha-vantage'));
    const secondary = provider('financial-modeling-prep', async (symbol) => result(symbol, 'financial-modeling-prep'));

    const before = new CompanyProfileService(primary, secondary, new SharedRequestCache(), Date.now, store.repository);
    await before.getCompanyProfile('RKLB');
    expect(primary.getCompanyProfile).toHaveBeenCalledTimes(1);

    // Everything in memory is gone. Only the row survives — which is the entire
    // claim this table is here to make.
    const after = new CompanyProfileService(primary, secondary, new SharedRequestCache(), Date.now, store.repository);
    const restored = await after.getCompanyProfile('RKLB');

    expect(primary.getCompanyProfile).toHaveBeenCalledTimes(1);
    expect(restored.data.symbol).toBe('RKLB');
    expect(restored.cachedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('serves a stale row immediately and refreshes it behind the reader', async () => {
    const store = sharedSnapshotStore();
    const primary = provider('alpha-vantage', async (symbol) => result(symbol, 'alpha-vantage'));
    const secondary = provider('financial-modeling-prep', async (symbol) => result(symbol, 'financial-modeling-prep'));
    const service = new CompanyProfileService(primary, secondary, new SharedRequestCache(), Date.now, store.repository);

    await service.getCompanyProfile('RKLB');
    const storedAt = store.rows.get('RKLB')!.fetchedAt;

    // Past the fresh window, inside the stale one, and past the short memo so
    // the read reaches the snapshot rather than this instance's memory.
    vi.setSystemTime(new Date(Date.parse(storedAt) + PROFILE_CACHE_POLICY.freshMs + 60_000));
    const stale = await service.getCompanyProfile('RKLB');

    // The reader was not made to wait for the refresh.
    expect(stale.profileStatus).toBe('stale');
    expect(stale.reasonCode).toBe('SNAPSHOT_STALE_REFRESHING');

    await vi.waitFor(() => {
      expect(primary.getCompanyProfile).toHaveBeenCalledTimes(2);
    });
    expect(Date.parse(store.rows.get('RKLB')!.fetchedAt)).toBeGreaterThan(Date.parse(storedAt));
  });

  it('falls back to the provider chain when the snapshot store is unreachable', async () => {
    const store = sharedSnapshotStore();
    store.repository.get.mockRejectedValue(new Error('Company profile snapshot read failed: 42P01'));
    store.repository.upsert.mockRejectedValue(new Error('Company profile snapshot write failed: 42501'));
    const primary = provider('alpha-vantage', async (symbol) => result(symbol, 'alpha-vantage'));
    const secondary = provider('financial-modeling-prep', async (symbol) => result(symbol, 'financial-modeling-prep'));
    const service = new CompanyProfileService(primary, secondary, new SharedRequestCache(), Date.now, store.repository);

    // A missing table or a revoked grant must not be able to take the card down.
    const served = await service.getCompanyProfile('RKLB');
    expect(served.data.symbol).toBe('RKLB');
    expect(primary.getCompanyProfile).toHaveBeenCalledTimes(1);
  });
});
