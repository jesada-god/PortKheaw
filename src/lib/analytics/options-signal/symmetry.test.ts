import { describe, expect, it } from 'vitest';
import { calculateOptionsSignal, scoreRiskReward, scoreSentiment } from './calculations';
import { OPTIONS_SIGNAL_CONFIG, OPTIONS_SIGNAL_WEIGHTS } from './config';
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
 * 1. THE CASE FROM THE REPORT. Every earlier check of the Risk/Reward rework used
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
// 1. The case from the report
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
  // 1.6/2 = 0.8, scaled by an RVOL of 0.915 -> 0.6 -> 15 points
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
  it('locks every published field for the case the report came from', () => {
    const result = calculateOptionsSignal(screenshotCase);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    const diagnostics = result.diagnostics;

    // The four factors that decide which side Risk/Reward is measured on.
    expect(diagnostics.factors.macro.points).toBe(15);
    expect(diagnostics.factors.trend.points).toBe(8);
    expect(diagnostics.factors.momentum.points).toBe(15);
    expect(diagnostics.factors.sentiment.points).toBe(-10);

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
     *   label                   SIDEWAYS -> SIDEWAYS   (unchanged, as required)
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

    expect(diagnostics.rawDirectionPoints).toBe(14);
    expect(diagnostics.availableWeight).toBe(90);
    expect(diagnostics.directionScore0to100).toBe(58);
    expect(diagnostics.scoreFormula).toBe('(+14 + 90) ÷ (2 × 90) × 100 = 58');

    // THE INVARIANT: the answer this case gives must not move. The evidence is
    // genuinely mixed and SIDEWAYS is the honest label for it.
    expect(result.signalType).toBe('SIDEWAYS');
    expect(result.underlyingBias).toBe('neutral');

    // Agreement is 23%, and the old weighted average published 62% on this.
    expect(diagnostics.agreement).toBeCloseTo(0.2258, 4);
    expect(diagnostics.coverage).toBe(1);
    expect(diagnostics.evidenceStrength).toBeCloseTo(0.6889, 4);
    expect(result.confidenceScore).toBe(40);
    expect(result.confidenceScore).toBeLessThan(45);

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

  it('records that only confidence moved, not the direction score', () => {
    // The old model scored this identically on direction: same factors, same
    // call-side geometry, same raw 13 of 90. The rework changed what the card
    // CLAIMS about it, not where it points.
    const result = calculateOptionsSignal(screenshotCase);
    expect(result.diagnostics.directionScore0to100).toBe(58);
    const legacyConfidence = Math.round(
      (0.3 * 1 + 0.35 * result.diagnostics.agreement + 0.35 * result.diagnostics.evidenceStrength) * 100,
    );
    expect(legacyConfidence).toBe(62);
    expect(result.confidenceScore).toBe(40);
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
    // Saturated call-heavy. The absolute bands are NOT symmetric around 1.0
    // (see the test below), so the mirror is built from the saturated ends,
    // where both sides genuinely reach +-1.
    putCallRatio: 0.4, basis: 'open-interest', putTotal: 4_000, callTotal: 10_000, expiration: '2026-09-18',
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
