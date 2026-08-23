/**
 * THE PUT/CALL FALLBACK CASE, pinned field by field, with every published number
 * derived rather than recorded.
 *
 * `symmetry.test.ts` already locks a fixture of its own, and this is not a second
 * copy of it. That one asks "did the answer move" across retunes. This one asks
 * the question the report raised, which is different and was never being asked:
 * CAN A READER REPRODUCE WHAT THE CARD SAYS?
 *
 * So the assertions below are not `toBe(41)` against a number somebody read off
 * a screen. Each one recomputes the value from the inputs, by hand, in the test —
 * the same arithmetic a reader would do with the sentences the card prints — and
 * demands the engine agree. A golden that only recorded outputs would have passed
 * happily on every bug this pass fixed, because each of those bugs was a true
 * number printed beside a wrong explanation of it.
 *
 * WHICH CARD THIS IS NOT: the one the contradiction report was written from. That
 * is `report-card.test.ts` (51 / confidence 5). This file was originally written
 * believing it was that card, which is the mistake `report-card.fixture.ts`
 * exists to correct — the method here was right and the subject was not.
 *
 * Input, constructed to isolate the Put/Call fallback:
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
  OPTIONS_SIGNAL_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_WEIGHTS,
} from './config';
import { baseInput } from './putcall-fallback.fixture';

/**
 * The Thai names `confidenceFormulaText` prints, in the order it prints them.
 * Declared here so the order assertion below reads as an ordering claim
 * rather than as three unrelated string literals.
 */
const TERM_LABEL = {
  coverage: 'ความครบ',
  agreement: 'ความสอดคล้อง',
  strength: 'ความหนักแน่น',
} as const;

const signal = calculateOptionsSignal(baseInput());
if (signal.status !== 'available') throw new Error('the golden case must produce a signal');
const { diagnostics } = signal;

