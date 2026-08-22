import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OptionsSignalFactorId,
  OptionsSignalFactorScore,
  OptionsSignalResult,
} from '@/src/lib/analytics/options-signal/types';

const mocks = vi.hoisted(() => ({
  guardRouteEntitlement: vi.fn(),
  checkMarketDataRateLimit: vi.fn(),
  computeServerOptionsSignal: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/subscription/server-entitlement', () => ({
  guardRouteEntitlement: mocks.guardRouteEntitlement,
}));
vi.mock('@/src/lib/market-data/api-rate-limit', () => ({
  checkMarketDataRateLimit: mocks.checkMarketDataRateLimit,
}));
vi.mock('@/src/lib/analytics/options-signal/server-signal', () => ({
  computeServerOptionsSignal: mocks.computeServerOptionsSignal,
}));

import { GET } from './route';

const BREAKDOWN_SECRET = 'ELITE_ROUTE_BREAKDOWN_SECRET';

function factor(id: OptionsSignalFactorId): OptionsSignalFactorScore {
  return {
    id,
    points: 0,
    maxPoints: 25,
    normalized: 0,
    state: 'DELAYED',
    available: true,
    measurement: 'measured',
    fallbackReason: null,
    partial: false,
    detail: 'test',
    reason: null,
    provider: 'test-provider',
    asOf: '2026-07-28T00:00:00.000Z',
  };
}

const result: OptionsSignalResult = {
  symbol: 'AAPL',
  timeframe: '1D',
  calculatedAt: '2026-07-28T00:00:00.000Z',
  latestCandleAt: '2026-07-27',
  finalizedCandles: 250,
  status: 'available',
  signalType: 'CALL_WATCH',
  directionScore0to100: 50,
  confidenceScore: 74,
  underlyingBias: 'bullish',
  liquidityGrade: null,
  asOf: '2026-07-28T00:00:00.000Z',
  staleMix: false,
  configVersion: '2026.08.19',
  historyDegraded: false,
  reasoning: [{ id: 'secret-reason', polarity: 'positive', text: BREAKDOWN_SECRET }],
  suggestedOptionsSetup: {
    status: 'not-recommended',
    reason: BREAKDOWN_SECRET,
    warnings: [],
  },
  diagnostics: {
    trendVeto: { applied: false, opposition: 0, multiplier: 1, pointsBeforeVeto: 0 },
    factors: {
      macro: factor('macro'),
      trend: factor('trend'),
      momentum: factor('momentum'),
      sentiment: factor('sentiment'),
      riskReward: factor('riskReward'),
    },
    rawDirectionPoints: 0,
    availableWeight: 100,
    totalWeight: 100,
    directionScore0to100: 50,
    scoreFormula: '(0 + 100) ÷ (2 × 100) × 100 = 50',
    coverage: 1,
    completeness: {
      value: 0.74,
      inputs: [
        { id: 'trend.ema50', group: 'trend', label: 'EMA50 ของหุ้น', available: true, counted: true, note: null },
        { id: 'pricing.own-baseline', group: 'pricing', label: 'ฐานเทียบความแพงของตัวเอง (IV Rank / IV percentile)', available: false, counted: false, note: 'ขาดอีก 59 วัน' },
      ],
      missing: ['ฐานเทียบความแพงของตัวเอง (IV Rank / IV percentile)'],
      notCounted: [],
    },
    agreement: 1,
    evidenceStrength: 1,
    confidenceBase: 74,
    confidenceFormula: 'ความครบ^0.2 × ความสอดคล้อง^0.55 × ความหนักแน่น^0.25 = 0.74 → 74%',
    penalties: [],
    penaltyTotal: 0,
    dataSufficiency: { passed: true, missing: [], primeEligible: true, primeBlockers: [] },
    riskReward: {
      reachability: 1,
      price: 200,
      support: 190,
      resistance: 220,
      upsidePercent: 10,
      downsidePercent: 5,
      callRewardRisk: 2,
      putRewardRisk: 0.5,
      scoredSide: 'call',
      setupQuality: 1,
      upsideAtr: 2,
      downsideAtr: 1,
      upsideExpectedMoves: null,
      downsideExpectedMoves: null,
      expectedMove: null,
      expectedMoveDte: null,
      expectedMoveHorizonWarning: null,
      state: 'DELAYED',
    },
    iv: {
      level: 'normal',
      levelSuppressedReason: null,
      basis: 'iv-vs-realized',
      ivRank: null,
      ivPercentile: null,
      percentilePending: null,
      percentileStoreUnavailable: false,
      impliedVolatility: 0.3,
      realizedVolatility: 0.25,
      realizedWindowDays: 252,
      dte: 55,
      ratio: 1.2,
      observations: 252,
      state: 'DELAYED',
      reason: null,
      source: 'test-provider',
      fetchedAt: '2026-07-28T00:00:00.000Z',
    },
    event: {
      reportDate: null,
      daysToEarnings: null,
      timeOfDay: null,
      state: 'UNAVAILABLE',
      reason: 'test',
      source: null,
      fetchedAt: null,
    },
    liquidity: {
      grade: null,
      score: null,
      medianOpenInterest: null,
      medianVolume: null,
      medianSpreadPercent: null,
      contractsExamined: null,
      expiration: null,
      marketOpenAtCapture: null,
      offHoursAssessment: null,
      state: 'UNAVAILABLE',
      reason: 'test',
      detail: 'test',
    },
    squeeze: {
      breakdown: { rawAtr: 0, saturation: 1, clamped: 0, afterSqueeze: 0, multiplier: 0.8 },
      state: 'OFF',
      momentum: 0,
      normalizedMomentum: 0,
      normalizedMomentumCapped: false,
      relativeVolume: 1,
      confirmation: 0,
    },
    macro: { benchmarks: [] },
    provenance: {
      asOf: '2026-07-28T00:00:00.000Z',
      newestAsOf: '2026-07-28T00:00:00.000Z',
      spreadHours: null,
      spreadSessions: 0,
      staleMix: false,
      sources: [],
    },
    gates: { ivWarning: false, ivWarningReasons: [], downgrades: [BREAKDOWN_SECRET] },
  },
};

