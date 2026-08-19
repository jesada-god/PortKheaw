// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import type { MarketSignalResult, MarketSignalState } from '@/src/lib/analytics/market-signal/types';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import { MARKET_SIGNAL_MEASURED } from '@/src/config/signal';
import { estimateLabelWidth, LABEL_BIAS, labelsCollide, spreadLabels, MARKET_SIGNAL_PRESENTATION, MarketSignalSection, zoneLabelStyle, zoneLeaderStyle, zoneScaleFor } from './MarketSignalSection';

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
  // `measuring` replaces `getBoundingClientRect` on Element.prototype, and a
  // stubbed layout leaking into the next test is a test that measures the last
  // one's bar.
  vi.restoreAllMocks();
});

/**
 * A browser's answer, in a runner that has no layout engine.
 *
 * The zone bar decides whether two captions can stand apart by MEASURING them,
 * which under jsdom means measuring nothing: every box is 0x0 and the bar keeps
 * the arrangement it rendered with. That is the right default — it is why the
 * card never merges two captions on a guess — but it also means the measured
 * path has no coverage unless the measurements are supplied, so this supplies
 * them: a track of a stated width, and captions whose width is a stated
 * function of their text.
 *
 * Only the two things the layout reads are answered. Everything else keeps
 * jsdom's own zero, so nothing else in the card starts behaving as if it had
 * been laid out.
 */
function measuring(track: number, widthOfText: (text: string) => number) {
  const rect = (width: number) => ({
    width, height: 0, top: 0, bottom: 0, left: 0, right: width, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const node = this as HTMLElement;
    if (node.dataset?.measure) return rect(widthOfText(node.textContent ?? ''));
    if (node.dataset?.track === 'prices') return rect(track);
    return rect(0);
  });
}

