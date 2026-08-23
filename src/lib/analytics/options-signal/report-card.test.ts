/**
 * THE CARD THE REPORT WAS WRITTEN FROM, reproduced end to end.
 *
 * For the whole of the `2026.08.23` pass, nothing in this directory could
 * produce the numbers the report actually quoted. Two fixtures each described
 * themselves as "the case from the report"; both carry a different factor table
 * and land on 52/58 and 42/41, and the report's card reads **51 / 100 ·
 * confidence 5 / 100**. Twelve commits were reviewed against cases that were not
 * the case.
 *
 * So this file starts from the five factor scores the report printed and rebuilds
 * everything else from them, in the order the page prints it. Every expectation
 * is recomputed here from the inputs rather than copied off the report — a test
 * that only recorded 51 would have been satisfied by any fixture that happened
 * to reach 51, which is exactly how the wrong ones got adopted.
 *
 * The report's own figures, all of which must fall out of the fixture:
 *
 *   macro 0 · trend −8 · momentum +9 · sentiment 0 · Risk/Reward +1  = +2 of 90
 *   score 51 · agreement 11% · strength 20% · completeness 100%
 *   confidence before deductions 20% · after earnings −15 → 5
 *   distances 10.83% / 6.23%, quoted as 1.15 ATR and 0.66 ATR
 *   setup quality 80%, printed beside that +1 of 15
 */

import { describe, expect, it } from 'vitest';
import { calculateOptionsSignal, rvolConfirmation, scoreTrend } from './calculations';
import {
  OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS,
  OPTIONS_SIGNAL_CONFIG,
  OPTIONS_SIGNAL_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_WEIGHTS,
} from './config';
import { ATR, PRICE, RESISTANCE, SUPPORT, reportCardInput } from './report-card.fixture';

const signal = calculateOptionsSignal(reportCardInput());
if (signal.status !== 'available') throw new Error('the reported card must produce a signal');
const { diagnostics } = signal;

