import { describe, expect, it } from 'vitest';
import { calculateOptionsSignal, scoreRiskReward, scoreSentiment } from './calculations';
import { OPTIONS_SIGNAL_CONFIG, OPTIONS_SIGNAL_TOTAL_WEIGHT, OPTIONS_SIGNAL_WEIGHTS } from './config';
import { projectOptionsSignal } from './dto';
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

/**
 * Two questions this file answers with numbers rather than with reasoning.
 *
 * 1. THE HANDOVER SCREENSHOT CARD. Every earlier check of the Risk/Reward rework used
 *    a tape where nothing led, which is the one shape the sideways damping was
 *    written for. The case it actually came from does not look like that — four
 *    factors lead bullish — so this locks every published field for it, whatever
 *    the answer turns out to be.
 *
 * 2. IS THE ENGINE SYMMETRIC? A 30-symbol run produced 8 PRIME_CALL and 0
 *    PRIME_PUT. That is either the regime or a bias in the code, and item B had
 *    just been editing the side that decides which reward:risk gets measured.
 *    Mirroring every input and demanding a mirrored answer separates the two.
 */

const AS_OF = '2026-08-19T01:43:00.000Z';

const available = <T>(value: T): OptionsSignalInputSlot<T> =>
  ({ status: 'available', state: 'DELAYED', value, provider: 'fixture', asOf: AS_OF });

const base = {
  symbol: 'TEST',
  timeframe: '1D' as const,
  calculatedAt: '2026-08-19T02:00:00.000Z',
  latestCandleAt: '2026-08-18',
  finalizedCandles: 250,
  pricing: available<IvPricingInput>({
    basis: 'iv-vs-realized', impliedVolatility: 0.24, realizedVolatility: 0.32,
    ratio: 0.75, observations: 250, realizedWindowDays: 252, dte: 55,
  }),
  event: available<EventRiskInput>({ reportDate: '2026-09-20', daysToEarnings: 28, timeOfDay: 'post-market' }),
};

// ---------------------------------------------------------------------------
// 1. The handover screenshot card
//
// From the EARLIER handover round (`docs/signal-handover.md`, "เคสจากภาพ"), and
// not from the later contradiction report. Its Put/Call of 1.51 was scoring a
// saturated -10 with nothing to rank it against, so striking that moved the
// published score 52 -> 58.
//
// The report's own card is `report-card.fixture.ts` and reads 51 / confidence 5.
// This fixture described itself as "the case from the report" for one release,
// as did `putcall-fallback.fixture.ts`, and neither was.
// ---------------------------------------------------------------------------

/**
 * macro +15 / trend +8 / momentum +15 / sentiment -10, and a chart whose call
 * reward:risk is 0.24 while its put reward:risk is 4.23.
 *
 * The four lead factors sum to +28 of an available 75, which is a BULLISH lead,
 * so the damping added for the sideways case does not apply here.
 */
const screenshotCase: OptionsSignalInput = {
  ...base,
  // both benchmarks above EMA20 -> +1 -> 15 points
  macro: available<MacroInput>({
    benchmarks: [
      { symbol: 'SPY', close: 500, ema20: 480 },
      { symbol: 'QQQ', close: 400, ema20: 390 },
    ],
  }),
  // above both EMAs but EMA20 still under EMA50 -> votes [1, 1, -1] -> 1/3 -> 8 points
  trend: available<TrendInput>({ close: 110, ema20: 105, ema50: 106 }),
  // 1.6/2 = 0.8 ATR, normalized against the 3.5 ATR ceiling -> 0.229, scaled by
  // an RVOL of 0.915 -> 0.171 -> 4 points. It was 15 while the ceiling was 1.0.
  momentum: available<MomentumInput>({ squeeze: 'OFF', squeezeMomentum: 1.6, atr: 2, relativeVolume: 0.915 }),
  // the 1.51 from the card, saturated bearish -> -10 points
  sentiment: available<SentimentInput>({
    putCallRatio: 1.51, basis: 'open-interest', putTotal: 15_100, callTotal: 10_000, expiration: '2026-09-18',
  }),
  // up 2.5%, down 10.575% -> rrCall 0.236, rrPut 4.23
  riskReward: available<RiskRewardInput>({ price: 100, support: 89.425, resistance: 102.5, atr: 3 }),
};

