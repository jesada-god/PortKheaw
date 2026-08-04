import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimulationWorkspace } from '@/src/lib/options-simulator/types';
import { prepareWhatIfCalculationInput } from '@/src/lib/options-simulator/validation';

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

function calculationInput(value: SimulationWorkspace = workspace) {
  const prepared = prepareWhatIfCalculationInput(value);
  if (!prepared.success) throw new Error(prepared.issues.join('; '));
  return prepared.data;
}

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
      method: 'POST', body: JSON.stringify({ input: calculationInput() }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.computeWhatIf).toHaveBeenCalledWith(calculationInput());
    expect(payload.data).toEqual({
      valuation: { theoreticalValue: 321 },
      decomposition: { currentValue: 300, priceImpact: 10, timeImpact: -2, ivImpact: 13 },
    });
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(response.headers.get('X-Entitlement-Tier')).toBe('pro');
  });

  it('runs the reported IV-over-100% case through the real pricing engine', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'pro' } });
    const actual = await vi.importActual<typeof import('@/src/lib/options-simulator/server-compute')>('@/src/lib/options-simulator/server-compute');
    mocks.computeWhatIf.mockImplementation(actual.computeWhatIf);
    const regression = calculationInput({
      ...workspace,
      underlyingPrice: 10,
      valuationDate: '2026-08-04',
      entryDate: '2026-08-04',
      legs: [{ ...workspace.legs[0], side: 'buy', kind: 'call', strike: 8, entryPremium: 1, quantity: 2, impliedVolatility: 1.1527, expiration: '2026-08-21' }],
      scenarios: [{ ...workspace.scenarios[0], targetPrice: 10, valuationDate: '2026-08-14', volatilityShift: 0, rate: 0, dividendYield: 0 }],
    });

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/what-if', {
      method: 'POST', body: JSON.stringify({ input: regression }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(regression.scenario.targetDate).toBe('2026-08-14');
    expect(regression.legs[0].expiration).toBe('2026-08-21');
    expect(regression.legs[0].impliedVolatility).toBeCloseTo(1.1527, 10);
    expect(payload.error).toBeNull();
    expect(Number.isFinite(payload.data.valuation.theoreticalValue)).toBe(true);
    expect(Number.isFinite(payload.data.valuation.profitLoss)).toBe(true);
    expect(Object.values(payload.data.valuation.greeks).every(Number.isFinite)).toBe(true);
    expect(payload.data.valuation.initialDebit).toBe(200);
    expect(payload.data.valuation.initialRisk).toBe(200);
    expect(payload.data.valuation.maxLoss).toBe(200);
    expect(payload.data.valuation.returnPct).toBeCloseTo(payload.data.valuation.profitLoss / 200 * 100, 10);
    expect(payload.data.valuation.breakEvenPrices).toEqual([9]);
    expect(payload.data.valuation.breakEvenPrices).toHaveLength(1);
    expect(payload.data.valuation.payoff).toHaveLength(241);
  });

  it('returns safe Thai field issues when Target Date exceeds expiration', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'pro' } });
    const invalid = { ...calculationInput(), scenario: { ...calculationInput().scenario, targetDate: '2027-02-01' } };

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/what-if', {
      method: 'POST', body: JSON.stringify({ input: invalid }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('invalid-calculation-input');
    expect(payload.error.issues).toContain('scenarios.0.valuationDate: วันที่ต้องการดูผลต้องอยู่หลังวันที่ใช้คำนวณ และต้องก่อนวันหมดอายุ');
    expect(mocks.computeWhatIf).not.toHaveBeenCalled();
  });

  it.each(['2027-01-01', '2027-01-02'])('rejects Target Date %s at or after expiration on the target-date field', async (targetDate) => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'pro' } });
    const invalid = { ...calculationInput(), scenario: { ...calculationInput().scenario, targetDate } };

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/what-if', {
      method: 'POST', body: JSON.stringify({ input: invalid }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.issues[0]).toMatch(/^scenarios\.0\.valuationDate:/);
    expect(mocks.computeWhatIf).not.toHaveBeenCalled();
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])('rejects a non-finite spot before pricing (%s)', async (spot) => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'pro' } });
    const invalid = { ...calculationInput(), spot };

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/what-if', {
      method: 'POST', body: JSON.stringify({ input: invalid }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.computeWhatIf).not.toHaveBeenCalled();
  });
});