describe('report card · the five factor scores the report printed', () => {
  it('macro 0 of 15, MEASURED — the two benchmarks cancel', () => {
    expect(diagnostics.factors.macro.points).toBe(0);
    // Counted, not absent. The report's divisor of 90 includes this 15.
    expect(diagnostics.factors.macro.measurement).toBe('measured');
  });

  it('trend −8 of 25, which pins the sign pattern and nothing else', () => {
    /*
     * `scoreTrend` averages the SIGNS of three comparisons, so −8 of 25 is
     * reachable by exactly one vote sum: −1 out of 3. The magnitudes never enter
     * the arithmetic, which is why choosing EMAs for the fixture is choosing
     * nothing the report has not already fixed.
     *
     * Demonstrated rather than asserted in prose: every other vote sum gives a
     * different score.
     */
    expect(diagnostics.factors.trend.points).toBe(-8);
    // Published rounded to four places, so compared at the precision it is published at.
    expect(diagnostics.factors.trend.normalized).toBeCloseTo(-1 / 3, 4);

    const scoreOf = (close: number, ema20: number, ema50: number) =>
      Math.round((scoreTrend({ close, ema20, ema50 }).normalized ?? 0) * OPTIONS_SIGNAL_WEIGHTS.trend);
    expect(scoreOf(41.88, 41.2, 42.6)).toBe(-8);   // +1 −1 −1 → the reported shape
    expect(scoreOf(41.88, 42.6, 43.0)).toBe(-25);  // −1 −1 −1
    expect(scoreOf(41.88, 41.2, 41.0)).toBe(25);   // +1 +1 +1
    expect(scoreOf(41.88, 41.2, 42.6)).not.toBe(scoreOf(41.88, 42.6, 41.0)); // −1 +1 +1 → +8
  });

  it('momentum +9 of 25, from 6.0774 over the ATR the distances imply', () => {
    const { momentumAtrSaturation, minimumConfirmation } = OPTIONS_SIGNAL_CONFIG.momentum;
    const inAtr = 6.0774 / ATR;
    const normalized = inAtr / momentumAtrSaturation;
    const multiplier = minimumConfirmation + (1 - minimumConfirmation) * rvolConfirmation(1.06);

    expect(diagnostics.squeeze.breakdown.rawAtr).toBeCloseTo(inAtr, 3);
    expect(diagnostics.factors.momentum.points)
      .toBe(Math.round(normalized * multiplier * OPTIONS_SIGNAL_WEIGHTS.momentum));
    expect(diagnostics.factors.momentum.points).toBe(9);
  });

  it('sentiment 0 of 10 in the report, and struck from the fraction now', () => {
    /*
     * THE ONE FACTOR THIS RELEASE MOVED ON THIS CARD, and it moved by zero.
     *
     * The report's card counted a fallback 0 inside a divisor of 90. P0-2 strikes
     * it instead. Because the fallback was already scoring nothing, the numerator
     * is untouched and the published score does not move at all — which is why
     * this card looks identical before and after twelve commits.
     */
    expect(diagnostics.factors.sentiment.measurement).toBe('fallback-neutral');
    expect(diagnostics.factors.sentiment.points).toBeNull();
    expect(diagnostics.factors.sentiment.fallbackReason)
      .toContain(`1/${OPTIONS_SIGNAL_CONFIG.sentiment.minimumPercentileObservations}`);
  });

  it('Risk/Reward +1 of 15, on the undirected path with its damping', () => {
    const { tiltSaturationRatio, sidewaysDamping } = OPTIONS_SIGNAL_CONFIG.riskReward;
    const upside = (RESISTANCE - PRICE) / PRICE * 100;
    const downside = (PRICE - SUPPORT) / PRICE * 100;
    const tilt = Math.log(upside / downside) / Math.log(tiltSaturationRatio);

    /*
     * The lead — macro 0, trend −8, momentum +9 — sums to +1 of 65, a balance of
     * +1.5 that is nowhere near the ±20 bands. So no side is chosen, and the
     * factor keeps only `sidewaysDamping` of its tilt. That is what turns a
     * genuine 1.74 call reward:risk into a single point.
     */
    expect(diagnostics.riskReward.scoredSide).toBeNull();
    expect(diagnostics.factors.riskReward.points)
      .toBe(Math.round(tilt * sidewaysDamping * OPTIONS_SIGNAL_WEIGHTS.riskReward));
    expect(diagnostics.factors.riskReward.points).toBe(1);
  });

  it('quotes the distances the report quotes, in percent and in ATR', () => {
    expect(diagnostics.riskReward.upsidePercent).toBeCloseTo(10.83, 2);
    expect(diagnostics.riskReward.downsidePercent).toBeCloseTo(6.23, 2);
    // The pair the fixture's ATR was recovered FROM, checked back against it.
    expect(diagnostics.riskReward.upsideAtr).toBeCloseTo(1.15, 2);
    expect(diagnostics.riskReward.downsideAtr).toBeCloseTo(0.66, 2);
  });

  it('prints the 80% setup quality the report shows beside that +1', () => {
    // Named in `scoreRiskReward`'s own comment as the figure a reader could not
    // reconcile with a score of 1. It is not a multiplier and never was.
    expect(Math.round((diagnostics.riskReward.setupQuality ?? 0) * 100)).toBe(80);
  });
});