describe('screenshot-baseline', () => {
  /*
   * Locked field by field. If any of these move, the change was deliberate and
   * this test is the place it gets restated — including the two that are still
   * wrong, which are marked below so they cannot be quietly normalised.
   */
  it('locks every published field for the handover screenshot card', () => {
    const result = calculateOptionsSignal(screenshotCase);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    const diagnostics = result.diagnostics;

    // The four factors that decide which side Risk/Reward is measured on.
    expect(diagnostics.factors.macro.points).toBe(15);
    expect(diagnostics.factors.trend.points).toBe(8);
    /*
     * WIDENED MOMENTUM SATURATION (1.0 ATR -> 3.5 ATR): 15 -> 4.
     *
     * This chart's momentum is 0.8 ATR. The old ceiling of 1.0 sat inside the
     * ordinary range of the measurement — the median of the 30 regression
     * tickers is 1.78 ATR and 22 of them saturated — so a distinctly
     * below-average reading was scoring 60% of the factor's full weight. At the
     * measured p90 of 3.5 it scores 4 of 25, which is what a below-average
     * reading is worth.
     */
    expect(diagnostics.factors.momentum.points).toBe(4);
    /*
     * SENTIMENT LEAVES THE FRACTION: -10 -> not counted.
     *
     * This is the case the whole fallback/measured split came from. The 1.51 is
     * real, but this fixture carries no percentile history for it, so there is
     * nothing on this symbol to rank it against — and a raw 1.51 is routine on
     * one ticker and an outlier on another. It was scoring a SATURATED -10 out
     * of the absolute bands and keeping all 10 points in the divisor, which is
     * the largest single unearned vote on the card.
     *
     * It is now `fallback-neutral`: no points, and its 10 struck from both sides
     * of the fraction. The reading itself is still published in `detail`,
     * described as the fallback it is.
     */
    expect(diagnostics.factors.sentiment.points).toBeNull();
    expect(diagnostics.factors.sentiment.measurement).toBe('fallback-neutral');
    expect(diagnostics.factors.sentiment.available).toBe(true);
    // Macro's +15 is a MEASURED reading that happens to be extreme, and the four
    // that were measured keep every point of their weight.
    expect(diagnostics.factors.macro.measurement).toBe('measured');

    /*
     * THE LEAD IS BULLISH, so the sideways damping does not fire and geometry is
     * measured on the CALL side — where the reward:risk is 0.24.
     *
     * WIDENED TILT BAND (saturation 2:1 -> 4.5:1). Before / after, on this case:
     *
     *   riskReward normalized   -1      -> -0.9589
     *   riskReward points       -15     -> -14
     *   rawDirectionPoints      13      -> 14
     *   directionScore0to100    57      -> 58
     *   confidence              38      -> 40
     *   label                   SIDEWAYS -> CONFLICTED (renamed later; see below)
     *
     * The conclusion was already right; what changed is the resolution behind
     * it. 0.24 and 0.49 used to score identically and now differ by 7 points.
     */
    expect(diagnostics.riskReward.scoredSide).toBe('call');
    expect(diagnostics.riskReward.callRewardRisk).toBeCloseTo(0.24, 2);
    expect(diagnostics.riskReward.putRewardRisk).toBeCloseTo(4.23, 2);
    expect(diagnostics.factors.riskReward.normalized).toBeCloseTo(-0.9589, 4);
    expect(diagnostics.factors.riskReward.points).toBe(-14);
    // No longer pinned at the end of the band, which is the whole point.
    expect(diagnostics.factors.riskReward.points)
      .toBeGreaterThan(-OPTIONS_SIGNAL_WEIGHTS.riskReward);

    /*
     * SENTIMENT LEAVING THE DIVISOR, in the published numbers:
     *
     *   summed points        +3   -> +13   (the -10 was never evidence)
     *   availableWeight      90   -> 80
     *   directionScore       52   -> 58
     *   agreement            5.9% -> 31.7%
     *   coverage             100% -> 88.9%
     *   confidence           18   -> 43
     *   label                SIDEWAYS -> CONFLICTED (ข้อสรุปเดิม พร้อมเหตุผล)
     *
     * The score moving 52 -> 58 is the point, not a side effect: six points of
     * the old answer were a saturated vote cast with no basis to cast it from.
     * The BIAS is what must not move, and it did not — the label was renamed on
     * purpose, from a word that covered two states to the one that fits this.
     */
    expect(diagnostics.rawDirectionPoints).toBe(13);
    expect(diagnostics.availableWeight).toBe(80);
    expect(diagnostics.directionScore0to100).toBe(58);
    expect(diagnostics.scoreFormula).toBe('(+13 + 80) ÷ (2 × 80) × 100 = 58');

    /*
     * THE INVARIANT, and the one deliberate exception to it.
     *
     * The answer this case gives must not move, and through three retunes it did
     * not: the direction stayed neutral and the card stayed off the CALL/PUT
     * ladder every time. What DID move, on purpose, is the name of that answer.
     *
     * SIDEWAYS was carrying two states. This case is the second one: macro +15,
     * trend +8 and momentum +4 against a geometry of -14, agreement at 32%. The
     * evidence is not absent, it is arguing — and a grey "ตลาดเงียบ" badge read as
     * a flat tape, which is the one thing this chart is not. CONFLICTED is the
     * same conclusion with the reason attached.
     *
     * The BIAS is what the invariant is really about, and it is untouched.
     */
    expect(result.signalType).toBe('CONFLICTED');
    expect(result.underlyingBias).toBe('neutral');
    expect(result.diagnostics.agreement)
      .toBeLessThan(OPTIONS_SIGNAL_CONFIG.quality.conflictedAgreement);

    /*
     * Agreement fell from 23% to 6% under the momentum retune, then recovered to
     * 32% when the unbased -10 sentiment left the fraction. Both moves are the
     * same correction from opposite ends: the model is now describing a chart of
     * +15 macro, +8 trend, +4 momentum and -14 geometry, which is mixed but not
     * the coin flip a phantom -10 made it look like. The old weighted average
     * published 62% confidence on this shape; the geometric mean publishes 44.
     */
    expect(diagnostics.agreement).toBeCloseTo(0.3171, 4);
    expect(diagnostics.coverage).toBeCloseTo(0.8889, 4);
    /*
     * COMPLETENESS, measured at the inputs rather than at the factors: 100% ->
     * 81%. This fixture carries no Put/Call volume, no Put/Call percentile, no
     * expected move and no IV baseline of its own, and the old figure — which
     * only asked whether each factor had produced a number — reported every one
     * of those gaps as full marks.
     */
    expect(diagnostics.completeness.value).toBeCloseTo(0.8125, 4);
    expect(diagnostics.completeness.missing).toContain('Expected Move จาก ATM straddle');
    expect(diagnostics.completeness.missing).toContain('ฐานเทียบความแพงของตัวเอง (IV Rank / IV percentile)');
    // The Put/Call itself IS here; what is absent is anything to rank it against.
    expect(diagnostics.completeness.notCounted).toContain('Put/Call จาก Open Interest');
    /*
     * STRENGTH IS NOW OVER THE MODEL'S FULL WEIGHT: 0.5125 -> 0.4556.
     *
     * 41 absolute points either way. The old divisor was `availableWeight`, so
     * striking the unranked Options Sentiment took it 90 -> 80 and the same 41
     * points reported as 0.5125 where they had reported 0.4556 — a factor
     * LEAVING made the evidence read stronger. Against the fixed 90 the reading
     * does not move when the factor set does, which is the whole point, and the
     * published confidence falls 43 -> 42 because of it.
     */
    expect(diagnostics.evidenceStrength).toBeCloseTo(41 / OPTIONS_SIGNAL_TOTAL_WEIGHT, 4);
    expect(result.confidenceScore).toBe(42);
    expect(result.confidenceScore).toBeLessThan(45);

    // And the sentence describing that confidence is reproducible by hand.
    expect(diagnostics.confidenceFormula)
      .toBe('ความครบ^0.2 × ความสอดคล้อง^0.55 × ความหนักแน่น^0.25 = 0.81^0.2 × 0.32^0.55 × 0.46^0.25 = 0.42 → 42%');

    // And both surfaces still read the one field.
    const projected = projectOptionsSignal(result, { includeBreakdown: true });
    expect(projected.summary.directionScore0to100).toBe(58);
    expect(projected.breakdown?.diagnostics.directionScore0to100).toBe(58);
  });

  it('shows the damping is unreachable here because the lead is not neutral', () => {
    const geometry = screenshotCase.riskReward;
    if (geometry.status !== 'available') throw new Error('expected levels');

    const underBullishLead = scoreRiskReward(geometry.value, { direction: 'bullish' });
    const underNoLead = scoreRiskReward(geometry.value, { direction: 'neutral' });

    // The damping exists and works — it is simply not what this case reaches.
    expect(underNoLead.normalized).toBeCloseTo(-0.2397, 4);
    expect(underBullishLead.normalized).toBeCloseTo(-0.9589, 4);
    expect(underNoLead.normalized).toBeCloseTo(
      (underBullishLead.normalized as number) * OPTIONS_SIGNAL_CONFIG.riskReward.sidewaysDamping, 6,
    );
    // The diagnostics field is rounded to 4dp for display; the engine used the
    // bullish branch, which is what this asserts.
    expect(calculateOptionsSignal(screenshotCase).diagnostics.factors.riskReward.normalized)
      .toBeCloseTo(underBullishLead.normalized as number, 4);
  });

  it('tells 0.236 apart from 0.49, which the old band could not', () => {
    // Both used to pin at -15. The requirement was a gap of at least 3 points.
    const worse = scoreRiskReward({ price: 100, support: 89.425, resistance: 102.5 }, { direction: 'bullish' });
    const better = scoreRiskReward({ price: 100, support: 89.796, resistance: 105 }, { direction: 'bullish' });
    expect(worse.callRewardRisk).toBeCloseTo(0.236, 3);
    expect(better.callRewardRisk).toBeCloseTo(0.49, 3);

    const points = (value: number) => Math.round(value * OPTIONS_SIGNAL_WEIGHTS.riskReward);
    const gap = points(better.normalized as number) - points(worse.normalized as number);
    expect(points(worse.normalized as number)).toBe(-14);
    expect(points(better.normalized as number)).toBe(-7);
    expect(gap).toBeGreaterThanOrEqual(3);
  });

  it('records how far the geometric mean sits below the old weighted average', () => {
    /*
     * The Risk/Reward rework left this chart's direction where it was and only
     * changed what the card CLAIMED about it. The momentum retune moved it 58 to
     * 52, because a 0.8 ATR momentum stopped being scored as though it were a
     * 3.5 ATR one; striking the unbased sentiment moved it back to 58, because a
     * saturated -10 stopped being counted as evidence. What has never moved
     * through any of the three is the label.
     *
     * The legacy weighted average is recomputed here from the CURRENT terms —
     * including the real coverage, which is no longer 1 — so the gap it shows is
     * the gap the product still closes on this shape today: a mixed chart the
     * old arithmetic would call better than half sure.
     */
    const result = calculateOptionsSignal(screenshotCase);
    expect(result.diagnostics.directionScore0to100).toBe(58);
    const legacyConfidence = Math.round(
      (0.3 * result.diagnostics.coverage
        + 0.35 * result.diagnostics.agreement
        + 0.35 * result.diagnostics.evidenceStrength) * 100,
    );
    // 56 -> 54: the legacy average is recomputed from the CURRENT terms, and
    // `evidenceStrength` is one of them, so fixing its divisor moves this
    // comparison too. The gap it exists to show is unchanged in direction.
    expect(legacyConfidence).toBe(54);
    expect(result.confidenceScore).toBe(42);
    expect(result.confidenceScore).toBeLessThan(legacyConfidence);
  });
});

