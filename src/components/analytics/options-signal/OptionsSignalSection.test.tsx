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
  directionScore0to100: 82,
  scoreFormula: '(+64 + 100) ÷ (2 × 100) × 100 = 82',
  confidenceScore: 74,
  underlyingBias: 'bullish',
  asOf: AS_OF,
  staleMix: false,
  liquidityGrade: 'good',
  configVersion: '2026.08.19',
  historyDegraded: false,
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
      trendVeto: { applied: false, opposition: 0, multiplier: 1, pointsBeforeVeto: 0 },
      factors: {
        macro: factor('macro', 12, 20, 'SPY และ QQQ อยู่เหนือ EMA20'),
        trend: factor('trend', 18, 25, 'ราคาอยู่เหนือ EMA20 และ EMA50'),
        momentum: factor('momentum', 14, 20, 'Squeeze fired bullish พร้อม RVOL'),
        sentiment: factor('sentiment', 8, 15, 'Put/Call OI = 0.72'),
        riskReward: factor('riskReward', 12, 20, 'Call R:R = 2.4'),
      },
      rawDirectionPoints: 64,
      availableWeight: 100,
      totalWeight: 100,
      directionScore0to100: 82,
      scoreFormula: '(+64 + 100) ÷ (2 × 100) × 100 = 82',
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
        reachability: 1,
        price: 110,
        support: 105,
        resistance: 122,
        upsidePercent: 10.91,
        downsidePercent: 4.55,
        callRewardRisk: 2.4,
        putRewardRisk: 0.42,
        scoredSide: 'call',
        setupQuality: 1,
        upsideAtr: 1.2,
        downsideAtr: 0.5,
        upsideExpectedMoves: 0.9,
        downsideExpectedMoves: 0.38,
        expectedMove: 13.3,
        expectedMoveDte: 24,
        expectedMoveHorizonWarning: null,
        state: 'DELAYED',
      },
      iv: {
        level: 'normal',
        basis: 'iv-vs-realized',
        ivRank: null,
        ivPercentile: null,
        percentilePending: { observations: 12, required: 60, missingDays: 48 },
        percentileStoreUnavailable: false,
        impliedVolatility: 0.38,
        realizedVolatility: 0.32,
        realizedWindowDays: 30,
        dte: 24,
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
      liquidity: {
        grade: 'good',
        score: 88,
        medianOpenInterest: 2_400,
        medianVolume: 310,
        medianSpreadPercent: 2.4,
        contractsExamined: 14,
        expiration: '2026-08-21',
        marketOpenAtCapture: true,
        offHoursAssessment: null,
        state: 'DELAYED',
        reason: null,
        detail: 'OI กลาง 2,400 · Volume กลาง 310',
      },
      squeeze: {
        breakdown: { rawAtr: 2.4, saturation: 1, clamped: 1, afterSqueeze: 1, multiplier: 0.98 },
        state: 'FIRED_BULLISH',
        momentum: 2.4,
        normalizedMomentum: 1,
        normalizedMomentumCapped: true,
        relativeVolume: 1.8,
        confirmation: 0.8,
      },
      macro: {
        benchmarks: [
          { symbol: 'SPY', close: 500, ema20: 480, aboveEma20: true },
          { symbol: 'QQQ', close: 400, ema20: 390, aboveEma20: true },
        ],
      },
      provenance: {
        asOf: AS_OF,
        newestAsOf: '2026-07-27T22:00:00.000Z',
        spreadHours: 2,
        staleMix: false,
        sources: [
          { id: 'trend', provider: 'fixture-market-data', asOf: AS_OF },
          { id: 'pricing', provider: 'fixture-options', asOf: '2026-07-27T22:00:00.000Z' },
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

  /*
   * The defect this whole block exists for: the card printed one number and the
   * dialog printed another, because the card was showing confidence and the
   * dialog was showing the signed sum. Both now read the SAME payload field, and
   * these assertions compare the two rendered strings rather than trusting that.
   */
  it('shows the identical direction score on the card and inside the dialog', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');

    const card = container.querySelector('[data-testid="options-signal-score-card"]');
    expect(card?.textContent).toBe('82');

    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const modal = document.body.querySelector('[data-testid="options-signal-score-modal"]');
    expect(modal?.textContent).toContain('82');
    expect(modal?.textContent?.replace(/\D/g, '')).toContain(card?.textContent ?? '');
    // And the arithmetic that produced it is on screen, not asserted on trust.
    expect(document.body.querySelector('[data-testid="options-signal-score-formula"]')?.textContent)
      .toBe('(+64 + 100) ÷ (2 × 100) × 100 = 82');
  });

  it('labels the direction score and the confidence score as different things', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');
    expect(container.textContent).toContain('คะแนนทิศทาง');
    expect(container.textContent).toContain('Confidence');
    expect(container.querySelector('[data-testid="options-signal-score-card"]')?.textContent).toBe('82');
    expect(container.textContent).toContain('74');
  });

  /*
   * Labelling the two numbers was not enough to pair them.
   *
   * They used to be two right-aligned blocks 16px apart, which printed the value
   * runs as one strip — `82 / 100  74 / 100` — whose only break was smaller than
   * the distance from either number to the word above it. Chrome at 1280px and
   * at 380px measured 16px between the groups against 22px inside each one, so
   * by proximity the numbers belonged to each other rather than to their labels.
   *
   * Geometry is not assertable in jsdom, so what is asserted here is the
   * STRUCTURE that produced it: each number and the word for it are inside one
   * container that holds no OTHER label, which is the property a reader relies
   * on and the one a future layout edit would have to break deliberately.
   */
  it('keeps each headline number inside a container that holds only its own label', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');

    const scoreGroup = container
      .querySelector('[data-testid="options-signal-score-card"]')
      ?.closest('p');
    const confidenceGroup = container
      .querySelector('[data-testid="options-signal-confidence-card"]')
      ?.closest('p');

    expect(scoreGroup).not.toBeNull();
    expect(confidenceGroup).not.toBeNull();
    expect(scoreGroup).not.toBe(confidenceGroup);

    expect(scoreGroup?.textContent).toContain('คะแนนทิศทาง');
    expect(scoreGroup?.textContent).toContain('82');
    expect(scoreGroup?.textContent).not.toContain('Confidence');

    expect(confidenceGroup?.textContent).toContain('Confidence');
    expect(confidenceGroup?.textContent).toContain('74');
    expect(confidenceGroup?.textContent).not.toContain('คะแนนทิศทาง');
  });

  it('shows the card score to a Pro reader who has no breakdown at all', async () => {
    await renderFor('pro');
    // The score lives in the SUMMARY precisely so this reader still sees it.
    expect(container.querySelector('[data-testid="options-signal-score-card"]')?.textContent).toBe('82');
    expect(container.querySelector('[data-testid="options-signal-breakdown-locked"]')).not.toBeNull();
  });

  it('carries the liquidity badge on the card', async () => {
    await renderFor('pro');
    expect(container.querySelector('[data-testid="options-signal-liquidity-badge"]')?.textContent)
      .toBe('สภาพคล่องดี');
  });

  it('raises STALE-MIX only when the payload says the sources diverged', async () => {
    await renderFor('pro');
    expect(container.querySelector('[data-testid="options-signal-stale-mix"]')).toBeNull();

    mocks.requestOptionsSignal.mockResolvedValue({
      status: 'ready',
      signal: { summary: { ...summary, staleMix: true }, breakdown: null },
    });
    await renderFor('pro', 'NVDA');
    expect(container.querySelector('[data-testid="options-signal-stale-mix"]')?.textContent).toBe('STALE-MIX');
  });

  it('prints every year in CE, never in the Buddhist era', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');
    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const text = document.body.textContent ?? '';
    expect(text).toContain('2026');
    // 2026 CE renders as 2569 under the th-TH default calendar.
    expect(text).not.toContain('2569');
    expect(text).not.toContain('2570');
  });

  it('says how many days an IV percentile still needs instead of "unavailable"', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');
    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(document.body.textContent).toContain('ต้องการข้อมูลอีก 48 วัน');
  });

  it('marks a clamped momentum ratio and prints three decimals', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');
    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(document.body.textContent).toContain('1.000 (capped)');
  });

  it('quotes the support and resistance distances in ATR beside the percentages', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');
    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(document.body.textContent).toContain('1.20× / 0.50×');
    expect(document.body.textContent).toContain('Expected Move');
  });

  it('renders nothing broken when every diagnostic number is absent', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({
      status: 'ready',
      signal: {
        summary: { ...summary, directionScore0to100: null, scoreFormula: null, asOf: null, liquidityGrade: null },
        breakdown: null,
      },
    });
    await renderFor('pro');
    const text = container.textContent ?? '';
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('Infinity');
    expect(container.querySelector('[data-testid="options-signal-score-card"]')?.textContent).toBe('—');
  });

  it('shows the expected move with the horizon it was priced over', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');
    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // A distance without a deadline is not a statement about this contract.
    expect(document.body.textContent).toContain('เหลือ 24 วัน');
  });

  it('raises the horizon warning when the payload carries one', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');
    let trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.querySelector('[data-testid="options-signal-em-horizon-warning"]')).toBeNull();

    mocks.requestOptionsSignal.mockResolvedValue({
      status: 'ready',
      signal: {
        ...eliteSignal,
        breakdown: {
          ...eliteSignal.breakdown!,
          diagnostics: {
            ...eliteSignal.breakdown!.diagnostics,
            riskReward: {
              ...eliteSignal.breakdown!.diagnostics.riskReward,
              expectedMoveHorizonWarning: 'แนวต้านอยู่ไกล 3.33 เท่าของ Expected Move',
            },
          },
        },
      },
    });
    await renderFor('elite', 'NVDA');
    trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.querySelector('[data-testid="options-signal-em-horizon-warning"]')?.textContent)
      .toContain('3.33');
  });

  it('says liquidity cannot be judged, rather than judging it, on a closed book', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({
      status: 'ready',
      signal: {
        summary: { ...summary, liquidityGrade: 'unknown' },
        breakdown: {
          ...eliteSignal.breakdown!,
          diagnostics: {
            ...eliteSignal.breakdown!.diagnostics,
            liquidity: {
              ...eliteSignal.breakdown!.diagnostics.liquidity,
              grade: 'unknown',
              score: null,
              medianSpreadPercent: 42,
              marketOpenAtCapture: false,
              offHoursAssessment: { grade: 'fair', score: 60 },
            },
          },
        },
      },
    });
    await renderFor('elite');

    // The badge stops making a claim instead of making a false one.
    const badge = container.querySelector('[data-testid="options-signal-liquidity-badge"]');
    expect(badge?.textContent).toContain('ประเมินไม่ได้');
    expect(badge?.textContent).not.toContain('ต้องระวัง');

    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    // ...and the measurement behind it is still on screen, labelled.
    expect(document.body.querySelector('[data-testid="options-signal-liquidity-closed"]')).not.toBeNull();
    expect(document.body.textContent).toContain('ถ้าดูเฉพาะ OI และ Volume');
    expect(document.body.textContent).toContain('สภาพคล่องพอใช้');
  });

  it('shows an outage as an outage, never as the accumulating countdown', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({
      status: 'ready',
      signal: {
        summary: { ...summary, historyDegraded: true },
        breakdown: {
          ...eliteSignal.breakdown!,
          diagnostics: {
            ...eliteSignal.breakdown!.diagnostics,
            iv: {
              ...eliteSignal.breakdown!.diagnostics.iv,
              percentilePending: null,
              percentileStoreUnavailable: true,
            },
          },
        },
      },
    });
    await renderFor('elite');

    expect(container.querySelector('[data-testid="options-signal-history-degraded"]')?.textContent)
      .toContain('ใช้ไม่ได้ชั่วคราว');

    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(document.body.querySelector('[data-testid="options-signal-percentile-outage"]')).not.toBeNull();
    expect(document.body.textContent).toContain('อ่านประวัติไม่สำเร็จ');
    // The countdown must be nowhere on the page: it would never count down.
    expect(document.body.textContent).not.toContain('ต้องการข้อมูลอีก');
  });

  it('keeps the countdown when the store is merely young', async () => {
    mocks.requestOptionsSignal.mockResolvedValue({ status: 'ready', signal: eliteSignal });
    await renderFor('elite');
    expect(container.querySelector('[data-testid="options-signal-history-degraded"]')).toBeNull();

    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.textContent).toContain('ต้องการข้อมูลอีก 48 วัน');
    expect(document.body.querySelector('[data-testid="options-signal-percentile-outage"]')).toBeNull();
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