describe('report card · the published totals, rung by rung', () => {
  const counted = Object.values(diagnostics.factors).filter((f) => f.measurement === 'measured');
  const summed = counted.reduce((total, f) => total + (f.points ?? 0), 0);
  const absolute = counted.reduce((total, f) => total + Math.abs(f.points ?? 0), 0);

  it('sums to the +2 the report prints', () => {
    expect(summed).toBe(2);
    expect(diagnostics.rawDirectionPoints).toBe(2);
    // No veto: the provisional bias is neutral, so there is no direction to oppose.
    expect(diagnostics.trendVeto.applied).toBe(false);
  });

  it('lands on 51 on the card, and on +3 on the ruler the thresholds use', () => {
    /*
     * 51 BOTH BEFORE AND AFTER the divisor changed, which is the fact this whole
     * fixture exists to establish: (2 + 90) ÷ 180 × 100 = 51.11 and
     * (2 + 80) ÷ 160 × 100 = 51.25 both round to 51.
     */
    expect(diagnostics.directionScore0to100).toBe(51);
    expect(diagnostics.scoreFormula).toBe('(+2 + 80) ÷ (2 × 80) × 100 = 51');
    expect(Number(((2 + 90) / 180 * 100).toFixed(0))).toBe(51);

    const fraction = summed / diagnostics.availableWeight * 100;
    expect(diagnostics.directionBalance).toBe(Number(fraction.toFixed(0)));
    expect(diagnostics.directionScaleFormula).toContain('+2 ÷ 80 × 100');
  });

  it('agreement 11%: two points of net direction out of eighteen cast', () => {
    expect(absolute).toBe(18);
    expect(diagnostics.agreement).toBeCloseTo(2 / 18, 4);
    expect(Math.round(diagnostics.agreement * 100)).toBe(11);
  });

  it('strength 20%: the same eighteen against the model\'s full weight', () => {
    /*
     * The report printed 20%, and so does the engine — but by a different route.
     * The report's 20% was 18 ÷ 90 where 90 was the COUNTED weight, which then
     * became 80 and would have reported 22.5%. Against the fixed total it is 18
     * ÷ 90 again, permanently.
     */
    expect(diagnostics.evidenceStrength).toBeCloseTo(18 / OPTIONS_SIGNAL_TOTAL_WEIGHT, 4);
    expect(Math.round(diagnostics.evidenceStrength * 100)).toBe(20);
  });

  it('completeness 81%, where the report card said 100%', () => {
    /*
     * THE ONE PUBLISHED NUMBER ON THIS CARD THAT THE RELEASE ACTUALLY CHANGES.
     *
     * The report's 100% was counting factors. This counts inputs, and this card
     * is missing an expected move and an IV baseline of its own — which is what
     * the same card's "IV Rank: ไม่พร้อมใช้งาน" was already saying out loud.
     */
    const expected = (
      OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.macro
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.trend
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.momentum
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.riskReward * 0.75
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.pricing / 2
    ) / OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT;
    expect(diagnostics.completeness.value).toBeCloseTo(expected, 4);
    expect(Math.round(diagnostics.completeness.value * 100)).toBe(81);
  });

  it('deducts the earnings 0.15 and ends on the confidence the card shows', () => {
    const { exponents } = OPTIONS_SIGNAL_CONFIG.confidence;
    const byHand = diagnostics.completeness.value ** exponents.coverage
      * diagnostics.agreement ** exponents.agreement
      * diagnostics.evidenceStrength ** exponents.strength;

    expect(diagnostics.confidenceBase).toBeCloseTo(byHand, 4);
    expect(diagnostics.penalties.map((penalty) => penalty.id)).toEqual(['earnings-near']);
    expect(diagnostics.penaltyTotal).toBeCloseTo(0.15, 4);
    expect(signal.confidenceScore)
      .toBe(Math.round((diagnostics.confidenceBase - diagnostics.penaltyTotal) * 100));
  });

  it('reproduces the report\'s own 20% → 5 when given the report\'s completeness', () => {
    /*
     * The strongest available check that this fixture IS the reported card: feed
     * the engine's confidence function the terms the report's card published —
     * completeness 1.00, and the two this fixture computes unchanged — and the
     * result is the report's 20%, and 5 after the deduction.
     *
     * Nothing here is fitted. Agreement and strength come from the factor scores
     * derived above; only completeness is substituted, and only because the
     * release deliberately changed how it is measured.
     */
    const { exponents } = OPTIONS_SIGNAL_CONFIG.confidence;
    const asReported = 1 ** exponents.coverage
      * diagnostics.agreement ** exponents.agreement
      * diagnostics.evidenceStrength ** exponents.strength;

    expect(Math.round(asReported * 100)).toBe(20);
    expect(Math.round((asReported - diagnostics.penaltyTotal) * 100)).toBe(5);
  });
});

