import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimulationWorkspace } from '@/src/lib/options-simulator/types';

const mocks = vi.hoisted(() => ({
  guardRouteEntitlement: vi.fn(),
  computeWhatIf: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/subscription/server-entitlement', () => ({ guardRouteEntitlement: mocks.guardRouteEntitlement }));
vi.mock('@/src/lib/options-simulator/server-compute', () => ({ computeWhatIf: mocks.computeWhatIf }));

import { POST } from './route';

const workspace: SimulationWorkspace = {
  name: 'Test', description: '', symbol: 'TEST', companyName: 'Test Inc', exchange: 'NASDAQ', currency: 'USD',
  simulationType: 'what-if', strategyType: 'Long Call', underlyingPrice: 100, stockQuantity: 0, cashPosition: 0,
  entryDate: '2026-01-01', valuationDate: '2026-01-01',
  legs: [{ id: 'leg-1', kind: 'call', side: 'buy', quantity: 1, strike: 100, expiration: '2027-01-01', entryPremium: 10, impliedVolatility: 0.2, multiplier: 100, fees: 0, style: 'european' }],
  scenarios: [{ id: 'base', name: 'Base', targetPrice: 110, valuationDate: '2026-06-01', volatilityShift: 0, rate: 0.05, dividendYield: 0 }],
  monteCarlo: { paths: 1_000, seed: 42, horizonDays: 30, steps: 30, drift: 0.05, volatility: 0.2, rate: 0.05, dividendYield: 0 },
  dataSource: null, dataTimestamp: null, dataStatus: 'manual', resultSnapshot: null, methodologyVersion: 'options-simulator-v1',
};

describe('POST /api/option-simulations/compute/what-if', () => {
  beforeEach(() => {
    mocks.guardRouteEntitlement.mockReset();
    mocks.computeWhatIf.mockReset();
  });

  it('rejects Basic before reading or computing an invalid body', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({
      denied: NextResponse.json({ data: null, error: { code: 'UPGRADE_REQUIRED' } }, { status: 403 }),
      entitlement: null,
    });

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/what-if', { method: 'POST', body: 'not-json' }));

    expect(response.status).toBe(403);
    expect(mocks.guardRouteEntitlement).toHaveBeenCalledWith('simulator.what_if');
    expect(mocks.computeWhatIf).not.toHaveBeenCalled();
  });

  it('computes for Pro and marks the result private', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'pro' } });
    mocks.computeWhatIf.mockReturnValue({
      valuation: { theoreticalValue: 321 },
      decomposition: { currentValue: 300, priceImpact: 10, timeImpact: -2, ivImpact: 13 },
    });

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/what-if', {
      method: 'POST', body: JSON.stringify({ workspace }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.computeWhatIf).toHaveBeenCalledOnce();
    expect(payload.data).toEqual({
      valuation: { theoreticalValue: 321 },
      decomposition: { currentValue: 300, priceImpact: 10, timeImpact: -2, ivImpact: 13 },
    });
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(response.headers.get('X-Entitlement-Tier')).toBe('pro');
  });
});