/** Every glyph the same width, so a test's arithmetic is doable by hand. */
const SEVEN_PX_PER_GLYPH = (text: string) => text.length * 7;

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

    it('says which close every number is measured from, on one line', async () => {
      await render(zoned);
      const source = zoneBar().querySelector('[data-zone-row="source"]')!;
      expect(source.textContent).toBe(
        'วัดจากราคาปิดตลาดรอบล่าสุด 44.06 (14 ส.ค. 2569) · นับเฉพาะราคาปิดของวัน ไม่นับที่แตะระหว่างวัน',
      );
      // One footnote, not two greyed lines that get skipped as a pair.
      expect(zoneBar().querySelectorAll('[data-zone-row="source"]').length).toBe(1);
    });

    /*
     * The block is the card, and the drawing grows instead of the block
     * shrinking.
     *
     * It used to be capped at 640px and centred, which answered a real
     * wide-screen complaint — a caption a hand's width from the line it names —
     * by shrinking the picture, and left the other half of the complaint
     * untouched: the type on it stayed phone-sized, so a desktop reader got a
     * small drawing marooned in a large card. `w-full` inside the card's own
     * padding is what makes the gap on the left the same as the gap on the
     * right without any arithmetic; `qa:signal-zone-bar` measures both gaps
     * against the card's content box at 1440 and 1280, and measures that every
     * kind of type on the picture is strictly larger there than at 390.
     */
    it('fills the card instead of capping itself at a reading width', async () => {
      await render(zoned, 'elite', 42.38);
      expect(zoneBar().className).toContain('w-full');
      expect(zoneBar().className).not.toContain('max-w-');
      // `mx-auto` centred a capped block. With no cap there is nothing to
      // centre, and leaving it in would hide a cap creeping back.
      expect(zoneBar().className).not.toContain('mx-auto');
    });

    /*
     * The sizes themselves, asked of the pure function rather than of a
     * rendered card: jsdom has no layout, so the track it measures is always 0
     * and the component can only ever be seen at the compact size here.
     *
     * The threshold is on the TRACK, which is why this is worth a test at all.
     * A viewport breakpoint would give a bar inside a narrow two-column layout
     * the same 15px names as one running the width of the window, and the
     * narrow one has nowhere to put them.
     */
    it('grows the picture from the width of the track, not the window', () => {
      const narrow = zoneScaleFor(390);
      const wide = zoneScaleFor(1400);
      // Nothing measured yet is the compact size, never the wide one: the
      // server and the first client render both land on 0 and have to agree.
      expect(zoneScaleFor(0)).toBe(narrow);
      expect(zoneScaleFor(900)).toBe(narrow);
      expect(zoneScaleFor(901)).toBe(wide);

      expect(narrow.caption.name).toContain('text-[10px]');
      expect(wide.caption.name).toContain('text-[15px]');
      expect(narrow.caption.price).toContain('text-[10px]');
      expect(wide.caption.price).toContain('text-[14px]');
      expect(narrow.caption.level).toContain('text-[10px]');
      expect(wide.caption.level).toContain('text-[13px]');
      // The bar and the mark a reader has to find grow with the type.
      expect(narrow.row.bar).toBe('h-9');
      expect(wide.row.bar).toBe('h-12');
      expect(wide.closeMarkPx).toBeGreaterThan(narrow.closeMarkPx);
    });

    /*
     * Every row in the block is MARKED as a row, which is what lets the browser
     * QA check that each one starts at the left end of the track and finishes at
     * the right end. The row this rule came from was a two-column grid whose
     * right cell ran out at about 70% of the block, leaving the up condition
     * ending in the middle of nowhere; nothing in the markup said it was wrong.
     */
    it('marks every row of the block so the QA can measure it against the track', async () => {
      await render(zoned, 'elite', 42.38);
      for (const child of zoneBar().children) {
        expect(child.getAttribute('data-zone-row'), `${child.tagName} is not a marked row`).not.toBeNull();
      }
      const picture = zoneBar().querySelector('[data-zone-row="picture"]')!;
      for (const child of picture.children) {
        expect(child.getAttribute('data-zone-row'), `${child.tagName} is not a marked row`).not.toBeNull();
      }
    });

    /*
     * Eight lines under a bar that has to be read in ten seconds is not a
     * reading, it is a page. What is left is the four that say something the
     * picture cannot: the live price against the close, where this leg is
     * considered over, where the convention points, and which close it all came
     * from.
     */
    it('leaves at most four lines under the picture', async () => {
      await render({
        ...zoned,
        zones: { ...zoned.zones!, zone: 'uptrend' },
        actionable: {
          invalidation: 42.24, invalidationAtr: 0.45, invalidationPct: 4.13, invalidationBasis: 'zone_floor',
          target: 58.51, targetAtr: 3.56, targetBasis: 'measured_move', targetIsConvention: true,
          riskReward: 7.94, notes: [],
        },
      }, 'elite', 42.38);
      const rows = [...zoneBar().children];
      const picture = rows.findIndex((node) => node.getAttribute('data-zone-row') === 'picture');
      const lines = rows.slice(picture + 1).flatMap((node) => (
        // The actionable list is one element and two lines; everything else is
        // one element and one line.
        node.getAttribute('data-zone-row') === 'actionable' ? [...node.children] : [node]
      ));
      expect(lines.length).toBeLessThanOrEqual(4);
    });

    /*
     * The two trigger rows, gone. Both numbers are still on the card — printed
     * under the cut each one makes — and the distance to the nearer of them is
     * still in the proximity line above the bar. What is gone is the third
     * telling of it in prose.
     */
    it('does not repeat the triggers as a row of prose under the bar', async () => {
      await render(zoned);
      const text = zoneBar().textContent ?? '';
      expect(text).not.toContain('ถือว่าเข้าโซนขาลง');
      expect(text).not.toContain('ถือว่าเข้าโซนขาขึ้น');
      expect(text).not.toContain('ต่ำกว่าราคาปิด 13.2%');
      // Still drawn, under their own cuts.
      expect(zoneBar().querySelector('[data-label="edge-lower"]')!.textContent).toBe('38.26');
      expect(zoneBar().querySelector('[data-label="edge-upper"]')!.textContent).toBe('47.24');
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
        expect(zoneBar().textContent).toContain('ปิดล่าสุด 44.06');
      });

      /*
       * The edge prices used to be the first and last cell of a two-column grid,
       * i.e. hard against the ends of the bar, pointing at nothing. They belong
       * under the cut they name, so this asserts each one is anchored on the
       * divider it names — and that a stem is drawn from the cut down to it, so
       * a reader can see the pairing rather than infer it.
       */
      it('puts each edge price under the cut it makes, not at the ends of the bar', async () => {
        await render(zoned);
        const lower = zoneBar().querySelector<HTMLElement>('[data-label="edge-lower"]')!;
        const upper = zoneBar().querySelector<HTMLElement>('[data-label="edge-upper"]')!;
        expect(lower.textContent).toBe('38.26');
        expect(upper.textContent).toBe('47.24');

        const lowerCut = leftOf('sideways');
        const upperCut = leftOf('uptrend');
        expect(lowerCut).toBeGreaterThan(0);
        expect(upperCut).toBeLessThan(100);
        /*
         * Anchored on the cut, centred on it, and pulled back only by half its
         * own width — the same expression `zoneLabelStyle` builds for the marker
         * captions, so the price cannot drift away from the line it names.
         *
         * Compared through jsdom's own CSS parser rather than as a string:
         * `cssstyle` mangles `clamp()` into an unrecognisable value, so the only
         * honest comparison here is between two values it has mangled the same
         * way. What the browser actually resolves these to is measured by
         * `qa:signal-zone-bar`, which is the point of having it.
         */
        const asJsdomParsesIt = (style: React.CSSProperties) => {
          const probe = document.createElement('span');
          Object.assign(probe.style, style);
          return probe.style.left;
        };
        expect(lower.style.left).toBe(asJsdomParsesIt(zoneLabelStyle({
          at: lowerCut, width: Number(lower.dataset.labelWidth), bias: LABEL_BIAS.centre,
        })));
        expect(upper.style.left).toBe(asJsdomParsesIt(zoneLabelStyle({
          at: upperCut, width: Number(upper.dataset.labelWidth), bias: LABEL_BIAS.centre,
        })));
        // The cut each one is measured against is drawn, and it is the divider
        // between the fields rather than a corner of the bar.
        expect(zoneBar().querySelector<HTMLElement>('[data-cut="lower"]')!.style.left)
          .toBe(`${lowerCut}%`);
        expect(zoneBar().querySelector<HTMLElement>('[data-cut="upper"]')!.style.left)
          .toBe(`${upperCut}%`);
      });

      /*
       * The reason this helper exists at all: a caption that is not on its mark
       * makes the reader hunt for the line it belongs to.
       *
       * The version this replaced switched to an edge-anchored position at fixed
       * percentages — under 40% the label started at the mark and ran right — so
       * a mark standing at 41% got a caption drawn a whole label-width away from
       * it. Centring plus a `clamp()` is the rule that holds at both ends: the
       * mark is a percentage of the track, the label's width is pixels, and the
       * caption only leaves centre when it would otherwise leave the card.
       */
      it('centres a floating label on its mark, and clamps it into the track', () => {
        const label = { at: 50, width: 80, bias: LABEL_BIAS.centre };
        expect(zoneLabelStyle(label)).toEqual({
          left: 'clamp(0px, calc(50% - 40px), calc(100% - 80px))',
        });
        // Same expression at both ends of the track: the clamp does the work, so
        // a caption at 2% and one at 98% are still described as centred.
        expect(zoneLabelStyle({ ...label, at: 2 }).left)
          .toBe('clamp(0px, calc(2% - 40px), calc(100% - 80px))');
        expect(zoneLabelStyle({ ...label, at: 98 }).left)
          .toBe('clamp(0px, calc(98% - 40px), calc(100% - 80px))');
        // Grown outward: the label ends on its mark, or starts on it.
        expect(zoneLabelStyle({ ...label, at: 30, bias: LABEL_BIAS.growLeft }).left)
          .toBe('clamp(0px, calc(30% - 80px), calc(100% - 80px))');
        expect(zoneLabelStyle({ ...label, at: 70, bias: LABEL_BIAS.growRight }).left)
          .toBe('clamp(0px, calc(70% - 0px), calc(100% - 80px))');
      });

      /*
       * The leader is what makes a moved caption readable: it runs from the mark
       * to the middle of the caption, so it is nothing at all in the ordinary
       * centred case and appears only where there is something to explain.
       */
      it('draws the leader between the mark and the label it names', () => {
        const label = { at: 50, width: 80, bias: LABEL_BIAS.centre };
        const centre = '(clamp(0px, 50% - 40px, 100% - 80px) + 40px)';
        expect(zoneLeaderStyle(50, label)).toEqual({
          left: `min(50%, ${centre})`,
          width: `calc(max(50%, ${centre}) - min(50%, ${centre}))`,
        });
        // A caption for a mark that is not its own — the merged one names two —
        // still resolves to the span between the two x positions.
        expect(zoneLeaderStyle(20, label).left).toBe(`min(20%, ${centre})`);
      });

      /*
       * The estimate the layout runs on. It has to be an OVERestimate: too big
       * pins a caption closer to its mark than it needed to be, too small puts
       * one caption on top of another. `qa:signal-zone-bar` re-measures every
       * drawn label against it in a real browser, and these are the numbers that
       * run measured on Chrome at the size these captions actually render.
       */
      /*
       * "กรอบเดิม" IS ALWAYS CENTRED IN ITS OWN FIELD.
       *
       * The rule this replaced moved any field's name off its preferred end
       * whenever the close marker was anywhere in that HALF of the field, which
       * on the ordinary card — close at about 65% of a wide middle field,
       * nowhere near the name sitting in the centre of it — shoved "กรอบเดิม"
       * hard against the lower cut. "ขาลง" is written against that same cut
       * from the other side, so the two names finished flush against each
       * other: two claims about two different price ranges reading as one run
       * of Thai. The outer names have the end of the bar on their far side and
       * can still move away from a mark standing on their glyphs; the middle
       * one has a name on both sides and no such position, so it does not move
       * at all. `qa:signal-zone-bar` measures the drawn gap at every width.
       */
      it('keeps the middle field name centred, whatever the marker is doing', async () => {
        const alignment = () => zoneBar().querySelector('[data-zone="sideways"]')!.className;
        // Close high in the field, close low in it, close outside it entirely.
        for (const close of [46.5, 39.5, 61.42]) {
          await render({ ...zoned, zones: { ...zoned.zones!, referenceClose: close } });
          expect(alignment(), `close ${close}`).toContain('justify-center');
          expect(alignment(), `close ${close}`).not.toContain('justify-start');
          expect(alignment(), `close ${close}`).not.toContain('justify-end');
        }
      });

      /*
       * The estimate has to be in the units of the size the caption is DRAWN
       * at. The glyph table is measured at the 12px `text-[10px]` renders, so a
       * 15px field name placed on an unscaled estimate is placed on a box a
       * quarter narrower than the one it occupies — which is how a name comes
       * to be drawn a pixel into the field beside it.
       *
       * Padding is not scaled with it: `px-1` and `px-1.5` are spacing
       * utilities, not lengths in ems, so they are added after.
       */
      it('scales the estimate with the size the caption is drawn at', () => {
        const base = estimateLabelWidth('กรอบเดิม');
        expect(estimateLabelWidth('กรอบเดิม', { scale: 15 / 12 })).toBeGreaterThan(base);
        // 8px of padding at the compact size, 12px at the wide one, both added
        // whole rather than multiplied by the glyph scale.
        expect(estimateLabelWidth('กรอบเดิม', { padding: 8 })).toBe(base + 8);
        expect(estimateLabelWidth('44.06', { mono: true, padding: 0, scale: 13 / 12 }))
          .toBeGreaterThan(estimateLabelWidth('44.06', { mono: true }));
      });

      it('estimates a label at least as wide as Chrome draws it', () => {
        // Chrome draws these two at 91.9px and 104.5px.
        expect(estimateLabelWidth('ปิดล่าสุด 44.06', { padding: 12 })).toBeGreaterThanOrEqual(91);
        expect(estimateLabelWidth('ราคาตอนนี้ 42.38', { padding: 12 })).toBeGreaterThanOrEqual(104);
        expect(estimateLabelWidth('38.26', { mono: true })).toBeGreaterThanOrEqual(33);
        expect(estimateLabelWidth('103,192', { mono: true })).toBeGreaterThanOrEqual(47);
        // And not wildly over: an estimate twice the truth would merge captions
        // that had room to stand apart.
        expect(estimateLabelWidth('ปิดล่าสุด 44.06', { padding: 12 })).toBeLessThan(110);
        // Thai tone marks stack on their consonant, so they cost almost nothing.
        expect(estimateLabelWidth('ปิด')).toBeLessThan(estimateLabelWidth('ปดด'));
      });

      it('keeps every field visible even when price is far outside the frame', async () => {
        await render({ ...zoned, zones: { ...zoned.zones!, zone: 'uptrend', referenceClose: 4406 } });
        for (const id of ['downtrend', 'sideways', 'uptrend']) {
          expect(widthOf(id), `${id} field collapsed`).toBeGreaterThan(10);
        }
      });
    });

    /*
     * The row rule, which is the fix for two numbers of different kinds reading
     * as one row of numbers: "สด 42.59" used to sit directly under the frame's
     * "43.23" with nothing between them.
     *
     * PRICES above the bar. LEVELS below it. Not "spaced apart" — separated by
     * kind, so no arrangement of the numbers can put them back in one row.
     */
    describe('the captions sit in two rows that cannot reach each other', () => {
      const rowOf = (label: string) => zoneBar().querySelector<HTMLElement>(`[data-label="${label}"]`)!
        .closest('[data-track]')!.getAttribute('data-track');

      it('keeps every price above the bar and every frame level below it', async () => {
        await render(zoned, 'elite', 41.2);
        const prices = [...zoneBar().querySelectorAll<HTMLElement>('[data-track="prices"] [data-label]')]
          .map((node) => node.dataset.label);
        const levels = [...zoneBar().querySelectorAll<HTMLElement>('[data-track="edges"] [data-label]')]
          .map((node) => node.dataset.label);
        // Whatever the arrangement chose, the two rows hold what they hold.
        expect(prices.every((key) => ['close', 'live', 'prices'].includes(key!))).toBe(true);
        expect(levels.every((key) => ['edge-lower', 'edge-upper', 'edges'].includes(key!))).toBe(true);
        expect(levels.length).toBeGreaterThan(0);
        expect(rowOf('edge-lower')).toBe('edges');
        // And the bar itself is BETWEEN them: prices above, levels below, in
        // that order, which is the whole separation stated as document order.
        const tracks = [...zoneBar().querySelectorAll('[data-track]')].map((node) => node.getAttribute('data-track'));
        expect(tracks).toEqual(['prices', 'bar', 'edges']);
      });

      it('gives every caption a leader to each mark it names', async () => {
        await render(zoned, 'elite', 41.2);
        for (const label of zoneBar().querySelectorAll<HTMLElement>('[data-label]')) {
          const key = label.dataset.label!;
          if (key.startsWith('zone-')) continue;
          const leaders = zoneBar().querySelectorAll(`[data-leader-for="${key}"]`);
          expect(leaders.length, `${key} has no leader to its mark`).toBeGreaterThan(0);
        }
      });
    });

    /*
     * The merge, and the measurement that is now the only thing that can trigger
     * it.
     *
     * Two captions is the normal arrangement: each names one price and has a
     * leader down to its own mark, which is the only version where a reader can
     * pair a number with a line. Merging is a concession, and the card makes it
     * for exactly one reason — the two rectangles, as drawn, overlap. Not the
     * distance between the prices, not a threshold, not a hypothetical 216px
     * track it is not being read on: the boxes.
     */
    /*
     * ONE PRICE, ONE CAPTION — the case none of the collision machinery below
     * can reach, because nothing about it is a collision.
     *
     * When the live price rounds to the figure the close rounds to, the two
     * marks stand on the same percent and paint as one line, and the bar was
     * captioning that single line "ปิดล่าสุด 42 · ราคาตอนนี้ 42": two identical
     * numbers offered as two facts, with a sentence underneath repeating the
     * second of them. There is all the room in the world for two captions at
     * 1440px and they still say the same thing twice, so the answer cannot come
     * from measuring boxes — it comes from comparing the two strings the bar
     * draws.
     */
    describe('when the live price is the close', () => {
      it('draws one caption, on the close', async () => {
        await render({ ...zoned, zones: { ...zoned.zones!, referenceClose: 42 } }, 'elite', 42);
        expect(zoneBar().querySelector<HTMLElement>('[data-label="close"]')!.textContent)
          .toBe('ปิดล่าสุด 42');
        expect(zoneBar().querySelector('[data-label="live"]')).toBeNull();
        expect(zoneBar().querySelector('[data-label="prices"]')).toBeNull();
      });

      it('does not say the price a second time under the bar', async () => {
        await render({ ...zoned, zones: { ...zoned.zones!, referenceClose: 42 } }, 'elite', 42);
        expect(container.querySelector('[data-testid="signal-live-price"]')).toBeNull();
        // The one line that still carries it is the provenance footnote, which
        // is saying which close every figure on the card was measured from.
        expect(zoneBar().querySelector('[data-zone-row="source"]')!.textContent)
          .toContain('วัดจากราคาปิดตลาดรอบล่าสุด 42');
      });

      /*
       * The MARKS do not collapse, and this is the line between the two.
       * Whether there are two prices is a fact about the payload; whether there
       * are two captions is a reading of it. Both marks stay drawn — they land
       * on the same percent and paint as one line, which is the truthful
       * picture of two prices that are one number.
       */
      it('still draws both marks', async () => {
        await render({ ...zoned, zones: { ...zoned.zones!, referenceClose: 42 } }, 'elite', 42);
        const live = zoneBar().querySelector<HTMLElement>('[data-marker="live"]')!;
        const close = zoneBar().querySelector<HTMLElement>('[data-marker="close"]')!;
        expect(live.style.left).toBe(close.style.left);
      });

      /*
       * Only when they are the same to every digit the card prints. The bar
       * drops the cents above a thousand, so two six-figure prices can share a
       * caption up there and still be two prices — and then the sentence under
       * the bar is the row that says so, and it stays.
       */
      it('keeps the sentence when the bar rounded two different prices together', async () => {
        const btc = {
          ...zoned,
          zones: {
            ...zoned.zones!,
            lowerTrigger: 103_192.08,
            upperTrigger: 120_091.68,
            referenceClose: 121_884.35,
          },
        };
        await render(btc, 'elite', 121_884.02);
        expect(zoneBar().querySelector<HTMLElement>('[data-label="close"]')!.textContent)
          .toBe('ปิดล่าสุด 121,884');
        expect(zoneBar().querySelector('[data-label="live"]')).toBeNull();
        expect(container.querySelector('[data-testid="signal-live-price"]')!.textContent)
          .toContain('ราคาตอนนี้ 121,884.02');
      });
    });

    describe('when two captions would land on top of each other', () => {
      it('never merges on a guess, when nothing has been measured', async () => {
        // No layout stub: every box reads 0, which is jsdom and also the server.
        // The bar has no evidence the captions collide, so it does not act as if
        // they do.
        await render(zoned, 'elite', 44.07);
        expect(zoneBar().querySelector('[data-label="prices"]')).toBeNull();
        expect(zoneBar().querySelector<HTMLElement>('[data-label="close"]')!.textContent).toBe('ปิดล่าสุด 44.06');
        expect(zoneBar().querySelector<HTMLElement>('[data-label="live"]')!.textContent).toBe('ราคาตอนนี้ 44.07');
      });

      /*
       * 44.06 and 43.85 sit 1.3% of the drawn extent apart. On a 280px track
       * that is 3.6px between the two captions once each has been grown away
       * from the other — under the 4px that keeps them from reading as one run
       * of text — so they merge. The same two prices on a 640px track are 8.3px
       * apart, and the same code leaves them alone. One picture per width,
       * because at those two widths they genuinely are different pictures.
       *
       * The track was 216px here until the marks were renamed. At seven pixels
       * a glyph "ปิดล่าสุด 44.06 · ราคาตอนนี้ 43.85" is 238px of caption, so
       * 216 is now the width where the merge itself does not fit — which is the
       * case below this one, not this one.
       */
      it('merges when the measured boxes touch', async () => {
        measuring(280, SEVEN_PX_PER_GLYPH);
        await render(zoned, 'elite', 43.85);
        const merged = zoneBar().querySelector<HTMLElement>('[data-label="prices"]')!;
        expect(merged.textContent).toBe('ปิดล่าสุด 44.06 · ราคาตอนนี้ 43.85');
        expect(zoneBar().querySelector('[data-label="close"]')).toBeNull();
        expect(zoneBar().querySelector('[data-label="live"]')).toBeNull();
        /*
         * AND SO DO THE MARKS, at this width.
         *
         * These two prices put their marks 3.6px apart centre to centre on a
         * 280px track, which is less than the marks are thick: the picture was
         * drawing two lines that paint as one and telling the reader they were
         * two. One mark, declared on the block, with both prices still named in
         * the caption above it and in the sentence below.
         */
        expect(zoneBar().querySelector('[data-marker="close"]')).not.toBeNull();
        expect(zoneBar().querySelector('[data-marker="live"]')).toBeNull();
        expect(zoneBar().getAttribute('data-markers-collapsed')).toBe('true');
        expect(container.querySelector('[data-testid="signal-live-price"]')!.textContent)
          .toContain('ราคาตอนนี้ 43.85');
      });

      /*
       * The rung below the merge, and why it exists.
       *
       * A merged caption is only worth drawing if it fits on the track, and a
       * caption wider than its track cannot be placed at all: it is clamped to
       * the left edge and runs out under the card's padding.
       *
       * The naming pass is what found this. Written "ปิดเมื่อวาน", the merged
       * caption for a six-figure instrument measured 225px on the 220px track a
       * 320px phone leaves, and `qa:signal-zone-bar` caught it hanging past the
       * end of its row; at "ปิดล่าสุด" the same caption is 215px and fits. Two
       * characters was the whole margin, so the rung stays.
       *
       * So the last arrangement is the CLOSE alone. It is the price every figure
       * on the card is measured from, both marks are still drawn, and the live
       * price is still stated in full in the sentence under the bar.
       */
      it('draws the close alone when even the merged caption is wider than the track', async () => {
        measuring(216, SEVEN_PX_PER_GLYPH);
        await render(zoned, 'elite', 43.85);
        expect(zoneBar().querySelector('[data-label="prices"]')).toBeNull();
        expect(zoneBar().querySelector('[data-label="live"]')).toBeNull();
        expect(zoneBar().querySelector<HTMLElement>('[data-label="close"]')!.textContent).toBe('ปิดล่าสุด 44.06');
        // One mark at this width, for the same reason as the case above: 2.8px
        // between two marks is one line. The close is the mark that survives,
        // because it is the price every figure on the card is measured from.
        expect(zoneBar().querySelector('[data-marker="close"]')).not.toBeNull();
        expect(zoneBar().querySelector('[data-marker="live"]')).toBeNull();
        // And the price neither the caption nor the picture could carry is in
        // the sentence below, in full.
        expect(container.querySelector('[data-testid="signal-live-price"]')!.textContent)
          .toContain('ราคาตอนนี้ 43.85');
      });

      /*
       * The other direction, and the reason both rules are measurements rather
       * than thresholds: the same two prices on a track wide enough put 18px
       * between the marks and 14px between the grown captions, so nothing
       * collapses and nothing merges. One picture per width.
       */
      it('keeps the two captions on the same prices once the bar is wide enough', async () => {
        measuring(1400, SEVEN_PX_PER_GLYPH);
        await render(zoned, 'elite', 43.85);
        expect(zoneBar().querySelector('[data-marker="live"]')).not.toBeNull();
        expect(zoneBar().getAttribute('data-markers-collapsed')).toBe('false');
        expect(zoneBar().querySelector('[data-label="prices"]')).toBeNull();
        expect(zoneBar().querySelector<HTMLElement>('[data-label="close"]')!.textContent).toBe('ปิดล่าสุด 44.06');
        expect(zoneBar().querySelector<HTMLElement>('[data-label="live"]')!.textContent).toBe('ราคาตอนนี้ 43.85');
        // And each one still points at its own mark rather than at the pair.
        for (const key of ['close', 'live']) {
          const leaders = [...zoneBar().querySelectorAll<HTMLElement>(`[data-leader-for="${key}"]`)]
            .map((node) => node.dataset.leader);
          expect(leaders).toEqual([key]);
        }
      });

      /*
       * The merged caption points at ONE mark, and it is the close.
       *
       * It used to be anchored at the midpoint between the two marks with a
       * leader running to each — "ปิดล่าสุด 44.9 · ราคาตอนนี้ 42.14" hanging between two lines
       * and claiming both. A reader who cannot tell which number belongs to
       * which line is worse off than one who has to read the live price out of
       * the sentence underneath, which is where it still is in full.
       */
      it('anchors the merged caption on the close and leads to that mark alone', async () => {
        measuring(280, SEVEN_PX_PER_GLYPH);
        await render(zoned, 'elite', 43.85);
        const leaders = [...zoneBar().querySelectorAll<HTMLElement>('[data-leader-for="prices"]')];
        expect(leaders.map((node) => node.dataset.leader)).toEqual(['close']);

        const merged = zoneBar().querySelector<HTMLElement>('[data-label="prices"]')!;
        const closeMark = zoneBar().querySelector<HTMLElement>('[data-marker="close"]')!;
        const asJsdomParsesIt = (style: React.CSSProperties) => {
          const probe = document.createElement('span');
          Object.assign(probe.style, style);
          return probe.style.left;
        };
        expect(merged.style.left).toBe(asJsdomParsesIt(zoneLabelStyle({
          at: Number.parseFloat(closeMark.style.left),
          width: Number(merged.dataset.labelWidth),
          bias: LABEL_BIAS.centre,
        })));
        // The live price is still on the card in full, in the sentence below.
        expect(container.querySelector('[data-testid="signal-live-price"]')!.textContent)
          .toContain('ราคาตอนนี้ 43.85');
      });

      /*
       * The rule itself, without a component around it: the same two labels
       * collide on a phone and stand apart on a desktop, because the track is an
       * argument now rather than a constant.
       */
      it('answers the collision question on the track it is given', () => {
        const close = { at: 60, width: 80, bias: LABEL_BIAS.centre };
        const live = { at: 61, width: 62, bias: LABEL_BIAS.centre };
        expect(labelsCollide(close, live, 216)).toBe(true);
        expect(spreadLabels(close, live, 216)).toBeNull();
        // The same pair on a 640px track: grown apart, there is room, and two
        // captions survive.
        expect(spreadLabels(close, live, 640)).toEqual([
          { ...close, bias: LABEL_BIAS.growLeft },
          { ...live, bias: LABEL_BIAS.growRight },
        ]);
        // Far apart, and centring is left alone.
        const away = { at: 20, width: 62, bias: LABEL_BIAS.centre };
        expect(spreadLabels(close, away, 216)).toEqual([away, close]);
      });
    });

    it('states the distance to the nearest trigger once, above the bar', async () => {
      await render(zoned);
      // 3.184 / 44.06, from the engine's own distance — said in the proximity
      // line and nowhere else on the card.
      const proximity = zoneBar().querySelector('[data-zone-row="proximity"]')!;
      expect(proximity.textContent).toContain('7.2%');
      expect((zoneBar().textContent ?? '').split('7.2%').length - 1).toBe(1);
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

    it('words every level as a condition, never as an instruction', async () => {
      await render({
        ...zoned,
        zones: { ...zoned.zones!, zone: 'uptrend' },
        actionable: {
          invalidation: 42.24, invalidationAtr: 0.45, invalidationPct: 4.13, invalidationBasis: 'zone_floor',
          target: 58.51, targetAtr: 3.56, targetBasis: 'measured_move', targetIsConvention: true,
          riskReward: 7.94, notes: [],
        },
      });
      expect(zoneBar().textContent).toContain('ถ้าปิดต่ำกว่า');
      expect(zoneBar().textContent).toContain('ถือว่าขาขึ้นรอบนี้จบตามกฎเดิม');
      expect(zoneBar().textContent).not.toMatch(/ซื้อเมื่อ|ขายเมื่อ|ควรซื้อ|ควรขาย|แนะนำให้/);
    });

    /*
     * The reversal the brief opened with: the up condition used to be in the
     * LEFT cell of a grid while the bar drew up on the right. The prose is gone
     * and the drawing is the only statement of it left, so this is asserted
     * where it is now made — on the fields, and on the name each one carries.
     */
    it('draws down on the left and up on the right, each named on its own field', async () => {
      await render(zoned);
      expect(leftOf('downtrend')).toBeLessThan(leftOf('uptrend'));
      expect(segment('downtrend').textContent).toBe('ขาลง');
      expect(segment('uptrend').textContent).toBe('ขาขึ้น');
    });

    /*
     * A field's name belongs against the cut that defines it.
     *
     * "ขาลง" names everything below the lower trigger, and that trigger is the
     * field's right-hand edge; centring the word put it as far from its own
     * boundary as the field allowed, which on a wide bar was most of a hand's
     * width of empty red before the word explaining the red.
     */
    it('sets each field name against the cut it is about', async () => {
      await render(zoned);
      expect(segment('downtrend').className).toContain('justify-end');
      expect(segment('uptrend').className).toContain('justify-start');
    });

    /*
     * A name moves off its own cut only when the mark is ON it — measured, and
     * not before.
     *
     * The question used to be asked as "is the marker in this half of the
     * field", which is a proxy for the real one and a bad one: on a wide bar
     * the marker is routinely in the same half as the name and 200px away from
     * it, and the answer "move" cost a reader a name written where its own
     * boundary is not. Now the two boxes are compared, on the track the reader
     * has, which is why both of these cases are the same card at two widths.
     *
     * Close 44.06 against an upper trigger of 43.25 puts the mark just inside
     * the uptrend field, which spans 77.8-100% of the track.
     */
    const markedUp: MarketSignalResult = {
      ...zoned,
      zones: { ...zoned.zones!, zone: 'uptrend', upperTrigger: 43.25, upperDistance: -0.81, nearestTriggerAtr: -0.2 },
    };

    it('moves a name off its own edge when the price marker is standing on it', async () => {
      // A 400px track leaves the uptrend field 89px, and the mark lands at
      // 347px — inside the 42px name written from the field's left edge.
      measuring(400, SEVEN_PX_PER_GLYPH);
      await render(markedUp);
      expect(segment('uptrend').className).toContain('justify-end');
    });

    it('leaves it on its own edge when the marker is nowhere near the glyphs', async () => {
      // The same card on a 1200px track: the name still starts at the cut, the
      // mark is still just inside the field, and there are now 60px of green
      // between them. Nothing has to move, and moving would put the word that
      // explains the field at the wrong end of it.
      measuring(1200, SEVEN_PX_PER_GLYPH);
      await render(markedUp);
      expect(segment('uptrend').className).toContain('justify-start');
    });

    /*
     * Unmeasured, nothing moves. The server and the first client render both
     * see a track of 0, and they have to draw the same card or hydration is
     * comparing two different ones — the same contract the caption merge keeps.
     */
    it('does not move a name on a track it has not measured', async () => {
      await render(markedUp);
      expect(segment('uptrend').className).toContain('justify-start');
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
      expect(zoneBar().textContent).toContain('ราคาตอนนี้ 46.31');
      expect(zoneBar().textContent).toContain('ยังอยู่ในกรอบเดิมเหมือนราคาปิด');
      // The caption ON the bar, so the thin mark is identifiable without the
      // sentence underneath it. Asserted on the caption itself rather than on
      // the card's text: both now say "ราคาตอนนี้ 46.31", which is the point —
      // one name for one price, wherever the reader meets it.
      expect(zoneBar().querySelector<HTMLElement>('[data-label="live"]')!.textContent).toBe('ราคาตอนนี้ 46.31');
      expect(zoneBar().querySelector('[data-marker="live"]')).not.toBeNull();
      // And it is not the price the percentages are measured from.
      expect(zoneBar().textContent).toContain('ปิดล่าสุด 44.06');
    });

    it('never drops the live marker, whatever the caption does', async () => {
      // Live and close a hair apart: the two captions are in rows of their own
      // precisely so neither has to be dropped here.
      await render(zoned, 'elite', 44.07);
      expect(zoneBar().querySelector('[data-marker="live"]')).not.toBeNull();
      expect(zoneBar().querySelector('[data-marker="close"]')).not.toBeNull();
      expect(zoneBar().querySelector<HTMLElement>('[data-label="live"]')!.textContent).toBe('ราคาตอนนี้ 44.07');
    });

    /*
     * The case the brief called out: the header shows a live price that has
     * already cleared the trigger while the signal still reads from a close
     * below it. Saying nothing invites a reader to conclude the card is stale.
     */
    it('says so out loud when the live price has left the close’s field', async () => {
      await render(zoned, 'elite', 47.9);
      expect(zoneBar().textContent).toContain('ราคาตอนนี้ 47.9 ขึ้นไปเหนือกรอบเดิมแล้ว');
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
        expect(line.textContent).toContain('ราคาตอนนี้ 42.38 ตกกลับเข้ากรอบเดิมแล้ว');
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
        expect(line.textContent).toContain('ราคาตอนนี้ 37.1 หลุดลงใต้กรอบเดิมแล้ว');
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
      /*
       * "ราคาผ่านขึ้นไปแล้ว" was the second half of a trigger row, and the rows
       * are gone: the same fact is now the drawing's to make — the close marker
       * stands past the upper cut, in the field named ขาขึ้น. So what is left to
       * assert here is the sentence and the number that must not appear.
       */
      expect(zoneBar().querySelector('[data-zone="uptrend"]')!.getAttribute('data-active')).toBe('true');
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
      expect(zoneBar().textContent).toContain('และกรอบนี้เพิ่งตั้งได้ไม่นาน ยังไม่มีฝั่งไหนคุมได้');
    });

    it('warns when the zone itself is the new thing', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, zoneAgeBars: 1, frameAgeBars: 40 } });
      expect(zoneBar().textContent).toContain('และกรอบนี้เพิ่งตั้งได้ไม่นาน ยังไม่มีฝั่งไหนคุมได้');
    });

    /*
     * A2 — the clause said something that had not happened.
     *
     * One sentence served all three zones: " แต่เพิ่งผ่านมาไม่นาน ยังพลิกกลับได้ง่าย".
     * On a sideways card the line above it reads "ราคายังอยู่ในกรอบเดิม" —
     * nothing was crossed — so the two halves of one sentence contradicted each
     * other and the half claiming an event was the false one. The word
     * "ผ่าน" must not appear on a card where nothing was passed.
     */
    it('never claims something was crossed on a zone where nothing was', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, zoneAgeBars: 1, frameAgeBars: 1 } });
      const text = zoneBar().textContent ?? '';
      expect(text).toContain('ราคายังอยู่ในกรอบเดิม');
      expect(text).not.toContain('เพิ่งผ่านมาไม่นาน');
    });

    it.each(['uptrend', 'downtrend'] as const)('keeps the crossing clause on %s, where something was crossed', async (zone) => {
      await render({ ...zoned, zones: { ...zoned.zones!, zone, zoneAgeBars: 1, frameAgeBars: 40 } });
      expect(zoneBar().textContent).toContain('แต่เพิ่งผ่านมาไม่นาน ยังพลิกกลับได้ง่าย');
    });

    it('stays quiet when both the zone and its frame have stood a while', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, zoneAgeBars: 45, frameAgeBars: 40 } });
      expect(zoneBar().textContent).not.toContain('เพิ่งผ่านมาไม่นาน');
      expect(zoneBar().textContent).not.toContain('เพิ่งตั้งได้ไม่นาน');
    });

    /*
     * A3 — the card's own question, on the zone that was not answering it.
     *
     * A sideways card carries no `actionable` rows (the engine publishes no
     * invalidation for a zone that claims no direction), so it said where price
     * was standing and stopped. "What has to happen for this to change?" is the
     * question the whole block is for, and both numbers were already on the
     * payload and already drawn on the bar.
     */
    it('says what would change a sideways zone, in the rule the engine uses', async () => {
      await render(zoned);
      const line = zoneBar().querySelector('[data-testid="signal-zone-change"]')!;
      expect(line.textContent).toBe('โซนจะเปลี่ยนก็ต่อเมื่อราคาปิดเหนือ 47.24 หรือต่ำกว่า 38.26');
      // Conditional, and naming no action: the row is a statement of the rule.
      for (const banned of ['ควร', 'น่าจะ', 'รอซื้อ', 'ตั้ง stop']) {
        expect(line.textContent, `"${banned}" is advice`).not.toContain(banned);
      }
    });

    it.each(['uptrend', 'downtrend'] as const)('leaves that row off %s, where the actionable rows answer it', async (zone) => {
      await render({ ...zoned, zones: { ...zoned.zones!, zone } });
      expect(zoneBar().querySelector('[data-testid="signal-zone-change"]')).toBeNull();
    });

    /*
     * B3 — the close is through an edge and the label has not followed.
     *
     * `pendingBreakout` is `zone !== 'uptrend' && close > upperTrigger`, so a
     * SIDEWAYS zone whose close is already above the frame is a state the
     * engine names, chips and writes a reason for. The headline over all of it
     * still said "ราคายังอยู่ในกรอบเดิม" while the proximity line one row down
     * said "ราคาเลยขอบกรอบมาแล้ว" — two sentences about one close, disagreeing
     * about which side of a line it is on.
     */
    describe('when a close has gone through an edge but the label has not', () => {
      const pendingUp: MarketSignalResult = {
        ...zoned,
        zones: {
          ...zoned.zones!,
          zone: 'sideways',
          upperTrigger: 43.25,
          referenceClose: 44.06,
          upperDistance: -0.81,
          upperDistanceAtr: -0.2,
          nearestTriggerAtr: -0.2,
          pendingBreakout: true,
        },
      };

      it('never says price is still inside a frame it has closed through', async () => {
        await render(pendingUp);
        const text = zoneBar().textContent ?? '';
        expect(text).toContain('ราคาปิดเลยขอบบนของกรอบแล้ว แต่ยังไม่ผ่านเงื่อนไขยืนยัน');
        expect(text).not.toContain('ราคายังอยู่ในกรอบเดิม');
      });

      it('stops naming a price the close has already passed as the thing to wait for', async () => {
        await render(pendingUp);
        const line = zoneBar().querySelector('[data-testid="signal-zone-change"]')!;
        expect(line.textContent).toBe('ราคาปิดเลยขอบกรอบไปแล้ว โซนจะเปลี่ยนก็ต่อเมื่อปิดแบบนี้จนผ่านเงื่อนไขยืนยัน');
        // The upper trigger must not be offered as a condition still ahead.
        expect(line.textContent).not.toContain('43.25');
      });

      it('drops the freshness clause, which is about a settled zone being young', async () => {
        await render({ ...pendingUp, zones: { ...pendingUp.zones!, zoneAgeBars: 1, frameAgeBars: 1 } });
        expect(zoneBar().textContent).not.toContain('ยังไม่มีฝั่งไหนคุมได้');
      });

      it('says the mirror of it when the close has gone through the floor', async () => {
        await render({
          ...zoned,
          zones: { ...zoned.zones!, zone: 'sideways', pendingBreakdown: true, referenceClose: 37.1 },
        });
        expect(zoneBar().textContent).toContain('ราคาปิดหลุดขอบล่างของกรอบแล้ว แต่ยังไม่ผ่านเงื่อนไขยืนยัน');
      });
    });

    /*
     * B3 — SIDEWAYS with a lean. With zones on, structure names the label and
     * the score describes the lean inside it, so "SIDEWAYS • Bullish Bias" is a
     * normal reading — and the description under it flatly denied the two words
     * above it.
     */
    /*
     * B4 — one zone, two boundary prices, both on the card.
     *
     * `upperTrigger` is `resistance + buffer` and it is the cut the picture is
     * drawn with; `actionable.invalidation` for an uptrend is `resistance`
     * itself. That is deliberate hysteresis and it means the bar shows a cut at
     * 47.24 while the row under it says the zone ends at 46.23 — two right
     * numbers a buffer apart, with nothing saying they are different lines.
     */
    it('says the entry cut and the exit level are different lines on purpose', async () => {
      await render({
        ...zoned,
        state: 'BULLISH',
        bias: 'bullish',
        zones: { ...zoned.zones!, zone: 'uptrend' },
        actionable: {
          invalidation: 46.2297, invalidationAtr: 0.45, invalidationPct: 4.13, invalidationBasis: 'zone_floor',
          target: 58.51, targetAtr: 3.56, targetBasis: 'measured_move', targetIsConvention: true,
          riskReward: 7.94, notes: [],
        },
      });
      // Both numbers are on the card at once, which is why the explanation has
      // to exist somewhere: the drawn cut and the printed level are a buffer
      // apart and neither is wrong.
      expect(zoneBar().textContent).toContain('47.24');
      expect(zoneBar().textContent).toContain('46.23');

      // It is in the dialog rather than on the card, because the card holds a
      // four-line budget under the picture that the test above enforces.
      expect(zoneBar().querySelector('[data-testid="signal-hysteresis-note"]')).toBeNull();
      await act(async () => buttonContaining('ทำไม?').click());
      const note = document.body.querySelector('[data-testid="signal-hysteresis-note"]')!;
      expect(note.textContent).toContain('เป็นคนละราคาโดยตั้งใจ');
      expect(note.textContent).toContain('ขอบที่วาดบนแถบคือเส้นเข้า');
    });

    it.each([
      ['bullish', 'ขาขึ้น'],
      ['bearish', 'ขาลง'],
    ] as const)('does not deny a %s lean the headline is already showing', async (bias, direction) => {
      await render({ ...zoned, bias, score: bias === 'bullish' ? 22 : -22 });
      expect(container.textContent).toContain(`แต่คะแนนรวมเอนไปทาง${direction}`);
      expect(container.textContent).not.toContain('ราคายังไม่มีทิศทางขึ้นหรือลงที่ชัดเจน');
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
        expect(rows.textContent).toContain('ต่ำกว่าราคาปิด 4.1%');
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
        expect(rows.textContent).toContain('สูงกว่าราคาปิด 32.8%');
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
        // `zoneLabelStyle`. Anywhere else it is how a sentence gets cut. The
        // measuring copies are exempt because they are never painted: they exist
        // to be measured, and a caption that has to be measured unwrapped is the
        // whole reason they carry the class.
        if (/whitespace-nowrap/.test(className) && !(node as HTMLElement).dataset?.measure) {
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
