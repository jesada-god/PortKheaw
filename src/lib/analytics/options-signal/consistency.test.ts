/**
 * The card and its "รายละเอียดการคำนวณ" dialog, held to ONE story.
 *
 * Every test here pins a pair of published statements that were found
 * contradicting each other on the same screen, and asserts they cannot drift
 * apart again. They are deliberately about the PUBLISHED strings and numbers
 * rather than about internal arithmetic — the arithmetic was mostly right, and
 * the sentences describing it were what lied.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateOptionsSignal,
  confidenceFormulaText,
  confidenceFromTerms,
} from './calculations';
import {
  OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_CONFIG,
  OPTIONS_SIGNAL_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_WEIGHTS,
} from './config';
import {
  directedDistanceText,
  distanceAtrText,
  distancePercentText,
} from '@/src/lib/presentation/distance';
import type {
  EventRiskInput,
  IvPricingInput,
  LiquidityInput,
  MacroInput,
  MomentumInput,
  OptionsSignalInput,
  OptionsSignalInputSlot,
  RiskRewardInput,
  SentimentInput,
  TrendInput,
} from './types';

function available<T>(value: T, state: 'LIVE' | 'DELAYED' | 'STALE' = 'DELAYED'): OptionsSignalInputSlot<T> {
  return { status: 'available', state, value, provider: 'fixture', asOf: '2026-08-21T20:00:00.000Z' };
}

const macro: MacroInput = {
  benchmarks: [
    { symbol: 'SPY', close: 500, ema20: 480 },
    { symbol: 'QQQ', close: 380, ema20: 390 },
  ],
};
const trend: TrendInput = { close: 90, ema20: 95, ema50: 100 };
const momentum: MomentumInput = {
  squeeze: 'OFF', squeezeMomentum: 1.6, atr: 2, relativeVolume: 1.06,
};
const sentiment: SentimentInput = {
  putCallRatio: 0.9, basis: 'open-interest', putTotal: 9_000, callTotal: 10_000, expiration: '2026-10-02',
  percentileObservations: 1, ownPercentile: null,
};
const riskReward: RiskRewardInput = { price: 100, support: 93.77, resistance: 110.83 };
const pricing: IvPricingInput = {
  basis: 'iv-vs-realized', impliedVolatility: 0.986, realizedVolatility: 1.284, ratio: 0.768,
  observations: 30, realizedWindowDays: 30, dte: 41,
};
const event: EventRiskInput = { reportDate: '2026-08-27', daysToEarnings: 5, timeOfDay: 'post-market' };

export function baseInput(overrides: Partial<OptionsSignalInput> = {}): OptionsSignalInput {
  return {
    symbol: 'TEST',
    timeframe: '1D',
    calculatedAt: '2026-08-22T00:00:00.000Z',
    latestCandleAt: '2026-08-21',
    finalizedCandles: 250,
    macro: available(macro),
    trend: available(trend),
    momentum: available(momentum),
    pricing: available<IvPricingInput>(pricing),
    sentiment: available(sentiment),
    riskReward: available(riskReward),
    event: available(event),
    ...overrides,
  };
}

describe('confidence — the printed formula is the formula that ran', () => {
  it('prints the exponents, so the printed terms multiply out to the printed result', () => {
    const terms = { coverage: 1, agreement: 0.11, strength: 0.2 };
    const text = confidenceFormulaText(terms);
    const value = confidenceFromTerms(terms);

    // The number at the end of the sentence IS the number the engine published.
    expect(text.endsWith(`${Math.round(value * 100)}%`)).toBe(true);

    /*
     * And the sentence is reproducible: pull the printed `base^exponent` pairs
     * back out, multiply them, and land on the printed result. This is the exact
     * check a reader does by hand, and it failed before the exponents appeared —
     * 1.00 × 0.11 × 0.20 is 2%, not 20%.
     */
    const pairs = [...text.matchAll(/(\d+\.\d+)\^(\d*\.?\d+)/g)];
    expect(pairs).toHaveLength(3);
    const rebuilt = pairs.reduce((product, [, base, exponent]) => product * Number(base) ** Number(exponent), 1);
    expect(rebuilt).toBeCloseTo(value, 2);
  });

  it('reads its exponents from the config the arithmetic reads, never from a copy', () => {
    const { exponents } = OPTIONS_SIGNAL_CONFIG.confidence;
    const text = confidenceFormulaText({ coverage: 1, agreement: 0.5, strength: 0.5 });
    expect(text).toContain(`ความครบ^${exponents.coverage}`);
    expect(text).toContain(`ความสอดคล้อง^${exponents.agreement}`);
    expect(text).toContain(`ความหนักแน่น^${exponents.strength}`);
  });

  it('publishes the same sentence on the signal it publishes the number on', () => {
    const result = calculateOptionsSignal(baseInput());
    expect(result.status).toBe('available');
    const { diagnostics } = result;
    // The COMPLETENESS is the coverage term, not the weight share: the two are
    // different numbers now, and the sentence has to name the one that ran.
    expect(diagnostics.confidenceFormula).toBe(confidenceFormulaText({
      coverage: diagnostics.completeness.value,
      agreement: diagnostics.agreement,
      strength: diagnostics.evidenceStrength,
    }));
    expect(diagnostics.confidenceFormula).toContain(`${Math.round(diagnostics.confidenceBase * 100)}%`);
  });

  it('prints the floor rather than a 0.00 nobody could reproduce', () => {
    const text = confidenceFormulaText({ coverage: 1, agreement: 0, strength: 0 });
    expect(text).toContain(`${OPTIONS_SIGNAL_CONFIG.confidence.termFloor.toFixed(2)}^`);
    expect(text).not.toContain('0.00^');
  });
});

