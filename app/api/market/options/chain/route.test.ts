import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { optionsChainSchema, type OptionContract } from '@/src/lib/market-data/options/contracts';

const mocks = vi.hoisted(() => ({
  guardRouteEntitlement: vi.fn(),
  checkMarketDataRateLimit: vi.fn(),
  getChain: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/subscription/server-entitlement', () => ({ guardRouteEntitlement: mocks.guardRouteEntitlement }));
vi.mock('@/src/lib/market-data/api-rate-limit', () => ({ checkMarketDataRateLimit: mocks.checkMarketDataRateLimit }));
vi.mock('@/src/lib/market-data/options', () => ({ getOptionsMarketDataService: () => ({ getChain: mocks.getChain }) }));
vi.mock('@/src/lib/market-data/route', () => ({
  observedMarketDataResponse: async (_request: unknown, _context: unknown, load: () => Promise<unknown>) => NextResponse.json(await load()),
}));
vi.mock('@/src/lib/market-data/options/route-diagnostics', () => ({ withOptionsRouteDiagnostics: (response: NextResponse) => response }));

import { GET } from './route';

const contract = (overrides: Partial<OptionContract> = {}): OptionContract => ({
  contractSymbol: 'RKLB260821C00050000', underlyingSymbol: 'RKLB', type: 'call', expiration: '2026-08-21',
  strike: 50, bid: 2, ask: 2.2, last: 2.1, mark: 2.1, volume: 100, openInterest: 500,
  impliedVolatility: 0.4, delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.1, rho: 0.01,
  inTheMoney: false, multiplier: 100, currency: 'USD', provider: 'test-provider', marketDataProvider: null,
  marketDataFeed: null, oiAsOf: null, delayedMinutes: null, valuationSource: 'provider',
  asOf: '2026-07-20T14:00:00.000Z', timestampKind: 'provider', status: 'live', ...overrides,
});

const chain = optionsChainSchema.parse({
  underlyingSymbol: 'RKLB', spot: 50, expiration: '2026-08-21', expirations: ['2026-08-21'],
  calls: [contract()], puts: [contract({ contractSymbol: 'RKLB260821P00050000', type: 'put', delta: -0.5 })],
  provider: 'test-provider', asOf: '2026-07-20T14:00:00.000Z', timestampKind: 'provider', status: 'live',
  delayedMinutes: 0, completeness: 1, warnings: [],
});

const request = () => new NextRequest('https://portkheaw.vercel.app/api/market/options/chain?symbol=RKLB&expiration=2026-08-21');

describe('GET /api/market/options/chain entitlement', () => {
  beforeEach(() => {
    mocks.guardRouteEntitlement.mockReset();
    mocks.checkMarketDataRateLimit.mockReset().mockReturnValue({ allowed: true });
    mocks.getChain.mockReset().mockResolvedValue({ data: chain });
  });

  it('denies Basic before rate limiting or provider access', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: NextResponse.json({ data: null }, { status: 403 }), entitlement: null });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.guardRouteEntitlement).toHaveBeenCalledWith('options.chain.basic');
    expect(mocks.checkMarketDataRateLimit).not.toHaveBeenCalled();
    expect(mocks.getChain).not.toHaveBeenCalled();
  });

  it('serves Pro ledger fields without serializing IV, Greeks or valuation provenance', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'pro' } });

    const response = await GET(request());
    const payload = await response.json();

    expect(payload.data.calls[0]).toMatchObject({ strike: 50, openInterest: 500 });
    for (const field of ['impliedVolatility', 'delta', 'gamma', 'theta', 'vega', 'rho', 'valuationSource']) {
      expect(Object.hasOwn(payload.data.calls[0], field)).toBe(false);
    }
    expect(response.headers.get('X-Entitlement-Tier')).toBe('pro');
  });

  it('serves Elite the full provider contract', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'elite' } });

    const response = await GET(request());
    const payload = await response.json();

    expect(payload.data.calls[0]).toMatchObject({ impliedVolatility: 0.4, delta: 0.5, valuationSource: 'provider' });
    expect(response.headers.get('X-Entitlement-Tier')).toBe('elite');
  });
});