describe('report card · the label is the one thing a reader will see change', () => {
  it('was SIDEWAYS, is CONFLICTED, and the bias never moved', () => {
    /*
     * The user-visible consequence of the whole release, on the card that
     * prompted it. Everything else about this signal is byte-identical: 51, 5,
     * neutral. What changes is that a grey "ตลาดเงียบ" badge becomes an amber
     * "ขัดแย้ง" one — on a chart whose Trend is pulling −8 against a Momentum of
     * +9, which is the opposite of a quiet tape.
     */
    expect(signal.signalType).toBe('CONFLICTED');
    expect(signal.underlyingBias).toBe('neutral');
  });

  it('meets both halves of the CONFLICTED test, not just the threshold', () => {
    expect(diagnostics.agreement).toBeLessThan(OPTIONS_SIGNAL_CONFIG.quality.conflictedAgreement);
    // The structural half: two MEASURED factors carrying real, opposite weight.
    // Without it, a flat tape at agreement 0 would take the same badge.
    expect(diagnostics.factors.trend.points).toBeLessThan(0);
    expect(diagnostics.factors.momentum.points).toBeGreaterThan(0);
    expect(diagnostics.factors.trend.measurement).toBe('measured');
    expect(diagnostics.factors.momentum.measurement).toBe('measured');
  });

  it('withholds the cheap/expensive verdict, which is what the report objected to', () => {
    // 98.6% IV against 128.4% realized is a ratio of 0.77, and the old card
    // called that "ระดับความแพง: ต่ำ" five days before a report inside the
    // contract's life.
    expect(diagnostics.iv.ratio).toBeCloseTo(0.986 / 1.284, 3);
    expect(diagnostics.iv.level).toBeNull();
    expect(diagnostics.iv.levelSuppressedReason).not.toBeNull();
  });
});

describe('report card · the fixture\'s four derived inputs are pinned, not chosen', () => {
  it('ATR sits in the band the reported ATR distances allow', () => {
    /*
     * The report gives 1.15 and 0.66 ATR, not the ATR. Recovering it leaves a
     * band, and the claim the fixture makes is that the band is narrower than
     * anything that depends on it.
     */
    const up = RESISTANCE - PRICE;
    const down = PRICE - SUPPORT;
    const prints = (atr: number) =>
      Number((up / atr).toFixed(2)) === 1.15 && Number((down / atr).toFixed(2)) === 0.66;

    expect(prints(ATR)).toBe(true);
    // The band is (3.9259, 3.9602]. Just outside it, one of the two figures
    // rounds away — which is what makes it a band and not a free choice.
    expect(prints(3.92)).toBe(false);
    expect(prints(3.99)).toBe(false);
  });

  it('and nothing published moves anywhere inside that band', () => {
    // Momentum is the only other consumer of the ATR, and it scores 9 at both
    // ends. So the fixture's 3.95 is a representative of the band, not a fit.
    for (const atr of [3.926, 3.95, 3.96]) {
      const probe = calculateOptionsSignal(reportCardInput({
        momentum: {
          status: 'available', state: 'DELAYED', provider: 'fixture', asOf: '2026-08-21T20:00:00.000Z',
          value: { squeeze: 'OFF', squeezeMomentum: 6.0774, atr, relativeVolume: 1.06 },
        },
      }));
      expect(probe.status).toBe('available');
      if (probe.status !== 'available') return;
      expect(probe.diagnostics.factors.momentum.points, `ATR ${atr}`).toBe(9);
      expect(probe.diagnostics.directionScore0to100, `ATR ${atr}`).toBe(51);
    }
  });
});
