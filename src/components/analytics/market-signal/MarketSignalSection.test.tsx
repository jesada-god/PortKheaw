// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import type { MarketSignalResult, MarketSignalState } from '@/src/lib/analytics/market-signal/types';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { MARKET_SIGNAL_PRESENTATION, MarketSignalSection } from './MarketSignalSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result: MarketSignalResult = {
  status: 'available',
  symbol: 'AAPL',
  state: 'SQUEEZE',
  bias: 'bullish',
  score: 31,
  confidence: 67,
  confidenceLabel: 'Medium',
  timeframe: '1D',
  calculatedAt: '2026-07-25T00:00:00.000Z',
  latestCandleAt: '2026-07-24',
  source: 'yahoo-finance-chart',
  freshness: { status: 'end-of-day', asOf: '2026-07-24T20:00:00.000Z', maxAgeSeconds: 21_600 },
  dataPoints: { received: 260, finalized: 259 },
  scoreBreakdown: {
    emaTrend: { points: 12, maxPoints: 30, normalizedScore: 0.4, coverage: 1, factorsUsed: 4, available: true },
    momentum: { points: 8, maxPoints: 25, normalizedScore: 0.32, coverage: 1, factorsUsed: 3, available: true },
    trendStrength: { points: 4, maxPoints: 15, normalizedScore: 0.2667, coverage: 1, factorsUsed: 1, available: true },
    volume: { points: 3, maxPoints: 15, normalizedScore: 0.2, coverage: 1, factorsUsed: 2, available: true },
    priceStructure: { points: 4, maxPoints: 15, normalizedScore: 0.2667, coverage: 1, factorsUsed: 2, available: true },
  },
  reasons: [
    { id: 'ema-structure', polarity: 'positive', text: 'ราคาและ EMA เรียงตัวเอนขึ้น', impact: 8 },
    { id: 'squeeze-on', polarity: 'caution', text: 'Bollinger Bands อยู่ภายใน Keltner Channels', impact: 6 },
  ],
  warnings: ['ยังไม่ยืนยัน RSI/MACD divergence จาก historical pivots'],
  flags: ['squeeze', 'weak_confirmation'],
  metrics: {
    close: 206.84,
    ema20: 200,
    ema50: 190,
    ema200: null,
    ema20SlopePct: 1.2,
    ema50SlopePct: 0.8,
    ema200SlopePct: null,
    emaCompressionRatio: null,
    rsi14: 62,
    macd: 2.1,
    macdSignal: 1.8,
    macdHistogram: 0.3,
    adx14: 24,
    plusDi14: 31,
    minusDi14: 18,
    relativeVolume20: 1.4,
    obvTrend: 'rising',
    bollingerUpper: 208,
    bollingerMiddle: 202,
    bollingerLower: 196,
    keltnerUpper: 210,
    keltnerMiddle: 202,
    keltnerLower: 194,
    squeezeOn: true,
    atr14: 4,
    ema20DeviationPct: 3.42,
    atrNormalizedDistance: 1.71,
    nearestSupport: 195,
    nearestResistance: 215,
    divergence: null,
  },
  confidenceBreakdown: {
    completeness: 85,
    agreement: 74,
    evidenceStrength: 31,
    volumeConfirmation: 20,
    regimeClarity: 100,
    conflictPenalty: 5,
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('React', React);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  value: MarketSignalResult | null = result,
  tier: SubscriptionTier = 'elite',
  livePrice: number | null = null,
) {
  await act(async () => root.render(
    <EntitlementProvider tier={tier} authenticated trialOffer="used">
      <MarketSignalSection result={value} livePrice={livePrice} />
    </EntitlementProvider>,
  ));
}

function buttonContaining(text: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text))!;
}

