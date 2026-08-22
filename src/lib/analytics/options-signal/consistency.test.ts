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
import { OPTIONS_SIGNAL_CONFIG, OPTIONS_SIGNAL_TOTAL_WEIGHT, OPTIONS_SIGNAL_WEIGHTS } from './config';
import type {
  EventRiskInput,
  IvPricingInput,
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
    expect(diagnostics.confidenceFormula).toBe(confidenceFormulaText({
      coverage: diagnostics.coverage,
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

describe('weights are not what this work is allowed to change', () => {
  it('keeps 15/25/25/10/15', () => {
    expect(OPTIONS_SIGNAL_WEIGHTS).toEqual({
      macro: 15, trend: 25, momentum: 25, sentiment: 10, riskReward: 15,
    });
  });
});
