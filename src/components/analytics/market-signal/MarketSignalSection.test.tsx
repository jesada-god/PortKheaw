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
    histogramExpanding: true,
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

/**
 * The label on the control that opens the advanced layer.
 *
 * Typed once here rather than fifteen times inline: the button was renamed from
 * "ทำไม?" when the card was split into a beginner layer and this one, and a
 * test file that spelled it out at every call site is a test file that gets
 * renamed by search-and-replace and half-misses.
 */
const ADVANCED_TOGGLE = 'ดูรายละเอียดการคำนวณ';

/**
 * Open the advanced layer and hand back the dialog it renders into.
 *
 * `ResponsiveDialog` portals to `document.body`, so everything that moved off
 * the card — the state description, the base rate, the history strip, the
 * footer — is outside `container` and has to be queried from the portal.
 */
async function openAdvanced(): Promise<HTMLElement> {
  await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
  return document.body.querySelector<HTMLElement>('[role="dialog"]')!;
}

describe('MarketSignalSection', () => {
  it.each(['basic', 'pro'] as const)('shows only a locked preview for %s', async (tier) => {
    await render(result, tier);

    expect(container.querySelector('[data-testid="technical-outlook-locked"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="locked-technical.outlook"]')).not.toBeNull();
    expect(container.textContent).not.toContain('SQUEEZE');
    expect(container.textContent).not.toContain('+31');
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

  /*
   * THE BEGINNER LAYER, AND THE LINE THAT IS NO LONGER ON IT.
   *
   * The state line used to read `SQUEEZE • Bullish Bias`. "Bias" is a word
   * about where price is going, printed above a footer saying the card does not
   * say where price is going, and on SIDEWAYS it restated the state name. It
   * moved to the dialog's own title, where it sits beside the score it comes
   * from — so this asserts both halves: gone from the card, kept one tap away.
   */
  it('shows the state, the one-line reading, its reasons, the agreement word and the chips', async () => {
    await render();
    expect(container.textContent).toContain('SQUEEZE');
    expect(container.textContent).not.toContain('Bullish Bias');
    expect(container.textContent).toContain('ราคาแกว่งแคบลงกว่าปกติ');
    // The reasons are on the card now, as labels rather than as sentences.
    const reasons = container.querySelector('[data-testid="signal-beginner-reasons"]')!;
    expect(reasons.textContent).toContain('ราคายืนเหนือเส้นค่าเฉลี่ยราคา');
    expect(reasons.textContent).toContain('ช่วงแกว่งของราคากำลังบีบแคบลง');
    expect(container.querySelector('[data-testid="signal-agreement-word"]')!.textContent)
      .toContain('หลักฐานไปทางเดียวกันบ้าง');
    expect(container.textContent).toContain('squeeze');
  });

  /*
   * The long disclosure is three lines and the beginner layer carries one of
   * them; the other two, and this one in full, are at the bottom of the
   * advanced layer. Both ends are asserted here so neither can be dropped by
   * itself — see the `signal-footer` block further down for every render path.
   */
  it('carries the short note and the legal line on the card, the evidence one tap away', async () => {
    await render();
    expect(container.querySelector('[data-testid="signal-short-note"]')!.textContent)
      .toBe('สถานะนี้อธิบายแนวโน้มจากข้อมูลที่ผ่านมา ไม่ใช่การคาดการณ์ว่าราคาจะไปทางไหน');
    expect(container.querySelector('[data-testid="signal-card-disclaimer"]')!.textContent)
      .toBe('Market Signal เป็นการสรุปข้อมูลทางเทคนิค ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย');
    expect(container.querySelector('[data-testid="signal-footer"]')).toBeNull();

    const dialog = await openAdvanced();
    expect(dialog.textContent).toContain('Market Signal เป็นการสรุปข้อมูลทางเทคนิค ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย');
    expect(dialog.textContent).toContain('ยังบอกไม่ได้ว่าราคาจะออกทางไหน แต่ตอนนี้หลักฐานเอนไปทางขึ้นมากกว่า');
    expect(dialog.textContent).toContain('SQUEEZE • Bullish Bias');
  });

  /*
   * P4a measured what the old headline was worth: the 90-99 band hit 53-55%,
   * which is what the 20-29 band hit. A reader shown "67%" next to a direction
   * reads a probability, and the number is not one. The word stays on the card;
   * the figure moved into the breakdown where its inputs are.
   */
  describe('no number on the card can be read as a probability of price', () => {
    /*
     * The rule the score joined, having been the standing exception to it.
     *
     * The agreement lost its figure in P4.5 and kept its word. The score kept
     * both, in the shape a reader is likeliest to misread — "Score +31 / 100"
     * next to a direction, which was reported back as "a 31% chance of going
     * up". The two are now held to one rule: the beginner layer carries the
     * WORD and no figure at all.
     */
    it('names the evidence agreement in words, and prints neither figure', async () => {
      await render();
      const headline = container.querySelector('[data-state]')!;
      expect(headline.textContent).toContain('หลักฐานไปทางเดียวกันบ้าง');
      expect(headline.textContent).not.toContain('Confidence');
      expect(headline.textContent).not.toContain('67');
      expect(headline.textContent).not.toContain('Score');
      expect(headline.textContent).not.toContain('+31');
    });

    it('keeps both figures one tap away, each said as a score out of 100', async () => {
      await render();
      await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
      const numbers = dialog.querySelector('[data-testid="signal-numbers"]')!;
      expect(numbers.textContent).toContain('คะแนนรวมเอนไปทางไหน');
      expect(numbers.textContent).toContain('+31');
      expect(dialog.textContent).toContain('67/100');
      expect(dialog.textContent).toContain('ไม่ใช่ % โอกาสที่ราคาจะไปทางนั้น');
    });

    /*
     * The label carries the axis, because the number cannot. "/ 100" was the
     * third of the three things inviting the percentage reading — after an
     * English word for a grade and a label with no sign in it — and a range
     * with a negative end is the only form that makes -45 a direction rather
     * than a bad mark out of a hundred.
     */
    it('prints the axis under the score instead of a denominator', async () => {
      await render();
      const numbers = (await openAdvanced()).querySelector('[data-testid="signal-numbers"]')!;
      expect(numbers.textContent).toContain('ช่วง -100 ถึง +100');
      expect(numbers.textContent).toContain('ไม่ใช่เปอร์เซ็นต์');
      expect(numbers.textContent).not.toContain('+31 / 100');
    });

    /*
     * Both readings the label has to survive, checked as the reader meets them:
     * the sign is the direction, so the same words have to work with the number
     * on either side of zero.
     */
    it.each([[7, '+7'], [-45, '-45']])('reads the same label at %s', async (score, printed) => {
      await render({ ...result, score });
      const numbers = (await openAdvanced()).querySelector('[data-testid="signal-numbers"]')!;
      expect(numbers.textContent).toContain('คะแนนรวมเอนไปทางไหน');
      expect(numbers.textContent).toContain(printed);
      // Never a word that would call a -45 card "unclear", and never the name
      // the number beside it already wears.
      expect(numbers.textContent).not.toContain('ความชัดเจนของสัญญาณ');
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
    const dialog = await openAdvanced();
    const scoreHint = dialog.querySelector<HTMLButtonElement>('[aria-label="คำอธิบาย: คะแนนรวมเอนไปทางไหน"]')!;
    expect(scoreHint.className).toContain("after:-inset-[13px]");
    await act(async () => scoreHint.click());
    // What it is: a sum, with a sign, on a stated axis.
    expect(dialog.textContent).toContain('ผลรวมของคะแนนหลักฐานทั้งห้าหมวด อยู่ระหว่าง -100 ถึง +100');
    // And what it is not, in the same breath, because that is the misreading.
    expect(dialog.textContent).toContain('ไม่ใช่เปอร์เซ็นต์ความแม่นยำ และไม่ใช่โอกาสที่ราคาจะไปทางนั้น');
    expect(dialog.textContent).toContain('+7 คือเอนขึ้นเพียงเล็กน้อย ไม่ใช่ 7%');
    expect(dialog.textContent).toContain('-45 คือเอนลงค่อนข้างมาก ไม่ใช่ 45%');
    await act(async () => scoreHint.click());

    const agreementHint = container.querySelector<HTMLButtonElement>('[aria-label="คำอธิบาย: ความสอดคล้องของหลักฐาน"]')!;
    await act(async () => agreementHint.click());
    expect(container.textContent).toContain('เป็นการวัดตัวระบบเอง ไม่ใช่โอกาสที่ราคาจะขึ้นหรือลง');
  });

  it('opens the responsive why dialog with six sections, exact breakdown, real metrics, and missing values as dash', async () => {
    await render();
    const why = buttonContaining(ADVANCED_TOGGLE);
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
    await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
    await render({ ...result, symbol: 'MSFT' });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('SQUEEZE');
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
    expect(container.textContent).toContain('ยังมีข้อมูลราคาไม่พอจะสรุปอะไรได้');
    expect(container.textContent).toContain('ต้องมี finalized candles เพิ่ม');
    expect(container.textContent).not.toContain('SQUEEZE • Bullish Bias');
    expect(container.textContent).not.toContain('+31');
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
    await act(async () => buttonContaining(ADVANCED_TOGGLE).click());

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
        'ทุกตัวเลขในกล่องนี้วัดจากราคาปิดล่าสุด 44.06 (14 ส.ค. 2569) · นับเฉพาะราคาปิดของวัน ราคาที่แตะระหว่างวันไม่นับ',
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
        expect(segment('downtrend').textContent).toBe('ใต้กรอบ');
        expect(segment('sideways').textContent).toBe('ในกรอบ');
        expect(segment('uptrend').textContent).toBe('เหนือกรอบ');
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
          .toContain('ทุกตัวเลขในกล่องนี้วัดจากราคาปิดล่าสุด 42');
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
      expect(zoneBar().textContent).toContain('ถ้าราคาปิดลงต่ำกว่า');
      expect(zoneBar().textContent).toContain('ถือว่าราคากลับเข้ากรอบ และการขึ้นรอบนี้จบ');
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
      expect(segment('downtrend').textContent).toBe('ใต้กรอบ');
      expect(segment('uptrend').textContent).toBe('เหนือกรอบ');
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
      expect(zoneBar().textContent).toContain('ยังไม่ออกจากกรอบ');
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
      expect(zoneBar().textContent).toContain('ราคาตอนนี้ 47.9 ขึ้นไปเหนือกรอบแล้ว');
      expect(zoneBar().textContent).toContain('แต่ต้องรอราคาปิดของวัน ราคาระหว่างวันยังไม่นับ');
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
        expect(line.textContent).toContain('ราคาตอนนี้ 42.38 ลงกลับเข้ากรอบแล้ว');
        expect(line.textContent).toContain('แต่ต้องรอราคาปิดของวัน ราคาระหว่างวันยังไม่นับ');
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
        expect(line.textContent).toContain('ยังอยู่เหนือกรอบ');
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
        expect(line.textContent).toContain('ราคาตอนนี้ 37.1 ลงไปใต้กรอบแล้ว');
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
      expect(zoneBar().textContent).toContain('ราคาขึ้นไปอยู่เหนือกรอบเดิมแล้ว');
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
     * price is. The score itself is untouched — same value, one tap away at
     * the head of the dialog now, under a label that names its axis.
     */
    it('says nothing about direction inside the zone box', async () => {
      await render(zoned);
      const text = zoneBar().textContent ?? '';
      expect(text).toContain('ราคายังอยู่ในกรอบเดิม ไม่ได้ขึ้นไปหรือลงไปพ้นกรอบ');
      for (const banned of ['ยังไม่เอียงไปทางไหน', 'เอียงขึ้น', 'เอียงลง', '(+16)']) {
        expect(text, `"${banned}" is back in the zone box`).not.toContain(banned);
      }
      // Unchanged, and still reachable: the same figure, one tap away.
      expect((await openAdvanced()).querySelector('[data-testid="signal-numbers"]')!.textContent)
        .toContain('+16');
    });

    it('keeps the position line, which is what that line is now for', async () => {
      await render(zoned);
      expect(zoneBar().textContent).toContain('ราคาปิดใกล้ขอบกรอบแล้ว');
      await render({ ...zoned, zones: { ...zoned.zones!, proximity: 'deep_range' } });
      expect(zoneBar().textContent).toContain('ราคาปิดยังอยู่กลางกรอบ ห่างขอบที่ใกล้ที่สุด');
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
      expect(zoneBar().textContent).toContain('· กรอบนี้เพิ่งตั้งได้ไม่กี่วัน ยังไม่นิ่ง');
    });

    it('warns when the zone itself is the new thing', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, zoneAgeBars: 1, frameAgeBars: 40 } });
      expect(zoneBar().textContent).toContain('· กรอบนี้เพิ่งตั้งได้ไม่กี่วัน ยังไม่นิ่ง');
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
      expect(text).toContain('ราคายังอยู่ในกรอบเดิม ไม่ได้ขึ้นไปหรือลงไปพ้นกรอบ');
      expect(text).not.toContain('เพิ่งผ่านมาไม่นาน');
    });

    /*
     * And the clause now names the direction price would come BACK in. It used
     * to be one string on both zones — "ยังพลิกกลับได้ง่าย" — which is a word a
     * beginner has to be taught and which points nowhere. Saying "ยังลงกลับเข้า
     * กรอบได้ง่าย" on a bearish card would point the wrong way, so the two are
     * asserted apart rather than together.
     */
    it.each([
      ['uptrend', '· เพิ่งขึ้นไปได้ไม่กี่วัน ยังลงกลับเข้ากรอบได้ง่าย'],
      ['downtrend', '· เพิ่งลงไปได้ไม่กี่วัน ยังขึ้นกลับเข้ากรอบได้ง่าย'],
    ] as const)('keeps the crossing clause on %s, pointing back into the frame', async (zone, clause) => {
      await render({ ...zoned, zones: { ...zoned.zones!, zone, zoneAgeBars: 1, frameAgeBars: 40 } });
      expect(zoneBar().textContent).toContain(clause);
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
      expect(line.textContent).toBe('ราคาปิดต้องขึ้นเหนือ 47.24 หรือลงต่ำกว่า 38.26 ถึงจะนับว่าออกจากกรอบ');
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
        expect(text).toContain('ราคาปิดขึ้นไปเหนือกรอบแล้ว แต่ยังไม่ผ่านเกณฑ์ที่จะนับว่าออกจากกรอบจริง');
        expect(text).not.toContain('ราคายังอยู่ในกรอบเดิม ไม่ได้ขึ้นไปหรือลงไปพ้นกรอบ');
      });

      it('stops naming a price the close has already passed as the thing to wait for', async () => {
        await render(pendingUp);
        const line = zoneBar().querySelector('[data-testid="signal-zone-change"]')!;
        expect(line.textContent).toBe('ราคาปิดออกนอกกรอบไปแล้ว ต้องปิดแบบนี้ต่ออีกจนผ่านเกณฑ์ ถึงจะนับว่าออกจากกรอบจริง');
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
        expect(zoneBar().textContent).toContain('ราคาปิดลงไปใต้กรอบแล้ว แต่ยังไม่ผ่านเกณฑ์ที่จะนับว่าออกจากกรอบจริง');
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
      await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
      const note = document.body.querySelector('[data-testid="signal-hysteresis-note"]')!;
      expect(note.textContent).toContain('เป็นคนละราคาโดยตั้งใจ');
      expect(note.textContent).toContain('ขอบที่วาดบนแถบคือเส้นเข้า');
    });

    it.each([
      ['bullish', 'ขึ้น'],
      ['bearish', 'ลง'],
    ] as const)('does not deny a %s lean the headline is already showing', async (bias, direction) => {
      await render({ ...zoned, bias, score: bias === 'bullish' ? 22 : -22 });
      // The sentence moved into §1 with the rest of the spelled-out reading;
      // what it may not do — deny the two words above it — is unchanged.
      const dialog = await openAdvanced();
      expect(dialog.textContent).toContain(`แต่คะแนนรวมเอนไปทาง${direction}`);
      expect(dialog.textContent).not.toContain('ราคายังไม่มีทิศทางขึ้นหรือลงที่ชัดเจน');
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
      expect(zoneBar().textContent).toContain('· อีกไม่กี่วันทำการก็เปลี่ยนได้');
      expect(zoneBar().textContent).toContain('ราคาปิดใกล้ขอบกรอบแล้ว เหลืออีก 7.2%');
    });

    it('never implies deep_range is the more trustworthy reading', async () => {
      await render({ ...zoned, zones: { ...zoned.zones!, proximity: 'deep_range', nearestTriggerAtr: 4.1 } });
      expect(zoneBar().textContent).toContain('ราคาปิดยังอยู่กลางกรอบ ห่างขอบที่ใกล้ที่สุด 7.2%');
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
      await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
      const details = document.querySelector('[data-testid="signal-zone-details"]')!;
      expect(details.textContent).toContain('68.8%');
      expect(details.textContent).toContain('จุดที่ราคาเคยกลับตัวจริง');
      expect(details.textContent).toContain('0.78 ATR');
      expect(details.textContent).toContain('1.43 ATR');
      expect(details.textContent).toContain('45 แท่ง');
      expect(details.textContent).toContain('3 แท่ง');
      expect(details.textContent).toContain('0 แท่งก่อน');
    });

    it('draws no zone detail block when there is no zone', async () => {
      await render(result);
      await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
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
        expect(rows.textContent).toContain('ถ้าราคาปิดลงต่ำกว่า');
        expect(rows.textContent).toContain('42.24');
        // The brief's own example: "0.45 ATR · 4.13% จากราคาปิด" becomes this.
        expect(rows.textContent).toContain('ต่ำกว่าราคาปิดล่าสุด 4.1%');
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
        expect(rows.textContent).toContain('สูงกว่าราคาปิดล่าสุด 32.8%');
        expect(rows.textContent).toContain('เป็นแค่การคาดคะเนตามธรรมเนียมของคนอ่านกราฟ ยังไม่เคยทดสอบว่าแม่นจริงไหม');
      });

      it('says what the measured move IS, instead of naming the arithmetic', async () => {
        await render(actionable);
        const rows = container.querySelector('[data-testid="signal-actionable"]')!;
        expect(rows.textContent).toContain('ถ้าขึ้นต่ออีกเท่ากับความสูงกรอบเดิม จะถึง');
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
        expect(rows.textContent).not.toContain('ระยะไปถึงเป้า ยาวกว่าระยะที่จะรู้ว่ารอบนี้จบ');
        expect(zoneBar().textContent).not.toContain('ระยะที่จะรู้ว่าโซนนี้จบ ยาวกว่า');

        await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
        const details = document.querySelector('[data-testid="signal-zone-details"]')!;
        expect(details.textContent).toContain('7.94');
        expect(details.textContent).toContain('0.45 ATR');
        expect(details.textContent).toContain('3.56 ATR');
        // The whole block moved, not just the number: the reading of the
        // quotient is now beside the quotient.
        expect(details.textContent).toContain('ระยะไปถึงเป้า ยาวกว่าระยะที่จะรู้ว่ารอบนี้จบ');
      });

      it('reads a ratio under one the other way round, in the dialog', async () => {
        await render({ ...actionable, actionable: { ...actionable.actionable!, riskReward: 0.6 } });
        await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
        const details = document.querySelector('[data-testid="signal-zone-details"]')!;
        expect(details.textContent).toContain('ระยะที่จะรู้ว่ารอบนี้จบ ยาวกว่าระยะไปถึงเป้า');
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
        await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
        const details = document.querySelector('[data-testid="signal-zone-details"]')!;
        expect(details.textContent).toContain('ไม่ได้แปลว่าโอกาสดีกว่า');
      });

      it('drops the note with the number when there is no ratio', async () => {
        await render({ ...actionable, actionable: { ...actionable.actionable!, riskReward: null } });
        await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
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
        expect(rows.textContent).not.toContain('ถ้าขึ้นต่ออีกเท่ากับความสูงกรอบเดิม');
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

      it('keeps the disclaimer intact, at the foot of the advanced layer', async () => {
        await render(actionable);
        expect((await openAdvanced()).textContent)
          .toContain('ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย');
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
     * EVERY STATE THIS BLOCK CAN BE IN, SAID OUT LOUD ONCE.
     *
     * The copy above grew one state at a time, and the states that never drew a
     * complaint never drew an assertion either: the two `downtrend` headlines,
     * the `atr_band` frame, a frame that could not be drawn, the bearish target
     * label, and the change condition on a directional zone all shipped without
     * a test naming the sentence a reader would see. That is how the target
     * label managed to point upward on a bearish card for as long as it did.
     *
     * So this is the whole matrix, in one place, asserted on the exact string.
     * `toBe` and not `toContain`: a containment check passes when a clause is
     * appended that nobody meant to append, and appended clauses are precisely
     * what went wrong here before.
     */
    describe('every zone state, in words a beginner already owns', () => {
      const headline = () => zoneBar().querySelector('[data-zone-row="headline"]')!.textContent;
      const liveRow = () => zoneBar().querySelector('[data-zone-row="live"]')?.textContent ?? null;
      const changeRow = () => zoneBar().querySelector('[data-zone-row="change"]')?.textContent ?? null;
      const withZones = (patch: Partial<NonNullable<MarketSignalResult['zones']>>): MarketSignalResult =>
        ({ ...zoned, zones: { ...zoned.zones!, ...patch } });

      // Ages that put the card either side of `FRESH_ZONE_BARS`, named so the
      // cases below read as "fresh" and "settled" rather than as two numbers.
      const fresh = { zoneAgeBars: 1, frameAgeBars: 40 };
      const settled = { zoneAgeBars: 45, frameAgeBars: 40 };

      it.each([
        [
          'inside, freshly framed',
          { zone: 'sideways' as const, zoneAgeBars: 1, frameAgeBars: 1 },
          'ราคายังอยู่ในกรอบเดิม ไม่ได้ขึ้นไปหรือลงไปพ้นกรอบ · กรอบนี้เพิ่งตั้งได้ไม่กี่วัน ยังไม่นิ่ง',
        ],
        [
          'inside, settled',
          { zone: 'sideways' as const, ...settled },
          'ราคายังอยู่ในกรอบเดิม ไม่ได้ขึ้นไปหรือลงไปพ้นกรอบ',
        ],
        [
          'above, freshly crossed',
          { zone: 'uptrend' as const, ...fresh },
          'ราคาขึ้นไปอยู่เหนือกรอบเดิมแล้ว · เพิ่งขึ้นไปได้ไม่กี่วัน ยังลงกลับเข้ากรอบได้ง่าย',
        ],
        [
          'above, settled',
          { zone: 'uptrend' as const, ...settled },
          'ราคาขึ้นไปอยู่เหนือกรอบเดิมแล้ว',
        ],
        [
          'below, freshly crossed',
          { zone: 'downtrend' as const, ...fresh },
          'ราคาลงไปอยู่ใต้กรอบเดิมแล้ว · เพิ่งลงไปได้ไม่กี่วัน ยังขึ้นกลับเข้ากรอบได้ง่าย',
        ],
        [
          'below, settled',
          { zone: 'downtrend' as const, ...settled },
          'ราคาลงไปอยู่ใต้กรอบเดิมแล้ว',
        ],
        [
          'closed above the edge, label not moved',
          { zone: 'sideways' as const, ...settled, pendingBreakout: true },
          'ราคาปิดขึ้นไปเหนือกรอบแล้ว แต่ยังไม่ผ่านเกณฑ์ที่จะนับว่าออกจากกรอบจริง จึงยังถือว่าอยู่ในกรอบเดิม',
        ],
        [
          'closed below the edge, label not moved',
          { zone: 'sideways' as const, ...settled, pendingBreakdown: true },
          'ราคาปิดลงไปใต้กรอบแล้ว แต่ยังไม่ผ่านเกณฑ์ที่จะนับว่าออกจากกรอบจริง จึงยังถือว่าอยู่ในกรอบเดิม',
        ],
        [
          'a frame that is arithmetic rather than history',
          { zone: 'sideways' as const, ...settled, mode: 'atr_band' as const },
          'ราคายังอยู่ในกรอบเดิม ไม่ได้ขึ้นไปหรือลงไปพ้นกรอบ · กรอบนี้คำนวณจากความเหวี่ยงของราคา ไม่ใช่ราคาที่ตลาดเคยชนจริง และขยับทุกวัน',
        ],
        [
          'no frame at all',
          { zone: 'sideways' as const, ...settled, lowerTrigger: 0, upperTrigger: 0 },
          'ราคายังอยู่ในกรอบเดิม ไม่ได้ขึ้นไปหรือลงไปพ้นกรอบ · ข้อมูลยังไม่พอจะตีกรอบ ตัวเลขขอบจึงยังไม่มี',
        ],
      ])('heads the block with %s', async (_name, patch, expected) => {
        await render(withZones(patch));
        expect(headline()).toBe(expected);
      });

      /*
       * The live row, on both axes it varies over: which field the price on
       * screen is standing in, and whether that is the field the close is in.
       *
       * The divergent cases all end in the same sentence, and that is the
       * point — the reason the number on screen changed nothing is one rule,
       * not four, and a reader who meets it once should recognise it again.
       */
      it.each([
        ['standing where the close stands, inside', 40.82, 44.06, 'sideways' as const, 'ราคาตอนนี้ 40.82 ยังไม่ออกจากกรอบ'],
        ['standing where the close stands, above', 49.2, 48, 'uptrend' as const, 'ราคาตอนนี้ 49.2 ยังอยู่เหนือกรอบ'],
        ['standing where the close stands, below', 36.4, 37, 'downtrend' as const, 'ราคาตอนนี้ 36.4 ยังอยู่ใต้กรอบ'],
        ['up through the edge since the close', 47.9, 44.06, 'sideways' as const, 'ราคาตอนนี้ 47.9 ขึ้นไปเหนือกรอบแล้ว · แต่ต้องรอราคาปิดของวัน ราคาระหว่างวันยังไม่นับ'],
        ['down through the edge since the close', 37.1, 44.06, 'sideways' as const, 'ราคาตอนนี้ 37.1 ลงไปใต้กรอบแล้ว · แต่ต้องรอราคาปิดของวัน ราคาระหว่างวันยังไม่นับ'],
        ['back down inside since the close', 42.01, 48, 'uptrend' as const, 'ราคาตอนนี้ 42.01 ลงกลับเข้ากรอบแล้ว · แต่ต้องรอราคาปิดของวัน ราคาระหว่างวันยังไม่นับ'],
        ['back up inside since the close', 40, 37, 'downtrend' as const, 'ราคาตอนนี้ 40 ขึ้นกลับเข้ากรอบแล้ว · แต่ต้องรอราคาปิดของวัน ราคาระหว่างวันยังไม่นับ'],
      ])('says the live price %s', async (_name, live, close, zone, expected) => {
        await render(withZones({ zone, referenceClose: close, ...settled }), 'elite', live);
        expect(liveRow()).toBe(expected);
      });

      it('draws no live row at all when the two prices are the same price', async () => {
        await render(zoned, 'elite', 44.06);
        expect(liveRow()).toBeNull();
      });

      /*
       * "ห่างจากราคาปิดน้อยมาก" read as a distance the card was reporting. What
       * it says is that one mark had to stand for two prices, which is a fact
       * about the drawing and not about the market.
       */
      it('says why one mark is standing for two prices', async () => {
        measuring(280, SEVEN_PX_PER_GLYPH);
        await render(zoned, 'elite', 43.85);
        expect(liveRow()).toContain('· ราคาทั้งสองต่างกันน้อยมาก บนแถบจึงวาดทับกันเป็นเส้นเดียว');
      });

      /*
       * "WHAT WOULD CHANGE THIS?" on all three zones.
       *
       * `sideways` has always had an answer. The directional zones had one only
       * when `ActionableRows` happened to be drawing the level anyway, and were
       * silent otherwise — which on today's corpus is most cards. These four
       * cases are the whole rule: the two-trigger sentence while both edges are
       * still ahead, the confirmation sentence once one is behind, the re-entry
       * level on a directional zone with no actionable row, and nothing at all
       * when the actionable row is already printing that same price.
       */
      it.each([
        [
          'inside, both edges still ahead',
          zoned,
          'ราคาปิดต้องขึ้นเหนือ 47.24 หรือลงต่ำกว่า 38.26 ถึงจะนับว่าออกจากกรอบ',
        ],
        [
          'inside, one edge already closed through',
          withZones({ pendingBreakout: true }),
          'ราคาปิดออกนอกกรอบไปแล้ว ต้องปิดแบบนี้ต่ออีกจนผ่านเกณฑ์ ถึงจะนับว่าออกจากกรอบจริง',
        ],
        [
          'above, with no actionable row to say it',
          withZones({ zone: 'uptrend', referenceClose: 48, ...settled }),
          'ราคาปิดต้องลงต่ำกว่า 46.23 ถึงจะนับว่ากลับเข้ากรอบ',
        ],
        [
          'below, with no actionable row to say it',
          withZones({ zone: 'downtrend', referenceClose: 37, ...settled }),
          'ราคาปิดต้องขึ้นเหนือ 39.27 ถึงจะนับว่ากลับเข้ากรอบ',
        ],
      ])('answers what would change it when %s', async (_name, value, expected) => {
        await render(value);
        expect(changeRow()).toBe(expected);
      });

      /*
       * And says it ONCE. The re-entry level and the invalidation level are the
       * same price — the engine hands `resistance` to `calculateActionable` and
       * gets it back as `invalidation` — so drawing both rows would print one
       * number twice and spend a fifth line doing it.
       */
      it('leaves the answer to the actionable row when that row is drawn', async () => {
        await render({
          ...withZones({ zone: 'uptrend', referenceClose: 48, ...settled }),
          actionable: {
            invalidation: 46.23, invalidationAtr: 0.44, invalidationPct: 3.69, invalidationBasis: 'zone_floor',
            target: 58.51, targetAtr: 2.62, targetBasis: 'measured_move', targetIsConvention: true,
            riskReward: 5.94, notes: [],
          },
        });
        expect(changeRow()).toBeNull();
        expect(zoneBar().querySelector('[data-testid="signal-actionable"]')!.textContent)
          .toContain('ถือว่าราคากลับเข้ากรอบ และการขึ้นรอบนี้จบ');
      });

      /*
       * A level the close is already past is not a condition a reader can wait
       * for. The engine refuses to publish it as an invalidation
       * (`invalidation_behind_close`); the fallback row applies that same
       * refusal to the same geometry rather than inventing a rule of its own.
       */
      it('does not ask for something that has already happened', async () => {
        await render(withZones({ zone: 'uptrend', referenceClose: 44.06, ...settled }));
        expect(changeRow()).toBeNull();
      });

      /*
       * THE BUG THIS MATRIX WAS WRITTEN TO CATCH.
       *
       * The target label was one constant string on both directional zones,
       * and the projection it labels is `level - height` on a bearish card. So
       * the row read "ก็มักไปได้อีกเท่านั้น" over a price BELOW the one it was
       * measured from, with its own percentage underneath correctly saying
       * "ต่ำกว่าราคาปิดล่าสุด". Both halves now come off `zones.zone`.
       */
      it.each([
        ['uptrend' as const, 48, 58.51, 'ถ้าขึ้นต่ออีกเท่ากับความสูงกรอบเดิม จะถึง', 'ถือว่าราคากลับเข้ากรอบ และการขึ้นรอบนี้จบ'],
        ['downtrend' as const, 37, 28.4, 'ถ้าลงต่ออีกเท่ากับความสูงกรอบเดิม จะถึง', 'ถือว่าราคากลับเข้ากรอบ และการลงรอบนี้จบ'],
      ])('points the target and end-of-leg rows the way a %s card is pointing', async (zone, close, target, label, ends) => {
        await render({
          ...withZones({ zone, referenceClose: close, ...settled }),
          actionable: {
            invalidation: zone === 'uptrend' ? 46.23 : 39.27,
            invalidationAtr: 0.44,
            invalidationPct: zone === 'uptrend' ? 3.69 : 6.14,
            invalidationBasis: zone === 'uptrend' ? 'zone_floor' : 'zone_ceiling',
            target, targetAtr: 2.62, targetBasis: 'measured_move', targetIsConvention: true,
            riskReward: 5.94, notes: [],
          },
        });
        const rows = zoneBar().querySelector('[data-testid="signal-actionable"]')!;
        expect(rows.textContent).toContain(label);
        expect(rows.textContent).toContain(ends);
      });

      /*
       * The four-line budget, on every zone rather than on the one it was
       * written against. A row added for `downtrend` alone would have shipped
       * under the old test.
       */
      it.each(['sideways', 'uptrend', 'downtrend'] as const)('keeps %s inside the four-line budget', async (zone) => {
        await render({
          ...withZones({ zone, referenceClose: zone === 'downtrend' ? 37 : 48, ...settled }),
          actionable: zone === 'sideways' ? undefined : {
            invalidation: zone === 'uptrend' ? 46.23 : 39.27,
            invalidationAtr: 0.44, invalidationPct: 3.69,
            invalidationBasis: zone === 'uptrend' ? 'zone_floor' : 'zone_ceiling',
            target: zone === 'uptrend' ? 58.51 : 28.4,
            targetAtr: 2.62, targetBasis: 'measured_move', targetIsConvention: true,
            riskReward: 5.94, notes: [],
          },
        }, 'elite', zone === 'downtrend' ? 36.4 : 47.2);
        const rows = [...zoneBar().children];
        const picture = rows.findIndex((node) => node.getAttribute('data-zone-row') === 'picture');
        const lines = rows.slice(picture + 1).flatMap((node) => (
          node.getAttribute('data-zone-row') === 'actionable' ? [...node.children] : [node]
        ));
        expect(lines.length, `${zone} spends more than four lines under the picture`).toBeLessThanOrEqual(4);
      });
    });

    /*
     * THE WORDS THE CARD IS NOT ALLOWED TO USE.
     *
     * Every one of these is a term of art a reader who has never traded would
     * have to look up, and every one of them was on this card at some point.
     * The list is a test rather than a comment because a banned word comes back
     * the way it arrived the first time: somebody adds one clause, in the
     * vocabulary they think in, to a card nobody re-reads whole.
     *
     * "โซน" is on it for a different reason from the rest. It is not jargon —
     * it is an ordinary Thai word — but it was the card's SECOND name for the
     * rectangle the bar draws, and the bar itself says "กรอบ". Two names for
     * one object is the failure this list exists to prevent, so the unused one
     * is banned outright.
     *
     * "ATR" and "swing" survive in `signal-zone-details`, which is the raw
     * numbers block inside "ทำไม?" and says so in its own first paragraph. The
     * sweep is scoped to the card, which is where the ten-second read happens.
     */
    const CARD_MUST_NOT_SAY = [
      'โซน', 'ไซด์เวย์', 'เบรก', 'breakout', 'breakdown', 'sideways',
      'หลุด', 'พลิกกลับ', 'ตกกลับ', 'โมเมนตัม', 'วอลุ่ม', 'โครงสร้าง',
      'swing', 'ATR', 'divergence', 'ของกรอบ', 'เงื่อนไขยืนยัน',
    ];

    it.each([
      ['sideways' as const, false, false],
      ['uptrend' as const, false, false],
      ['downtrend' as const, false, false],
      ['sideways' as const, true, false],
      ['sideways' as const, false, true],
    ])('keeps the %s block (pending %s, band %s) clear of every banned term', async (zone, pending, band) => {
      await render({
        ...zoned,
        zones: {
          ...zoned.zones!,
          zone,
          pendingBreakout: pending,
          mode: band ? 'atr_band' : 'structural',
          referenceClose: zone === 'downtrend' ? 37 : zone === 'uptrend' ? 48 : 44.06,
        },
        actionable: zone === 'sideways' ? undefined : {
          invalidation: zone === 'uptrend' ? 46.23 : 39.27,
          invalidationAtr: 0.44, invalidationPct: 3.69,
          invalidationBasis: zone === 'uptrend' ? 'zone_floor' : 'zone_ceiling',
          target: zone === 'uptrend' ? 58.51 : 28.4,
          targetAtr: 2.62, targetBasis: 'measured_move', targetIsConvention: true,
          riskReward: 5.94, notes: [],
        },
      }, 'elite', zone === 'downtrend' ? 36.4 : 47.2);
      const text = zoneBar().textContent ?? '';
      for (const banned of CARD_MUST_NOT_SAY) {
        expect(text, `"${banned}" is on the zone block`).not.toContain(banned);
      }
    });

    /*
     * The same sweep over the card OUTSIDE the zone block — the state line, its
     * Thai description, and the flag chips. A card that explains itself in
     * plain words below the picture and in trading vocabulary above it has not
     * been translated, it has been made bilingual, which is worse than either.
     *
     * The English STATE names and `Bullish Bias` are deliberately exempt: they
     * are identifiers the payload carries and the history strip is keyed on,
     * not prose. The Thai line directly under them is what this checks.
     */
    it('keeps the headline, its Thai description and the chips clear of the same terms', async () => {
      await render({ ...zoned, flags: ['strong_momentum', 'high_volume', 'pre_earnings_breakout'] });
      const whole = container.querySelector('[aria-label="Technical Outlook"]')!.textContent ?? '';
      const outside = whole.replace(zoneBar().textContent ?? '', '');
      for (const banned of CARD_MUST_NOT_SAY) {
        expect(outside, `"${banned}" is on the card above the picture`).not.toContain(banned);
      }
    });

    /*
     * ONE NAME PER THING, CHECKED ACROSS THE LINES RATHER THAN WITHIN THEM.
     *
     * Each row of the block read fine on its own; what did not was reading two
     * of them in sequence. The bar said "กรอบเดิม", the sentence above it said
     * "กรอบ", and the two sentences below it said "โซน" — three rows, one
     * rectangle, two vocabularies. This asserts the relationship rather than
     * the strings: whatever the bar calls its three fields, the prose has to
     * use those same words for those same three states.
     */
    it('calls the bar fields and the sentences around them by the same names', async () => {
      await render(zoned, 'elite', 47.9);
      const names = ['downtrend', 'sideways', 'uptrend'].map((id) => segment(id).textContent ?? '');
      expect(names).toEqual(['ใต้กรอบ', 'ในกรอบ', 'เหนือกรอบ']);
      const text = zoneBar().textContent ?? '';
      // Every field name the bar draws is a phrase the prose actually uses, so a
      // reader can carry a word from the picture to the sentence and back.
      for (const name of names) {
        expect(text, `the bar says "${name}" and no sentence does`).toContain(name);
      }
      // And the noun is the same one throughout: no row may reach for a synonym.
      for (const synonym of ['ช่วงราคา', 'ระดับราคา', 'โซนราคา']) {
        expect(text).not.toContain(synonym);
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
      expect(chips.slice(0, 3)).toEqual(['หลักฐานขัดแย้งกัน', 'ปริมาณซื้อขายน้อย', 'ยังยืนยันไม่ชัด']);
      expect(chips.at(-1)).toContain('+3');
      expect(chips.at(-1)).toContain(ADVANCED_TOGGLE);
    });

    it('explains in the dialog why it would not commit to a direction', async () => {
      await render(gated);
      await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
      const explainer = document.querySelector('[data-testid="signal-gate-explainer"]')!;
      expect(explainer.textContent).toContain('คะแนนรวมยังต่ำกว่าเกณฑ์');
      expect(explainer.textContent).toContain('EMA/Trend กับ Momentum ชี้คนละทาง');
      expect(explainer.textContent).toContain('อีก 10 วันจะประกาศงบ');
      // The overflow chips are listed rather than lost.
      expect(explainer.textContent).toContain('ความผันผวนบีบตัว');
      expect(explainer.textContent).toContain('ราคามีแรงส่ง');
      expect(explainer.textContent).toContain('ปริมาณซื้อขายสูง');
    });

    it('shows confidence as the multipliers it actually is', async () => {
      await render(gated);
      await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
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

  const SHORT_NOTE = 'สถานะนี้อธิบายแนวโน้มจากข้อมูลที่ผ่านมา ไม่ใช่การคาดการณ์ว่าราคาจะไปทางไหน';
  const MEASURED_PROVENANCE_TEXT = `วัดจาก ${MARKET_SIGNAL_MEASURED.corpusInstruments} สินทรัพย์ · ${MARKET_SIGNAL_MEASURED.period.thai}`;

  /*
   * WHERE THE THREE LINES ARE NOW, AND WHY THE RULE DID NOT CHANGE.
   *
   * The rule was: no render path ships without the disclosure. It still holds,
   * and it is still checked on every one of the eight surfaces below — what
   * changed is that the full card has two layers, and the full footer sits at
   * the bottom of the second one. The beginner layer carries `SHORT_NOTE`,
   * which says the same thing the finding says without the evidence attached.
   *
   * The three surfaces with no advanced layer to open — locked, failed, too few
   * candles — keep the footer exactly where it was, on the only layer they
   * have. `finder` is what tells the two shapes apart, and it is deliberately
   * the ONLY difference between them: everything asserted about the footer is
   * asserted about all eight.
   */
  const footerFor = async (payload: MarketSignalResult | null, tier: SubscriptionTier): Promise<HTMLElement> => {
    const onCard = container.querySelector<HTMLElement>('[data-testid="signal-footer"]');
    if (onCard) return onCard;
    // The full card: the short note is up here and the footer is one tap away.
    expect(container.querySelector('[data-testid="signal-short-note"]')!.textContent, `${tier}`).toBe(SHORT_NOTE);
    expect(payload).not.toBeNull();
    return (await openAdvanced()).querySelector<HTMLElement>('[data-testid="signal-footer"]')!;
  };

  it.each(surfaces)('%s reads it', async (_name, tier, capability, payload) => {
    await render(payload, tier, null, capability);
    const footer = await footerFor(payload, tier);
    expect(footer).not.toBeNull();
    expect(footer.textContent).toContain(NOT_A_FORECAST);
    // The disclaimer it sits above is still there, unchanged.
    expect(footer.textContent).toContain('ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย');
  });

  it('puts the finding above the legal line, not below it', async () => {
    await render();
    const lines = [...(await footerFor(result, 'elite')).children].map((line) => line.textContent ?? '');
    expect(lines[0]).toBe(NOT_A_FORECAST);
    expect(lines.at(-1)).toContain('ไม่ใช่คำแนะนำซื้อขาย');
  });

  /*
   * The one sentence the beginner layer has room for, and the thing that makes
   * it a summary rather than a replacement: it says what the card is describing
   * against what a reader assumes it is describing, which is the useful half of
   * the disclosure. The evidence and the legal line are one tap away, asserted
   * above on this very surface.
   */
  /*
   * THE LEGAL LINE, AND WHY IT IS ON THE CARD RATHER THAN ONLY BEHIND A TAP.
   *
   * `git log -S "no render path can ship without it"` lands on 02c3070, and
   * that commit decides the placement of the FINDING — "above the disclaimer,
   * on every one of the four render paths" — because P4a had just measured it.
   * The disclaimer itself is older (51f4f5f) and the same clause is written
   * inline on six other surfaces; the versioned instrument is
   * `INVESTMENT_DISCLAIMER` in `src/lib/legal/documents.ts`. So this line is
   * convention, not compliance — and the convention is that it sits on the
   * surface a reader acts from. Only this line came back; the finding and its
   * provenance stay with the evidence they quote.
   */
  it('says on the card that this is not trading advice, on every full-card tier', async () => {
    for (const [tier, capability] of [
      ['elite', 'technical.outlook'],
      ['elite', 'technical.outlook.commodity'],
      ['pro', 'technical.outlook.commodity'],
    ] as const) {
      await render(result, tier, null, capability);
      const line = container.querySelector('[data-testid="signal-card-disclaimer"]')!;
      expect(line.textContent, `${tier}/${capability}`).toContain('ไม่ใช่คำแนะนำซื้อขาย');
      expect(line.getAttribute('class')).not.toMatch(/truncate|line-clamp-|hidden|overflow-hidden/);
      // The other two lines stay where the evidence is.
      expect(container.textContent, `${tier}/${capability}`).not.toContain(NOT_A_FORECAST);
      expect(container.textContent, `${tier}/${capability}`).not.toContain(MEASURED_PROVENANCE_TEXT);
    }
  });

  it('says on the beginner layer that the card is not a forecast', async () => {
    await render();
    const note = container.querySelector('[data-testid="signal-short-note"]')!;
    expect(note.textContent).toBe(SHORT_NOTE);
    expect(note.getAttribute('class')).not.toMatch(/truncate|line-clamp-|hidden|overflow-hidden/);
  });

  /*
   * The claim is only checkable if a reader can see what it was measured over,
   * and it only stays true if the numbers come from the run rather than from
   * somebody's memory of the run. `signal-measured.test.ts` holds the other end
   * of this: it fails when the config stops matching the newest calibration run.
   */
  it('quotes the corpus and the period from the measurement, not from the copy', async () => {
    await render();
    const footer = await footerFor(result, 'elite');
    expect(footer.textContent).toContain(`วัดจาก ${MARKET_SIGNAL_MEASURED.corpusInstruments} สินทรัพย์`);
    expect(footer.textContent).toContain(MARKET_SIGNAL_MEASURED.period.thai);
  });

  it('names the run in the breakdown, so a figure on the card can be traced to one', async () => {
    await render();
    await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
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
    const footer = await footerFor(result, 'elite');
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
    const first = (await footerFor(result, 'elite')).firstElementChild!;
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
  // `rawState` mirrors `state`: these fixtures are days where the hold rule
  // had nothing to hold, which is what makes them a baseline for the days it
  // does. The tests that exercise a held day set the two apart explicitly.
  const day = (asOf: string, state: MarketSignalState, rawState: MarketSignalState | null = state) => ({
    asOf,
    state,
    rawState,
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
      currentRawLabelDays: 2,
      recentFlip: false,
      ...over,
    },
  });

  /*
   * THE STRIP MOVED, AND NOTHING IT SAYS DID.
   *
   * It is a measurement about the ENGINE — how long this label has stood, how
   * many days were recorded, and the flat statement that neither number makes
   * the label more accurate — which is the advanced layer's subject rather than
   * the beginner layer's. Every assertion below is the one it had; only the
   * node it reads is now inside the dialog.
   */
  const historyBlock = async () => (await openAdvanced()).querySelector('[data-testid="signal-history"]');
  const historyStrip = async () => (await openAdvanced())
    .querySelector('[aria-label="ประวัติป้าย 30 วัน"]')!;

  it('draws one cell per recorded day and not one per calendar day', async () => {
    await render(withHistory());
    expect((await historyStrip()).children).toHaveLength(3);
  });

  it('says how many of the days in its window it actually has', async () => {
    await render(withHistory());
    const block = (await historyBlock())!;
    // The absence is disclosed as a number rather than drawn as invented cells.
    expect(block.textContent).toContain('บันทึกได้ 3 วัน จาก 30 วันที่ผ่านมา');
  });

  it('states the label age as a duration', async () => {
    await render(withHistory());
    expect((await historyBlock())!.textContent).toContain('ยืนมา 2 วัน');
  });

  /*
   * P8 — the strip may only show the age the hold rule did not touch.
   *
   * Holding a changed label makes every published run at least as long as the
   * reading under it, so `currentLabelDays` now carries the engine's own
   * influence. §6.8 measured that an older label is not a more accurate one and
   * forbids the card implying otherwise; printing a duration the engine
   * lengthened would be that claim with an extra step. So the number on the
   * card is `currentRawLabelDays`, and this test fails if anyone swaps it back.
   */
  it('shows the raw run and never the held one', async () => {
    await render(withHistory({ currentLabelDays: 9, currentRawLabelDays: 2 }));
    const block = (await historyBlock())!;
    expect(block.textContent).toContain('ยืนมา 2 วัน');
    expect(block.textContent).not.toContain('ยืนมา 9 วัน');
  });

  it('shows no age at all when the raw run cannot be counted honestly', async () => {
    await render(withHistory({ currentLabelDays: 9, currentRawLabelDays: null }));
    const block = (await historyBlock())!;
    expect(block.textContent).toContain('ยังไม่มีวันที่บันทึกพอ');
    expect(block.textContent).not.toContain('9 วัน');
  });

  it('will not call one recorded day a run', async () => {
    await render(withHistory({
      entries: [day('2026-08-12', 'SIDEWAYS')],
      currentLabelDays: null,
      currentRawLabelDays: null,
    }));
    const block = (await historyBlock())!;
    expect(block.textContent).toContain('ยังไม่มีวันที่บันทึกพอ');
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
    const cells = [...(await historyStrip()).children].map((cell) => cell.getAttribute('class'));
    expect(new Set(cells).size).toBe(1);
  });

  it('says in words that a long-standing label is not a more accurate one', async () => {
    await render(withHistory());
    expect((await historyBlock())!.textContent).toContain('ป้ายที่ยืนนานไม่ได้แปลว่าแม่นกว่า');
  });

  it('warns when the label is unsettled, which is the safe direction', async () => {
    await render(withHistory({ recentFlip: true }));
    expect((await historyBlock())!.textContent).toContain('ยังไม่นิ่ง');
  });

  it('draws nothing at all while the flag is off', async () => {
    await render(result);
    expect(await historyBlock()).toBeNull();
  });
});

/*
 * SIDEWAYS, and the gap between what the label says and what was measured.
 *
 * §6.6 followed 10,525 sideways calls: twenty bars on, the LABEL is still
 * sideways 72.6% of the time and price is still inside the frame it named only
 * 25.7% of the time. The card used to answer that with "ราคายังไม่ไปทางไหนชัด"
 * — a sentence with no moment in it, which a reader takes as a description of
 * how the instrument IS rather than of where it stands today. These tests hold
 * the two halves of the fix: the wording is bound to now, and the base rate is
 * on the card rather than in a report.
 */
describe('the SIDEWAYS label says when it is talking about', () => {
  /*
   * Thai has no spaces between words, so the length rule needs the platform's
   * own segmentation rather than `split(' ')` — the same ruler
   * `reason-copy.test.ts` holds the reason table to, for the same reason.
   */
  const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
  const wordCount = (text: string): number =>
    [...segmenter.segment(text)].filter((piece) => piece.isWordLike).length;

  const frame: MarketSignalResult['zones'] = {
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
  };

  /* `Partial<MarketSignalResult>` would widen `status` back to the union and
     leave the fixture assignable to neither half of it. */
  type AvailableSignal = Extract<MarketSignalResult, { status: 'available' }>;

  const sideways = (over: Partial<AvailableSignal> = {}): MarketSignalResult => ({
    ...(result as AvailableSignal), state: 'SIDEWAYS', bias: 'neutral', score: 8, ...over,
  });
  const framed = (over: Partial<AvailableSignal> = {}) => sideways({ zones: frame, ...over });

  /*
   * THE HEADLINE IS ON THE CARD; THE SENTENCE UNDER IT IS NOT, ANY MORE.
   *
   * The card used to carry the state name, this headline, the description AND
   * the frame's own caption on the bar — three tellings of one fact stacked in
   * one column. The headline survived because it is the shortest and the bar
   * because it also shows WHERE, so the description and the base rate moved
   * into the advanced layer. Everything they are held to here is unchanged;
   * only where the test has to look for them is.
   */
  const headline = () => container.querySelector('[data-testid="signal-state-headline"]')!.textContent ?? '';
  const description = async () => (await openAdvanced())
    .querySelector('[data-testid="signal-state-description"]')!.textContent ?? '';
  const baseRate = async () => (await openAdvanced())
    .querySelector('[data-testid="signal-sideways-base-rate-dialog"]');
  const baseRateSentences = async () => [...((await baseRate())?.querySelectorAll('p') ?? [])]
    .map((node) => node.textContent ?? '');

  /*
   * THE DEFECT, RESTATED AS AN ASSERTION. The old wording named no moment, and
   * every replacement — on both card shapes — has to.
   */
  it('never states the label without saying it is about now', async () => {
    for (const payload of [sideways(), sideways({ bias: 'bullish' }), framed(), framed({ bias: 'bearish' })]) {
      await render(payload);
      const spelled = await description();
      expect(headline(), `"${headline()}" could be about any day`).toContain('ตอนนี้');
      expect(spelled, `"${spelled}" could be about any day`).toContain('ตอนนี้');
      expect(`${headline()} ${spelled}`).not.toContain('ยังไม่ไปทางไหนชัด');
    }
  });

  it('names the frame on a card that draws one, and the direction on a card that does not', async () => {
    await render(framed());
    expect(headline()).toBe('ตอนนี้ราคายังอยู่ในกรอบ');
    expect(await description()).toContain('ตอนนี้ราคายังอยู่ในกรอบ');

    /*
     * The other half, and the reason there are two wordings at all. With
     * `SIGNAL_ZONES` off there is no frame in the payload and no rectangle on
     * the card — CL-F ships in exactly this state — so the frame's word would
     * be naming an object the reader cannot see. That is the collision
     * `market-signal/no-unsourced-frame-word` exists to stop.
     */
    await render(sideways());
    expect(headline()).toBe('ตอนนี้ราคายังไม่ไปทางขึ้นหรือทางลง');
    expect(`${headline()} ${await description()}`).not.toContain('กรอบ');
  });

  it('says the lean without denying the label above it', async () => {
    await render(framed({ bias: 'bullish' }));
    expect(await description()).toContain('ตอนนี้ราคายังอยู่ในกรอบ');
    expect(await description()).toContain('แต่คะแนนรวมเอนไปทางขึ้น');

    await render(sideways({ bias: 'bearish' }));
    expect(await description()).toContain('แต่คะแนนรวมเอนไปทางลง');
  });

  /*
   * The disclosure itself, and the one thing that makes it worth having: every
   * figure is READ from the run rather than typed here, so a calibration pass
   * that moves them moves this line too. `signal-measured.test.ts` is the other
   * end of that wire — it fails when the config stops matching the newest run's
   * own `report.md`.
   */
  it('keeps the measured base rate reading from the config and not from memory', async () => {
    await render(framed());
    const measured = MARKET_SIGNAL_MEASURED.sidewaysPersistence;
    const text = (await baseRate())!.textContent ?? '';
    expect(text).toContain(measured.sampleSize.toLocaleString('en-US'));
    expect(text).toContain(`${measured.horizonBars} แท่ง`);
    expect(text).toContain(`${measured.labelStillSidewaysPct}%`);
    expect(text).toContain(`${measured.priceInsideFramePct}%`);
    // Both halves of the finding, never the reassuring one alone.
    expect(text).toContain('ป้ายมักอยู่ต่อ');
    expect(text).toContain('ราคามักออกจากกรอบไปก่อน');
  });

  it('repeats it in the advanced layer beside the reasons', async () => {
    await render(framed());
    await act(async () => buttonContaining(ADVANCED_TOGGLE).click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const inDialog = dialog.querySelector('[data-testid="signal-sideways-base-rate-dialog"]')!;
    expect(inDialog.textContent).toContain(`${MARKET_SIGNAL_MEASURED.sidewaysPersistence.labelStillSidewaysPct}%`);
  });

  /*
   * WHERE IT MAY NOT APPEAR. The measurement is `zone === 'sideways'` followed
   * against `frame.support/resistance`. With no frame there is no "inside" for
   * the second figure to be about, so quoting it would attach a number to a
   * mechanism it never measured — and on any other zone it is simply not that
   * zone's evidence.
   */
  it('withholds the base rate where the measurement does not reach', async () => {
    await render(sideways());
    expect(await baseRate(), 'quoted at a label with no frame behind it').toBeNull();

    await render(framed({ state: 'BULLISH', bias: 'bullish', zones: { ...frame, zone: 'uptrend' } }));
    expect(await baseRate(), 'quoted at a zone it was not measured on').toBeNull();
  });

  /*
   * The two things §6.8 forbids outright, and the one this card forbids itself.
   *
   * A base rate is a fact about past observations. The moment it is written as
   * what price will do next, or as a reason a label that lasts can be trusted,
   * it has stopped being the measurement and started being the claim the
   * measurement rules out.
   */
  it('reports a base rate rather than making a forecast out of it', async () => {
    await render(framed());
    const text = [headline(), await description(), ...(await baseRateSentences())].join(' ');
    for (const forecast of ['จะขึ้น', 'จะลง', 'คาดว่า', 'พยากรณ์', 'มีโอกาส', 'โอกาสที่']) {
      expect(text, `"${forecast}" turns the base rate into a forecast`).not.toContain(forecast);
    }
    for (const endorsement of ['น่าเชื่อถือ', 'ยืนยันแล้ว', 'ยืนนาน', 'แข็งแรง', 'มั่นใจได้']) {
      expect(text, `"${endorsement}" reads a long-standing label as a trustworthy one`).not.toContain(endorsement);
    }
    // Past tense, stated as such: the sentence has to name where the figures
    // came from rather than presenting them as a property of this instrument.
    expect((await baseRateSentences())[0]).toContain('จากการวัดย้อนหลัง');
  });

  /*
   * THE LENGTH RULE, on the prose and not on the labels.
   *
   * 15-35 words is the band `reason-copy.test.ts` holds every reason sentence
   * to, and these sentences are read in the same breath as those. The two
   * headlines are deliberately outside it: they are LABELS, in the same
   * register as the other six states' (four to eleven words each), and a
   * fifteen-word floor would stop them being headlines at all.
   */
  it('keeps every SIDEWAYS sentence inside the 15-35 word band', async () => {
    const sentences: string[] = [];
    for (const bias of ['neutral', 'bullish', 'bearish'] as const) {
      await render(framed({ bias }));
      sentences.push(await description(), ...(await baseRateSentences()));
      await render(sideways({ bias }));
      sentences.push(await description());
    }
    expect(sentences.length).toBeGreaterThan(5);
    for (const sentence of sentences) {
      const words = wordCount(sentence);
      expect(words, `${words} words: "${sentence}"`).toBeGreaterThanOrEqual(15);
      expect(words, `${words} words: "${sentence}"`).toBeLessThanOrEqual(35);
    }
  });

  /*
   * And the card's own ban list, applied to the new sentences directly. The
   * sweep further up covers the zoned fixture; this covers the no-frame card,
   * which that fixture never renders.
   */
  /*
   * P7 — the reading that used to be impossible, and its one sentence.
   *
   * A directional label while the frame still says price has not left it.
   * `trend_diagnosis.md` §B measured what suppressing it cost: 11,330 bars
   * where the ground truth called a move, the GATE+ZONES engine said SIDEWAYS,
   * and `zone === 'sideways'` was 100% of the reason — while the flags-OFF
   * engine named the right direction on 95.3% of those same bars. The card now
   * shows both facts, and these tests hold the sentence that joins them to the
   * same rules every other sentence on the card obeys.
   */
  const inRange = (over: Partial<AvailableSignal> = {}) => sideways({
    zones: frame, state: 'BULLISH', bias: 'bullish', score: 72, ...over,
  });

  it('says both facts when the evidence names a direction from inside the frame', async () => {
    for (const [state, bias, leaning] of [
      ['BULLISH', 'bullish', 'ขึ้น'],
      ['BEARISH', 'bearish', 'ลง'],
    ] as const) {
      await render(inRange({ state, bias, score: state === 'BULLISH' ? 72 : -72 }));
      const text = await description();
      // the direction, from the evidence
      expect(text, state).toContain(`เอนไปทาง${leaning}`);
      // and the frame, unmoved — neither erases the other
      expect(text, state).toContain('ยังอยู่ในกรอบเดิม');
    }
  });

  it('keeps that sentence inside the same 15-35 word band as the rest', async () => {
    for (const state of ['BULLISH', 'BEARISH'] as const) {
      await render(inRange({ state, bias: state === 'BULLISH' ? 'bullish' : 'bearish' }));
      const spelled = await description();
      const words = wordCount(spelled);
      expect(words, `${words} words: "${spelled}"`).toBeGreaterThanOrEqual(15);
      expect(words, `${words} words: "${spelled}"`).toBeLessThanOrEqual(35);
    }
  });

  it('keeps that sentence clear of the terms the card bans', async () => {
    for (const state of ['BULLISH', 'BEARISH'] as const) {
      await render(inRange({ state, bias: state === 'BULLISH' ? 'bullish' : 'bearish' }));
      const text = [headline(), await description()].join(' ');
      for (const banned of ['โซน', 'ไซด์เวย์', 'เบรก', 'sideways', 'หลุด', 'พลิกกลับ', 'โมเมนตัม', 'วอลุ่ม', 'โครงสร้าง', 'สวิง', 'ไดเวอร์เจนซ์', 'เทรนด์', 'ของกรอบ']) {
        expect(text, `"${banned}" is in the in-range direction copy`).not.toContain(banned);
      }
    }
  });

  it('keeps the new sentences clear of the terms the card bans', async () => {
    for (const payload of [framed(), sideways({ bias: 'bullish' })]) {
      await render(payload);
      const text = [headline(), await description(), ...(await baseRateSentences())].join(' ');
      for (const banned of ['โซน', 'ไซด์เวย์', 'เบรก', 'sideways', 'หลุด', 'พลิกกลับ', 'โมเมนตัม', 'วอลุ่ม', 'โครงสร้าง', 'สวิง', 'ไดเวอร์เจนซ์', 'เทรนด์', 'ของกรอบ']) {
        expect(text, `"${banned}" is in the SIDEWAYS copy`).not.toContain(banned);
      }
    }
  });
});
});

/*
 * THE SPLIT ITSELF: what a reader meets before they open anything, and the
 * promise that opening it is the only way to see more.
 *
 * The beginner layer is not a shorter card — it is a card with a different
 * subject. It names the state, gives the account of it, tags it, draws it, and
 * says once that this is not a forecast. Everything that is a measurement about
 * the ENGINE — both sets of edges, the calibration figures, the label's own
 * age, the metric table — is one tap away. These tests hold both halves of
 * that: what is on the first layer, and that nothing left the card entirely.
 */
describe('the beginner layer and the advanced one', () => {
  const reason = (id: string, polarity: MarketSignalResult['reasons'][number]['polarity'], impact: number) => ({
    id, polarity, impact, text: `engine text for ${id}`,
  });

  it('draws the reasons as labels, not as the sentences the dialog draws', async () => {
    await render({
      ...result,
      reasons: [
        reason('ema-structure', 'positive', 8),
        reason('squeeze-on', 'caution', 6),
      ],
    });
    const bullets = [...container.querySelectorAll('[data-testid="signal-beginner-reasons"] [data-reason-id]')]
      .map((node) => node.textContent ?? '');
    expect(bullets).toEqual(['ราคายืนเหนือเส้นค่าเฉลี่ยราคา', 'ช่วงแกว่งของราคากำลังบีบแคบลง']);

    // …and the same two rows, spelled out, one tap away.
    const dialog = await openAdvanced();
    expect(dialog.textContent).toContain('เป็นการเรียงตัวแบบที่เห็นตอนราคาไต่ขึ้นต่อเนื่อง');
  });

  /*
   * Four, and the tail counted rather than dropped. The count is what makes
   * the cut safe to make at all: a reader can see there is more and knows
   * exactly where it is, which is the shape the chip row already uses.
   */
  it('draws four reasons at most and says how many it did not draw', async () => {
    await render({
      ...result,
      reasons: [
        reason('ema-structure', 'positive', 8),
        reason('squeeze-on', 'caution', 6),
        reason('rsi14', 'positive', 5),
        reason('macd-signal', 'positive', 4),
        reason('obv-trend', 'positive', 3),
        reason('swing-structure', 'positive', 2),
      ],
    });
    const list = container.querySelector('[data-testid="signal-beginner-reasons"]')!;
    expect(list.querySelectorAll('[data-reason-id]')).toHaveLength(4);
    expect(list.textContent).toContain('และอีก 2 ข้อ');
    expect(list.textContent).toContain('ดูรายละเอียดการคำนวณ');

    // Every one of the six is still drawn in full in the advanced layer.
    const dialog = await openAdvanced();
    for (const id of ['ema-structure', 'squeeze-on', 'rsi14', 'macd-signal', 'obv-trend', 'swing-structure']) {
      expect(dialog.querySelector(`[data-reason-id="${id}"]`), `${id} left the card entirely`).not.toBeNull();
    }
  });

  /*
   * ORDERED BY THE ENGINE'S OWN `impact`, which is the only ranking the payload
   * carries. A card that picked by id, or by which section a row lands in,
   * would be the presentation layer inventing an importance nobody measured.
   * `Math.abs` because impact carries a side and this list does not.
   */
  it('picks the four by the impact the engine assigned, not by payload order', async () => {
    await render({
      ...result,
      reasons: [
        reason('obv-trend', 'positive', 1),
        reason('ema-structure', 'positive', 9),
        reason('rsi14', 'positive', 2),
        reason('squeeze-on', 'caution', 7),
      ],
    });
    const ids = [...container.querySelectorAll('[data-testid="signal-beginner-reasons"] [data-reason-id]')]
      .map((node) => node.getAttribute('data-reason-id'));
    expect(ids).toEqual(['ema-structure', 'squeeze-on', 'rsi14', 'obv-trend']);
  });

  /*
   * THE ROW THAT WAS FILED UNDER THE WRONG HEADING.
   *
   * `bullish-divergence` says "ราคาทำจุดต่ำใหม่ แต่แรงขายไม่ได้แรงขึ้นตาม" and the
   * engine files it as `caution` — correctly from where the engine sits, because
   * it is a caution to anybody reading the downtrend it interrupts. Under a
   * heading reading ปัจจัยที่ต้องระวัง it read as the opposite of what it says,
   * with §4 sitting empty beside it.
   *
   * The engine's field is untouched. `metrics.divergence` — the field the
   * engine raised the row FROM — is what decides the heading here.
   */
  it('files a bullish divergence as support, and says what it is worth', async () => {
    await render({
      ...result,
      state: 'SIDEWAYS',
      bias: 'neutral',
      metrics: { ...result.metrics, divergence: 'bullish' },
      reasons: [reason('bullish-divergence', 'caution', 4)],
    });
    const dialog = await openAdvanced();
    const sections = [...dialog.querySelectorAll('section')];
    const supporting = sections.find((node) => node.textContent?.startsWith('4. ปัจจัยสนับสนุน'))!;
    const cautions = sections.find((node) => node.textContent?.startsWith('5. ปัจจัยที่ต้องระวัง'))!;

    expect(supporting.querySelector('[data-reason-id="bullish-divergence"]')).not.toBeNull();
    expect(cautions.querySelector('[data-reason-id="bullish-divergence"]')).toBeNull();
    expect(cautions.textContent).toContain('ยังไม่มีปัจจัยขัดแย้งเด่น');

    // And the reader is told it did not move the reading.
    expect(supporting.querySelector('[data-testid="signal-reason-note"]')!.textContent)
      .toContain('น้ำหนักน้อย');
  });

  it('leaves a bearish divergence on the other side of the same line', async () => {
    await render({
      ...result,
      state: 'SIDEWAYS',
      bias: 'neutral',
      metrics: { ...result.metrics, divergence: 'bearish' },
      reasons: [reason('bearish-divergence', 'caution', 4)],
    });
    const dialog = await openAdvanced();
    const sections = [...dialog.querySelectorAll('section')];
    const cautions = sections.find((node) => node.textContent?.startsWith('5. ปัจจัยที่ต้องระวัง'))!;
    expect(cautions.querySelector('[data-reason-id="bearish-divergence"]')).not.toBeNull();
  });

  /*
   * The note is only for the rows this layer RE-FILED. A row the engine itself
   * classified carries no note, because there is nothing to explain about it.
   */
  it('notes only the rows it re-filed, never the ones the engine classified', async () => {
    await render({
      ...result,
      reasons: [reason('ema-structure', 'positive', 8), reason('squeeze-on', 'caution', 6)],
    });
    const dialog = await openAdvanced();
    expect(dialog.querySelector('[data-testid="signal-reason-note"]')).toBeNull();
  });

  /*
   * THE PARTITION IS TOTAL, which it was not before.
   *
   * The old filters asked for `polarity === 'information'` under a neutral bias
   * and `polarity === 'positive'` under a bullish one, so an information row on
   * a directional card — and every positive or negative row on a neutral one —
   * matched neither list and was drawn nowhere at all.
   */
  it('draws every reason under exactly one of the two headings', async () => {
    const reasons = [
      reason('ema-structure', 'positive', 8),
      reason('macd-signal', 'negative', 6),
      reason('rsi14', 'information', 5),
      reason('squeeze-on', 'caution', 4),
    ];
    for (const bias of ['bullish', 'bearish', 'neutral'] as const) {
      await render({ ...result, symbol: `T-${bias}`, bias, reasons });
      const dialog = await openAdvanced();
      for (const { id } of reasons) {
        expect(dialog.querySelectorAll(`[data-reason-id="${id}"]`), `${id} on a ${bias} card`).toHaveLength(1);
      }
    }
  }, 15_000);

  /*
   * C3 — "ทำไมถึงไม่สรุปแรงกว่านี้" and §5 were saying the same two things.
   *
   * The gate block listed `gate.conflicts` and printed an earnings sentence;
   * §5 two headings below carried the SAME two facts as reason rows, raised by
   * the engine from the same two gate fields, word for word in the earnings
   * case. Deduplicated toward §5, which says what each one MEANS.
   */
  /* `Partial<MarketSignalResult>` would widen `status` back to the union and
     leave the fixture assignable to neither half of it. */
  type Available = Extract<MarketSignalResult, { status: 'available' }>;

  const gatedWithReasons = (over: Partial<Available> = {}): MarketSignalResult => ({
    ...(result as Available),
    state: 'SIDEWAYS',
    bias: 'neutral',
    gate: {
      band: 'neutral',
      conflicts: ['ema_vs_momentum'],
      forcedNeutral: false,
      earningsProximity: 'soon',
      daysToEarnings: 10,
      confidenceFactors: { base: 72.66, completeness: 1, agreement: 0.7, regimeClarity: 0.6, conflict: 0.9, earnings: 0.8 },
    },
    reasons: [reason('component-conflict', 'caution', 7), reason('earnings-proximity', 'caution', 5)],
    ...over,
  });

  it('says the conflict and the report date once, in the section that explains them', async () => {
    await render(gatedWithReasons());
    const dialog = await openAdvanced();
    const explainer = dialog.querySelector('[data-testid="signal-gate-explainer"]')!;

    // The band is this block's own and stays.
    expect(explainer.textContent).toContain('คะแนนรวมยังต่ำกว่าเกณฑ์');
    // The two it was repeating are gone from here…
    expect(explainer.textContent).not.toContain('EMA/Trend กับ Momentum ชี้คนละทาง');
    expect(explainer.textContent).not.toContain('อีก 10 วันจะประกาศงบ');
    // …and still said, once, where they are explained.
    expect(dialog.querySelector('[data-reason-id="component-conflict"]')!.textContent)
      .toContain('กำลังชี้คนละทาง');
    expect(dialog.querySelector('[data-reason-id="earnings-proximity"]')!.textContent)
      .toContain('อีก 10 วันบริษัทจะประกาศผลประกอบการ');
  });

  /*
   * NOTHING IS DROPPED, which is why this is a filter and not a deletion.
   * `component-conflict` is ONE row however many conflicts the gate holds — it
   * names the EMA pair when there is one and the structure pair otherwise — so
   * a card carrying both would lose the second if the list simply went away.
   */
  it('still lists a second conflict the reason row has no room to name', async () => {
    await render(gatedWithReasons({
      gate: {
        ...gatedWithReasons().gate!,
        conflicts: ['ema_vs_momentum', 'structure_vs_momentum'],
      },
    }));
    const dialog = await openAdvanced();
    const explainer = dialog.querySelector('[data-testid="signal-gate-explainer"]')!;
    expect(explainer.textContent).toContain('Price Structure กับ Momentum ชี้คนละทาง');
    expect(explainer.textContent).not.toContain('EMA/Trend กับ Momentum ชี้คนละทาง');
  });

  /*
   * And the other direction: with no §5 row for it, the gate block is the only
   * place the earnings proximity is said, so it says it. `gated` in the
   * consistency-layer block above is exactly that card.
   */
  it('keeps the earnings line when no reason row carries it', async () => {
    await render(gatedWithReasons({ reasons: [reason('component-conflict', 'caution', 7)] }));
    const dialog = await openAdvanced();
    expect(dialog.querySelector('[data-testid="signal-gate-explainer"]')!.textContent)
      .toContain('อีก 10 วันจะประกาศงบ');
  });
});