// ---------------------------------------------------------------------------
// 2. Mirror symmetry
// ---------------------------------------------------------------------------

/** Every directional input, turned upside down. */
const bullishSide: OptionsSignalInput = {
  ...base,
  macro: available<MacroInput>({
    benchmarks: [
      { symbol: 'SPY', close: 500, ema20: 480 },
      { symbol: 'QQQ', close: 400, ema20: 390 },
    ],
  }),
  trend: available<TrendInput>({ close: 110, ema20: 105, ema50: 100 }),
  momentum: available<MomentumInput>({
    squeeze: 'FIRED_BULLISH', squeezeMomentum: 2.4, atr: 2, relativeVolume: 1.8,
  }),
  sentiment: available<SentimentInput>({
    // Saturated call-heavy, ON THE SYMBOL'S OWN PERCENTILE BASIS.
    //
    // The absolute bands are not symmetric around 1.0 (see the test below), so
    // the mirror used to be built from their saturated ends. It cannot be built
    // from them at all any more: a reading with no percentile basis is
    // `fallback-neutral` and leaves the fraction, which would drop sentiment out
    // of the mirror on BOTH sides and stop this test from checking it. The
    // percentile band IS symmetric — 0 and 1 reflect exactly about 0.5 — so the
    // mirror is now built where the symmetry is real.
    putCallRatio: 0.4, basis: 'open-interest', putTotal: 4_000, callTotal: 10_000, expiration: '2026-09-18',
    ownPercentile: 0, percentileObservations: 60,
  }),
  // up 20%, down 5% -> rrCall 4, rrPut 0.25
  riskReward: available<RiskRewardInput>({ price: 100, support: 95, resistance: 120, atr: 3 }),
};

