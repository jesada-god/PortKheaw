/**
 * THE GOLDEN CASE: the signal the contradiction report was written about, pinned
 * field by field, with every published number derived rather than recorded.
 *
 * `symmetry.test.ts` already locks a fixture of its own, and this is not a second
 * copy of it. That one asks "did the answer move" across retunes. This one asks
 * the question the report actually raised, which is different and was never
 * being asked: CAN A READER REPRODUCE WHAT THE CARD SAYS?
 *
 * So the assertions below are not `toBe(41)` against a number somebody read off
 * a screen. Each one recomputes the value from the inputs, by hand, in the test —
 * the same arithmetic a reader would do with the sentences the card prints — and
 * demands the engine agree. A golden that only records outputs would have passed
 * happily on every bug this pass fixed, because each of those bugs was a true
 * number printed beside a wrong explanation of it.
 *
 * Input, from the reported card:
 *
 *   Macro         SPY above EMA20, QQQ below   → the two cancel
 *   Trend         close < EMA20 < EMA50        → fully down
 *   Momentum      histogram 1.6, ATR 2, RVOL 1.06, Squeeze OFF
 *   Sentiment     Put/Call 0.90, own history 1 of 20 days
 *   Risk/Reward   price 100, support 93.77, resistance 110.83
 *   IV            98.6% against 30-day realized 128.4%, 41 DTE
 *   Earnings      5 days out
 */

import { describe, expect, it } from 'vitest';
import { calculateOptionsSignal, confidenceFromTerms, rvolConfirmation } from './calculations';
import {
  OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS,
  OPTIONS_SIGNAL_CONFIG,
  OPTIONS_SIGNAL_WEIGHTS,
} from './config';
import { baseInput } from './reported-case.fixture';

const signal = calculateOptionsSignal(baseInput());
if (signal.status !== 'available') throw new Error('the golden case must produce a signal');
const { diagnostics } = signal;

describe('golden · every factor score is reproducible from its own inputs', () => {
  it('Macro: one benchmark above its EMA20 and one below, so they cancel', () => {
    expect(diagnostics.factors.macro.points).toBe(0);
    // A MEASURED zero. It keeps its full weight, which is the whole distinction
    // the fallback/measured split was introduced to draw.
    expect(diagnostics.factors.macro.measurement).toBe('measured');
  });

  it('Trend: price under both EMAs and EMA20 under EMA50, so the vote is -1', () => {
    expect(diagnostics.factors.trend.normalized).toBe(-1);
    expect(diagnostics.factors.trend.points).toBe(-OPTIONS_SIGNAL_WEIGHTS.trend);
  });

  it('Momentum: 0.8 ATR against a 3.5 ceiling, scaled by the RVOL multiplier', () => {
    const { momentumAtrSaturation, minimumConfirmation } = OPTIONS_SIGNAL_CONFIG.momentum;
    const inAtr = 1.6 / 2;
    const normalized = inAtr / momentumAtrSaturation;
    const multiplier = minimumConfirmation + (1 - minimumConfirmation) * rvolConfirmation(1.06);

    expect(diagnostics.squeeze.breakdown.rawAtr).toBeCloseTo(inAtr, 4);
    expect(diagnostics.squeeze.breakdown.clamped).toBeCloseTo(normalized, 3);
    expect(diagnostics.squeeze.breakdown.multiplier).toBeCloseTo(multiplier, 3);
    expect(diagnostics.factors.momentum.points)
      .toBe(Math.round(normalized * multiplier * OPTIONS_SIGNAL_WEIGHTS.momentum));
  });

  it('Sentiment: a real Put/Call with 1 of the 20 days it needs to rank it', () => {
    const factor = diagnostics.factors.sentiment;
    expect(factor.measurement).toBe('fallback-neutral');
    expect(factor.points).toBeNull();
    expect(factor.fallbackReason)
      .toContain(`1/${OPTIONS_SIGNAL_CONFIG.sentiment.minimumPercentileObservations}`);
  });

  it('Risk/Reward: measured on the Put side, tilt on the configured log base', () => {
    const { tiltSaturationRatio } = OPTIONS_SIGNAL_CONFIG.riskReward;
    const upside = (110.83 - 100) / 100 * 100;
    const downside = (100 - 93.77) / 100 * 100;
    const putRewardRisk = downside / upside;
    // The lead (macro 0, trend -25, momentum +5) is bearish, so geometry is
    // scored on the Put side and a strong put R:R is bearish evidence.
    const normalized = -Math.log(putRewardRisk) / Math.log(tiltSaturationRatio);

    expect(diagnostics.riskReward.upsidePercent).toBeCloseTo(upside, 2);
    expect(diagnostics.riskReward.downsidePercent).toBeCloseTo(downside, 2);
    expect(diagnostics.riskReward.scoredSide).toBe('put');
    expect(diagnostics.factors.riskReward.points)
      .toBe(Math.round(normalized * OPTIONS_SIGNAL_WEIGHTS.riskReward));
  });
});

