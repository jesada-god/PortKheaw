// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import type { OptionsSignalDto } from '@/src/lib/analytics/options-signal/dto';
import type { OptionsSignalFactorId, OptionsSignalFactorScore, OptionsSignalType } from '@/src/lib/analytics/options-signal/types';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { OPTIONS_SIGNAL_PRESENTATION } from './presentation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  requestOptionsSignal: vi.fn(),
}));

vi.mock('./signal-client', async () => {
  const actual = await vi.importActual<typeof import('./signal-client')>('./signal-client');
  return { ...actual, requestOptionsSignal: mocks.requestOptionsSignal };
});

const { OptionsSignalSection } = await import('./OptionsSignalSection');

const AS_OF = '2026-07-27T20:00:00.000Z';
const BREAKDOWN_SECRET = 'ELITE_BREAKDOWN_SECRET';

function factor(
  id: OptionsSignalFactorId,
  points: number,
  maxPoints: number,
  detail: string,
): OptionsSignalFactorScore {
  return {
    id,
    points,
    maxPoints,
    normalized: points / maxPoints,
    state: 'DELAYED',
    available: true,
    partial: false,
    detail,
    reason: null,
    provider: 'fixture-market-data',
    asOf: AS_OF,
  };
}

const summary: OptionsSignalDto['summary'] = {
  symbol: 'AAPL',
  timeframe: '1D',
  calculatedAt: '2026-07-28T00:00:00.000Z',
  latestCandleAt: '2026-07-27',
  finalizedCandles: 250,
  status: 'available',
  signalType: 'CALL_WATCH',
  confidenceScore: 74,
  underlyingBias: 'bullish',
  reason: null,
};

const eliteSignal: OptionsSignalDto = {
  summary,
  breakdown: {
    reasoning: [
      { id: 'trend-up', polarity: 'positive', text: BREAKDOWN_SECRET },
      { id: 'earnings', polarity: 'caution', text: 'อีก 28 วันมี Earnings' },
    ],
    suggestedOptionsSetup: {
      status: 'suggested',
      direction: 'call',
      dteMin: 30,
      dteMax: 45,
      deltaMin: 0.35,
      deltaMax: 0.5,
      rationale: 'ใช้ Call เมื่อแนวโน้มและโมเมนตัมยืนยันกัน',
      warnings: ['จำกัดความเสี่ยงต่อสถานะ'],
    },
    diagnostics: {
      factors: {
        macro: factor('macro', 12, 20, 'SPY และ QQQ อยู่เหนือ EMA20'),
        trend: factor('trend', 18, 25, 'ราคาอยู่เหนือ EMA20 และ EMA50'),
        momentum: factor('momentum', 14, 20, 'Squeeze fired bullish พร้อม RVOL'),
        sentiment: factor('sentiment', 8, 15, 'Put/Call OI = 0.72'),
        riskReward: factor('riskReward', 12, 20, 'Call R:R = 2.4'),
      },
      directionScore: 64,
      availableWeight: 100,
      totalWeight: 100,
      normalizedScore: 64,
      coverage: 1,
      agreement: 0.86,
      evidenceStrength: 0.8,
      confidenceBase: 0.74,
      penalties: [],
      penaltyTotal: 0,
      dataSufficiency: {
        passed: true,
        missing: [],
        primeEligible: false,
        primeBlockers: ['CONFIDENCE_BELOW_PRIME'],
      },
      riskReward: {
        price: 110,
        support: 105,
        resistance: 122,
        upsidePercent: 10.91,
        downsidePercent: 4.55,
        callRewardRisk: 2.4,
        putRewardRisk: 0.42,
        state: 'DELAYED',
      },
      iv: {
        level: 'normal',
        basis: 'iv-vs-realized',
        ivRank: null,
        impliedVolatility: 0.38,
        realizedVolatility: 0.32,
        ratio: 1.19,
        observations: 250,
        state: 'DELAYED',
        reason: null,
        source: 'fixture-options',
        fetchedAt: AS_OF,
      },
      event: {
        reportDate: '2026-08-25',
        daysToEarnings: 28,
        timeOfDay: 'post-market',
        state: 'DELAYED',
        reason: null,
        source: 'fixture-earnings',
        fetchedAt: AS_OF,
      },
      squeeze: {
        state: 'FIRED_BULLISH',
        momentum: 2.4,
        normalizedMomentum: 1.2,
        relativeVolume: 1.8,
        confirmation: 0.8,
      },
      macro: {
        benchmarks: [
          { symbol: 'SPY', close: 500, ema20: 480, aboveEma20: true },
          { symbol: 'QQQ', close: 400, ema20: 390, aboveEma20: true },
        ],
      },
      gates: { ivWarning: false, ivWarningReasons: [], downgrades: [] },
    },
  },
};

const proSignal: OptionsSignalDto = { summary, breakdown: null };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.requestOptionsSignal.mockReset();
  mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: proSignal });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderFor(tier: SubscriptionTier, symbol = 'AAPL', active = true) {
  await act(async () => {
    root.render(
      <EntitlementProvider tier={tier} authenticated trialOffer="used">
        <OptionsSignalSection symbol={symbol} active={active} />
      </EntitlementProvider>,
    );
  });
}