describe('the divisor counts measurements, and only measurements', () => {
  it('strikes a fallback factor from the divisor by exactly its own weight', () => {
    const measured = calculateOptionsSignal(baseInput({
      sentiment: available<SentimentInput>({ ...sentiment, percentileObservations: 60, ownPercentile: 0.5 }),
    }));
    const fallback = calculateOptionsSignal(baseInput());
    if (measured.status !== 'available' || fallback.status !== 'available') throw new Error('expected signals');

    expect(measured.diagnostics.factors.sentiment.measurement).toBe('measured');
    expect(fallback.diagnostics.factors.sentiment.measurement).toBe('fallback-neutral');
    expect(fallback.diagnostics.availableWeight)
      .toBe(measured.diagnostics.availableWeight - OPTIONS_SIGNAL_WEIGHTS.sentiment);
  });

  it('keeps a MEASURED zero in the divisor, because a measured zero is a finding', () => {
    /*
     * The two cases below score the same 0 for entirely different reasons, and
     * the whole split exists to keep them apart:
     *
     *   percentile 0.5   — this symbol's own Put/Call sits mid-range. Measured.
     *   no percentile    — nothing to rank a 0.9 against at all. Not measured.
     */
    const measuredZero = calculateOptionsSignal(baseInput({
      sentiment: available<SentimentInput>({ ...sentiment, percentileObservations: 60, ownPercentile: 0.5 }),
    }));
    if (measuredZero.status !== 'available') throw new Error('expected a signal');

    expect(measuredZero.diagnostics.factors.sentiment.points).toBe(0);
    expect(measuredZero.diagnostics.factors.sentiment.measurement).toBe('measured');
    // The divisor did NOT shrink: the full model was available and was judged.
    expect(measuredZero.diagnostics.availableWeight).toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT);
  });

  it('never publishes a score for a factor it did not count', () => {
    const result = calculateOptionsSignal(baseInput());
    if (result.status !== 'available') throw new Error('expected a signal');
    for (const factor of Object.values(result.diagnostics.factors)) {
      if (factor.measurement === 'measured') continue;
      // "0 / 10" is the shape of a measurement. A factor that was not weighed
      // must not be able to print one.
      expect(factor.points, factor.id).toBeNull();
      expect(factor.normalized, factor.id).toBeNull();
    }
  });

  it('says WHY a fallback factor was not counted, in the reason list', () => {
    const result = calculateOptionsSignal(baseInput());
    if (result.status !== 'available') throw new Error('expected a signal');
    const sentimentFactor = result.diagnostics.factors.sentiment;
    expect(sentimentFactor.fallbackReason).toContain('baseline');
    expect(sentimentFactor.fallbackReason).toContain(`/${OPTIONS_SIGNAL_CONFIG.sentiment.minimumPercentileObservations}`);
    expect(result.reasoning.some((reason) => reason.id === 'sentiment-not-counted')).toBe(true);
  });

  it('leaves the sum of the counted points as the numerator, nothing more', () => {
    const result = calculateOptionsSignal(baseInput());
    if (result.status !== 'available') throw new Error('expected a signal');
    const { factors, availableWeight } = result.diagnostics;
    const counted = Object.values(factors).filter((factor) => factor.measurement === 'measured');
    expect(counted.reduce((sum, factor) => sum + factor.maxPoints, 0)).toBe(availableWeight);
  });
});

