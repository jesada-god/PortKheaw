import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimulationWorkspace } from '@/src/lib/options-simulator/types';

const mocks = vi.hoisted(() => ({
  guardRouteEntitlement: vi.fn(),
  createClient: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/subscription/server-entitlement', () => ({
  guardRouteEntitlement: mocks.guardRouteEntitlement,
  entitlementDenialResponse: (denial: { status: number; code: string; capability: string }) => NextResponse.json({ data: null, error: denial }, { status: denial.status }),
}));
vi.mock('@/src/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/src/lib/options-simulator/repository', () => ({
  OptionSimulationsRepository: class {
    list = mocks.list;
    create = mocks.create;
  },
}));

import { GET, POST } from './route';

const workspace: SimulationWorkspace = {
  name: 'Test', description: '', symbol: 'TEST', companyName: 'Test Inc', exchange: 'NASDAQ', currency: 'USD',
  simulationType: 'what-if', strategyType: 'Long Call', underlyingPrice: 100, stockQuantity: 0, cashPosition: 0,
  entryDate: '2026-01-01', valuationDate: '2026-01-01',
  legs: [{ id: 'leg-1', kind: 'call', side: 'buy', quantity: 1, strike: 100, expiration: '2027-01-01', entryPremium: 10, impliedVolatility: 0.2, multiplier: 100, fees: 0, style: 'european' }],
  scenarios: [{ id: 'base', name: 'Base', targetPrice: 110, valuationDate: '2026-06-01', volatilityShift: 0, rate: 0.05, dividendYield: 0 }],
  monteCarlo: { paths: 1_000, seed: 42, horizonDays: 30, steps: 30, drift: 0.05, volatility: 0.2, rate: 0.05, dividendYield: 0 },
  dataSource: null, dataTimestamp: null, dataStatus: 'manual', resultSnapshot: null, methodologyVersion: 'options-simulator-v1',
};

describe('/api/option-simulations entitlement', () => {
  beforeEach(() => {
    mocks.guardRouteEntitlement.mockReset();
    mocks.createClient.mockReset();
    mocks.list.mockReset();
    mocks.create.mockReset();
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) } });
  });

  it('denies Basic list access before constructing a repository', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: NextResponse.json({ data: null }, { status: 403 }), entitlement: null });

    const response = await GET(new NextRequest('https://portkheaw.vercel.app/api/option-simulations'));

    expect(response.status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('strips an Elite Monte Carlo snapshot from a Pro list response', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'pro' } });
    mocks.list.mockResolvedValue({
      items: [{ ...workspace, id: 'saved-1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1, resultSnapshot: { whatIf: { theoreticalValue: 123 }, monteCarlo: { pathSetId: 'ELITE_SNAPSHOT_SECRET' } } }],
      total: 1,
    });

    const response = await GET(new NextRequest('https://portkheaw.vercel.app/api/option-simulations'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.items[0].resultSnapshot).toEqual({ whatIf: { theoreticalValue: 123 } });
    expect(JSON.stringify(payload)).not.toContain('ELITE_SNAPSHOT_SECRET');
    expect(response.headers.get('X-Entitlement-Tier')).toBe('pro');
  });

  it('denies a Pro Monte Carlo save before constructing a repository', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'pro' } });

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations', {
      method: 'POST', body: JSON.stringify({ ...workspace, simulationType: 'monte-carlo' }),
    }));

    expect(response.status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