describe('OptionsSignalSection gated DTO rendering', () => {
  it('keeps Basic locked and never starts a Signal request', async () => {
    await renderFor('basic');

    expect(container.querySelector('[data-testid="options-signal-locked"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="locked-options.signal.summary"]')).not.toBeNull();
    expect(mocks.requestOptionsSignal).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('74');
    expect(container.textContent).not.toContain(BREAKDOWN_SECRET);
  });

  it('does not load while the Analysis tab is inactive', async () => {
    await renderFor('pro', 'AAPL', false);
    expect(mocks.requestOptionsSignal).not.toHaveBeenCalled();
  });

  it('renders only the gauge and summary for Pro', async () => {
    await renderFor('pro');

    const section = container.querySelector('section[aria-label="Options Signal Engine"]');
    expect(section?.getAttribute('data-signal')).toBe('CALL_WATCH');
    expect(container.textContent).toContain('74');
    expect(container.querySelector('[data-testid="options-signal-breakdown-locked"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="locked-options.signal.breakdown"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Macro');
    expect(container.textContent).not.toContain('Risk/Reward');
    expect(container.textContent).not.toContain(BREAKDOWN_SECRET);
    expect(mocks.requestOptionsSignal).toHaveBeenCalledWith('AAPL', expect.any(AbortSignal));
  });

  it('renders the complete breakdown for Elite and opens its detail dialog', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');

    expect(container.textContent).toContain('Macro');
    expect(container.textContent).toContain('Risk/Reward');
    expect(container.textContent).toContain(BREAKDOWN_SECRET);
    expect(container.querySelector('[data-testid="options-signal-breakdown-locked"]')).toBeNull();

    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    expect(trigger).toBeDefined();
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.textContent).toContain('คะแนนทิศทางมาจากอะไร');
    expect(document.body.textContent).toContain('TTM Squeeze');
    expect(document.body.textContent).toContain('Confidence');
  });

  it('does not render an in-memory Elite breakdown after entitlement drops to Pro', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');
    expect(container.textContent).toContain(BREAKDOWN_SECRET);

    await renderFor('pro');
    expect(container.textContent).not.toContain(BREAKDOWN_SECRET);
    expect(container.querySelector('[data-testid="options-signal-breakdown-locked"]')).not.toBeNull();
  });

  it('shows a server denial as a locked surface and never fabricates a result', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'locked', message: 'ต้องอัปเกรดแพ็กเกจ' });
    await renderFor('pro');

    expect(container.querySelector('[data-testid="options-signal-locked"]')).not.toBeNull();
    expect(container.textContent).toContain('ต้องอัปเกรดแพ็กเกจ');
    expect(container.textContent).not.toContain('74');
  });

  it('reports insufficient data from the projected summary', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({
      status: 'ready',
      signal: {
        summary: {
          ...summary,
          status: 'insufficient-data',
          signalType: null,
          confidenceScore: 0,
          underlyingBias: null,
          reason: 'มีแท่งราคาที่ปิดแล้วไม่พอ',
        },
        breakdown: null,
      },
    });
    await renderFor('pro');

    expect(container.querySelector('section')?.getAttribute('data-signal')).toBe('insufficient-data');
    expect(container.textContent).toContain('ข้อมูลไม่เพียงพอ');
    expect(container.textContent).toContain('มีแท่งราคาที่ปิดแล้วไม่พอ');
  });

  it('restarts against the new symbol instead of carrying the previous signal over', async () => {
    mocks.requestOptionsSignal.mockImplementation(async (symbol: string) => ({
      status: 'ready',
      signal: symbol === 'AAPL'
        ? proSignal
        : {
          summary: {
            ...summary,
            symbol,
            status: 'insufficient-data',
            signalType: null,
            confidenceScore: 0,
            underlyingBias: null,
            reason: 'ข้อมูลของสัญลักษณ์ใหม่ยังไม่พอ',
          },
          breakdown: null,
        },
    }));

    await renderFor('pro', 'AAPL');
    expect(container.querySelector('section')?.getAttribute('data-signal')).toBe('CALL_WATCH');

    await renderFor('pro', 'NVDA');
    expect(container.querySelector('section')?.getAttribute('data-signal')).toBe('insufficient-data');
    expect(mocks.requestOptionsSignal).toHaveBeenLastCalledWith('NVDA', expect.any(AbortSignal));
  });

  it('keeps all six signal labels paired with beginner-facing Thai copy', () => {
    const types = Object.keys(OPTIONS_SIGNAL_PRESENTATION) as OptionsSignalType[];
    expect(types).toHaveLength(6);
    for (const type of types) {
      expect(OPTIONS_SIGNAL_PRESENTATION[type].headline.length).toBeGreaterThan(10);
      expect(OPTIONS_SIGNAL_PRESENTATION[type].title).toBe(type.replaceAll('_', ' '));
    }
  });
});