describe('completeness is measured under the factors, not at them', () => {
  /** Everything present: every input in the registry arrives. */
  const complete = (): Partial<OptionsSignalInput> => ({
    sentiment: available<SentimentInput>({
      ...sentiment, volumeRatio: 0.8, percentileObservations: 60, ownPercentile: 0.5,
    }),
    riskReward: available<RiskRewardInput>({
      ...riskReward, atr: 3, expectedMove: 6, expectedMoveDte: 45,
    }),
    pricing: available<IvPricingInput>({
      basis: 'iv-percentile', ivPercentile: 44, impliedVolatility: 0.986, observations: 60, dte: 41,
    }),
    momentum: available<MomentumInput>({ ...momentum, relativeVolume: 1.06 }),
  });

  it('reaches 100% only when every registered input actually arrived', () => {
    const result = calculateOptionsSignal(baseInput(complete()));
    if (result.status !== 'available') throw new Error('expected a signal');
    expect(result.diagnostics.completeness.value).toBe(1);
    expect(result.diagnostics.completeness.missing).toEqual([]);
    expect(result.diagnostics.completeness.notCounted).toEqual([]);
  });

  /*
   * THE INVARIANT FROM THE REPORT.
   *
   * The card was showing a yellow "ข้อมูลบางส่วน" badge — which is a factor's own
   * `partial` flag — beside "ความครบของข้อมูล 100%". Whatever else changes, those
   * two statements may never appear together again.
   */
  it('is below 100% whenever ANY factor is flagged as partial', () => {
    const partialCases: Array<[string, Partial<OptionsSignalInput>]> = [
      ['no RVOL to confirm momentum', {
        ...complete(),
        momentum: available<MomentumInput>({ ...momentum, relativeVolume: null }),
      }],
      ['no EMA50 under the trend', {
        ...complete(),
        trend: available<TrendInput>({ ...trend, ema50: null }),
      }],
      ['no Put/Call baseline', { ...complete(), sentiment: available(sentiment) }],
    ];

    for (const [name, overrides] of partialCases) {
      const result = calculateOptionsSignal(baseInput(overrides));
      if (result.status !== 'available') throw new Error(`expected a signal for ${name}`);
      const flaggedPartial = Object.values(result.diagnostics.factors)
        .some((factor) => factor.partial || factor.measurement !== 'measured');
      expect(flaggedPartial, name).toBe(true);
      expect(result.diagnostics.completeness.value, name).toBeLessThan(1);
    }
  });

  it('names what is missing, and counts down where a countdown applies', () => {
    const result = calculateOptionsSignal(baseInput({ ...complete(), sentiment: available(sentiment) }));
    if (result.status !== 'available') throw new Error('expected a signal');
    const entry = result.diagnostics.completeness.inputs
      .find((input) => input.id === 'sentiment.own-percentile');
    expect(entry?.available).toBe(false);
    expect(entry?.note).toContain('ขาดอีก');
  });

  it('zeroes a whole factor that could not be judged, however much of it arrived', () => {
    // Sentiment holds a real Put/Call and a real volume ratio, and still has no
    // baseline. Two of three inputs present must not read as two-thirds complete
    // when the factor they feed produced nothing the model could use.
    const result = calculateOptionsSignal(baseInput({
      ...complete(),
      sentiment: available<SentimentInput>({ ...sentiment, volumeRatio: 0.8 }),
    }));
    if (result.status !== 'available') throw new Error('expected a signal');
    const withoutSentiment = 1 - OPTIONS_SIGNAL_WEIGHTS.sentiment / OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT;
    expect(result.diagnostics.completeness.value).toBeCloseTo(withoutSentiment, 6);
    // …and the inputs that DID arrive are reported as present, not as missing.
    expect(result.diagnostics.completeness.missing).not.toContain('Put/Call จาก Open Interest');
    expect(result.diagnostics.completeness.notCounted).toContain('Put/Call จาก Open Interest');
  });

  it('keeps the PRIME floor on the weight share it was calibrated against', () => {
    const result = calculateOptionsSignal(baseInput(complete()));
    if (result.status !== 'available') throw new Error('expected a signal');
    // Two different rulers, deliberately: one for what the reader is told, one
    // for the threshold. Nothing here re-tunes the second.
    expect(result.diagnostics.coverage).toBe(1);
    expect(result.diagnostics.completeness.value).toBe(1);
  });
});