describe('put/call fallback · every factor score is reproducible from its own inputs', () => {
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

describe('put/call fallback · the published totals follow from those factor scores', () => {
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
    // Over the model's TOTAL weight, not the counted weight — see
    // `confidence-monotonicity.test.ts` for why the divisor had to stop moving.
    const strength = absolute / OPTIONS_SIGNAL_TOTAL_WEIGHT;

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

describe('put/call fallback · the confidence ladder, one rung at a time', () => {
  /*
   * WHY THIS IS A LADDER AND NOT A FINAL-VALUE CHECK.
   *
   * Five confidence figures for this engine were in circulation at once - 5,
   * 20%, 46%, 31 and 44->43 - and every one of them was a real number produced
   * by a real step. What was missing was any statement of WHICH step, so they
   * read as five answers to one question instead of rungs on three different
   * ladders. (The first two are the reported card's, and belong to
   * `report-card.test.ts`; these are this case's.)
   *
   * A test that only pinned the last rung would have been green through all of
   * it. Each `it` below therefore starts from the value the previous one ended
   * on and applies exactly one operation, so a change anywhere in the chain
   * fails at the rung that moved rather than at the bottom.
   */
  const counted = Object.values(diagnostics.factors).filter((f) => f.measurement === 'measured');
  const summed = counted.reduce((total, f) => total + (f.points ?? 0), 0);
  const weight = counted.reduce((total, f) => total + f.maxPoints, 0);
  const absolute = counted.reduce((total, f) => total + Math.abs(f.points ?? 0), 0);

  it('rung 1 · completeness, over the INPUT registry and not the factor list', () => {
    const completeness = (
      OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.macro
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.trend
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.momentum
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.riskReward / 2
      + OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS.pricing / 2
    ) / OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT;
    expect(diagnostics.completeness.value).toBeCloseTo(completeness, 4);

    /*
     * NOT the same fraction as `coverage`, and the difference is the point.
     * `coverage` is the share of the direction model's WEIGHT that scored - 80
     * of 90 - and it is what the PRIME floor is written on. Completeness counts
     * INPUTS, including the risk gate that carries no directional weight at all.
     * Two fractions, two jobs, and one Thai name would have covered both.
     */
    expect(diagnostics.coverage).toBeCloseTo(weight / OPTIONS_SIGNAL_TOTAL_WEIGHT, 4);
    expect(diagnostics.coverage).not.toBeCloseTo(diagnostics.completeness.value, 3);
  });

  it('rung 2 · agreement, from the same two sums the score came from', () => {
    expect(diagnostics.agreement).toBeCloseTo(Math.abs(summed) / absolute, 4);
  });

  it('rung 3 · strength, over the full model weight so the divisor cannot move', () => {
    expect(diagnostics.evidenceStrength).toBeCloseTo(absolute / OPTIONS_SIGNAL_TOTAL_WEIGHT, 4);
    /*
     * NOT over `weight`, which is the COUNTED weight and shrinks whenever a
     * factor is struck from the fraction. That divisor made this case report
     * 0.45 where the same 36 absolute points had reported 0.40 the commit
     * before — evidence reading stronger because a factor went away.
     */
    expect(weight).toBeLessThan(OPTIONS_SIGNAL_TOTAL_WEIGHT);
    expect(absolute / weight).toBeGreaterThan(diagnostics.evidenceStrength);
  });

  it('rung 4 · the three exponents, each pinned to the term it actually raises', () => {
    /*
     * WHICH TERM GETS 0.25 - the question the spec guessed wrong.
     *
     * The heaviest exponent is agreement's, by design. The other two are NOT
     * interchangeable: strength carries 0.25 and completeness carries 0.20, so
     * a reader who swapped them computes a different published number from the
     * same three terms. The swap is exercised below rather than described.
     */
    const { exponents } = OPTIONS_SIGNAL_CONFIG.confidence;
    expect(exponents.coverage).toBe(0.2);
    expect(exponents.agreement).toBe(0.55);
    expect(exponents.strength).toBe(0.25);
    expect(exponents.coverage + exponents.agreement + exponents.strength).toBeCloseTo(1, 10);

    const swapped = confidenceFromTerms(
      {
        coverage: diagnostics.completeness.value,
        agreement: diagnostics.agreement,
        strength: diagnostics.evidenceStrength,
      },
      {
        ...OPTIONS_SIGNAL_CONFIG.confidence,
        // The config's exponents are literal types; this deliberately-wrong pair
        // has to be widened to be passed at all.
        exponents: { coverage: 0.25, agreement: 0.55, strength: 0.2 } as unknown as
          typeof OPTIONS_SIGNAL_CONFIG.confidence.exponents,
      },
    );
    expect(Math.round(swapped * 100)).not.toBe(Math.round(diagnostics.confidenceBase * 100));
  });

  it('rung 5 · the weighted geometric mean of rungs 1-3, under rung 4', () => {
    const { exponents } = OPTIONS_SIGNAL_CONFIG.confidence;
    // Written as the product it is, not by calling the engine's own helper -
    // a helper checked against itself proves nothing about the printed formula.
    const byHand = diagnostics.completeness.value ** exponents.coverage
      * diagnostics.agreement ** exponents.agreement
      * diagnostics.evidenceStrength ** exponents.strength;
    expect(diagnostics.confidenceBase).toBeCloseTo(byHand, 4);
  });

  it('rung 6 · the deduction, subtracted from rung 5 on the 0-1 scale', () => {
    // The penalty is a FRACTION, not a point count: 0.15 off 0.4496, not 15 off
    // 45. Applying it on the wrong scale is a 15-point error that still lands in
    // a plausible-looking range, which is why the scale is asserted here.
    expect(diagnostics.penaltyTotal).toBeGreaterThan(0);
    expect(diagnostics.penaltyTotal).toBeLessThan(1);
    expect(diagnostics.penalties.map((penalty) => penalty.id)).toEqual(['earnings-near']);
  });

  it('rung 7 · the card number, and nothing between it and rung 6', () => {
    expect(signal.confidenceScore)
      .toBe(Math.round((diagnostics.confidenceBase - diagnostics.penaltyTotal) * 100));
  });

  it('prints every rung it used, in the order it used them, and ends on rung 7', () => {
    /*
     * The formula the detail page renders verbatim. A reader retypes these three
     * bases and three exponents into a calculator IN THE ORDER THEY ARE PRINTED,
     * so the order is part of the contract: if the copy reads
     * completeness -> agreement -> strength while the exponents are applied in
     * another order, everyone who checks the page gets a different answer from
     * the page.
     */
    const { exponents } = OPTIONS_SIGNAL_CONFIG.confidence;
    const formula = diagnostics.confidenceFormula;
    expect(formula.indexOf(TERM_LABEL.coverage)).toBeGreaterThanOrEqual(0);
    expect(formula.indexOf(TERM_LABEL.coverage)).toBeLessThan(formula.indexOf(TERM_LABEL.agreement));
    expect(formula.indexOf(TERM_LABEL.agreement)).toBeLessThan(formula.indexOf(TERM_LABEL.strength));
    expect(formula).toContain(`${TERM_LABEL.coverage}^${exponents.coverage}`);
    expect(formula).toContain(`${TERM_LABEL.agreement}^${exponents.agreement}`);
    expect(formula).toContain(`${TERM_LABEL.strength}^${exponents.strength}`);

    // The substituted bases, in that same order, each rounded the way it prints.
    const substituted = [
      diagnostics.completeness.value,
      diagnostics.agreement,
      diagnostics.evidenceStrength,
    ].map((value) => value.toFixed(2));
    const printed = [...formula.matchAll(/(\d\.\d\d)\^/g)].map((match) => match[1]);
    expect(printed).toEqual(substituted);

    /*
     * AND THE PRINTED LINE IS ARITHMETICALLY CLOSED. Everything above checks the
     * engine against itself; this checks the SENTENCE against a calculator, from
     * the rounded numbers a reader can actually see, which is the only version
     * of the claim that matters to them.
     */
    const asShown = Number(printed[0]) ** exponents.coverage
      * Number(printed[1]) ** exponents.agreement
      * Number(printed[2]) ** exponents.strength;
    expect(Number(asShown.toFixed(2))).toBe(Number(diagnostics.confidenceBase.toFixed(2)));
    const shownAfterPenalty = Number(asShown.toFixed(2)) - diagnostics.penaltyTotal;
    expect(Math.round(shownAfterPenalty * 100)).toBe(signal.confidenceScore);
    expect(formula.endsWith(`${signal.confidenceScore}%`)).toBe(true);
  });
});

describe('put/call fallback · the direction ladder ends on ONE number, on two named scales', () => {
  // Both published figures round the SAME fraction, and the engine rounds half
  // away from zero (`Number.toFixed`) where `Math.round` rounds half up — which
  // is the whole difference between the -17 a reader gets and the -18 published.
  const fraction = diagnostics.rawDirectionPoints / diagnostics.availableWeight * 100;
  const asEngineRounds = (value: number) => Number(value.toFixed(0));

  it('publishes the bipolar figure the thresholds are written on', () => {
    // The value that decides bullish/bearish and gates PRIME. It was computed
    // and used on every card, and printed on none of them.
    expect(diagnostics.directionBalance).toBe(asEngineRounds(fraction));
  });

  it('is the same fraction as the card score, rounded on the other scale', () => {
    expect(diagnostics.directionScore0to100).toBe(asEngineRounds(fraction / 2 + 50));
  });

  it('prints the shared fraction, so neither rounding has to be taken on trust', () => {
    /*
     * NOT `balance / 2 + 50`. The two roundings are independent: +1 of 80 gives
     * a balance of +1 and a card score of 51, and the tidy identity is out by
     * half a point. The published line therefore starts from the fraction.
     */
    const printed = diagnostics.directionScaleFormula;
    expect(printed).toContain(`${diagnostics.rawDirectionPoints} ÷ ${diagnostics.availableWeight} × 100`);
    expect(printed).toContain(`${fraction > 0 ? '+' : ''}${Number(fraction.toFixed(2))}`);
    expect(printed).toContain(`ปัดเป็น ${diagnostics.directionBalance > 0 ? '+' : ''}${diagnostics.directionBalance}`);
    expect(printed).toContain(`ปัดเป็น ${diagnostics.directionScore0to100}`);
  });

  it('blocks PRIME on the bipolar figure, not on the number the card shows', () => {
    /*
     * The two comparisons agree on THIS case and need not in general: the
     * screenshot case in `symmetry.test.ts` publishes 58 of 100, which clears a
     * `primeScore` of 55 on the visible ruler and misses it by 39 on the one the
     * engine reads. Asserting which ruler is read is what stops section 8 being
     * re-derived from the visible number later.
     */
    expect(Math.abs(diagnostics.directionBalance))
      .toBeLessThan(OPTIONS_SIGNAL_CONFIG.quality.primeScore);
    expect(diagnostics.dataSufficiency.primeBlockers).toContain('score-below-prime');
  });
});

describe('put/call fallback · the label, and every verdict the card withholds', () => {
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

describe('put/call fallback · nothing the page prints as prose is a slug', () => {
  /*
   * Section 8 was printing `score-below-prime` and `coverage-below-floor` in the
   * middle of a Thai page, because the engine's identifiers were rendered
   * directly. That is fixed in the component, and this is the check that stops
   * the next one arriving the same way.
   *
   * A string is judged by THE FIELD IT LIVES IN, not by where it sits in the
   * tree — array elements inherit the name of the array. Identifier fields are
   * meant to hold slugs (`primeBlockers`, `penalties[].id`) and are simply not
   * on the list: they exist so telemetry and `data-blocker-id` keep working, and
   * demanding Thai of them would be demanding the wrong thing.
   */
  const PROSE_KEYS = new Set([
    'detail', 'fallbackReason', 'reason', 'levelSuppressedReason', 'text',
    'scoreFormula', 'confidenceFormula', 'directionScaleFormula', 'confirmationFormula',
    'label', 'note', 'expectedMoveHorizonWarning', 'closedSpreadWarning',
    'missing', 'notCounted', 'warnings', 'ivWarningReasons', 'headline',
  ]);

  /** `two-or-more-hyphenated-lowercase-words` standing alone as the whole value. */
  const isBareSlug = (value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value.trim());

  const collect = (root: unknown): string[] => {
    const found: string[] = [];
    const walk = (node: unknown, path: string, field: string | null): void => {
      if (typeof node === 'string') {
        if (field !== null && PROSE_KEYS.has(field) && isBareSlug(node)) found.push(`${path} = ${node}`);
        return;
      }
      if (Array.isArray(node)) {
        // Elements keep the array's field name: `warnings[2]` is still `warnings`.
        node.forEach((item, index) => walk(item, `${path}[${index}]`, field));
        return;
      }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          walk(value, path ? `${path}.${key}` : key, key);
        }
      }
    };
    walk(root, '', null);
    return found;
  };

  it('leaves no bare identifier in any field the card renders as a sentence', () => {
    expect(collect(signal)).toEqual([]);
  });

  it('would notice one — the detector is not vacuously true', () => {
    // Without this, a walker that silently stopped descending would pass forever,
    // and so would one whose field list had drifted away from the payload.
    expect(collect({ diagnostics: { iv: { levelSuppressedReason: 'iv-basis-unavailable' } } }))
      .toEqual(['diagnostics.iv.levelSuppressedReason = iv-basis-unavailable']);
    // Including inside an array of prose, which is how the setup warnings arrive.
    expect(collect({ suggestedOptionsSetup: { warnings: ['ตรวจสภาพคล่องก่อน', 'chain-too-thin'] } }))
      .toEqual(['suggestedOptionsSetup.warnings[1] = chain-too-thin']);
  });

  it('keeps the blocker slugs themselves intact, because telemetry reads them', () => {
    // The other half of the bargain: Thai on screen, slug in the payload.
    expect(diagnostics.dataSufficiency.primeBlockers).toContain('score-below-prime');
    expect(diagnostics.penalties.map((penalty) => penalty.id)).toEqual(['earnings-near']);
  });
});

describe('put/call fallback · no two published sentences contradict each other', () => {
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