describe('MarketSignalSection', () => {
  it.each(['basic', 'pro'] as const)('shows only a locked preview for %s', async (tier) => {
    await render(result, tier);

    expect(container.querySelector('[data-testid="technical-outlook-locked"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="locked-technical.outlook"]')).not.toBeNull();
    expect(container.textContent).not.toContain('SQUEEZE');
    expect(container.textContent).not.toContain('Score +31');
    expect(container.textContent).not.toContain('Confidence 67%');
    expect(container.textContent).not.toContain('ราคาและ EMA เรียงตัวเอนขึ้น');
    expect(container.textContent).not.toContain('206.84');
  });

  it('shows state, independent bias, beginner copy, score/confidence, flags, and the exact disclaimer', async () => {
    await render();
    expect(container.textContent).toContain('SQUEEZE • Bullish Bias');
    expect(container.textContent).toContain('สะสมพลัง / เตรียมเลือกทาง');
    expect(container.textContent).toContain('ยังไม่ยืนยันการเบรก แต่โครงสร้างปัจจุบันเอนเอียงไปทางขาขึ้น');
    expect(container.textContent).toContain('Score +31 / 100');
    expect(container.textContent).toContain('Confidence 67%');
    expect(container.textContent).toContain('squeeze');
    expect(container.textContent).toContain('Market Signal เป็นการสรุปข้อมูลทางเทคนิค ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย');
  });

  it('uses accessible score and confidence hints with the required non-probability copy', async () => {
    await render();
    const scoreHint = container.querySelector<HTMLButtonElement>('[aria-label="คำอธิบาย: Directional Score"]')!;
    expect(scoreHint.className).toContain("after:-inset-[13px]");
    await act(async () => scoreHint.click());
    expect(container.textContent).toContain('Score วัดว่าหลักฐานทางเทคนิคเอนเอียงขึ้นหรือลงแค่ไหน อยู่ระหว่าง -100 ถึง +100 และไม่ใช่เปอร์เซ็นต์ความแม่นยำ');
    await act(async () => scoreHint.click());

    const confidenceHint = container.querySelector<HTMLButtonElement>('[aria-label="คำอธิบาย: Signal Confidence"]')!;
    await act(async () => confidenceHint.click());
    expect(container.textContent).toContain('Confidence วัดว่าหลักฐานที่ระบบมีครบและสอดคล้องกันแค่ไหน ไม่ใช่โอกาสที่ราคาจะขึ้นหรือลง');
  });

  it('opens the responsive why dialog with six sections, exact breakdown, real metrics, and missing values as dash', async () => {
    await render();
    const why = buttonContaining('ทำไม?');
    expect(why.className).toContain('min-h-11');
    await act(async () => why.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.className).toContain('max-h-[min(calc(100dvh-24px),100%)]');
    expect(dialog.textContent).toContain('1. สถานะนี้แปลว่าอะไร');
    expect(dialog.textContent).toContain('2. ระบบดูจากอะไร');
    expect(dialog.textContent).toContain('3. คะแนนมาจากอะไร');
    expect(dialog.textContent).toContain('4. ปัจจัยสนับสนุน');
    expect(dialog.textContent).toContain('5. ปัจจัยที่ต้องระวัง');
    expect(dialog.textContent).toContain('6. สิ่งที่ยังไม่ยืนยัน');
    expect(dialog.textContent).toContain('EMA / Trend');
    expect(dialog.textContent).toContain('+12 / 30');
    expect(dialog.textContent).toContain('รวม+31 / 100');
    expect(dialog.textContent).toContain('Bollinger U / M / L');
    expect(dialog.textContent).toContain('Keltner U / M / L');
    expect(dialog.textContent).toContain('200 / 190 / —');
    expect(dialog.textContent).toContain('Source: yahoo-finance-chart');
  }, 15_000);

  it('maps all seven states to distinct text-labelled state styling', async () => {
    const states = Object.keys(MARKET_SIGNAL_PRESENTATION) as MarketSignalState[];
    for (const state of states) {
      await render({ ...result, state, bias: state.includes('BEARISH') ? 'bearish' : state === 'SIDEWAYS' ? 'neutral' : 'bullish' });
      const section = container.querySelector<HTMLElement>('[data-state]')!;
      expect(section.dataset.state).toBe(state);
      expect(section.className).toContain(MARKET_SIGNAL_PRESENTATION[state].tone.split(' ')[0]);
      expect(container.textContent).toContain(state);
      expect(container.textContent).toContain(MARKET_SIGNAL_PRESENTATION[state].thai);
    }
  }, 15_000);

  it('resets open dialog state when the symbol changes', async () => {
    await render();
    await act(async () => buttonContaining('ทำไม?').click());
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
    await render({ ...result, symbol: 'MSFT' });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('SQUEEZE • Bullish Bias');
  });

  it('does not invent a state, bias, score, or confidence for insufficient data', async () => {
    const insufficient: MarketSignalResult = {
      ...result,
      status: 'insufficient-data',
      state: null,
      bias: null,
      score: null,
      confidence: 0,
      confidenceLabel: 'Insufficient',
      reason: 'ต้องมี finalized candles เพิ่ม',
    };
    await render(insufficient);
    expect(container.textContent).toContain('ข้อมูลไม่เพียงพอ');
    expect(container.textContent).toContain('ต้องมี finalized candles เพิ่ม');
    expect(container.textContent).not.toContain('SQUEEZE • Bullish Bias');
    expect(container.textContent).not.toContain('Score +31');
  });

  /*
   * A MACD row was reported from a screen as "-0.1121 / -0.1386 / +1.2741",
   * which cannot be true of any three numbers: the histogram is the difference
   * of the other two, and -0.1121 - (-0.1386) is 0.0265, not 1.2741. The
   * reported signal is exactly the engine's value divided by ten, so the
   * question was whether something between the engine and the screen was
   * scaling it.
   *
   * This renders the real captured IREN metrics through the real component and
   * reads the DOM. Nothing in that path does arithmetic, and this test is what
   * keeps it that way: any future formatter that rescales a metric on its way to
   * a reader fails here.
   */
  it('renders MACD, signal and histogram exactly as the engine computed them', async () => {
    const captured = {
      macd: -0.11205758719454195,
      macdSignal: -1.3861779991116565,
      macdHistogram: 1.2741204119171146,
    };
    await render({ ...result, metrics: { ...result.metrics, ...captured } });
    await act(async () => buttonContaining('ทำไม?').click());

    const row = [...document.querySelectorAll('dt')]
      .find((term) => term.textContent === 'MACD / Signal / Histogram')!.nextElementSibling!;
    expect(row.textContent).toBe('-0.1121 / -1.3862 / 1.2741');
    // The identity the reported trio violated, restated against the rendered text.
    expect(captured.macd - captured.macdSignal).toBeCloseTo(captured.macdHistogram, 12);
  });


  /*
   * P2 rendering is keyed off `result.zones`, which the engine only produces
   * when `SIGNAL_ZONES` is on. The zone bar sits BELOW score and confidence and
   * adds nothing above them, so the existing layout is untouched.
   */
  describe('with trend zones on', () => {
    const zoned: MarketSignalResult = {
      ...result,
      state: 'SIDEWAYS',
      bias: 'neutral',
      score: 16,
      zones: {
        mode: 'structural',
        zone: 'sideways',
        support: 39.2727,
        resistance: 46.2297,
        upperTrigger: 47.244,
        lowerTrigger: 38.2583,
        positionPct: 68.8,
        upperDistance: 3.184,
        upperDistanceAtr: 0.78,
        lowerDistance: 5.8017,
        lowerDistanceAtr: 1.43,
        zoneAgeBars: 9,
        lastTestedBarsAgo: 0,
        pendingBreakout: false,
        pendingBreakdown: false,
        referenceClose: 44.06,
        referenceDate: '2026-08-14',
      },
    };

    it('says which close every number is measured from', async () => {
      await render(zoned);
      const bar = container.querySelector('[data-testid="signal-zone-bar"]')!;
      expect(bar.textContent).toContain('อิงราคาปิด 44.06 (2026-08-14)');
      expect(bar.textContent).toContain('ใช้ราคาปิดยืนยันเท่านั้น');
    });

    it('states both triggers with their distance in price and in ATR', async () => {
      await render(zoned);
      const bar = container.querySelector('[data-testid="signal-zone-bar"]')!;
      expect(bar.textContent).toContain('47.24');
      expect(bar.textContent).toContain('0.78 ATR');
      expect(bar.textContent).toContain('38.26');
      expect(bar.textContent).toContain('1.43 ATR');
      expect(bar.textContent).toContain('68.8% ของกรอบ');
      expect(bar.textContent).toContain('โซนนี้ยืนมา 9 แท่ง');
    });

    it('words the triggers as conditions, never as instructions', async () => {
      await render(zoned);
      const bar = container.querySelector('[data-testid="signal-zone-bar"]')!;
      expect(bar.textContent).toContain('ถ้าปิดเหนือ');
      expect(bar.textContent).toContain('จะเข้าเงื่อนไขโซนขาขึ้น');
      expect(bar.textContent).not.toMatch(/ซื้อเมื่อ|ขายเมื่อ|ควรซื้อ|ควรขาย|แนะนำให้/);
    });

    it('draws the live price as its own marker and says it has not crossed', async () => {
      await render(zoned, 'elite', 46.31);
      const bar = container.querySelector('[data-testid="signal-zone-bar"]')!;
      expect(bar.textContent).toContain('ราคาสด 46.31');
      expect(bar.textContent).toContain('ยังไม่ผ่านแนวทั้งสองฝั่ง');
    });

    /*
     * The case the brief called out: the header shows a live price that has
     * already cleared the trigger while the signal still reads from a close
     * below it. Saying nothing invites a reader to conclude the card is stale.
     */
    it('says so out loud when the live price has crossed a trigger', async () => {
      await render(zoned, 'elite', 47.9);
      const bar = container.querySelector('[data-testid="signal-zone-bar"]')!;
      expect(bar.textContent).toContain('ผ่านแนวบนไปแล้ว — รอปิดแท่งยืนยัน');
    });

    it('names an open side rather than drawing a level nobody defended', async () => {
      const open: MarketSignalResult = {
        ...zoned,
        state: 'BULLISH',
        bias: 'bullish',
        zones: {
          ...zoned.zones!,
          mode: 'open_above',
          zone: 'uptrend',
          resistance: null,
          upperTrigger: null,
          positionPct: null,
          upperDistance: null,
          upperDistanceAtr: null,
        },
      };
      await render(open);
      const bar = container.querySelector('[data-testid="signal-zone-bar"]')!;
      expect(bar.textContent).toContain('ไม่มีแนวที่ยืนยันแล้วฝั่งนี้');
      expect(bar.textContent).toContain('ไม่เหลือแนวต้านที่ยืนยันแล้วเหนือราคา');
      expect(bar.textContent).not.toContain('% ของกรอบ');
    });

    it('reports the score as a lean inside the zone, not as a direction', async () => {
      await render(zoned);
      const bar = container.querySelector('[data-testid="signal-zone-bar"]')!;
      expect(bar.textContent).toContain('อยู่ในกรอบระหว่างแนวรับและแนวต้าน');
      expect(bar.textContent).toContain('เอียงขึ้นเล็กน้อย (+16)');
    });

    it('draws no zone bar at all when the flag is off', async () => {
      await render(result);
      expect(container.querySelector('[data-testid="signal-zone-bar"]')).toBeNull();
    });
  });
  /*
   * P1 rendering is keyed off `result.gate`, which the engine only produces when
   * `SIGNAL_GATE` is on. Everything above this block is the flags-OFF card and
   * passes unchanged — that is the evidence that turning the flag off really
   * does give a reader back the card they had.
   */
  describe('with the consistency layer on', () => {
    const gated: MarketSignalResult = {
      ...result,
      state: 'SIDEWAYS',
      bias: 'neutral',
      score: 11,
      confidence: 27,
      confidenceLabel: 'Low',
      flags: ['strong_momentum', 'conflicting_evidence', 'low_volume_confirmation', 'high_volume', 'squeeze', 'weak_confirmation'],
      gate: {
        band: 'neutral',
        conflicts: ['ema_vs_momentum'],
        forcedNeutral: false,
        earningsProximity: 'soon',
        daysToEarnings: 10,
        confidenceFactors: { base: 72.66, completeness: 1, agreement: 0.7, regimeClarity: 0.6, conflict: 0.9, earnings: 0.8 },
      },
    };

    it('draws at most four chips, most consequential first, and says where the rest went', async () => {
      await render(gated);
      const chips = [...container.querySelector('[aria-label="Signal flags"]')!.children].map((chip) => chip.textContent);
      expect(chips).toHaveLength(5);
      // Sorted by consequence, not by the order the engine happened to push them:
      // the conflict that voided the direction leads, the decorative ones drop off.
      expect(chips.slice(0, 4)).toEqual(['หลักฐานขัดแย้งกัน', 'วอลุ่มไม่ยืนยัน', 'ยังยืนยันไม่ชัด', 'ความผันผวนบีบตัว']);
      expect(chips.at(-1)).toContain('+2');
    });

    it('explains in the dialog why it would not commit to a direction', async () => {
      await render(gated);
      await act(async () => buttonContaining('ทำไม?').click());
      const explainer = document.querySelector('[data-testid="signal-gate-explainer"]')!;
      expect(explainer.textContent).toContain('คะแนนรวมยังต่ำกว่าเกณฑ์');
      expect(explainer.textContent).toContain('EMA/Trend กับ Momentum ชี้คนละทาง');
      expect(explainer.textContent).toContain('อีก 10 วันจะประกาศงบ');
      // The overflow chips are listed rather than lost.
      expect(explainer.textContent).toContain('โมเมนตัมแรง');
      expect(explainer.textContent).toContain('วอลุ่มสูง');
    });

    it('shows confidence as the multipliers it actually is', async () => {
      await render(gated);
      await act(async () => buttonContaining('ทำไม?').click());
      const explainer = document.querySelector('[data-testid="signal-gate-explainer"]')!;
      expect(explainer.textContent).toContain('× ความชัดของภาวะตลาด');
      expect(explainer.textContent).toContain('60%');
      expect(explainer.textContent).toContain('× ระยะถึงวันงบ');
      expect(explainer.textContent).toContain('80%');
    });

    it('leaves the card alone when there is no gate block', async () => {
      await render(result);
      const chips = [...container.querySelector('[aria-label="Signal flags"]')!.children].map((chip) => chip.textContent);
      expect(chips).toEqual(['squeeze', 'weak confirmation']);
      expect(container.querySelector('[data-testid="signal-gate-explainer"]')).toBeNull();
    });
  });
});