describe('the premium is not judged across an earnings report inside the contract', () => {
  const cheapLookingIv: IvPricingInput = {
    basis: 'iv-vs-realized', impliedVolatility: 0.986, realizedVolatility: 1.284, ratio: 0.768,
    observations: 30, realizedWindowDays: 30, dte: 41,
  };

  /*
   * THE PASS CRITERION FROM THE REPORT: with earnings inside the contract, the
   * words ถูก and แพง may not appear anywhere in the payload. The card was
   * printing "ระดับความแพง: ต่ำ" five days before a report, on a contract with 41
   * days to run, while deducting 15 confidence points for that same report.
   */
  it('lets no ถูก/แพง verdict reach the payload', () => {
    const result = calculateOptionsSignal(baseInput({
      pricing: available<IvPricingInput>(cheapLookingIv),
      event: available<EventRiskInput>({ reportDate: '2026-08-27', daysToEarnings: 5, timeOfDay: 'post-market' }),
    }));
    if (result.status !== 'available') throw new Error('expected a signal');

    expect(result.diagnostics.iv.level).toBeNull();
    expect(result.diagnostics.iv.levelSuppressedReason).toContain('อยู่ในอายุสัญญา');

    const payload = JSON.stringify(result);
    expect(payload).not.toContain('ระดับความแพง: ต่ำ');
    expect(payload).not.toContain('ยังไม่แพง');
    expect(payload).not.toContain('แพงกว่าปกติ');
    expect(payload).not.toContain('แพงผิดปกติ');
  });

  it('still publishes the raw ratio, with the disclaimer attached to it', () => {
    const result = calculateOptionsSignal(baseInput({
      pricing: available<IvPricingInput>(cheapLookingIv),
      event: available<EventRiskInput>({ reportDate: '2026-08-27', daysToEarnings: 5, timeOfDay: 'post-market' }),
    }));
    if (result.status !== 'available') throw new Error('expected a signal');
    // Withholding a verdict is not hiding a measurement.
    expect(result.diagnostics.iv.ratio).toBeCloseTo(0.768, 3);
    expect(result.diagnostics.iv.impliedVolatility).toBeCloseTo(0.986, 3);
    expect(result.reasoning.some((reason) => reason.id === 'iv-level-pre-earnings')).toBe(true);
  });

  it('publishes the verdict again once the report falls outside the contract', () => {
    const result = calculateOptionsSignal(baseInput({
      pricing: available<IvPricingInput>({ ...cheapLookingIv, dte: 3 }),
      event: available<EventRiskInput>({ reportDate: '2026-09-30', daysToEarnings: 39, timeOfDay: 'post-market' }),
    }));
    if (result.status !== 'available') throw new Error('expected a signal');
    // The report is 39 days out and the contract expires in 3: this option never
    // meets the event, so its premium is judgeable on the ordinary basis.
    expect(result.diagnostics.iv.levelSuppressedReason).toBeNull();
    expect(result.diagnostics.iv.level).not.toBeNull();
  });

  it('leaves the confidence penalty and the risk gate exactly where they were', () => {
    /*
     * Withholding the VERDICT must not withhold the GATE. An extreme premium
     * still raises IV_WARNING and still costs confidence, whether or not the
     * card is willing to put a word to it.
     */
    const extreme: IvPricingInput = {
      basis: 'iv-vs-realized', impliedVolatility: 2.4, realizedVolatility: 1.2, ratio: 2,
      observations: 30, realizedWindowDays: 30, dte: 41,
    };
    const result = calculateOptionsSignal(baseInput({
      pricing: available<IvPricingInput>(extreme),
      event: available<EventRiskInput>({ reportDate: '2026-08-27', daysToEarnings: 5, timeOfDay: 'post-market' }),
    }));
    if (result.status !== 'available') throw new Error('expected a signal');
    expect(result.diagnostics.iv.level).toBeNull();
    expect(result.diagnostics.penalties.map((penalty) => penalty.id)).toContain('iv-extreme');
    expect(result.signalType).toBe('IV_WARNING');
  });
});

