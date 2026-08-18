// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import type { MarketSignalResult, MarketSignalState } from '@/src/lib/analytics/market-signal/types';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import { MARKET_SIGNAL_MEASURED } from '@/src/config/signal';
import { MARKET_SIGNAL_PRESENTATION, MarketSignalSection, zoneLabelStyle } from './MarketSignalSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result: MarketSignalResult = {
  status: 'available',
  symbol: 'AAPL',
  state: 'SQUEEZE',
  bias: 'bullish',
  score: 31,
  confidence: 67,
  confidenceLabel: 'Medium',
  evidenceAgreement: 67,
  evidenceAgreementLabel: 'Medium',
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
  capability: SubscriptionCapability = 'technical.outlook',
) {
  await act(async () => root.render(
    <EntitlementProvider tier={tier} authenticated trialOffer="used">
      <MarketSignalSection result={value} livePrice={livePrice} capability={capability} />
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
    expect(container.textContent).not.toContain('หลักฐานไปทางเดียวกันบ้าง');
    expect(container.textContent).not.toContain('ราคาและ EMA เรียงตัวเอนขึ้น');
    expect(container.textContent).not.toContain('206.84');
  });

  /*
   * The locked preview is the surface where the old promise and the new honesty
   * would have met: its description sits a few centimetres above the footer
   * saying the card does not forecast, so a word like "ความมั่นใจ" there would
   * contradict the sentence directly underneath it. It is also the surface where
   * somebody decides whether to pay.
   */
  it.each(['basic', 'pro'] as const)('sells %s nothing the card will not show', async (tier) => {
    await render(result, tier);
    const locked = container.querySelector('[data-testid="technical-outlook-locked"]')!;
    /*
     * Scoped to the SUMMARY, not the whole section. The footer underneath says
     * "ไม่ได้พยากรณ์สิ่งที่ราคาจะทำ", and a forbidden-word scan over the section
     * would fail on the very sentence doing the disclosing.
     */
    const summary = locked.querySelector('[data-testid="technical-outlook-locked-summary"]')!;
    ['ความมั่นใจ', 'Confidence', 'แม่นยำ', 'ทำนาย', 'พยากรณ์'].forEach((word) => {
      expect(summary.textContent, `"${word}" is back in the locked preview`).not.toContain(word);
    });
    // And it still describes what is actually there.
    expect(summary.textContent).toContain('เหตุผลว่าทำไมถึงสรุปแบบนั้น');
    // The not-a-forecast line reaches this reader too — it is the same footer.
    expect(locked.textContent).toContain('ไม่ได้พยากรณ์สิ่งที่ราคาจะทำ');
  });

  it('shows state, independent bias, beginner copy, score, flags, and the exact disclaimer', async () => {
    await render();
    expect(container.textContent).toContain('SQUEEZE • Bullish Bias');
    expect(container.textContent).toContain('สะสมพลัง / เตรียมเลือกทาง');
    expect(container.textContent).toContain('ยังไม่ยืนยันการเบรก แต่โครงสร้างปัจจุบันเอนเอียงไปทางขาขึ้น');
    expect(container.textContent).toContain('Score +31 / 100');
    expect(container.textContent).toContain('squeeze');
    expect(container.textContent).toContain('Market Signal เป็นการสรุปข้อมูลทางเทคนิค ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย');
  });

  /*
   * P4a measured what the old headline was worth: the 90-99 band hit 53-55%,
   * which is what the 20-29 band hit. A reader shown "67%" next to a direction
   * reads a probability, and the number is not one. The word stays on the card;
   * the figure moved into the breakdown where its inputs are.
   */
  describe('no number on the card can be read as a probability of price', () => {
    it('names the evidence agreement in words, without a percentage', async () => {
      await render();
      const headline = container.querySelector('[data-state]')!;
      expect(headline.textContent).toContain('ความสอดคล้องของหลักฐาน');
      expect(headline.textContent).toContain('หลักฐานไปทางเดียวกันบ้าง');
      expect(headline.textContent).not.toContain('Confidence');
      expect(headline.textContent).not.toContain('67%');
    });

    it('keeps the figure, in the breakdown, said as a score out of 100', async () => {
      await render();
      await act(async () => buttonContaining('ทำไม?').click());
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.textContent).toContain('67/100');
      expect(dialog.textContent).toContain('ไม่ใช่ % โอกาสที่ราคาจะไปทางนั้น');
    });

    /*
     * The blunt version, scoped to the card that ships today — flags off, no
     * zone bar. Every percentage the later phases add is a distance
     * (`4.13% จากราคาปิด`) or a position in a frame (`113.7% ของกรอบ`), both of
     * which are read as measurements; this asserts the DEFAULT card carries no
     * percentage at all beside the direction, which is where a reader would
     * have taken one for a likelihood.
     */
    it('prints no bare percentage next to the direction', async () => {
      await render();
      const headline = container.querySelector('[data-state]')!;
      const percentages = [...(headline.textContent ?? '').matchAll(/(\S+)\s*%/g)].map((match) => match[0]);
      expect(percentages).toEqual([]);
    });
  });

  it('uses accessible score and confidence hints with the required non-probability copy', async () => {
    await render();
    const scoreHint = container.querySelector<HTMLButtonElement>('[aria-label="คำอธิบาย: Directional Score"]')!;
    expect(scoreHint.className).toContain("after:-inset-[13px]");
    await act(async () => scoreHint.click());
    expect(container.textContent).toContain('Score วัดว่าหลักฐานทางเทคนิคเอนเอียงขึ้นหรือลงแค่ไหน อยู่ระหว่าง -100 ถึง +100 และไม่ใช่เปอร์เซ็นต์ความแม่นยำ');
    await act(async () => scoreHint.click());

    const agreementHint = container.querySelector<HTMLButtonElement>('[aria-label="คำอธิบาย: ความสอดคล้องของหลักฐาน"]')!;
    await act(async () => agreementHint.click());
    expect(container.textContent).toContain('เป็นการวัดตัวระบบเอง ไม่ใช่โอกาสที่ราคาจะขึ้นหรือลง');
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
      evidenceAgreement: 0,
      evidenceAgreementLabel: 'Insufficient',
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
        frameAgeBars: 12,
        proximity: 'near_trigger',
        nearestTriggerAtr: 0.78,
        zoneAgeBars: 9,
        lastTestedBarsAgo: 0,
        triggerCrossings: 14,
        pendingBreakout: false,
        pendingBreakdown: false,
        entry: null,
        referenceClose: 44.06,
        referenceDate: '2026-08-14',
      },
    };

    const zoneBar = () => container.querySelector('[data-testid="signal-zone-bar"]')!;
    const segment = (id: string) => zoneBar().querySelector<HTMLElement>(`[data-zone="${id}"]`)!;
    const widthOf = (id: string) => Number.parseFloat(segment(id).style.width);
    const leftOf = (id: string) => Number.parseFloat(segment(id).style.left);

    it('says which close every number is measured from', async () => {
      await render(zoned);
      expect(zoneBar().textContent).toContain('ตัวเลขทั้งหมดวัดจากราคาปิด 44.06 วันที่ 2026-08-14');
      expect(zoneBar().textContent).toContain('นับเฉพาะราคาปิดของวัน ไม่นับที่แตะระหว่างวัน');
    });

    /*
     * The bar is three FIELDS, and the fields are the thing being tested.
     *
     * Before this it was one rail with two tick marks on it: nothing in the
     * drawing said which side was down and which was up, and the grid of numbers
     * underneath actively said the wrong one. So these assertions are about
     * geometry rather than about copy — order, non-zero width, and which field
     * the current label is in.
     */
    describe('the bar is divided into three fields a reader can see', () => {
      it('runs low on the left and high on the right, with all three fields drawn', async () => {
        await render(zoned);
        expect(leftOf('downtrend')).toBe(0);
        expect(leftOf('sideways')).toBeGreaterThan(leftOf('downtrend'));
        expect(leftOf('uptrend')).toBeGreaterThan(leftOf('sideways'));
        // None of them may collapse: the triggers used to BE the extremes of the
        // drawn extent, which left the two outer fields at zero width.
        for (const id of ['downtrend', 'sideways', 'uptrend']) {
          expect(widthOf(id), `${id} field collapsed`).toBeGreaterThan(10);
        }
        expect(leftOf('uptrend') + widthOf('uptrend')).toBeCloseTo(100, 6);
      });

      it('names each field on the bar itself, not underneath it', async () => {
        await render(zoned);
        expect(segment('downtrend').textContent).toBe('ขาลง');
        expect(segment('sideways').textContent).toBe('กรอบเดิม');
        expect(segment('uptrend').textContent).toBe('ขาขึ้น');
      });

      it('marks the field the current label is in, and only that one', async () => {
        await render(zoned);
        expect(segment('sideways').dataset.active).toBe('true');
        expect(segment('downtrend').dataset.active).toBe('false');
        expect(segment('uptrend').dataset.active).toBe('false');

        await render({ ...zoned, zones: { ...zoned.zones!, zone: 'uptrend' } });
        expect(segment('uptrend').dataset.active).toBe('true');
        expect(segment('sideways').dataset.active).toBe('false');
      });

      it('labels the price marker so a reader knows which mark is now', async () => {
        await render(zoned);
        expect(zoneBar().textContent).toContain('ตอนนี้ 44.06');
      });

      /*
       * The edge prices used to be the first and last cell of a two-column grid,
       * i.e. hard against the ends of the bar, pointing at nothing. They belong
       * under the cut they name, so this asserts the position they are given is
       * the position of the divider and not a corner.
       */
      it('puts each edge price under the cut it makes, not at the ends of the bar', async () => {
        await render(zoned);
        const edges = [...zoneBar().querySelectorAll<HTMLElement>('span.font-mono')]
          .filter((node) => ['38.26', '47.24'].includes(node.textContent ?? ''));
        expect(edges).toHaveLength(2);
        const lowerCut = leftOf('sideways');
        const upperCut = leftOf('uptrend');
        // Each price is anchored ON its own cut and grows inward from it, so the
        // lower one is placed from the left and the upper one from the right.
        expect(Number.parseFloat(edges[0].style.left)).toBeCloseTo(lowerCut, 6);
        expect(Number.parseFloat(edges[1].style.right)).toBeCloseTo(100 - upperCut, 6);
        expect(lowerCut).toBeGreaterThan(0);
        expect(upperCut).toBeLessThan(100);
      });

      /*
       * A label cannot hang off the side of its track: at 390px there is no
       * gutter to hang into, so it runs under the card's own padding. Outside
       * the middle fifth the label anchors to the marker and grows INWARD,
       * which is safe without knowing the label's width — the rule that
       * replaced an edge-pin `qa:signal-zone-bar` caught overhanging on a
       * six-figure price.
       */
      it('grows a floating label inward from its marker instead of overhanging', () => {
        expect(zoneLabelStyle(50)).toEqual({ left: '50%', transform: 'translateX(-50%)' });
        // Left of the band: the label starts at the mark and runs right.
        expect(zoneLabelStyle(2)).toEqual({ left: '2%' });
        expect(zoneLabelStyle(40)).toEqual({ left: '40%' });
        // Right of it: the label ends at the mark and runs left. 84% is the
        // position that put "ตอนนี้ 121,884" through the edge of the card.
        expect(zoneLabelStyle(84)).toEqual({ right: '16%' });
        expect(zoneLabelStyle(100)).toEqual({ right: '0%' });
      });

      it('keeps every field visible even when price is far outside the frame', async () => {
        await render({ ...zoned, zones: { ...zoned.zones!, zone: 'uptrend', referenceClose: 4406 } });
        for (const id of ['downtrend', 'sideways', 'uptrend']) {
          expect(widthOf(id), `${id} field collapsed`).toBeGreaterThan(10);
        }
      });
    });

    it('states both triggers as a percentage away from the price on screen', async () => {
      await render(zoned);
      // 5.8017 / 44.06 and 3.184 / 44.06, from the engine's own distances.
      expect(zoneBar().textContent).toContain('ต่ำกว่าตอนนี้ 13.2%');
      expect(zoneBar().textContent).toContain('สูงกว่าตอนนี้ 7.2%');
    });

    /*
     * The removal list, asserted as a list.
     *
     * Every one of these is still in the payload and still in "ทำไม?" — what is
     * being tested is that the beginner's surface no longer carries any of them.
     * A regression here is somebody putting a unit back on the card because it
     * was convenient, which is exactly how the card got this way.
     */
    it('carries no ATR, no percent-of-frame, no bar ages and no raw ratio', async () => {
      await render({
        ...zoned,
        actionable: {
          invalidation: 42.24,
          invalidationAtr: 0.45,
          invalidationPct: 4.13,
          invalidationBasis: 'zone_floor',
          target: 58.51,
          targetAtr: 3.56,
          targetBasis: 'measured_move',
          targetIsConvention: true,
          riskReward: 7.94,
          notes: [],
        },
        zones: { ...zoned.zones!, zone: 'uptrend' },
      });
      const text = zoneBar().textContent ?? '';
      for (const banned of ['ATR', 'swing', '68.8%', 'ของกรอบ', 'แท่ง', '7.94']) {
        expect(text, `"${banned}" is back on the card`).not.toContain(banned);
      }
    });

    it('words the triggers as conditions, never as instructions', async () => {
      await render(zoned);
      expect(zoneBar().textContent).toContain('ถ้าปิดเหนือ');
      expect(zoneBar().textContent).toContain('ถือว่าเข้าโซนขาขึ้น');
      expect(zoneBar().textContent).toContain('ถือว่าเข้าโซนขาลง');
      expect(zoneBar().textContent).not.toMatch(/ซื้อเมื่อ|ขายเมื่อ|ควรซื้อ|ควรขาย|แนะนำให้/);
    });

    /*
     * The reversal the brief opened with: the up condition was in the LEFT cell
     * of the grid while the bar drew up on the right.
     */
    it('lists the down condition before the up one, matching the bar', async () => {
      await render(zoned);
      const labels = [...zoneBar().querySelectorAll('dt')].map((node) => node.textContent?.trim());
      expect(labels.indexOf('ถ้าปิดต่ำกว่า')).toBeLessThan(labels.indexOf('ถ้าปิดเหนือ'));
    });

    /*
     * The live price is the number on screen, and the one the reader's eye is
     * already on. It gets a mark on the bar, a caption of its own, and a line
     * that names the FIELD it is standing in — "ยังไม่ผ่านขอบกรอบทั้งสองฝั่ง"
     * was the same sentence for a price in the middle of the frame and for one
     * a hair under the trigger, which is to say it was not a status at all.
     */
    it('draws the live price as its own marker, captioned, beside the close', async () => {
      await render(zoned, 'elite', 46.31);
      expect(zoneBar().textContent).toContain('ราคาสด 46.31');
      expect(zoneBar().textContent).toContain('ยังอยู่ในกรอบเดิมเหมือนราคาปิด');
      // The caption ON the bar, so the thin mark is identifiable without the
      // sentence underneath it.
      expect(zoneBar().textContent).toContain('สด 46.31');
      expect(zoneBar().querySelector('[data-marker="live"]')).not.toBeNull();
      // And it is not the price the percentages are measured from.
      expect(zoneBar().textContent).toContain('ตอนนี้ 44.06');
    });

    it('never drops the live marker, whatever the caption does', async () => {
      // Live and close a hair apart: the two captions are in rows of their own
      // precisely so neither has to be dropped here.
      await render(zoned, 'elite', 44.07);
      expect(zoneBar().querySelector('[data-marker="live"]')).not.toBeNull();
      expect(zoneBar().querySelector('[data-marker="close"]')).not.toBeNull();
      expect(zoneBar().textContent).toContain('สด 44.07');
    });

    /*
     * The case the brief called out: the header shows a live price that has
     * already cleared the trigger while the signal still reads from a close
     * below it. Saying nothing invites a reader to conclude the card is stale.
     */
    it('says so out loud when the live price has left the close’s field', async () => {
      await render(zoned, 'elite', 47.9);
      expect(zoneBar().textContent).toContain('ราคาสด 47.9 ขึ้นไปเหนือกรอบเดิมแล้ว');
      expect(zoneBar().textContent).toContain('โซนจะเปลี่ยนก็ต่อเมื่อปิดแบบนี้');
    });

    /*
     * IREN, 2026-08-18: upper trigger 43.25, close 44.06, live 42.38. The
     * headline reads BULLISH off a close above the frame while the number on
     * screen has already fallen back inside it. One marker at 44.06 in a green
     * field is a reader concluding the move is still on.
     *
     * The sides are read off the TRIGGERS, not off `zones.zone` — the engine's
     * label is a statement about a finalized close after hysteresis, and the
     * live price has been through neither.
     */
    describe('when the live price is in a different field from the close', () => {
      const crossedBack: MarketSignalResult = {
        ...zoned,
        state: 'BULLISH',
        bias: 'bullish',
        score: 34,
        zones: {
          ...zoned.zones!,
          zone: 'uptrend',
          upperTrigger: 43.25,
          lowerTrigger: 38.2583,
          referenceClose: 44.06,
          upperDistance: -0.81,
          upperDistanceAtr: -0.2,
          nearestTriggerAtr: -0.2,
        },
      };

      it('says the live price fell back inside the frame, and what would change the zone', async () => {
        await render(crossedBack, 'elite', 42.38);
        const line = container.querySelector('[data-testid="signal-live-price"]')!;
        expect(line.textContent).toContain('ราคาสด 42.38 ตกกลับเข้ากรอบเดิมแล้ว');
        expect(line.textContent).toContain('โซนจะเปลี่ยนก็ต่อเมื่อปิดแบบนี้');
      });

      it('weights that line harder than the rest of the box', async () => {
        await render(crossedBack, 'elite', 42.38);
        const line = container.querySelector('[data-testid="signal-live-price"]')!;
        expect(line.getAttribute('data-diverges')).toBe('true');
        expect(line.className).toContain('font-semibold');
        expect(line.className).toContain('text-amber-200');
        expect(line.className).not.toContain('text-slate-400');
      });

      it('leaves the line in the ordinary weight when both marks are in one field', async () => {
        await render(crossedBack, 'elite', 44.2);
        const line = container.querySelector('[data-testid="signal-live-price"]')!;
        expect(line.getAttribute('data-diverges')).toBe('false');
        expect(line.className).toContain('text-slate-400');
        expect(line.className).not.toContain('font-semibold');
        expect(line.textContent).toContain('ยังอยู่เหนือกรอบเดิมเหมือนราคาปิด');
      });

      it('draws the two marks apart, the live one thinner than the close', async () => {
        await render(crossedBack, 'elite', 42.38);
        const live = zoneBar().querySelector<HTMLElement>('[data-marker="live"]')!;
        const close = zoneBar().querySelector<HTMLElement>('[data-marker="close"]')!;
        const at = (node: HTMLElement) => Number.parseFloat(node.style.left);
        // 42.38 is below 44.06, and left is low on this bar.
        expect(at(live)).toBeLessThan(at(close));
        // Thinner and fainter: the label moves on closes, not on the live tick.
        expect(live.className).toContain('w-1 ');
        expect(close.className).toContain('w-1.5');
        expect(live.className).toContain('bg-white/45');
        expect(close.className).toContain('bg-white/90');
      });

      it('says the other direction when the live price breaks out of the frame', async () => {
        await render({ ...zoned, zones: { ...zoned.zones!, zone: 'sideways' } }, 'elite', 37.1);
        const line = container.querySelector('[data-testid="signal-live-price"]')!;
        expect(line.textContent).toContain('ราคาสด 37.1 หลุดลงใต้กรอบเดิมแล้ว');
        expect(line.getAttribute('data-diverges')).toBe('true');
      });
    });

    it('says a broken-out zone in words, and keeps the percentage off the frame', async () => {
      const broken: MarketSignalResult = {
        ...zoned,
        state: 'BULLISH',
        bias: 'bullish',
        zones: { ...zoned.zones!, zone: 'uptrend', positionPct: 113.7, upperDistance: -0.81, upperDistanceAtr: -0.2 },
      };
      await render(broken);
      expect(zoneBar().textContent).toContain('ราคาขึ้นมาเหนือกรอบเดิมแล้ว');
      expect(zoneBar().textContent).toContain('ราคาผ่านขึ้นไปแล้ว');
      expect(zoneBar().textContent).not.toContain('113.7');
    });

    /*
     * The contradiction this removes: the headline read "BULLISH · Bullish
     * Bias" and the zone box, three lines below it, opened with "ยังไม่เอียงไป
     * ทางไหน". Two sentences a thumb-length apart saying opposite things, and
     * the one a fast reader believes is the big one at the top. Direction is
     * the headline's job and the chips' job; the box below is about WHERE
     * price is. The score itself is untouched and still on the card above.
     */
    it('says nothing about direction inside the zone box', async () => {
      await render(zoned);
      const text = zoneBar().textContent ?? '';
      expect(text).toContain('ราคายังอยู่ในกรอบเดิม');
      for (const banned of ['ยังไม่เอียงไปทางไหน', 'เอียงขึ้น', 'เอียงลง', '(+16)']) {
        expect(text, `"${banned}" is back in the zone box`).not.toContain(banned);
      }
      // Still on the card, above the box, where direction belongs.
      expect(container.textContent).toContain('+16 / 100');
    });

    it('keeps the position line, which is what that line is now for', async () => {
      await render(zoned);
      expect(zoneBar().textContent).toContain('ราคาใกล้ขอบกรอบแล้ว');
      await render({ ...zoned, zones: { ...zoned.zones!, proximity: 'deep_range' } });
      expect(zoneBar().textContent).toContain('ราคายังอยู่กลางกรอบ ห่างขอบที่ใกล้ที่สุด');
      await render({ ...zoned, zones: { ...zoned.zones!, proximity: 'mid_range' } });
      expect(zoneBar().textContent).not.toContain('ห่างขอบที่ใกล้ที่สุด');
    });

    it('draws no zone bar at all when the flag is off', async () => {
      await render(result);
      expect(container.querySelector('[data-testid="signal-zone-bar"]')).toBeNull();
    });

    /*
     * P4.5, now said in words. The label outlasts the frame it describes — 74%
     * of sideways observations see price close outside the frame within twenty
     * bars, and two thirds of those keep the label only because the frame
     * re-anchored around the move. "โซนนี้ยืนมา 45 แท่ง · กรอบปัจจุบันตั้งมา 3
     * แท่ง" said that by handing the reader the arithmetic; the sentence has to
     * fire on exactly the same cases without the two numbers.
     */
    it('warns that a zone standing on a new frame can still flip', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, zoneAgeBars: 45, frameAgeBars: 3 } });
      expect(zoneBar().textContent).toContain('แต่เพิ่งผ่านมาไม่นาน ยังพลิกกลับได้ง่าย');
    });

    it('warns when the zone itself is the new thing', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, zoneAgeBars: 1, frameAgeBars: 40 } });
      expect(zoneBar().textContent).toContain('แต่เพิ่งผ่านมาไม่นาน ยังพลิกกลับได้ง่าย');
    });

    it('stays quiet when both the zone and its frame have stood a while', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, zoneAgeBars: 45, frameAgeBars: 40 } });
      expect(zoneBar().textContent).not.toContain('เพิ่งผ่านมาไม่นาน');
    });

    /*
     * The proximity band predicts label durability over about five bars and
     * nothing else — accuracy is indistinguishable across all three. So
     * `near_trigger` may say the label is unstable, and `deep_range` may say
     * only where price is.
     */
    it('says near_trigger means the label may change, not that it is less accurate', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, proximity: 'near_trigger' } });
      expect(zoneBar().textContent).toContain('โซนนี้จึงเปลี่ยนได้ในไม่กี่วันทำการ');
      expect(zoneBar().textContent).toContain('ราคาใกล้ขอบกรอบแล้ว (ห่างอีก 7.2%)');
    });

    it('never implies deep_range is the more trustworthy reading', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, proximity: 'deep_range', nearestTriggerAtr: 4.1 } });
      expect(zoneBar().textContent).toContain('ราคายังอยู่กลางกรอบ ห่างขอบที่ใกล้ที่สุด 7.2%');
      ['น่าเชื่อถือ', 'แม่นยำ', 'มั่นใจได้', 'ชัดเจนกว่า'].forEach((phrase) => {
        expect(zoneBar().textContent).not.toContain(phrase);
      });
    });

    /*
     * Nothing was deleted, only moved. "ทำไม?" is where the reader who wants the
     * old card goes, so it has to hold every figure the card stopped printing.
     */
    it('keeps every figure it removed from the card inside the why dialog', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, zoneAgeBars: 45, frameAgeBars: 3 } });
      await act(async () => buttonContaining('ทำไม?').click());
      const details = document.querySelector('[data-testid="signal-zone-details"]')!;
      expect(details.textContent).toContain('68.8%');
      expect(details.textContent).toContain('swing high/low');
      expect(details.textContent).toContain('0.78 ATR');
      expect(details.textContent).toContain('1.43 ATR');
      expect(details.textContent).toContain('45 แท่ง');
      expect(details.textContent).toContain('3 แท่ง');
      expect(details.textContent).toContain('0 แท่งก่อน');
    });

    it('draws no zone detail block when there is no zone', async () => {
      await render(result);
      await act(async () => buttonContaining('ทำไม?').click());
      expect(document.querySelector('[data-testid="signal-zone-details"]')).toBeNull();
    });

    /*
     * P3 rendering is keyed off `result.actionable`, which the engine only
     * produces when `SIGNAL_ACTIONABLE` is on AND a zone exists. The rows live
     * inside the zone bar because that is what they are about: the price at which
     * the ZONE ends, not a stop the card is recommending.
     */
    describe('with the actionable layer on', () => {
      const actionable: MarketSignalResult = {
        ...zoned,
        state: 'BULLISH',
        bias: 'bullish',
        zones: {
          ...zoned.zones!,
          zone: 'uptrend',
          entry: { level: 43.72, height: 14.79, mode: 'structural', barsAgo: 1 },
        },
        actionable: {
          invalidation: 42.24,
          invalidationAtr: 0.45,
          invalidationPct: 4.13,
          invalidationBasis: 'zone_floor',
          target: 58.51,
          targetAtr: 3.56,
          targetBasis: 'measured_move',
          targetIsConvention: true,
          riskReward: 7.94,
          notes: [],
        },
      };

      it('states the invalidation as a condition, in percent, not as an instruction', async () => {
        await render(actionable);
        const rows = container.querySelector('[data-testid="signal-actionable"]')!;
        expect(rows.textContent).toContain('ถ้าปิดต่ำกว่า');
        expect(rows.textContent).toContain('42.24');
        // The brief's own example: "0.45 ATR · 4.13% จากราคาปิด" becomes this.
        expect(rows.textContent).toContain('ต่ำกว่าตอนนี้ 4.1%');
        expect(rows.textContent).not.toContain('ATR');
        // Nothing that tells a reader what to do with the number.
        ['ตั้ง stop', 'ควรซื้อ', 'ควรขาย', 'แนะนำ', 'เข้าซื้อ'].forEach((phrase) => {
          expect(rows.textContent).not.toContain(phrase);
        });
      });

      it('admits on the row itself that the target is a convention', async () => {
        await render(actionable);
        const rows = container.querySelector('[data-testid="signal-actionable"]')!;
        expect(rows.textContent).toContain('58.51');
        expect(rows.textContent).toContain('สูงกว่าตอนนี้ 32.8%');
        expect(rows.textContent).toContain('เป็นการคาดคะเนตามธรรมเนียมการอ่านกราฟ ยังไม่เคยทดสอบว่าแม่นจริงไหม');
      });

      it('says what the measured move IS, instead of naming the arithmetic', async () => {
        await render(actionable);
        const rows = container.querySelector('[data-testid="signal-actionable"]')!;
        expect(rows.textContent).toContain('กรอบเดิมสูงเท่าไร ก็มักไปได้อีกเท่านั้น');
        expect(rows.textContent).not.toContain('ระยะที่กรอบเดิมวัดได้');
      });

      /*
       * 7.94 is a correct quotient and it reads to a beginner as a grade. P4a
       * measured the signals carrying the biggest ones at +0.5 / +0.5 / -0.8pp
       * of edge, so the card says which leg is longer and the digits move into
       * the dialog beside the two distances they came from.
       */
      it('keeps the ratio off the card entirely, words and digits alike', async () => {
        await render(actionable);
        const rows = container.querySelector('[data-testid="signal-actionable"]')!;
        expect(rows.textContent).not.toContain('7.94');
        expect(rows.textContent).not.toContain('เทียบระยะสองฝั่ง');
        expect(rows.textContent).not.toContain('ระยะไปถึงเป้า ยาวกว่าระยะที่จะรู้ว่าโซนนี้จบ');
        expect(zoneBar().textContent).not.toContain('ระยะที่จะรู้ว่าโซนนี้จบ ยาวกว่า');

        await act(async () => buttonContaining('ทำไม?').click());
        const details = document.querySelector('[data-testid="signal-zone-details"]')!;
        expect(details.textContent).toContain('7.94');
        expect(details.textContent).toContain('0.45 ATR');
        expect(details.textContent).toContain('3.56 ATR');
        // The whole block moved, not just the number: the reading of the
        // quotient is now beside the quotient.
        expect(details.textContent).toContain('ระยะไปถึงเป้า ยาวกว่าระยะที่จะรู้ว่าโซนนี้จบ');
      });

      it('reads a ratio under one the other way round, in the dialog', async () => {
        await render({ ...actionable, actionable: { ...actionable.actionable!, riskReward: 0.6 } });
        await act(async () => buttonContaining('ทำไม?').click());
        const details = document.querySelector('[data-testid="signal-zone-details"]')!;
        expect(details.textContent).toContain('ระยะที่จะรู้ว่าโซนนี้จบ ยาวกว่าระยะไปถึงเป้า');
      });

      /*
       * A big ratio built on a tiny risk leg is arithmetically correct and
       * unstable. P4a measured those signals at +0.5 / +0.5 / -0.8pp of edge, so
       * the caveat travels with the number into the dialog.
       */
      it('says beside the number when the ratio rests on a risk leg inside the noise', async () => {
        await render({
          ...actionable,
          actionable: { ...actionable.actionable!, notes: ['risk_leg_inside_noise'] },
        });
        expect(container.querySelector('[data-testid="signal-actionable"]')!.textContent)
          .not.toContain('ไม่ได้แปลว่าโอกาสดีกว่า');
        await act(async () => buttonContaining('ทำไม?').click());
        const details = document.querySelector('[data-testid="signal-zone-details"]')!;
        expect(details.textContent).toContain('ไม่ได้แปลว่าโอกาสดีกว่า');
      });

      it('drops the note with the number when there is no ratio', async () => {
        await render({ ...actionable, actionable: { ...actionable.actionable!, riskReward: null } });
        await act(async () => buttonContaining('ทำไม?').click());
        expect(document.querySelector('[data-testid="signal-risk-reward-note"]')).toBeNull();
      });

      /*
       * The rule the whole layer turns on. A `null` row is ABSENT — an em dash in
       * a price row reads as a number the card is withholding, and sends a reader
       * looking for it elsewhere. Four instruments in five are in this state.
       */
      it('hides a row rather than drawing a placeholder for it', async () => {
        await render({
          ...actionable,
          actionable: {
            ...actionable.actionable!,
            target: null,
            targetAtr: null,
            targetBasis: null,
            targetIsConvention: false,
            riskReward: null,
            notes: ['no_measurable_frame'],
          },
        });
        const rows = container.querySelector('[data-testid="signal-actionable"]')!;
        expect(rows.textContent).toContain('42.24');
        expect(rows.textContent).not.toContain('กรอบเดิมสูงเท่าไร');
        expect(rows.textContent).not.toContain('เทียบระยะสองฝั่ง');
        expect(rows.textContent).not.toContain('—');
      });

      it('draws nothing at all in a sideways zone', async () => {
        await render({
          ...actionable,
          zones: { ...actionable.zones!, zone: 'sideways' },
          actionable: {
            invalidation: null,
            invalidationAtr: null,
            invalidationPct: null,
            invalidationBasis: null,
            target: null,
            targetAtr: null,
            targetBasis: null,
            targetIsConvention: false,
            riskReward: null,
            notes: ['no_direction_to_invalidate'],
          },
        });
        expect(container.querySelector('[data-testid="signal-zone-bar"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="signal-actionable"]')).toBeNull();
      });

      it('draws no rows at all when the flag is off', async () => {
        await render(zoned);
        expect(container.querySelector('[data-testid="signal-zone-bar"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="signal-actionable"]')).toBeNull();
      });

      it('keeps the disclaimer exactly where it was', async () => {
        await render(actionable);
        expect(container.textContent).toContain('ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย');
      });
    });

    /*
     * The phone, done the only way jsdom can do it honestly: there is no layout
     * engine here, so this asserts the CLASSES that cause a line to be cut —
     * clipped to one line, clamped to N, or dropped below a breakpoint — are
     * absent from every node of the bar. Real pixels at 390x844 are checked by
     * `npm run qa:ui-redesign-auth`, which needs a server and a signed-in Elite
     * account and so cannot live here.
     */
    it('carries nothing on the bar that would cut a line on a phone', async () => {
      await render(zoned, 'elite', 46.31);
      const nodes = [zoneBar(), ...zoneBar().querySelectorAll('*')];
      for (const node of nodes) {
        const className = node.getAttribute('class') ?? '';
        expect(className).not.toMatch(/truncate/);
        expect(className).not.toMatch(/line-clamp-/);
        expect(className).not.toMatch(/\bhidden\b/);
        expect(className).not.toMatch(/overflow-hidden/);
        // `whitespace-nowrap` is allowed on the floating labels ONLY — a price
        // must not wrap mid-number — and those are kept inside the bar by
        // `zoneLabelStyle`. Anywhere else it is how a sentence gets cut.
        if (/whitespace-nowrap/.test(className)) {
          expect(node.getAttribute('style') ?? '', 'a nowrap node with no clamped position').toMatch(/left|right/);
        }
      }
    });

    /*
     * P1 rendering is keyed off `result.gate`, which the engine only produces when
     * `SIGNAL_GATE` is on. Everything above this block is the flags-OFF card and
     * passes unchanged — that is the evidence that turning the flag off really
     * does give a reader back the card they had.
     */
  });

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

    /*
     * Three chips, not four. A fourth wraps to a second line at 390px and the
     * second line reads as decoration. The two that lead are the two that tell a
     * reader the card itself is shaky; the rest colour a reading that stands.
     */
    it('draws at most three chips, most consequential first, and says where the rest went', async () => {
      await render(gated);
      const chips = [...container.querySelector('[aria-label="Signal flags"]')!.children].map((chip) => chip.textContent);
      expect(chips).toHaveLength(4);
      expect(chips.slice(0, 3)).toEqual(['หลักฐานขัดแย้งกัน', 'วอลุ่มไม่ยืนยัน', 'ยังยืนยันไม่ชัด']);
      expect(chips.at(-1)).toContain('+3');
      expect(chips.at(-1)).toContain('ทำไม?');
    });

    it('explains in the dialog why it would not commit to a direction', async () => {
      await render(gated);
      await act(async () => buttonContaining('ทำไม?').click());
      const explainer = document.querySelector('[data-testid="signal-gate-explainer"]')!;
      expect(explainer.textContent).toContain('คะแนนรวมยังต่ำกว่าเกณฑ์');
      expect(explainer.textContent).toContain('EMA/Trend กับ Momentum ชี้คนละทาง');
      expect(explainer.textContent).toContain('อีก 10 วันจะประกาศงบ');
      // The overflow chips are listed rather than lost.
      expect(explainer.textContent).toContain('ความผันผวนบีบตัว');
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

/*
 * P4.5 — the sentence that says what the card is.
 *
 * Three things had to be true and none of them are true by construction, so
 * each gets a test: the wording is derived from the measurement rather than
 * typed in, it reaches every reader who can see this card rather than only the
 * tier that pays most for it, and it survives a phone screen.
 */
describe('the card says it is not a forecast, everywhere it renders', () => {
  const NOT_A_FORECAST = 'การ์ดนี้อธิบายสิ่งที่ราคาทำไปแล้ว ไม่ได้พยากรณ์สิ่งที่ราคาจะทำ — ผลทดสอบย้อนหลังยังไม่พบว่าทิศทางที่ระบุแม่นกว่าอัตราพื้นฐานของตลาด';

  const unavailable: MarketSignalResult = {
    ...result,
    status: 'insufficient-data',
    state: null,
    bias: null,
    score: null,
    confidence: 0,
    confidenceLabel: 'Insufficient',
    evidenceAgreement: 0,
    evidenceAgreementLabel: 'Insufficient',
    reason: 'แท่งเทียนที่ปิดแล้วมี 20 แท่ง ต่ำกว่าเกณฑ์ 50 แท่ง',
  };

  /*
   * Every (tier, capability, payload) combination that puts this card on a
   * screen. The commodity rows are the ones that were easy to miss: a Pro
   * subscriber reading GC-F sees the FULL card through
   * `technical.outlook.commodity`, so a test that only ever renders Elite would
   * have passed while the paying reader most likely to act on a futures signal
   * saw nothing.
   */
  const surfaces = [
    ['elite reading a stock', 'elite', 'technical.outlook', result],
    ['elite reading a contract', 'elite', 'technical.outlook.commodity', result],
    ['pro reading a contract', 'pro', 'technical.outlook.commodity', result],
    ['elite when the engine had too few candles', 'elite', 'technical.outlook', unavailable],
    ['elite when the fetch failed', 'elite', 'technical.outlook', null],
    ['basic looking at the locked stock preview', 'basic', 'technical.outlook', result],
    ['pro looking at the locked stock preview', 'pro', 'technical.outlook', result],
    ['basic looking at the locked contract preview', 'basic', 'technical.outlook.commodity', result],
  ] as const satisfies readonly (readonly [string, SubscriptionTier, SubscriptionCapability, MarketSignalResult | null])[];

  it.each(surfaces)('%s reads it', async (_name, tier, capability, payload) => {
    await render(payload, tier, null, capability);
    const footer = container.querySelector('[data-testid="signal-footer"]');
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain(NOT_A_FORECAST);
    // The disclaimer it sits above is still there, unchanged.
    expect(footer!.textContent).toContain('ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย');
  });

  it('puts the finding above the legal line, not below it', async () => {
    await render();
    const lines = [...container.querySelector('[data-testid="signal-footer"]')!.children]
      .map((line) => line.textContent ?? '');
    expect(lines[0]).toBe(NOT_A_FORECAST);
    expect(lines.at(-1)).toContain('ไม่ใช่คำแนะนำซื้อขาย');
  });

  /*
   * The claim is only checkable if a reader can see what it was measured over,
   * and it only stays true if the numbers come from the run rather than from
   * somebody's memory of the run. `signal-measured.test.ts` holds the other end
   * of this: it fails when the config stops matching the newest calibration run.
   */
  it('quotes the corpus and the period from the measurement, not from the copy', async () => {
    await render();
    const footer = container.querySelector('[data-testid="signal-footer"]')!;
    expect(footer.textContent).toContain(`วัดจาก ${MARKET_SIGNAL_MEASURED.corpusInstruments} สินทรัพย์`);
    expect(footer.textContent).toContain(MARKET_SIGNAL_MEASURED.period.thai);
  });

  it('names the run in the breakdown, so a figure on the card can be traced to one', async () => {
    await render();
    await act(async () => buttonContaining('ทำไม?').click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain(MARKET_SIGNAL_MEASURED.runId);
  });

  /*
   * The phone test, done the only way jsdom can do it honestly.
   *
   * There is no layout engine here, so this cannot measure a rendered height —
   * it asserts the CLASSES that would cause a collapse are absent, on the block
   * and on every line in it. That covers the three ways this disclosure could
   * quietly stop being made: clipped to one line (`truncate`), clamped to N
   * (`line-clamp-*`), or dropped below a breakpoint (`hidden` with a `sm:`
   * escape). Real pixels at 390x844 are checked by `npm run qa:ui-redesign-auth`,
   * which needs a server and a signed-in Elite account and so cannot live here.
   */
  it('carries nothing that would truncate, clamp or hide it on a phone', async () => {
    await render();
    const footer = container.querySelector('[data-testid="signal-footer"]')!;
    const classNames = [footer, ...footer.querySelectorAll('*')]
      .map((node) => node.getAttribute('class') ?? '');

    for (const className of classNames) {
      expect(className).not.toMatch(/truncate/);
      expect(className).not.toMatch(/line-clamp-/);
      expect(className).not.toMatch(/hidden/);
      expect(className).not.toMatch(/text-nowrap|whitespace-nowrap/);
      // `max-h-*` plus `overflow-hidden` is the hand-rolled version of a clamp.
      expect(className).not.toMatch(/overflow-hidden/);
    }
  });

  it('renders the sentence as one uninterrupted string, not as fragments a clamp could split', async () => {
    await render();
    const first = container.querySelector('[data-testid="signal-footer"]')!.firstElementChild!;
    expect(first.childElementCount).toBe(0);
    expect(first.textContent).toHaveLength(NOT_A_FORECAST.length);
  });
});

/*
 * P6 — the history strip, and the things the measurement forbids it to say.
 *
 * `docs/market-signal/p6-history-findings.md` asked whether a label that has
 * stood longer is a more accurate one and found nothing: no age bucket beat the
 * base rate by more than its own sampling error, and the buckets old enough to
 * matter hold 76, 4 and 0 observations. So the strip is a disclosure, and these
 * tests are mostly about what it must NOT do.
 */
describe('the history strip discloses without ranking', () => {
  const day = (asOf: string, state: MarketSignalState) => ({
    asOf,
    state,
    bias: 'neutral' as const,
    zone: 'sideways' as const,
    score: 4,
    evidenceAgreement: 61,
    flags: [] as string[],
  });

  const withHistory = (over: Partial<MarketSignalResult['history']> = {}): MarketSignalResult => ({
    ...result,
    history: {
      entries: [
        day('2026-08-10', 'SIDEWAYS'),
        day('2026-08-11', 'SIDEWAYS'),
        day('2026-08-12', 'SIDEWAYS'),
      ],
      windowDays: 30,
      currentLabelDays: 2,
      recentFlip: false,
      ...over,
    },
  });

  it('draws one cell per recorded day and not one per calendar day', async () => {
    await render(withHistory());
    const strip = container.querySelector('[aria-label="ประวัติป้าย 30 วัน"]')!;
    expect(strip.children).toHaveLength(3);
  });

  it('says how many of the days in its window it actually has', async () => {
    await render(withHistory());
    const block = container.querySelector('[data-testid="signal-history"]')!;
    // The absence is disclosed as a number rather than drawn as invented cells.
    expect(block.textContent).toContain('บันทึกได้ 3 วัน จาก 30 วันที่ผ่านมา');
  });

  it('states the label age as a duration', async () => {
    await render(withHistory());
    expect(container.querySelector('[data-testid="signal-history"]')!.textContent)
      .toContain('ยืนมา 2 วัน');
  });

  it('will not call one recorded day a run', async () => {
    await render(withHistory({ entries: [day('2026-08-12', 'SIDEWAYS')], currentLabelDays: null }));
    const block = container.querySelector('[data-testid="signal-history"]')!;
    expect(block.textContent).toContain('บันทึกไว้วันเดียว');
    expect(block.textContent).not.toContain('ยืนมา 0 วัน');
  });

  /*
   * The load-bearing one. A colour, weight or opacity that grew with age would
   * be an argument the harness does not support, made in a language nobody
   * reads critically — so cells of the same label must be pixel-identical
   * whatever their position in the run.
   */
  it('gives every cell of the same label identical styling, whatever its age', async () => {
    await render(withHistory());
    const cells = [...container.querySelector('[aria-label="ประวัติป้าย 30 วัน"]')!.children]
      .map((cell) => cell.getAttribute('class'));
    expect(new Set(cells).size).toBe(1);
  });

  it('says in words that a long-standing label is not a more accurate one', async () => {
    await render(withHistory());
    expect(container.querySelector('[data-testid="signal-history"]')!.textContent)
      .toContain('ป้ายที่ยืนนานไม่ได้แปลว่าแม่นกว่า');
  });

  it('warns when the label is unsettled, which is the safe direction', async () => {
    await render(withHistory({ recentFlip: true }));
    expect(container.querySelector('[data-testid="signal-history"]')!.textContent)
      .toContain('ยังไม่นิ่ง');
  });

  it('draws nothing at all while the flag is off', async () => {
    await render(result);
    expect(container.querySelector('[data-testid="signal-history"]')).toBeNull();
  });
});
});