describe('golden · the published totals follow from those factor scores', () => {
  const counted = Object.values(diagnostics.factors).filter((factor) => factor.measurement === 'measured');
  const summed = counted.reduce((total, factor) => total + (factor.points ?? 0), 0);
  const weight = counted.reduce((total, factor) => total + factor.maxPoints, 0);

  it('adds up the counted factors, and divides by the counted weight', () => {
    // Sentiment is in neither sum. That is the correction, stated as arithmetic.
    expect(weight).toBe(OPTIONS_SIGNAL_WEIGHTS.macro + OPTIONS_SIGNAL_WEIGHTS.trend
      + OPTIONS_SIGNAL_WEIGHTS.momentum + OPTIONS_SIGNAL_WEIGHTS.riskReward);
    expect(diagnostics.availableWeight).toBe(weight);
    expect(diagnostics.rawDirectionPoints).toBe(summed);
  });

  it('converts to 0-100 by the formula it prints, landing on the printed score', () => {
    const score = Math.round((summed + weight) / (2 * weight) * 100);
    expect(diagnostics.directionScore0to100).toBe(score);
    expect(diagnostics.scoreFormula).toBe(`(${summed} + ${weight}) ÷ (2 × ${weight}) × 100 = ${score}`);
  });

  it('leaves the trend veto out, and says so rather than staying silent', () => {
    // The provisional bias is neutral, so there is no direction for the trend to
    // oppose. The line still exists — "checked, did not apply" is a different
    // statement from "nobody checked".
    expect(diagnostics.trendVeto.applied).toBe(false);
    expect(diagnostics.trendVeto.multiplier).toBe(1);
    expect(diagnostics.trendVeto.pointsBeforeVeto).toBe(diagnostics.rawDirectionPoints);
  });

  it('derives all three confidence terms, then the confidence itself', () => {
    const absolute = counted.reduce((total, factor) => total + Math.abs(factor.points ?? 0), 0);
    const agreement = Math.abs(summed) / absolute;
    const strength = absolute / weight;

    // Completeness: full marks for macro, trend and momentum; nothing for the
    // sentiment that could not be judged; half of risk/reward (no ATR, no
    // expected move) and half of the risk gate (an IV, but no baseline of its own).
    const completeness = (
      OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.macro
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.trend
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.momentum
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.riskReward / 2
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.pricing / 2
    ) / OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT;

    expect(diagnostics.agreement).toBeCloseTo(agreement, 4);
    expect(diagnostics.evidenceStrength).toBeCloseTo(strength, 4);
    expect(diagnostics.completeness.value).toBeCloseTo(completeness, 4);

    const base = confidenceFromTerms({ coverage: completeness, agreement, strength });
    expect(diagnostics.confidenceBase).toBeCloseTo(base, 4);
    expect(signal.confidenceScore)
      .toBe(Math.round((base - diagnostics.penaltyTotal) * 100));
  });

  it('deducts for the report five days out, and for nothing else', () => {
    const { earningsNear, earningsNearDays } = OPTIONS_SIGNAL_CONFIG.confidence.penalties;
    // 5 days: past the IV_WARNING gate at 3, inside the "near" band at 7.
    expect(5).toBeGreaterThan(OPTIONS_SIGNAL_CONFIG.event.warningDays);
    expect(5).toBeLessThanOrEqual(earningsNearDays);
    expect(diagnostics.penalties.map((penalty) => penalty.id)).toEqual(['earnings-near']);
    expect(diagnostics.penaltyTotal).toBeCloseTo(earningsNear, 4);
  });

  it('ends the printed confidence sentence on the number the card shows', () => {
    // Not on the geometric mean before the deduction, which is an intermediate
    // the copy never named as one.
    expect(diagnostics.confidenceFormula.endsWith(`${signal.confidenceScore}%`)).toBe(true);
  });
});

describe('golden · the label, and every verdict the card withholds', () => {
  it('is CONFLICTED: a middling total with the evidence pulling apart', () => {
    expect(signal.underlyingBias).toBe('neutral');
    expect(signal.signalType).toBe('CONFLICTED');
    expect(diagnostics.agreement).toBeLessThan(OPTIONS_SIGNAL_CONFIG.quality.conflictedAgreement);
    // Not quiet: two counted factors carry real, opposite weight.
    expect(diagnostics.factors.trend.points).toBeLessThan(0);
    expect(diagnostics.factors.momentum.points).toBeGreaterThan(0);
  });

  it('withholds the cheap/expensive verdict, because the report is inside the contract', () => {
    expect(diagnostics.iv.level).toBeNull();
    expect(diagnostics.iv.levelSuppressedReason).not.toBeNull();
    // The measurement itself is still published — withholding a verdict is not
    // hiding a number.
    expect(diagnostics.iv.ratio).toBeCloseTo(0.768, 3);
  });

  it('raises no STALE-MIX: every source is one and the same session', () => {
    expect(diagnostics.provenance.spreadSessions).toBe(0);
    expect(signal.staleMix).toBe(false);
  });

  it('offers no setup, and gives the conflicted reason for it', () => {
    expect(signal.suggestedOptionsSetup.status).toBe('not-recommended');
    if (signal.suggestedOptionsSetup.status !== 'not-recommended') return;
    expect(signal.suggestedOptionsSetup.reason).toContain('ขัดกันเอง');
  });
});

describe('golden · no two published sentences contradict each other', () => {
  const payload = JSON.stringify(signal);

  it('never calls the premium cheap while warning about the report pricing it', () => {
    expect(payload).toContain('งบประกาศ');
    expect(payload).not.toContain('ยังไม่แพง');
    expect(payload).not.toContain('ระดับความแพง: ต่ำ');
  });

  it('never signs a distance one way in one sentence and the other in another', () => {
    expect(payload).toContain('ลงถึงแนวรับ 6.23%');
    expect(payload).not.toContain('-6.23%');
    expect(payload).not.toContain('+6.23%');
  });

  it('never prints a score for the factor it says it did not count', () => {
    expect(diagnostics.factors.sentiment.points).toBeNull();
    expect(payload).toContain('ไม่นับรวมในคะแนน');
  });

  it('never claims full data while a factor is flagged partial or uncounted', () => {
    const incomplete = Object.values(diagnostics.factors)
      .some((factor) => factor.partial || factor.measurement !== 'measured');
    expect(incomplete).toBe(true);
    expect(diagnostics.completeness.value).toBeLessThan(1);
  });
});
