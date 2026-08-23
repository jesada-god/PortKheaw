import { describe, expect, it } from 'vitest';
import {
  calculateOptionsSignal,
  confidenceFromTerms,
  directionScoreFormula,
  directionScoreOutOf100,
  gradeLiquidity,
  rvolConfirmation,
  scoreMomentum,
  scoreRiskReward,
  scoreSentiment,
  summariseProvenance,
} from './calculations';
import {
  OPTIONS_SIGNAL_CONFIG,
  OPTIONS_SIGNAL_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_WEIGHTS,
} from './config';
import { projectOptionsSignal } from './dto';
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

/**
 * The acceptance contract for the engine rework.
 *
 * Every case here is one the shipped card actually got wrong: a score that
 * disagreed with itself, a Risk/Reward factor that voted against a direction
 * nobody had claimed, a confidence figure that hid a 21% agreement, a step
 * function at exactly average volume, and three source timestamps presented as
 * if they were one moment.
 */

const AS_OF = '2026-08-19T01:43:00.000Z';

function available<T>(
  value: T,
  state: 'LIVE' | 'DELAYED' | 'STALE' = 'DELAYED',
  asOf: string | null = AS_OF,
  provider = 'fixture',
): OptionsSignalInputSlot<T> {
  return { status: 'available', state, value, provider, asOf };
}

function missing<T>(reason = 'ไม่มีข้อมูล'): OptionsSignalInputSlot<T> {
  return { status: 'unavailable', state: 'UNAVAILABLE', reason, provider: null, asOf: null };
}

const bullishMacro: MacroInput = {
  benchmarks: [
    { symbol: 'SPY', close: 500, ema20: 480 },
    { symbol: 'QQQ', close: 400, ema20: 390 },
  ],
};
const bearishMacro: MacroInput = {
  benchmarks: [
    { symbol: 'SPY', close: 460, ema20: 480 },
    { symbol: 'QQQ', close: 380, ema20: 390 },
  ],
};
const bullishTrend: TrendInput = { close: 110, ema20: 105, ema50: 100 };
const bearishTrend: TrendInput = { close: 90, ema20: 95, ema50: 100 };
const cheapIv: IvPricingInput = {
  basis: 'iv-vs-realized', impliedVolatility: 0.24, realizedVolatility: 0.32, ratio: 0.75,
  observations: 250, realizedWindowDays: 252, dte: 55,
};
const farEarnings: EventRiskInput = { reportDate: '2026-09-20', daysToEarnings: 28, timeOfDay: 'post-market' };
const neutralSentiment: SentimentInput = {
  putCallRatio: 0.9, basis: 'open-interest', putTotal: 9_000, callTotal: 10_000, expiration: '2026-09-18',
};

/**
 * The same reading WITH the symbol's own percentile basis.
 *
 * `neutralSentiment` alone has no basis to be ranked against, which now makes it
 * `fallback-neutral` — struck from the numerator AND the divisor. Every test
 * below that is about something other than that rule needs a sentiment that is
 * genuinely MEASURED, or it would be asserting against a 90 that quietly became
 * an 80 for a reason it never meant to exercise.
 *
 * 0.5 sits inside the neutral percentile band, so this scores exactly what the
 * absolute bands scored for a 0.9 ratio: zero, and measured.
 */
const ratedSentiment = (ownPercentile: number): SentimentInput => ({
  ...neutralSentiment, ownPercentile, percentileObservations: 60,
});

