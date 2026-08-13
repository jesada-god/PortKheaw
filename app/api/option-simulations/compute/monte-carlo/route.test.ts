import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimulationWorkspace } from '@/src/lib/options-simulator/types';
import { prepareMonteCarloCalculationInput } from '@/src/lib/options-simulator/validation';

const mocks = vi.hoisted(() => ({
  guardRouteEntitlement: vi.fn(),
  computeMonteCarlo: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/subscription/server-entitlement', () => ({ guardRouteEntitlement: mocks.guardRouteEntitlement }));
vi.mock('@/src/lib/options-simulator/server-compute', () => ({ computeMonteCarlo: mocks.computeMonteCarlo }));

import { POST } from './route';

const workspace: SimulationWorkspace = {
  name: 'Test', description: '', symbol: 'TEST', companyName: 'Test Inc', exchange: 'NASDAQ', currency: 'USD',
  simulationType: 'monte-carlo', strategyType: 'Long Call', underlyingPrice: 100, stockQuantity: 0, cashPosition: 0,
  entryDate: '2026-01-01', valuationDate: '2026-01-01',
  legs: [{ id: 'leg-1', kind: 'call', side: 'buy', quantity: 1, strike: 100, expiration: '2027-01-01', entryPremium: 10, impliedVolatility: 0.2, multiplier: 100, fees: 0, style: 'european' }],
  scenarios: [{ id: 'base', name: 'Base', targetPrice: 110, valuationDate: '2026-06-01', volatilityShift: 0, rate: 0.05, dividendYield: 0 }],
  monteCarlo: { paths: 1_000, seed: 42, horizonDays: 151, steps: 30, drift: 0.05, volatility: 0.2, rate: 0.05, dividendYield: 0 },
  dataSource: null, dataTimestamp: null, dataStatus: 'manual', resultSnapshot: null, methodologyVersion: 'options-simulator-v1',
};

function calculationInput(value: SimulationWorkspace = workspace) {
  const prepared = prepareMonteCarloCalculationInput(value, value, value.monteCarlo);
  if (!prepared.success) throw new Error(prepared.issues.join('; '));
  return prepared.data;
}

describe('POST /api/option-simulations/compute/monte-carlo', () => {
  beforeEach(() => {
    mocks.guardRouteEntitlement.mockReset();
    mocks.computeMonteCarlo.mockReset();
  });

  it('rejects Basic and Pro before the Monte Carlo engine sees the body', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({
      denied: NextResponse.json({ data: null, error: { code: 'UPGRADE_REQUIRED' } }, { status: 403 }),
      entitlement: null,
    });

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/monte-carlo', { method: 'POST', body: 'not-json' }));

    expect(response.status).toBe(403);
    expect(mocks.guardRouteEntitlement).toHaveBeenCalledWith('simulator.monte_carlo');
    expect(mocks.computeMonteCarlo).not.toHaveBeenCalled();
  });

  it('computes for Elite and marks the result private', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'elite' } });
    mocks.computeMonteCarlo.mockReturnValue({ result: { paths: 1_000 }, scenarioScore: { status: 'unavailable', reason: 'test', auditStatus: 'not-run' } });

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/monte-carlo', {
      method: 'POST',
      body: JSON.stringify({ input: calculationInput() }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.computeMonteCarlo).toHaveBeenCalledWith(calculationInput());
    expect(payload.data.result.paths).toBe(1_000);
    expect(payload.error).toBeNull();
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(response.headers.get('X-Entitlement-Tier')).toBe('elite');
  });

  it('runs the reported Forecast case through 50,000 paths with IV over 100%', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'elite' } });
    const actual = await vi.importActual<typeof import('@/src/lib/options-simulator/server-compute')>('@/src/lib/options-simulator/server-compute');
    mocks.computeMonteCarlo.mockImplementation(actual.computeMonteCarlo);
    const regression: SimulationWorkspace = {
      ...workspace,
      symbol: 'ONDS', companyName: 'Ondas Holdings Inc.', underlyingPrice: 10,
      valuationDate: '2026-08-04', entryDate: '2026-08-04',
      legs: [{ ...workspace.legs[0], kind: 'call', side: 'buy', quantity: 2, strike: 8, entryPremium: 1, impliedVolatility: 1.1527, expiration: '2026-08-21', fees: 0 }],
      scenarios: [{ ...workspace.scenarios[0], targetPrice: 10, valuationDate: '2026-08-14', volatilityShift: 0, rate: 0, dividendYield: 0 }],
      monteCarlo: { paths: 50_000, seed: 42, horizonDays: 10, steps: 10, drift: 0, volatility: 1.1527, rate: 0, dividendYield: 0, driftMode: 'forecast' },
      dataTimestamp: 'not-a-provider-timestamp',
    };
    const input = calculationInput(regression);

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/monte-carlo', {
      method: 'POST', body: JSON.stringify({ input }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.error).toBeNull();
    expect(input.portfolio.legs[0].impliedVolatility).toBeCloseTo(1.1527, 10);
    expect(input.settings.volatility).toBeCloseTo(1.1527, 10);
    expect(input.settings.driftMode).toBe('forecast');
    expect(input.quality.dataTimestamp).toBeNull();
    expect(payload.data.result.paths).toBe(50_000);
    expect(payload.data.result.validPaths).toBe(50_000);
    expect(Number.isFinite(payload.data.result.probabilityOfProfit)).toBe(true);
    expect(payload.data.result.initialDebit).toBe(200);
    expect(payload.data.result.initialRisk).toBe(200);
    expect(payload.data.result.maxLoss).toBe(200);
    expect(payload.data.result.returnPct).toBeCloseTo(payload.data.result.expectedProfitLoss / 200 * 100, 10);
    expect(payload.data.result.breakEvenPrices).toEqual([9]);
    expect(payload.data.result.breakEvenPrices).toHaveLength(1);
    expect(payload.data.result.histogram).toHaveLength(24);
    expect(payload.data.result.terminalPriceHistogram).toHaveLength(24);
    expect(payload.data.result.samplePaths).toHaveLength(40);
    expect(payload.data.result.breakEvenPrices).not.toEqual(payload.data.result.histogram.map((bucket: { lower: number }) => bucket.lower));
    expect(payload.data.scenarioScore.status).toBe('available');
    expect(payload.data.scenarioScore.call.status).toBe('available');
    expect(payload.data.scenarioScore.call.metrics.maxLoss).toBe(200);
    expect(payload.data.scenarioScore.call.metrics.riskCapital).toBe(payload.data.result.initialRisk);
  }, 30_000);

  it('rejects non-finite calculation values before invoking the engine', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'elite' } });
    const invalid = calculationInput();
    const raw = JSON.stringify({ input: { ...invalid, portfolio: { ...invalid.portfolio, spot: Number.NaN } } });

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/monte-carlo', { method: 'POST', body: raw }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.data).toBeNull();
    expect(payload.error.code).toBe('invalid-calculation-input');
    expect(payload.error.issues.some((issue: string) => issue.startsWith('underlyingPrice:'))).toBe(true);
    expect(mocks.computeMonteCarlo).not.toHaveBeenCalled();
  });

  it('returns a safe Thai cause when the engine fails instead of a generic error', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({ denied: null, entitlement: { authenticated: true, tier: 'elite' } });
    mocks.computeMonteCarlo.mockImplementation(() => { throw new Error('Monte Carlo produced a non-finite result'); });

    /*
     * A seed of its own, so this case does not collide with the successful run
     * above in the route's dedupe cache. The cache is keyed by the exact request
     * body and only ever stores successes, so an identical body really would be
     * answered from it — correctly, since the simulation is a pure function of
     * its input. This case is about the failure path, so it needs an input the
     * cache has never seen.
     */
    const input = calculationInput();
    const raw = JSON.stringify({
      input: { ...input, settings: { ...input.settings, seed: 987_654 } },
    });

    const response = await POST(new Request('https://portkheaw.vercel.app/api/option-simulations/compute/monte-carlo', {
      method: 'POST', body: raw,
    }));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.data).toBeNull();
    expect(payload.error).toEqual({
      code: 'invalid-monte-carlo-input',
      message: 'ข้อมูลสำหรับจำลองมีค่าที่ไม่ใช่ตัวเลข กรุณาตรวจสอบราคา IV จำนวนรอบ และสมมติฐาน',
    });
  });
});