const bearishSide: OptionsSignalInput = {
  ...base,
  macro: available<MacroInput>({
    benchmarks: [
      { symbol: 'SPY', close: 460, ema20: 480 },
      { symbol: 'QQQ', close: 380, ema20: 390 },
    ],
  }),
  trend: available<TrendInput>({ close: 90, ema20: 95, ema50: 100 }),
  momentum: available<MomentumInput>({
    squeeze: 'FIRED_BEARISH', squeezeMomentum: -2.4, atr: 2, relativeVolume: 1.8,
  }),
  sentiment: available<SentimentInput>({
    putCallRatio: 1.5, basis: 'open-interest', putTotal: 15_000, callTotal: 10_000, expiration: '2026-09-18',
    ownPercentile: 1, percentileObservations: 60,
  }),
  // up 5%, down 20% -> rrCall 0.25, rrPut 4: the mirror image of the above
  riskReward: available<RiskRewardInput>({ price: 100, support: 80, resistance: 105, atr: 3 }),
};

describe('the engine treats the two sides identically', () => {
  it('mirrors a fully-aligned signal, factor for factor', () => {
    const up = calculateOptionsSignal(bullishSide);
    const down = calculateOptionsSignal(bearishSide);
    if (up.status !== 'available' || down.status !== 'available') throw new Error('expected signals');

    for (const id of ['macro', 'trend', 'momentum', 'sentiment', 'riskReward'] as const) {
      // Both sides must be in the SAME measurement state, or "mirrored" would be
      // satisfied by a factor that dropped out of both fractions.
      expect(down.diagnostics.factors[id].measurement, id).toBe(up.diagnostics.factors[id].measurement);
      expect(down.diagnostics.factors[id].measurement, id).toBe('measured');
      expect(down.diagnostics.factors[id].points, id).toBe(-(up.diagnostics.factors[id].points as number));
    }
    expect(down.diagnostics.rawDirectionPoints).toBe(-up.diagnostics.rawDirectionPoints);
    expect(down.diagnostics.availableWeight).toBe(up.diagnostics.availableWeight);
  });

  it('mirrors a signal whose TREND is the factor pointing the other way', () => {
    /*
     * The trend veto reads one factor's sign against the aggregate and presses
     * the score for it, which is exactly the shape a side-specific bug hides in.
     * Both sides get a trend that disagrees by the same one-vote-in-three, and
     * the two answers have to be reflections.
     */
    const up = calculateOptionsSignal({
      ...bullishSide,
      trend: available<TrendInput>({ close: 100, ema20: 105, ema50: 104 }),
    });
    const down = calculateOptionsSignal({
      ...bearishSide,
      trend: available<TrendInput>({ close: 100, ema20: 95, ema50: 96 }),
    });
    if (up.status !== 'available' || down.status !== 'available') throw new Error('expected signals');

    expect(up.diagnostics.trendVeto.applied).toBe(true);
    expect(down.diagnostics.trendVeto.applied).toBe(true);
    expect(down.diagnostics.trendVeto.opposition).toBeCloseTo(up.diagnostics.trendVeto.opposition, 6);
    expect(down.diagnostics.trendVeto.multiplier).toBeCloseTo(up.diagnostics.trendVeto.multiplier, 6);
    expect(down.diagnostics.trendVeto.pointsBeforeVeto).toBe(-up.diagnostics.trendVeto.pointsBeforeVeto);
    expect(down.diagnostics.rawDirectionPoints).toBe(-up.diagnostics.rawDirectionPoints);
    expect(Math.abs(up.diagnostics.directionScore0to100 - 50))
      .toBeCloseTo(Math.abs(down.diagnostics.directionScore0to100 - 50), 6);
  });

  it('mirrors a geometry that sits beyond what the contract can reach', () => {
    // The reachability scaling is applied per SIDE, so it is the other place a
    // one-sided mistake would live.
    const up = calculateOptionsSignal({
      ...bullishSide,
      riskReward: available<RiskRewardInput>({
        price: 100, support: 95, resistance: 120, atr: 3, expectedMove: 2, expectedMoveDte: 45,
      }),
    });
    const down = calculateOptionsSignal({
      ...bearishSide,
      riskReward: available<RiskRewardInput>({
        price: 100, support: 80, resistance: 105, atr: 3, expectedMove: 2, expectedMoveDte: 45,
      }),
    });
    if (up.status !== 'available' || down.status !== 'available') throw new Error('expected signals');
    expect(up.diagnostics.riskReward.reachability).toBeLessThan(1);
    expect(down.diagnostics.riskReward.reachability)
      .toBeCloseTo(up.diagnostics.riskReward.reachability, 6);
    expect(down.diagnostics.factors.riskReward.points)
      .toBe(-(up.diagnostics.factors.riskReward.points as number));
  });

  it('mirrors the published score about the midpoint, to the point', () => {
    const up = calculateOptionsSignal(bullishSide);
    const down = calculateOptionsSignal(bearishSide);
    const upDistance = Math.abs(up.diagnostics.directionScore0to100 - 50);
    const downDistance = Math.abs(down.diagnostics.directionScore0to100 - 50);
    expect(Math.abs(upDistance - downDistance)).toBeLessThanOrEqual(1);
    expect(up.diagnostics.directionScore0to100).toBeGreaterThan(50);
    expect(down.diagnostics.directionScore0to100).toBeLessThan(50);
  });

  it('gives the two sides the same confidence, to the point', () => {
    const up = calculateOptionsSignal(bullishSide);
    const down = calculateOptionsSignal(bearishSide);
    expect(Math.abs(up.confidenceScore - down.confidenceScore)).toBeLessThanOrEqual(1);
    expect(up.diagnostics.agreement).toBeCloseTo(down.diagnostics.agreement, 4);
    expect(up.diagnostics.evidenceStrength).toBeCloseTo(down.diagnostics.evidenceStrength, 4);
    expect(up.diagnostics.coverage).toBe(down.diagnostics.coverage);
  });

  it('swaps the label rather than downgrading one side', () => {
    const up = calculateOptionsSignal(bullishSide);
    const down = calculateOptionsSignal(bearishSide);
    expect(up.signalType).toBe('PRIME_CALL');
    expect(down.signalType).toBe('PRIME_PUT');
    expect(up.underlyingBias).toBe('bullish');
    expect(down.underlyingBias).toBe('bearish');
    expect(up.diagnostics.dataSufficiency.primeBlockers).toEqual([]);
    expect(down.diagnostics.dataSufficiency.primeBlockers).toEqual([]);
    // PRIME_PUT is reachable. A 30-symbol run that produced none of them was
    // describing the tape, not a hole in this code.
    expect(down.suggestedOptionsSetup).toMatchObject({ status: 'suggested', direction: 'put' });
  });

  it('mirrors the geometry itself, at every branch of it', () => {
    const cases: Array<[RiskRewardInput, RiskRewardInput]> = [
      // ordinary two-sided geometry
      [{ price: 100, support: 95, resistance: 120 }, { price: 100, support: 80, resistance: 105 }],
      // the lopsided shape from the report, and its mirror
      [{ price: 100, support: 89.425, resistance: 102.5 }, { price: 100, support: 97.5, resistance: 110.575 }],
      // price sitting on a level
      [{ price: 100, support: 100, resistance: 110 }, { price: 100, support: 90, resistance: 100 }],
      // one side unbounded
      [{ price: 100, support: 90, resistance: null }, { price: 100, support: null, resistance: 110 }],
    ];
    for (const [up, down] of cases) {
      // Each is scored for the side its own lead would pick.
      const upScore = scoreRiskReward(up, { direction: 'bullish' });
      const downScore = scoreRiskReward(down, { direction: 'bearish' });
      expect(downScore.normalized).toBeCloseTo(-(upScore.normalized as number), 6);

      // ...and with no lead at all, the damped residuals mirror too.
      const upNeutral = scoreRiskReward(up, { direction: 'neutral' });
      const downNeutral = scoreRiskReward(down, { direction: 'neutral' });
      expect(downNeutral.normalized).toBeCloseTo(-(upNeutral.normalized as number), 6);
    }
  });

  it('mirrors a SIDEWAYS reading as well as a decided one', () => {
    const flat = (rr: RiskRewardInput): OptionsSignalInput => ({
      ...base,
      macro: available<MacroInput>({
        benchmarks: [
          { symbol: 'SPY', close: 500, ema20: 480 },
          { symbol: 'QQQ', close: 380, ema20: 390 },
        ],
      }),
      trend: available<TrendInput>({ close: 100, ema20: 100, ema50: 100 }),
      momentum: available<MomentumInput>({ squeeze: 'OFF', squeezeMomentum: 0, atr: 2, relativeVolume: 1 }),
      sentiment: available<SentimentInput>({
        putCallRatio: 0.9, basis: 'open-interest', putTotal: 9_000, callTotal: 10_000, expiration: '2026-09-18',
      }),
      riskReward: available(rr),
    });
    const up = calculateOptionsSignal(flat({ price: 100, support: 89.425, resistance: 102.5, atr: 3 }));
    const down = calculateOptionsSignal(flat({ price: 100, support: 97.5, resistance: 110.575, atr: 3 }));
    expect(down.diagnostics.rawDirectionPoints).toBe(-up.diagnostics.rawDirectionPoints);
    expect(Math.abs(
      Math.abs(up.diagnostics.directionScore0to100 - 50) - Math.abs(down.diagnostics.directionScore0to100 - 50),
    )).toBeLessThanOrEqual(1);
    expect(up.confidenceScore).toBe(down.confidenceScore);
  });

  it('applies the risk gate and the penalties to both sides alike', () => {
    const expensive: IvPricingInput = {
      basis: 'iv-vs-realized', impliedVolatility: 0.6, realizedVolatility: 0.3,
      ratio: 2, observations: 250, realizedWindowDays: 252, dte: 55,
    };
    const up = calculateOptionsSignal({ ...bullishSide, pricing: available(expensive) });
    const down = calculateOptionsSignal({ ...bearishSide, pricing: available(expensive) });
    expect(up.signalType).toBe('IV_WARNING');
    expect(down.signalType).toBe('IV_WARNING');
    expect(up.diagnostics.penaltyTotal).toBe(down.diagnostics.penaltyTotal);
    expect(Math.abs(up.confidenceScore - down.confidenceScore)).toBeLessThanOrEqual(1);
  });

  /**
   * The one asymmetry in the engine, and it is deliberate.
   *
   * The absolute Put/Call bands are 0.40-0.70 on the call-heavy side and
   * 1.10-1.50 on the put-heavy side — NOT reciprocals of each other. That is a
   * property of the measurement rather than a bug in the scoring: index and
   * single-stock Put/Call open interest sits near 0.7-1.0 in ordinary
   * conditions, so "1.0" is not the neutral point and mirroring the bands about
   * it would call an unremarkable book bearish.
   *
   * It is written down here so that a future reader finds a decision rather than
   * an accident, and so that any attempt to "fix" the symmetry has to argue with
   * this comment first. The percentile basis, which is what the engine prefers
   * whenever a symbol has enough history, has no such asymmetry.
   */
  it('documents the Put/Call band asymmetry as a measurement property', () => {
    // Reciprocal pairs do not produce mirrored scores in the middle of the bands.
    expect(scoreSentiment({
      putCallRatio: 0.6, basis: 'open-interest', putTotal: 6_000, callTotal: 10_000, expiration: '2026-09-18',
    }).normalized).toBeCloseTo(0.3333, 3);
    expect(scoreSentiment({
      putCallRatio: 1 / 0.6, basis: 'open-interest', putTotal: 16_667, callTotal: 10_000, expiration: '2026-09-18',
    }).normalized).toBe(-1);

    // The saturated ends do mirror, which is what the tests above are built on.
    expect(scoreSentiment({
      putCallRatio: OPTIONS_SIGNAL_CONFIG.sentiment.bullishSaturation,
      basis: 'open-interest', putTotal: 4_000, callTotal: 10_000, expiration: '2026-09-18',
    }).normalized).toBe(1);
    expect(scoreSentiment({
      putCallRatio: OPTIONS_SIGNAL_CONFIG.sentiment.bearishSaturation,
      basis: 'open-interest', putTotal: 15_000, callTotal: 10_000, expiration: '2026-09-18',
    }).normalized).toBe(-1);

    // The percentile basis, which is preferred once history exists, IS symmetric.
    const percentileAt = (percentile: number) => scoreSentiment({
      putCallRatio: 1.0, basis: 'open-interest', putTotal: 10_000, callTotal: 10_000,
      expiration: '2026-09-18', ownPercentile: percentile, percentileObservations: 60,
    }).normalized as number;
    expect(percentileAt(0.1)).toBeCloseTo(-percentileAt(0.9), 6);
    expect(percentileAt(0)).toBeCloseTo(-percentileAt(1), 6);
    expect(percentileAt(0.5)).toBe(0);
  });
});