function input(overrides: Partial<OptionsSignalInput> = {}): OptionsSignalInput {
  return {
    symbol: 'TEST',
    timeframe: '1D',
    calculatedAt: '2026-08-19T02:00:00.000Z',
    latestCandleAt: '2026-08-18',
    finalizedCandles: 250,
    macro: available(bullishMacro),
    trend: available(bullishTrend),
    momentum: available<MomentumInput>({ squeeze: 'FIRED_BULLISH', squeezeMomentum: 2.4, atr: 2, relativeVolume: 1.8 }),
    pricing: available<IvPricingInput>(cheapIv),
    sentiment: available(ratedSentiment(0.5)),
    riskReward: available<RiskRewardInput>({ price: 110, support: 105, resistance: 130, atr: 3 }),
    event: available(farEarnings),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. one score, shown identically everywhere
// ---------------------------------------------------------------------------

describe('A · the card and the modal show the same score, always', () => {
  it('publishes ONE 0-100 score, in the summary and in the diagnostics', () => {
    const result = calculateOptionsSignal(input());
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.directionScore0to100).toBe(result.diagnostics.directionScore0to100);

    // The card reads the SUMMARY (a Pro reader has no breakdown at all); the
    // modal reads the DIAGNOSTICS. Both projections must carry the same number.
    const elite = projectOptionsSignal(result, { includeBreakdown: true });
    const pro = projectOptionsSignal(result, { includeBreakdown: false });
    expect(pro.summary.directionScore0to100).toBe(elite.summary.directionScore0to100);
    expect(elite.summary.directionScore0to100).toBe(elite.breakdown?.diagnostics.directionScore0to100);
    expect(pro.breakdown).toBeNull();
  });

  it('keeps card and modal in step across every kind of signal', () => {
    const cases: OptionsSignalInput[] = [
      input(),
      input({ macro: available(bearishMacro), trend: available(bearishTrend) }),
      input({ trend: available<TrendInput>({ close: 100, ema20: 100, ema50: 100 }) }),
      input({ sentiment: missing<SentimentInput>('ไม่มี OI'), riskReward: missing<RiskRewardInput>('ไม่มีโซน') }),
      input({ event: available<EventRiskInput>({ reportDate: '2026-08-20', daysToEarnings: 1, timeOfDay: 'post-market' }) }),
    ];
    for (const candidate of cases) {
      const result = calculateOptionsSignal(candidate);
      if (result.status !== 'available') continue;
      const projected = projectOptionsSignal(result, { includeBreakdown: true });
      expect(projected.summary.directionScore0to100).toBe(projected.breakdown?.diagnostics.directionScore0to100);
      expect(projected.summary.scoreFormula).toBe(projected.breakdown?.diagnostics.scoreFormula);
    }
  });

  it('converts the signed sum with the documented formula and shows its arithmetic', () => {
    // The exact pair the shipped card contradicted itself over: +13 out of 90.
    expect(directionScoreOutOf100(13, 90)).toBe(57);
    expect(directionScoreFormula(13, 90)).toBe('(+13 + 90) ÷ (2 × 90) × 100 = 57');
    expect(directionScoreOutOf100(0, 90)).toBe(50);
    expect(directionScoreOutOf100(-90, 90)).toBe(0);
    expect(directionScoreOutOf100(90, 90)).toBe(100);
  });

  it('writes the formula out of the SAME numbers the total row shows', () => {
    const result = calculateOptionsSignal(input());
    if (result.status !== 'available') return;
    const { rawDirectionPoints, availableWeight, scoreFormula, directionScore0to100 } = result.diagnostics;
    expect(scoreFormula).toBe(directionScoreFormula(rawDirectionPoints, availableWeight));
    expect(scoreFormula.endsWith(`= ${directionScore0to100}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. Risk/Reward no longer judges one side only
// ---------------------------------------------------------------------------

describe('B · Risk/Reward is scored for the side the evidence points at', () => {
  // price 100, support 89.5, resistance 102.5 -> up 2.5%, down 10.5%
  // -> R:R call 0.238, R:R put 4.2. The exact shape from the report.
  const lopsided: RiskRewardInput = { price: 100, support: 89.5, resistance: 102.5, atr: 3 };

  it('does not take the full -15 on a sideways tape with a workable put side', () => {
    const outcome = scoreRiskReward(lopsided, { direction: 'neutral' });
    expect(outcome.callRewardRisk).toBeCloseTo(0.238, 2);
    expect(outcome.putRewardRisk).toBeCloseTo(4.2, 1);
    // The tilt is real and is kept, but damped: never a full-weight vote.
    expect(outcome.normalized).toBeGreaterThan(-1);
    expect(Math.abs(outcome.normalized as number)).toBeLessThanOrEqual(
      OPTIONS_SIGNAL_CONFIG.riskReward.sidewaysDamping,
    );
    expect(outcome.normalized).toBeCloseTo(-0.2385, 4);
    expect(outcome.scoredSide).toBeNull();
    // The best side IS workable, and that is what the factor reports instead.
    expect(outcome.setupQuality).toBe(1);
  });

  it('gives the factor far less than its full weight against a SIDEWAYS signal', () => {
    const result = calculateOptionsSignal(input({
      // Nothing leads: macro split, trend flat, momentum flat, sentiment neutral.
      macro: available<MacroInput>({
        benchmarks: [{ symbol: 'SPY', close: 500, ema20: 480 }, { symbol: 'QQQ', close: 380, ema20: 390 }],
      }),
      trend: available<TrendInput>({ close: 100, ema20: 100, ema50: 100 }),
      momentum: available<MomentumInput>({ squeeze: 'OFF', squeezeMomentum: 0, atr: 2, relativeVolume: 1 }),
      sentiment: available(ratedSentiment(0.5)),
      riskReward: available(lopsided),
    }));
    if (result.status !== 'available') throw new Error('expected a signal');
    expect(result.signalType).toBe('SIDEWAYS');

    // -4 of a possible -15, not the full -15 the shipped engine took here.
    const points = result.diagnostics.factors.riskReward.points as number;
    expect(points).toBeGreaterThan(-OPTIONS_SIGNAL_WEIGHTS.riskReward);
    expect(Math.abs(points)).toBeLessThanOrEqual(Math.ceil(
      OPTIONS_SIGNAL_WEIGHTS.riskReward * OPTIONS_SIGNAL_CONFIG.riskReward.sidewaysDamping,
    ));
    expect(result.diagnostics.riskReward.callRewardRisk).toBeCloseTo(0.24, 2);
    expect(result.diagnostics.riskReward.putRewardRisk).toBeCloseTo(4.2, 1);
  });

  it('scores the put side when the other four factors lead bearish', () => {
    const result = calculateOptionsSignal(input({
      macro: available(bearishMacro),
      trend: available(bearishTrend),
      momentum: available<MomentumInput>({ squeeze: 'FIRED_BEARISH', squeezeMomentum: -2.4, atr: 2, relativeVolume: 1.8 }),
      riskReward: available(lopsided),
    }));
    if (result.status !== 'available') throw new Error('expected a signal');
    expect(result.diagnostics.riskReward.scoredSide).toBe('put');
    /*
     * A 4.2:1 put reward:risk SUPPORTS the bearish thesis rather than opposing
     * it. It is -14 of a possible -15 rather than the full -15: the tilt band
     * saturates at 4.5:1 now, so 4.2 is very strong evidence but not maximal,
     * which is the resolution the widening was for.
     */
    expect(result.diagnostics.factors.riskReward.points).toBe(-14);
    expect(result.diagnostics.factors.riskReward.points)
      .toBeGreaterThan(-OPTIONS_SIGNAL_WEIGHTS.riskReward);
    expect(result.underlyingBias).toBe('bearish');
  });

  it('never lets geometry alone manufacture a direction', () => {
    const neutral = scoreRiskReward(lopsided, { direction: 'neutral' });
    const bullish = scoreRiskReward(lopsided, { direction: 'bullish' });
    // Same chart, and the neutral reading is strictly the weaker statement.
    expect(Math.abs(neutral.normalized as number)).toBeLessThan(Math.abs(bullish.normalized as number));
  });
});

// ---------------------------------------------------------------------------
// The published score reads the DAMPED factor, and divides by the weight that
// actually had data. Both were asserted only indirectly before, and the pair of
// them is what decides every number a reader sees.
// ---------------------------------------------------------------------------

describe('the published score is built from post-damping points over live weight', () => {
  // rrCall 0.238, rrPut 4.2, and nothing else leading: the reported shape.
  const lopsided: RiskRewardInput = { price: 100, support: 89.5, resistance: 102.5, atr: 3 };
  const sideways = (overrides: Partial<OptionsSignalInput> = {}) => input({
    macro: available<MacroInput>({
      benchmarks: [
        { symbol: 'SPY', close: 500, ema20: 480 },
        { symbol: 'QQQ', close: 380, ema20: 390 },
      ],
    }),
    trend: available<TrendInput>({ close: 100, ema20: 100, ema50: 100 }),
    momentum: available<MomentumInput>({ squeeze: 'OFF', squeezeMomentum: 0, atr: 2, relativeVolume: 1 }),
    sentiment: available(ratedSentiment(0.5)),
    riskReward: available(lopsided),
    ...overrides,
  });

  it('feeds the damped Risk/Reward points into the total, not the raw tilt', () => {
    const result = calculateOptionsSignal(sideways());
    const diagnostics = result.diagnostics;

    // The factor scored -4 of a possible -15 (0.25 damping), and the total is
    // that -4. If the score were built from the pre-damping tilt the total
    // would be -15 and the published score 42 instead of 48.
    expect(diagnostics.factors.riskReward.points).toBe(-4);
    // -0.2385, not exactly -0.25: the tilt at rrCall 0.236 no longer saturates,
    // so the damping is applied to a real number rather than to a pinned one.
    expect(diagnostics.factors.riskReward.normalized).toBeCloseTo(-0.2385, 4);
    expect(diagnostics.rawDirectionPoints).toBe(-4);
    expect(diagnostics.availableWeight).toBe(90);
    expect(diagnostics.directionScore0to100).toBe(48);
    expect(diagnostics.scoreFormula).toBe('(-4 + 90) ÷ (2 × 90) × 100 = 48');

    // The counterfactual, stated so a regression to the undamped value is loud.
    expect(directionScoreOutOf100(-15, 90)).toBe(42);
    expect(diagnostics.directionScore0to100).not.toBe(42);
  });

  it('agrees with the standalone converter on the engine’s own numbers', () => {
    const result = calculateOptionsSignal(sideways());
    const { rawDirectionPoints, availableWeight, directionScore0to100 } = result.diagnostics;
    expect(directionScore0to100).toBe(directionScoreOutOf100(rawDirectionPoints, availableWeight));
  });

  it('shrinks the divisor by the weight of every factor that had no data', () => {
    const full = calculateOptionsSignal(sideways());
    const noSentiment = calculateOptionsSignal(sideways({
      sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
    }));
    const noSentimentOrMacro = calculateOptionsSignal(sideways({
      sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
      macro: missing<MacroInput>('ไม่มีดัชนีอ้างอิง'),
    }));

    expect(full.diagnostics.availableWeight).toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT);
    expect(noSentiment.diagnostics.availableWeight)
      .toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT - OPTIONS_SIGNAL_WEIGHTS.sentiment);
    expect(noSentiment.diagnostics.availableWeight).toBe(80);
    expect(noSentimentOrMacro.diagnostics.availableWeight)
      .toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT - OPTIONS_SIGNAL_WEIGHTS.sentiment - OPTIONS_SIGNAL_WEIGHTS.macro);
    expect(noSentimentOrMacro.diagnostics.availableWeight).toBe(65);
  });

  it('divides by the shrinking weight, and prints the divisor it used', () => {
    // The raw sum is identical in all three (the dropped factors scored 0), so
    // the DIVISOR is the only thing that can move — and it is the number the
    // formula has to name, or a reader doing the arithmetic gets a different
    // answer from the one printed beside it.
    const full = calculateOptionsSignal(sideways());
    const noSentiment = calculateOptionsSignal(sideways({
      sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
    }));
    const noSentimentOrMacro = calculateOptionsSignal(sideways({
      sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
      macro: missing<MacroInput>('ไม่มีดัชนีอ้างอิง'),
    }));

    for (const result of [full, noSentiment, noSentimentOrMacro]) {
      expect(result.diagnostics.rawDirectionPoints).toBe(-4);
    }
    expect(full.diagnostics.availableWeight).toBe(90);
    expect(noSentiment.diagnostics.availableWeight).toBe(80);
    expect(noSentimentOrMacro.diagnostics.availableWeight).toBe(65);

    expect(full.diagnostics.scoreFormula).toBe('(-4 + 90) ÷ (2 × 90) × 100 = 48');
    expect(noSentiment.diagnostics.scoreFormula).toBe('(-4 + 80) ÷ (2 × 80) × 100 = 48');
    expect(noSentimentOrMacro.diagnostics.scoreFormula).toBe('(-4 + 65) ÷ (2 × 65) × 100 = 47');
  });

  /**
   * The strongest form of the guarantee: do the printed arithmetic and check it
   * lands on the printed answer. A formula is a promise to the reader that they
   * can check the number themselves, and this is that check, run.
   */
  it('produces a formula whose own arithmetic lands on the number beside it', () => {
    const cases = [
      ['full coverage', sideways()],
      ['one factor missing', sideways({ sentiment: missing<SentimentInput>('ไม่มี Open Interest') })],
      ['two factors missing', sideways({
        sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
        macro: missing<MacroInput>('ไม่มีดัชนีอ้างอิง'),
      })],
      ['a bullish signal', input()],
      ['a bearish signal', input({
        macro: available(bearishMacro),
        trend: available(bearishTrend),
        momentum: available<MomentumInput>({
          squeeze: 'FIRED_BEARISH', squeezeMomentum: -2.4, atr: 2, relativeVolume: 1.8,
        }),
      })],
    ] as const;

    for (const [label, candidate] of cases) {
      const result = calculateOptionsSignal(candidate);
      if (result.status !== 'available') throw new Error(`${label}: expected a signal`);
      const { rawDirectionPoints, availableWeight, directionScore0to100, scoreFormula } = result.diagnostics;

      // Read the numbers back out of the string the reader is shown.
      const parsed = /^\(([+-]?\d+) \+ (\d+)\) ÷ \(2 × (\d+)\) × 100 = (\d+)$/.exec(scoreFormula);
      expect(parsed, `${label}: formula did not parse -> ${scoreFormula}`).not.toBeNull();
      const [, printedRaw, printedMaxAbs, printedDivisorMaxAbs, printedAnswer] = parsed as RegExpExecArray;

      // Every number in the sentence is one of the numbers shown above it.
      expect(Number(printedRaw), label).toBe(rawDirectionPoints);
      expect(Number(printedMaxAbs), label).toBe(availableWeight);
      expect(Number(printedDivisorMaxAbs), label).toBe(availableWeight);

      // And doing the sum by hand gives the answer printed at the end of it,
      // which is the same field the card renders.
      const byHand = Math.round(
        (Number(printedRaw) + Number(printedMaxAbs)) / (2 * Number(printedDivisorMaxAbs)) * 100,
      );
      expect(byHand, `${label}: hand arithmetic disagreed with the printed answer`)
        .toBe(Number(printedAnswer));
      expect(Number(printedAnswer), label).toBe(directionScore0to100);

      // The card and the dialog read this same field, so agreeing with it is
      // agreeing with both surfaces.
      const projected = projectOptionsSignal(result, { includeBreakdown: true });
      expect(projected.summary.directionScore0to100, label).toBe(directionScore0to100);
      expect(projected.breakdown?.diagnostics.directionScore0to100, label).toBe(directionScore0to100);
      expect(projected.summary.scoreFormula, label).toBe(scoreFormula);
    }
  });

  it('never divides by the full model weight when a factor had no data', () => {
    const thin = calculateOptionsSignal(sideways({
      sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
      macro: missing<MacroInput>('ไม่มีดัชนีอ้างอิง'),
    }));
    // 65, not 90: the divisor in the sentence is the weight that actually voted.
    expect(thin.diagnostics.scoreFormula).toContain('2 × 65');
    expect(thin.diagnostics.scoreFormula).not.toContain('90');
    expect(thin.diagnostics.availableWeight).toBe(65);
    expect(thin.diagnostics.totalWeight).toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT);
  });

  it('publishes no second ruler for a reader to trip over', () => {
    const diagnostics = calculateOptionsSignal(sideways()).diagnostics as unknown as Record<string, unknown>;
    // The bipolar figure used to sit here beside the 0-100 one, and the two
    // disagreed on sight (-5 next to a formula ending in 48). It is internal now.
    expect('normalizedScore' in diagnostics).toBe(false);
    expect('directionScore' in diagnostics).toBe(false);
    expect('score' in diagnostics).toBe(false);
  });

  it('moves the published 0-100 score when the shrinking divisor is decisive', () => {
    // A signal with real weight behind it: dropping a factor that scored zero
    // raises the score, because the surviving evidence is now a larger share of
    // what could have been scored.
    const bullish = input({ sentiment: available(ratedSentiment(0.5)) });
    const withoutSentiment = input({ sentiment: missing<SentimentInput>('ไม่มี Open Interest') });

    const before = calculateOptionsSignal(bullish).diagnostics;
    const after = calculateOptionsSignal(withoutSentiment).diagnostics;
    expect(before.rawDirectionPoints).toBe(after.rawDirectionPoints);
    expect(after.availableWeight).toBeLessThan(before.availableWeight);
    expect(after.directionScore0to100).toBeGreaterThan(before.directionScore0to100);
  });

  it('prints the divisor it actually used, never the full weight', () => {
    const noSentiment = calculateOptionsSignal(sideways({
      sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
    }));
    expect(noSentiment.diagnostics.scoreFormula).toBe('(-4 + 80) ÷ (2 × 80) × 100 = 48');
    expect(noSentiment.diagnostics.scoreFormula).not.toContain('90');
    // The same number the modal prints in its total row.
    expect(noSentiment.diagnostics.scoreFormula)
      .toContain(String(noSentiment.diagnostics.availableWeight));
  });

  it('never divides by the total weight when coverage is partial', () => {
    const cases = [
      sideways({ sentiment: missing<SentimentInput>('x') }),
      sideways({ riskReward: missing<RiskRewardInput>('x') }),
      sideways({ macro: missing<MacroInput>('x'), sentiment: missing<SentimentInput>('x') }),
    ];
    for (const candidate of cases) {
      const diagnostics = calculateOptionsSignal(candidate).diagnostics;
      expect(diagnostics.availableWeight).toBeLessThan(OPTIONS_SIGNAL_TOTAL_WEIGHT);
      expect(diagnostics.directionScore0to100).toBe(
        directionScoreOutOf100(diagnostics.rawDirectionPoints, diagnostics.availableWeight),
      );
      expect(diagnostics.scoreFormula.split('÷')[0]).toContain(String(diagnostics.availableWeight));
    }
  });
});

// ---------------------------------------------------------------------------
// C. confidence can no longer hide disagreement
// ---------------------------------------------------------------------------

describe('C · confidence is a product, so a collapsed term cannot be bought back', () => {
  it('holds confidence under 45% at 21% agreement, whatever the other terms do', () => {
    // The worst case for the requirement: perfect coverage, maximal strength.
    expect(confidenceFromTerms({ coverage: 1, agreement: 0.21, strength: 1 })).toBeLessThan(0.45);
    expect(confidenceFromTerms({ coverage: 1, agreement: 0.21, strength: 0.7 })).toBeLessThan(0.45);
    // The old weighted average published 62% on exactly this shape.
    const legacyAverage = 0.3 * 1 + 0.35 * 0.21 + 0.35 * 0.7;
    expect(legacyAverage).toBeGreaterThan(0.6);
  });

  it('publishes under 45% for a real signal whose factors disagree that badly', () => {
    const result = calculateOptionsSignal(input({
      // macro -15, trend +25, momentum ~-25, sentiment 0, riskReward +15
      macro: available(bearishMacro),
      trend: available(bullishTrend),
      momentum: available<MomentumInput>({ squeeze: 'FIRED_BEARISH', squeezeMomentum: -2.4, atr: 2, relativeVolume: 1.8 }),
      sentiment: available(ratedSentiment(0.5)),
    }));
    if (result.status !== 'available') throw new Error('expected a signal');
    expect(result.diagnostics.agreement).toBeLessThanOrEqual(0.25);
    expect(result.confidenceScore).toBeLessThan(45);
  });

  it('still rewards evidence that genuinely agrees', () => {
    const result = calculateOptionsSignal(input({
      sentiment: available<SentimentInput>(ratedSentiment(0.05)),
    }));
    if (result.status !== 'available') throw new Error('expected a signal');
    expect(result.diagnostics.agreement).toBe(1);
    expect(result.confidenceScore).toBeGreaterThanOrEqual(OPTIONS_SIGNAL_CONFIG.quality.primeConfidence);
  });

  it('subtracts the event penalty AFTER the geometric mean, not inside it', () => {
    const calm = calculateOptionsSignal(input());
    const nearEarnings = calculateOptionsSignal(input({
      event: available<EventRiskInput>({ reportDate: '2026-08-24', daysToEarnings: 5, timeOfDay: 'post-market' }),
    }));
    expect(nearEarnings.diagnostics.confidenceBase).toBe(calm.diagnostics.confidenceBase);
    expect(nearEarnings.confidenceScore).toBeLessThan(calm.confidenceScore);
  });
});

// ---------------------------------------------------------------------------
// The house rule the rework must not break
// ---------------------------------------------------------------------------

describe('a factor without data leaves the denominator, it never scores zero', () => {
  it('shrinks the divisor by exactly that factor\'s weight', () => {
    const full = calculateOptionsSignal(input());
    const withoutSentiment = calculateOptionsSignal(input({ sentiment: missing<SentimentInput>('ไม่มี OI') }));

    expect(full.diagnostics.availableWeight).toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT);
    expect(withoutSentiment.diagnostics.availableWeight)
      .toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT - OPTIONS_SIGNAL_WEIGHTS.sentiment);
    expect(withoutSentiment.diagnostics.factors.sentiment.points).toBeNull();
    expect(withoutSentiment.diagnostics.factors.sentiment.normalized).toBeNull();
    expect(withoutSentiment.diagnostics.coverage).toBeLessThan(1);
  });

  it('does not move the direction when the dropped factor scored zero anyway', () => {
    // The neutral Put/Call scores 0 points. Dropping it must change the DIVISOR,
    // which is the whole point: a 0 kept in the denominator would dilute the rest.
    const withZero = calculateOptionsSignal(input());
    const withoutIt = calculateOptionsSignal(input({ sentiment: missing<SentimentInput>('ไม่มี OI') }));
    expect(withZero.diagnostics.rawDirectionPoints).toBe(withoutIt.diagnostics.rawDirectionPoints);
    expect(withoutIt.diagnostics.availableWeight).toBeLessThan(withZero.diagnostics.availableWeight);
    expect(withoutIt.diagnostics.directionScore0to100)
      .toBeGreaterThan(withZero.diagnostics.directionScore0to100);
  });
});

// ---------------------------------------------------------------------------
// F. RVOL is continuous
// ---------------------------------------------------------------------------

describe('F · RVOL confirmation is a curve, not a cliff at 1.00x', () => {
  it('separates 0.99x and 1.01x by less than 10 percentage points', () => {
    const quiet = rvolConfirmation(0.99);
    const busy = rvolConfirmation(1.01);
    expect(busy).toBeGreaterThan(quiet);
    expect(Math.abs(busy - quiet)).toBeLessThan(0.1);
    expect(rvolConfirmation(1)).toBeCloseTo(0.5, 6);
  });

  it('reports an ordinary 0.81x session as reduced confirmation, never as zero', () => {
    const confirmation = rvolConfirmation(0.81);
    expect(confirmation).toBeGreaterThan(0.1);
    expect(confirmation).toBeLessThan(0.5);
  });

  it('stays monotonic and bounded across the whole range', () => {
    const samples = [0.1, 0.5, 0.81, 0.99, 1, 1.01, 1.5, 3, 10];
    const values = samples.map((sample) => rvolConfirmation(sample));
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(Number.isFinite(value)).toBe(true);
    }
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]);
    }
    // Over the range any real RVOL lands in, the curve has no flat spot and no
    // endpoint — which is the property the old step function lacked.
    const realistic = [0.1, 0.5, 0.81, 0.99, 1, 1.01, 1.5, 3].map((sample) => rvolConfirmation(sample));
    for (let index = 1; index < realistic.length; index += 1) {
      expect(realistic[index]).toBeGreaterThan(realistic[index - 1]);
    }
    expect(realistic.at(-1)).toBeLessThan(1);
  });

  it('carries the same continuity into the momentum factor', () => {
    const quiet = scoreMomentum({ squeeze: 'OFF', squeezeMomentum: 2, atr: 2, relativeVolume: 0.99 });
    const busy = scoreMomentum({ squeeze: 'OFF', squeezeMomentum: 2, atr: 2, relativeVolume: 1.01 });
    expect(Math.abs((busy.confirmation as number) - (quiet.confirmation as number))).toBeLessThan(0.1);
    expect(Math.abs((busy.normalized as number) - (quiet.normalized as number))).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// G. one asOf, and STALE-MIX when the sources really do disagree
// ---------------------------------------------------------------------------

describe('G · one published timestamp, and an honest badge when sources diverge', () => {
  const at = (hours: number) => new Date(Date.parse('2026-08-19T00:00:00.000Z') + hours * 3_600_000).toISOString();

  it('publishes the OLDEST source timestamp as the signal timestamp', () => {
    const result = calculateOptionsSignal(input({
      trend: available(bullishTrend, 'DELAYED', at(0)),
      momentum: available<MomentumInput>(
        { squeeze: 'FIRED_BULLISH', squeezeMomentum: 2.4, atr: 2, relativeVolume: 1.8 }, 'DELAYED', at(2),
      ),
      pricing: available<IvPricingInput>(cheapIv, 'DELAYED', at(4)),
    }));
    expect(result.asOf).toBe(at(0));
    expect(result.diagnostics.provenance.newestAsOf).toBe(at(4));
    expect(result.diagnostics.provenance.asOf).toBe(result.asOf);
  });

  it('does NOT raise STALE-MIX inside one session, whatever the clock says', () => {
    const result = calculateOptionsSignal(input({
      macro: available(bullishMacro, 'DELAYED', at(0)),
      trend: available(bullishTrend, 'DELAYED', at(0)),
      momentum: available<MomentumInput>(
        { squeeze: 'FIRED_BULLISH', squeezeMomentum: 2.4, atr: 2, relativeVolume: 1.8 }, 'DELAYED', at(0),
      ),
      pricing: available<IvPricingInput>(cheapIv, 'DELAYED', at(5)),
      sentiment: available(ratedSentiment(0.5), 'DELAYED', at(5)),
      riskReward: available<RiskRewardInput>({ price: 110, support: 105, resistance: 130, atr: 3 }, 'DELAYED', at(0)),
      event: available(farEarnings, 'DELAYED', at(0)),
    }));
    expect(result.diagnostics.provenance.spreadHours).toBe(5);
    expect(result.diagnostics.provenance.spreadSessions).toBe(0);
    expect(result.staleMix).toBe(false);
    expect(result.diagnostics.provenance.staleMix).toBe(false);
  });

  /*
   * THE CASE THE FLAG WAS FIRING ON, AND SHOULD NEVER HAVE FIRED ON.
   *
   * 2026-08-21 is a Friday and 2026-08-22 a Saturday. A chain pulled at 23:11 on
   * the Saturday is a snapshot of FRIDAY's session — the exchange did not open in
   * between, so there is no newer chain to have pulled. Beside a Friday closing
   * bar that is 26.7 clock hours and ZERO trading sessions, and only one of those
   * two numbers is about how current the evidence is.
   *
   * Under the old wall-clock rule this fired on every signal computed at a
   * weekend. A flag that is always up is a flag nobody reads on the day it is
   * real, which is the entire cost of getting this wrong.
   */
  it('does NOT raise STALE-MIX for a Saturday capture of the Friday session', () => {
    const fridayClose = '2026-08-21T20:00:00.000Z';
    const saturdayNightPull = '2026-08-22T03:11:00.000Z';
    const summary = summariseProvenance([
      { id: 'trend', slot: available(1, 'DELAYED', fridayClose) },
      { id: 'pricing', slot: available(2, 'DELAYED', saturdayNightPull) },
    ]);
    expect(summary.spreadHours).toBeGreaterThan(OPTIONS_SIGNAL_CONFIG.provenance.staleMixHours);
    expect(summary.spreadSessions).toBe(0);
    expect(summary.staleMix).toBe(false);
  });

  it('DOES raise STALE-MIX when the sources really are two sessions apart', () => {
    // Wednesday's close against Friday's: two different days of a market, which
    // is what the flag has always been for.
    const summary = summariseProvenance([
      { id: 'trend', slot: available(1, 'DELAYED', '2026-08-19T20:00:00.000Z') },
      { id: 'pricing', slot: available(2, 'DELAYED', '2026-08-21T20:00:00.000Z') },
    ]);
    expect(summary.spreadSessions).toBe(2);
    expect(summary.staleMix).toBe(true);
  });

  it('raises it on the first FULL session of separation, and not before', () => {
    const sameSession = summariseProvenance([
      // Both inside Wednesday's session: 09:35 and 15:55 ET.
      { id: 'a', slot: available(1, 'DELAYED', '2026-08-19T13:35:00.000Z') },
      { id: 'b', slot: available(2, 'DELAYED', '2026-08-19T19:55:00.000Z') },
    ]);
    expect(sameSession.spreadSessions).toBe(0);
    expect(sameSession.staleMix).toBe(false);

    const oneApart = summariseProvenance([
      { id: 'a', slot: available(1, 'DELAYED', '2026-08-19T20:00:00.000Z') },
      { id: 'b', slot: available(2, 'DELAYED', '2026-08-20T20:00:00.000Z') },
    ]);
    expect(oneApart.spreadSessions).toBe(OPTIONS_SIGNAL_CONFIG.provenance.staleMixSessions);
    expect(oneApart.staleMix).toBe(true);
  });

  it('carries the fetch time beside the data time, never instead of it', () => {
    const summary = summariseProvenance([
      {
        id: 'pricing',
        slot: {
          status: 'available', state: 'DELAYED', value: 1, provider: 'alpaca',
          asOf: '2026-08-21T20:00:00.000Z', fetchedAt: '2026-08-22T03:11:00.000Z',
        },
      },
    ]);
    const [source] = summary.sources;
    expect(source.asOf).toBe('2026-08-21T20:00:00.000Z');
    expect(source.fetchedAt).toBe('2026-08-22T03:11:00.000Z');
    // The published signal time is the DATA time. The fetch never becomes it.
    expect(summary.asOf).toBe('2026-08-21T20:00:00.000Z');
  });

  it('ignores the timestamps of sources that produced nothing', () => {
    const summary = summariseProvenance([
      { id: 'a', slot: available(1, 'DELAYED', at(3)) },
      { id: 'b', slot: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'x', provider: 'p', asOf: at(99) } },
    ]);
    expect(summary.asOf).toBe(at(3));
    expect(summary.newestAsOf).toBe(at(3));
    expect(summary.spreadHours).toBeNull();
    expect(summary.staleMix).toBe(false);
    // The unusable source is still LISTED, so the audit trail stays complete.
    expect(summary.sources.map((source) => source.id)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// H / I. what the modal has to be able to say
// ---------------------------------------------------------------------------

describe('H · a clamped momentum ratio says it was clamped', () => {
  it('reports three decimals and flags a genuine cap', () => {
    /*
     * Written against the CONFIGURED ceiling rather than a literal, because the
     * ceiling moved once already: it was 1.0 ATR, where it clamped 22 of the 30
     * regression tickers, and is now 3.5. A test that hardcodes the old number
     * stops testing the clamp the moment the clamp is retuned.
     */
    const saturation = OPTIONS_SIGNAL_CONFIG.momentum.momentumAtrSaturation;
    const capped = calculateOptionsSignal(input({
      momentum: available<MomentumInput>({
        squeeze: 'OFF', squeezeMomentum: saturation * 2.4, atr: 2, relativeVolume: 1.5,
      }),
    }));
    expect(capped.diagnostics.squeeze.normalizedMomentum).toBe(1);
    expect(capped.diagnostics.squeeze.normalizedMomentumCapped).toBe(true);
    // The reading itself is still reported in ATR, unclamped.
    expect(capped.diagnostics.squeeze.breakdown.rawAtr).toBeCloseTo(saturation * 1.2, 3);

    const inRange = calculateOptionsSignal(input({
      momentum: available<MomentumInput>({
        squeeze: 'OFF', squeezeMomentum: saturation * 1.234_5, atr: 2, relativeVolume: 1.5,
      }),
    }));
    expect(inRange.diagnostics.squeeze.normalizedMomentum).toBe(0.617);
    expect(inRange.diagnostics.squeeze.normalizedMomentumCapped).toBe(false);
  });
});

describe('I · distances are quoted in ATR and in expected moves, not only in percent', () => {
  it('converts both sides with the ATR and the straddle it was given', () => {
    const outcome = scoreRiskReward(
      { price: 100, support: 88, resistance: 103, atr: 3, expectedMove: 6 },
      { direction: 'neutral' },
    );
    expect(outcome.upsideAtr).toBeCloseTo(1, 6);
    expect(outcome.downsideAtr).toBeCloseTo(4, 6);
    expect(outcome.upsideExpectedMoves).toBeCloseTo(0.5, 6);
    expect(outcome.downsideExpectedMoves).toBeCloseTo(2, 6);
  });

  it('leaves the ATR columns absent rather than inventing a scale', () => {
    const outcome = scoreRiskReward({ price: 100, support: 88, resistance: 103 }, { direction: 'neutral' });
    expect(outcome.upsideAtr).toBeNull();
    expect(outcome.downsideExpectedMoves).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D / E. the two readings that were meaningless on their own
// ---------------------------------------------------------------------------

describe('D · IV percentile reports a countdown, never a flat "unavailable"', () => {
  it('carries how many days are still missing through to the reasons', () => {
    const result = calculateOptionsSignal(input({
      ivPercentilePending: { observations: 12, required: 60, missingDays: 48 },
    }));
    expect(result.diagnostics.iv.percentilePending).toEqual({ observations: 12, required: 60, missingDays: 48 });
    const text = result.reasoning.find((reason) => reason.id === 'iv-percentile-pending')?.text ?? '';
    expect(text).toContain('48');
    expect(text).not.toContain('ไม่พร้อมใช้งาน');
  });

  it('discloses which realized-volatility window a short-dated contract used', () => {
    const result = calculateOptionsSignal(input({
      pricing: available<IvPricingInput>({
        basis: 'iv-vs-realized', impliedVolatility: 0.3, realizedVolatility: 0.28,
        ratio: 0.3 / 0.28, observations: 30, realizedWindowDays: 30, dte: 21,
      }),
    }));
    expect(result.diagnostics.iv.realizedWindowDays).toBe(30);
    expect(result.diagnostics.iv.dte).toBe(21);
  });
});

describe('E · Put/Call is read against the symbol itself, and says what OI is', () => {
  it('warns that open interest is mostly hedging, on every reading', () => {
    const withoutHistory = scoreSentiment({ ...neutralSentiment, putCallRatio: 1.51 });
    expect(withoutHistory.detail).toContain('hedge');
    expect(withoutHistory.partial).toBe(true);
    expect(withoutHistory.detail).toContain('เกณฑ์กลาง');
  });

  it('prefers the symbol\'s own percentile once enough of its history exists', () => {
    const scored = scoreSentiment({
      ...neutralSentiment,
      putCallRatio: 1.51,
      ownPercentile: 0.82,
      percentileObservations: 60,
    });
    expect(scored.partial).toBe(false);
    expect(scored.detail).toContain('เปอร์เซ็นไทล์ที่ 82');
    expect(scored.normalized).toBeLessThan(0);
  });

  it('reads the same raw ratio in opposite directions on two different symbols', () => {
    const routine = scoreSentiment({
      ...neutralSentiment, putCallRatio: 1.51, ownPercentile: 0.2, percentileObservations: 60,
    });
    const unusual = scoreSentiment({
      ...neutralSentiment, putCallRatio: 1.51, ownPercentile: 0.95, percentileObservations: 60,
    });
    expect(routine.normalized).toBeGreaterThan(0);
    expect(unusual.normalized).toBeLessThan(0);
  });

  it('averages in the traded volume ratio when the chain supplied one', () => {
    const oiOnly = scoreSentiment({ ...neutralSentiment, putCallRatio: 1.5 });
    const withCallHeavyFlow = scoreSentiment({ ...neutralSentiment, putCallRatio: 1.5, volumeRatio: 0.4 });
    expect(oiOnly.normalized).toBeLessThan(0);
    expect(withCallHeavyFlow.normalized).toBeGreaterThan(oiOnly.normalized as number);
  });

  it('withholds the percentile until the minimum number of readings exists', () => {
    const tooFew = scoreSentiment({
      ...neutralSentiment, putCallRatio: 1.51, ownPercentile: 0.82, percentileObservations: 5,
    });
    expect(tooFew.partial).toBe(true);
    expect(tooFew.detail).toContain('5/20');
  });
});

// ---------------------------------------------------------------------------
// New 1. liquidity badge
// ---------------------------------------------------------------------------

describe('liquidity is graded from real chain numbers, and never scores direction', () => {
  const liquid: LiquidityInput = {
    medianOpenInterest: 2_000, medianVolume: 400, medianSpreadPercent: 2,
    contractsExamined: 12, expiration: '2026-09-18',
  };
  const thin: LiquidityInput = {
    medianOpenInterest: 20, medianVolume: 1, medianSpreadPercent: 40,
    contractsExamined: 6, expiration: '2026-09-18',
  };

  it('grades a deep chain good and an empty one thin', () => {
    expect(gradeLiquidity(liquid).grade).toBe('good');
    expect(gradeLiquidity(thin).grade).toBe('thin');
    expect(gradeLiquidity({
      medianOpenInterest: 250, medianVolume: 40, medianSpreadPercent: 14,
      contractsExamined: 8, expiration: '2026-09-18',
    }).grade).toBe('fair');
  });

  it('drops a missing component from the average instead of scoring it zero', () => {
    const withoutVolume = gradeLiquidity({ ...liquid, medianVolume: null });
    expect(withoutVolume.grade).toBe('good');
    expect(gradeLiquidity({
      medianOpenInterest: null, medianVolume: null, medianSpreadPercent: null,
      contractsExamined: 0, expiration: '2026-09-18',
    }).grade).toBeNull();
  });

  it('changes the badge but never the direction score', () => {
    const withLiquid = calculateOptionsSignal(input({ liquidity: available(liquid) }));
    const withThin = calculateOptionsSignal(input({ liquidity: available(thin) }));
    expect(withLiquid.diagnostics.directionScore0to100).toBe(withThin.diagnostics.directionScore0to100);
    expect(withLiquid.liquidityGrade).toBe('good');
    expect(withThin.liquidityGrade).toBe('thin');
    expect(withThin.suggestedOptionsSetup.warnings.some((warning) => warning.includes('บาง'))).toBe(true);
  });

  it('says so plainly when there is no chain to judge', () => {
    const result = calculateOptionsSignal(input());
    expect(result.liquidityGrade).toBeNull();
    expect(result.diagnostics.liquidity.state).toBe('UNAVAILABLE');
    expect(result.diagnostics.liquidity.reason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Badges that must not mislead: an after-hours spread, and an expected move
// quoted without the horizon it belongs to.
// ---------------------------------------------------------------------------

describe('a bid-ask spread quoted while the book is shut is not a liquidity grade', () => {
  /*
   * A chain that is thin ONLY because of its spread: the standing book is
   * ordinary, and the 42% spread is what a quote looks like at 02:00. Counting
   * that spread drags the composite to `thin`; excluding it lands on `fair`.
   */
  const thinLookingAfterHours: LiquidityInput = {
    medianOpenInterest: 400, medianVolume: 40, medianSpreadPercent: 42,
    contractsExamined: 12, expiration: '2026-09-18',
  };

  it('grades the same chain thin when open and unknown when shut', () => {
    const open = gradeLiquidity({ ...thinLookingAfterHours, marketOpenAtCapture: true });
    const shut = gradeLiquidity({ ...thinLookingAfterHours, marketOpenAtCapture: false });
    expect(open.grade).toBe('thin');
    expect(shut.grade).toBe('unknown');
    expect(shut.score).toBeNull();
  });

  it('keeps the open-interest and volume evidence rather than throwing it away', () => {
    const shut = gradeLiquidity({ ...thinLookingAfterHours, marketOpenAtCapture: false });
    /*
     * A PASS/FAIL, not a grade and not a score.
     *
     * This used to publish `{ grade: 'fair', score: 60 }` and the card rendered
     * the pair as a badge one line under "คะแนนรวม: —". The measurement is still
     * kept and still labelled — what it no longer does is dress a partial view up
     * as a liquidity verdict with a number beside it.
     */
    expect(shut.offHoursAssessment).toEqual({ standingPassed: false });
    expect(shut.detail).toContain('OI/Volume ยังบาง');
    expect(shut.detail).toContain('สเปรดยังตัดสินไม่ได้');
    expect(shut.detail).toContain('42%');
  });

  it('never publishes a score or a green grade in a box whose gate did not pass', () => {
    const shut = gradeLiquidity({
      // The case from the report: standing interest comfortably through, and a
      // spread nobody can grade because the book was shut.
      medianOpenInterest: 899, medianVolume: 533, medianSpreadPercent: 6.18,
      contractsExamined: 12, expiration: '2026-09-18', marketOpenAtCapture: false,
    });
    expect(shut.grade).toBe('unknown');
    expect(shut.score).toBeNull();
    expect(shut.offHoursAssessment).toEqual({ standingPassed: true });
    // The two facts, in one sentence, in the order a reader needs them.
    expect(shut.detail).toContain('OI/Volume ผ่านเกณฑ์ (899 / 533)');
    expect(shut.detail).toContain('สเปรดยังตัดสินไม่ได้ — เก็บตอนตลาดปิดที่ 6.2% ต้องดูซ้ำตอนเปิด');
    // Nothing anywhere in the box claims a full mark.
    expect(shut.detail).not.toContain('100');
    expect(shut.detail).not.toContain('สภาพคล่องดี');
  });

  it('keeps a very wide closed-book spread as an upper bound instead of discarding it', () => {
    const wide = gradeLiquidity({
      medianOpenInterest: 899, medianVolume: 533, medianSpreadPercent: 42,
      contractsExamined: 12, expiration: '2026-09-18', marketOpenAtCapture: false,
    });
    expect(wide.closedSpreadWarning).toContain('กว้างผิดปกติแม้เผื่อผลของตลาดปิด');

    // 6.18% is wide but not wide enough to survive the halving argument, so it
    // stays a "look again", not a warning. A warning that fires on every closed
    // book is the flag nobody reads.
    const ordinary = gradeLiquidity({
      medianOpenInterest: 899, medianVolume: 533, medianSpreadPercent: 6.18,
      contractsExamined: 12, expiration: '2026-09-18', marketOpenAtCapture: false,
    });
    expect(ordinary.closedSpreadWarning).toBeNull();
  });

  it('treats an unknown capture time as unknown, not as closed', () => {
    // "We do not know when this was quoted" is not "we know the market was shut".
    const unknownTime = gradeLiquidity({ ...thinLookingAfterHours, marketOpenAtCapture: null });
    expect(unknownTime.grade).toBe('thin');
    expect(gradeLiquidity(thinLookingAfterHours).grade).toBe('thin');
  });

  it('carries the closed state and the fallback assessment into the diagnostics', () => {
    const result = calculateOptionsSignal(input({
      liquidity: available<LiquidityInput>({ ...thinLookingAfterHours, marketOpenAtCapture: false }),
    }));
    expect(result.liquidityGrade).toBe('unknown');
    expect(result.diagnostics.liquidity.marketOpenAtCapture).toBe(false);
    expect(result.diagnostics.liquidity.offHoursAssessment).toEqual({ standingPassed: false });
    // And the setup warns the reader to look again when the book reopens.
    expect(result.suggestedOptionsSetup.warnings.some((warning) => warning.includes('ตลาดปิด'))).toBe(true);
    // It is NOT the thin-chain warning: that would be the false claim.
    expect(result.suggestedOptionsSetup.warnings.some((warning) => warning.includes('บาง'))).toBe(false);
  });

  it('still never touches the direction score', () => {
    const open = calculateOptionsSignal(input({
      liquidity: available<LiquidityInput>({ ...thinLookingAfterHours, marketOpenAtCapture: true }),
    }));
    const shut = calculateOptionsSignal(input({
      liquidity: available<LiquidityInput>({ ...thinLookingAfterHours, marketOpenAtCapture: false }),
    }));
    expect(open.diagnostics.directionScore0to100).toBe(shut.diagnostics.directionScore0to100);
    expect(open.confidenceScore).toBe(shut.confidenceScore);
  });
});

describe('an expected move is never shown without the horizon it belongs to', () => {
  it('carries the straddle DTE through to the diagnostics and the detail text', () => {
    const result = calculateOptionsSignal(input({
      riskReward: available<RiskRewardInput>({
        price: 100, support: 95, resistance: 110, atr: 2, expectedMove: 6, expectedMoveDte: 32,
      }),
    }));
    expect(result.diagnostics.riskReward.expectedMoveDte).toBe(32);
    expect(result.diagnostics.factors.riskReward.detail).toContain('32 วัน');
  });

  it('warns when a level sits further away than this contract can reach', () => {
    // Resistance 20% away on a straddle pricing a 6% move: reaching it before
    // expiry is a tail event, and the R:R measured against it flatters the setup.
    const outcome = scoreRiskReward(
      { price: 100, support: 97, resistance: 120, atr: 2, expectedMove: 6, expectedMoveDte: 7 },
      { direction: 'bullish' },
    );
    expect(outcome.upsideExpectedMoves).toBeCloseTo(3.33, 2);
    expect(outcome.expectedMoveHorizonWarning).toContain('Expected Move');
    expect(outcome.expectedMoveHorizonWarning).toContain('7 วัน');
  });

  it('stays quiet when both levels are inside the move the contract prices', () => {
    const outcome = scoreRiskReward(
      { price: 100, support: 96, resistance: 105, atr: 2, expectedMove: 8, expectedMoveDte: 45 },
      { direction: 'bullish' },
    );
    expect(outcome.expectedMoveHorizonWarning).toBeNull();
  });

  it('says nothing at all when there is no straddle to compare against', () => {
    const outcome = scoreRiskReward({ price: 100, support: 90, resistance: 130 }, { direction: 'bullish' });
    expect(outcome.expectedMoveDte).toBeNull();
    expect(outcome.expectedMoveHorizonWarning).toBeNull();
  });

  it('surfaces the warning as a caution reason on the signal', () => {
    const result = calculateOptionsSignal(input({
      riskReward: available<RiskRewardInput>({
        price: 100, support: 97, resistance: 120, atr: 2, expectedMove: 6, expectedMoveDte: 7,
      }),
    }));
    const reason = result.reasoning.find((entry) => entry.id === 'expected-move-horizon');
    expect(reason?.polarity).toBe('caution');
    expect(result.diagnostics.riskReward.expectedMoveHorizonWarning).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Nothing broken reaches the UI
// ---------------------------------------------------------------------------

/** Walk a projected payload and collect anything a React render could not print. */
function unrenderable(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [] : [`${path} = ${value}`];
  }
  if (value === undefined) return [`${path} = undefined`];
  if (Array.isArray(value)) return value.flatMap((entry, index) => unrenderable(entry, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => unrenderable(entry, `${path}.${key}`));
  }
  return [];
}

describe('no NaN and no undefined ever reaches the card', () => {
  const brokenSlots: Array<[string, Partial<OptionsSignalInput>]> = [
    ['every source down', {
      macro: missing<MacroInput>('provider down'),
      trend: missing<TrendInput>('provider down'),
      momentum: missing<MomentumInput>('provider down'),
      pricing: missing<IvPricingInput>('provider down'),
      sentiment: missing<SentimentInput>('provider down'),
      riskReward: missing<RiskRewardInput>('provider down'),
      event: missing<EventRiskInput>('provider down'),
    }],
    ['NaN prices from a bad payload', {
      trend: available<TrendInput>({ close: Number.NaN, ema20: Number.NaN, ema50: 100 }),
      riskReward: available<RiskRewardInput>({ price: Number.NaN, support: Number.NaN, resistance: 130, atr: Number.NaN }),
    }],
    ['a zero-price underlying', {
      riskReward: available<RiskRewardInput>({ price: 0, support: 0, resistance: 0, atr: 0, expectedMove: 0 }),
    }],
    ['infinite indicator output', {
      momentum: available<MomentumInput>({
        squeeze: 'OFF', squeezeMomentum: Number.POSITIVE_INFINITY, atr: 0, relativeVolume: Number.NaN,
      }),
    }],
    ['a NaN Put/Call ratio', {
      sentiment: available<SentimentInput>({ ...neutralSentiment, putCallRatio: Number.NaN }),
    }],
    ['unparseable timestamps', {
      macro: available(bullishMacro, 'DELAYED', 'not-a-date'),
      pricing: available<IvPricingInput>(cheapIv, 'DELAYED', ''),
    }],
    ['a liquidity slot full of holes', {
      liquidity: available<LiquidityInput>({
        medianOpenInterest: Number.NaN, medianVolume: null,
        medianSpreadPercent: Number.POSITIVE_INFINITY, contractsExamined: 0, expiration: '2026-09-18',
      }),
    }],
  ];

  for (const [name, overrides] of brokenSlots) {
    it(`survives ${name}`, () => {
      const result = calculateOptionsSignal(input(overrides));
      const projected = projectOptionsSignal(result, { includeBreakdown: true });
      expect(unrenderable(projected)).toEqual([]);
      // And it stays serializable, which is how it reaches the browser at all.
      expect(() => JSON.parse(JSON.stringify(projected))).not.toThrow();
    });
  }

  it('shows an em dash rather than a broken number when the chain is gone', () => {
    const result = calculateOptionsSignal(input({ pricing: missing<IvPricingInput>('provider down') }));
    expect(result.diagnostics.iv.level).toBeNull();
    expect(result.diagnostics.iv.ratio).toBeNull();
    expect(result.diagnostics.iv.reason).toBe('provider down');
  });

  it('keeps the published score inside 0-100 even with nothing to score', () => {
    const result = calculateOptionsSignal(input({ finalizedCandles: 3 }));
    expect(result.status).toBe('insufficient-data');
    expect(result.diagnostics.directionScore0to100).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.directionScore0to100).toBeLessThanOrEqual(100);
    expect(result.directionScore0to100).toBeNull();
    expect(unrenderable(projectOptionsSignal(result, { includeBreakdown: true }))).toEqual([]);
  });
});
