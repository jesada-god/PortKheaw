import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { optionsChainSchema } from '@/src/lib/market-data/options/contracts';

const mocks = vi.hoisted(() => ({
  guardRouteEntitlement: vi.fn(),
  checkMarketDataRateLimit: vi.fn(),
  getChain: vi.fn(),
  computeOptionsSupportResistance: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/subscription/server-entitlement', () => ({ guardRouteEntitlement: mocks.guardRouteEntitlement }));
vi.mock('@/src/lib/market-data/api-rate-limit', () => ({ checkMarketDataRateLimit: mocks.checkMarketDataRateLimit }));
vi.mock('@/src/lib/market-data/options', () => ({ getOptionsMarketDataService: () => ({ getChain: mocks.getChain }) }));
vi.mock('@/src/lib/analytics/options-sr', () => ({ computeOptionsSupportResistance: mocks.computeOptionsSupportResistance }));
vi.mock('@/src/lib/market-data/route', () => ({
  observedMarketDataResponse: async (_request: unknown, _context: unknown, load: () => Promise<unknown>) => NextResponse.json(await load()),
}));
vi.mock('@/src/lib/market-data/options/route-diagnostics', () => ({ withOptionsRouteDiagnostics: (response: NextResponse) => response }));

import { GET } from './route';

const chain = optionsChainSchema.parse({
  underlyingSymbol: 'RKLB', spot: 50, expiration: '2026-08-21', expirations: ['2026-08-21'], calls: [], puts: [],
  provider: 'test-provider', asOf: '2026-07-20T14:00:00.000Z', timestampKind: 'provider', status: 'live',
  delayedMinutes: 0, completeness: 1, warnings: [],
});

const request = () => new NextRequest('https://portkheaw.vercel.app/api/market/options/walls?symbol=RKLB&expiration=2026-08-21');

describe('GET /api/market/options/walls entitlement', () => {
  beforeEach(() => {
    mocks.guardRouteEntitlement.mockReset();
    mocks.checkMarketDataRateLimit.mockReset().mockReturnValue({ allowed: true });
    mocks.getChain.mockReset().mockResolvedValue({ data: chain });
    mocks.computeOptionsSupportResistance.mockReset().mockReturnValue({ callWall: { strike: 55 }, putWall: { strike: 45 }, maxPain: { strike: 50 } });
  });

  it('denies Basic and Pro before provider access or wall computation', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: NextResponse.json({ data: null }, { status: 403 }), entitlement: null });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.guardRouteEntitlement).toHaveBeenCalledWith('options.analytics.walls');
    expect(mocks.checkMarketDataRateLimit).not.toHaveBeenCalled();
    expect(mocks.getChain).not.toHaveBeenCalled();
    expect(mocks.computeOptionsSupportResistance).not.toHaveBeenCalled();
  });

  it('computes walls for Elite and marks the response private', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'elite' } });

    const response = await GET(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getChain).toHaveBeenCalledOnce();
    expect(mocks.computeOptionsSupportResistance).toHaveBeenCalledOnce();
    expect(payload.data.callWall.strike).toBe(55);
    expect(response.headers.get('X-Entitlement-Tier')).toBe('elite');
  });
});