describe('a distance to a level is written one way everywhere', () => {
  it('never signs either distance, in the factor sentence or in the diagnostics', () => {
    const result = calculateOptionsSignal(baseInput());
    if (result.status !== 'available') throw new Error('expected a signal');
    const { detail } = result.diagnostics.factors.riskReward;

    /*
     * The pair that contradicted itself on one screen: the row printed
     * `+10.83% / +6.23%` while this sentence printed `ลงถึงแนวรับ -6.23%`. Both
     * distances are magnitudes now, and the direction is in the words.
     */
    expect(detail).toContain('ขึ้นถึงแนวต้าน 10.83%');
    expect(detail).toContain('ลงถึงแนวรับ 6.23%');
    expect(detail).not.toContain('-6.23%');
    expect(detail).not.toContain('+6.23%');
    expect(detail).not.toContain('+10.83%');

    // And the numbers the UI formats are magnitudes too, so no call site can
    // reintroduce a sign by negating one on the way out.
    expect(result.diagnostics.riskReward.upsidePercent).toBeGreaterThan(0);
    expect(result.diagnostics.riskReward.downsidePercent).toBeGreaterThan(0);
  });

  it('formats a distance the same way whoever asks', () => {
    expect(distancePercentText(6.23)).toBe('6.23%');
    expect(distancePercentText(-6.23)).toBe('6.23%');
    expect(distancePercentText(null)).toBe('—');
    expect(distanceAtrText(-1.2)).toBe('1.20 ATR');
    expect(directedDistanceText('down', 'แนวรับ', -6.23)).toBe('ลงถึงแนวรับ 6.23%');
  });
});

describe('a liquidity gate that did not pass awards no marks', () => {
  const closedBook: LiquidityInput = {
    medianOpenInterest: 899, medianVolume: 533, medianSpreadPercent: 6.18,
    contractsExamined: 12, expiration: '2026-10-02', marketOpenAtCapture: false,
  };

  it('publishes no grade and no score anywhere in the payload for that chain', () => {
    const result = calculateOptionsSignal(baseInput({ liquidity: available<LiquidityInput>(closedBook) }));
    if (result.status !== 'available') throw new Error('expected a signal');
    const { liquidity } = result.diagnostics;

    expect(result.liquidityGrade).toBe('unknown');
    expect(liquidity.score).toBeNull();
    // The one thing standing interest can honestly say, said as a pass and not
    // as a mark out of a hundred.
    expect(liquidity.offHoursAssessment).toEqual({ standingPassed: true });
    expect(liquidity.detail).not.toContain('100');
  });

  it('keeps liquidity out of the direction, exactly as before', () => {
    const withChain = calculateOptionsSignal(baseInput({ liquidity: available<LiquidityInput>(closedBook) }));
    const withoutChain = calculateOptionsSignal(baseInput());
    if (withChain.status !== 'available' || withoutChain.status !== 'available') throw new Error('expected signals');

    // Not a rule this work is allowed to change, and the easiest one to break by
    // accident while rearranging the box that displays it.
    expect(withChain.diagnostics.directionScore0to100).toBe(withoutChain.diagnostics.directionScore0to100);
    expect(withChain.diagnostics.availableWeight).toBe(withoutChain.diagnostics.availableWeight);
    expect(withChain.confidenceScore).toBe(withoutChain.confidenceScore);
  });
});

describe('weights are not what this work is allowed to change', () => {
  it('keeps 15/25/25/10/15', () => {
    expect(OPTIONS_SIGNAL_WEIGHTS).toEqual({
      macro: 15, trend: 25, momentum: 25, sentiment: 10, riskReward: 15,
    });
  });
});