function request() {
  return new NextRequest('https://portkheaw.vercel.app/api/analytics/options-signal/AAPL');
}

function context(symbol = 'AAPL') {
  return { params: Promise.resolve({ symbol }) };
}

describe('GET /api/analytics/options-signal/[symbol]', () => {
  beforeEach(() => {
    mocks.guardRouteEntitlement.mockReset();
    mocks.checkMarketDataRateLimit.mockReset();
    mocks.computeServerOptionsSignal.mockReset();
    mocks.checkMarketDataRateLimit.mockReturnValue({ allowed: true });
    mocks.computeServerOptionsSignal.mockResolvedValue({ result, expiration: '2026-08-21' });
  });

  it('rejects Basic before rate limiting or computing premium inputs', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({
      denied: NextResponse.json(
        { data: null, error: { code: 'UPGRADE_REQUIRED', capability: 'options.signal.summary' } },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      ),
      entitlement: null,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.guardRouteEntitlement).toHaveBeenCalledWith('options.signal.summary');
    expect(mocks.checkMarketDataRateLimit).not.toHaveBeenCalled();
    expect(mocks.computeServerOptionsSignal).not.toHaveBeenCalled();
  });

  it('serves Pro only the summary and serializes no breakdown value', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({
      denied: null,
      entitlement: { authenticated: true, tier: 'pro' },
    });

    const response = await GET(request(), context());
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload.data.summary).toMatchObject({
      symbol: 'AAPL',
      signalType: 'CALL_WATCH',
      confidenceScore: 74,
      underlyingBias: 'bullish',
    });
    expect(payload.data.breakdown).toBeNull();
    expect(serialized).not.toContain(BREAKDOWN_SECRET);
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(response.headers.get('X-Entitlement-Tier')).toBe('pro');
    expect(response.headers.get('Vary')).toContain('Cookie');
  });

  it('serves Elite the complete projected breakdown', async () => {
    mocks.guardRouteEntitlement.mockResolvedValue({
      denied: null,
      entitlement: { authenticated: true, tier: 'elite' },
    });

    const response = await GET(request(), context());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.breakdown.reasoning[0].text).toBe(BREAKDOWN_SECRET);
    expect(payload.data.breakdown.suggestedOptionsSetup.reason).toBe(BREAKDOWN_SECRET);
    expect(payload.data.breakdown.diagnostics.gates.downgrades[0]).toBe(BREAKDOWN_SECRET);
    expect(response.headers.get('X-Entitlement-Tier')).toBe('elite');
  });
});
