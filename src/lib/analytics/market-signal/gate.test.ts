import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MARKET_SIGNAL_GATE, MARKET_SIGNAL_SCORE_WEIGHTS } from '@/src/config/signal';
import type { DataFreshness } from '@/src/lib/market-data/types';
import {
  agreementRatio,
  bandFromScore,
  calculateGatedConfidence,
  calculateMarketSignal,
  capLowVolumeComponent,
  detectComponentConflicts,
  divergenceWeight,
  duplicatedReasonTags,
  earningsProximityFrom,
  gatedBias,
  isDegradedFreshness,
} from './calculations';
import type {
  MarketSignalCandle,
  MarketSignalScoreBreakdown,
  MarketSignalScoreComponent,
} from './types';

/**
 * P1 — the consistency layer behind `SIGNAL_GATE`.
 *
 * The case this whole phase exists for: EMA -10/30, Momentum +18/25,
 * TrendStrength 0/15, Volume +8/15, Structure -15/15, total +1 — and a card
 * that said BULLISH with 64% confidence. Every rule below is one of the reasons
 * that sentence was wrong.
 *
 * The last block is the one that protects everyone else: with the flag off,
 * none of this runs.
 */

const capture = (symbol: string) => JSON.parse(
  readFileSync(join(process.cwd(), '__golden__', 'candles', `${symbol}.json`), 'utf8'),
) as { source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] };

const irenCandles = capture('IREN');
const runIren = (features?: { gate: boolean }, earnings?: { daysToNextReport: number | null }) =>
  calculateMarketSignal(irenCandles.candles, {
    symbol: 'IREN',
    source: irenCandles.source,
    freshness: irenCandles.freshness,
    calculatedAt: '2026-01-01T00:00:00.000Z',
    ...(features ? { features } : {}),
    ...(earnings ? { earnings } : {}),
  });

function component(points: number | null, maxPoints: number): MarketSignalScoreComponent {
  return {
    points,
    maxPoints: maxPoints as MarketSignalScoreComponent['maxPoints'],
    normalizedScore: points === null ? null : points / maxPoints,
    coverage: 1,
    factorsUsed: 2,
    available: points !== null,
  };
}

/** The reported IREN breakdown, before the P0 structure fix changed it. */
function breakdown(points: Partial<Record<keyof MarketSignalScoreBreakdown, number | null>> = {}): MarketSignalScoreBreakdown {
  const value = (id: keyof MarketSignalScoreBreakdown, fallback: number) =>
    component(points[id] === undefined ? fallback : points[id], MARKET_SIGNAL_SCORE_WEIGHTS[id]);
  return {
    emaTrend: value('emaTrend', -10),
    momentum: value('momentum', 18),
    trendStrength: value('trendStrength', 0),
    volume: value('volume', 8),
    priceStructure: value('priceStructure', -15),
  };
}

describe('score bands', () => {
  it('treats a score under the neutral band as no direction at all', () => {
    expect(bandFromScore(1)).toBe('neutral');
    expect(bandFromScore(-14)).toBe('neutral');
    expect(bandFromScore(MARKET_SIGNAL_GATE.bands.neutral)).toBe('weak');
    expect(bandFromScore(-MARKET_SIGNAL_GATE.bands.neutral)).toBe('weak');
  });

  it('separates weak, moderate and strong at the configured edges', () => {
    const { weak, strong } = MARKET_SIGNAL_GATE.bands;
    expect(bandFromScore(weak - 1)).toBe('weak');
    expect(bandFromScore(weak)).toBe('moderate');
    expect(bandFromScore(strong - 1)).toBe('moderate');
    expect(bandFromScore(strong)).toBe('strong');
    expect(bandFromScore(-100)).toBe('strong');
  });

  it('refuses a direction below the neutral band whatever the sign says', () => {
    expect(gatedBias(1, bandFromScore(1), [])).toBe('neutral');
    expect(gatedBias(-14, bandFromScore(-14), [])).toBe('neutral');
    expect(gatedBias(41, bandFromScore(41), [])).toBe('bullish');
    expect(gatedBias(-41, bandFromScore(-41), [])).toBe('bearish');
  });

  it('refuses a direction while two parts of the evidence contradict each other', () => {
    expect(gatedBias(85, 'strong', ['ema_vs_momentum'])).toBe('neutral');
    expect(gatedBias(-85, 'strong', ['structure_vs_momentum'])).toBe('neutral');
  });
});

describe('component conflicts', () => {
  it('catches trend and momentum pulling opposite ways', () => {
    expect(detectComponentConflicts(breakdown())).toContain('ema_vs_momentum');
    expect(detectComponentConflicts(breakdown())).toContain('structure_vs_momentum');
  });

  it('is silent when everything agrees', () => {
    expect(detectComponentConflicts(breakdown({ emaTrend: 20, priceStructure: 10 }))).toEqual([]);
  });

  /*
   * Silver: four of five components positive, score 36, and an EMA component at
   * -0.11 of its range. Reading sign alone forced that to NEUTRAL.
   */
  it('does not let a component that is barely off zero veto everything else', () => {
    const barely = MARKET_SIGNAL_GATE.conflictMinimumMagnitude * MARKET_SIGNAL_SCORE_WEIGHTS.emaTrend - 1;
    expect(detectComponentConflicts(breakdown({ emaTrend: -barely, priceStructure: 15 }))).toEqual([]);
  });

  it('says nothing when momentum itself has no opinion', () => {
    expect(detectComponentConflicts(breakdown({ momentum: 0 }))).toEqual([]);
  });

  /*
   * The magnitude rule has to apply to BOTH pairs. Guarding only the EMA side
   * would leave a price-structure component at a rounding-level reading still
   * able to void a direction on its own.
   */
  it('applies the same magnitude rule to the structure pair', () => {
    const floor = MARKET_SIGNAL_GATE.conflictMinimumMagnitude;
    const belowFloor = Math.floor((floor * MARKET_SIGNAL_SCORE_WEIGHTS.priceStructure) - 1);
    const aboveFloor = Math.ceil(floor * MARKET_SIGNAL_SCORE_WEIGHTS.priceStructure) + 1;

    expect(detectComponentConflicts(breakdown({ emaTrend: 20, priceStructure: -belowFloor })))
      .not.toContain('structure_vs_momentum');
    expect(detectComponentConflicts(breakdown({ emaTrend: 20, priceStructure: -aboveFloor })))
      .toContain('structure_vs_momentum');
  });

  /*
   * Measured over the 108-instrument corpus in `scripts/signal-sensitivity.ts`:
   * sweeping 0.10 -> 0.30 moves 29, 29, 27, 27, 25 labels, and no adjacent pair
   * of thresholds differs by more than four symbols out of 108. The chosen value
   * sits in the flat middle of that sweep rather than on an edge of it.
   */
  it('keeps the chosen threshold inside the range the sweep found stable', () => {
    expect(MARKET_SIGNAL_GATE.conflictMinimumMagnitude).toBeGreaterThanOrEqual(0.15);
    expect(MARKET_SIGNAL_GATE.conflictMinimumMagnitude).toBeLessThanOrEqual(0.25);
  });
});

describe('agreement', () => {
  it('is the share of weight that points the way the total does', () => {
    // ema -10 opposes, momentum +18 and volume +8 agree, trend and structure
    // contribute nothing: 25 + 15 out of 100.
    expect(agreementRatio(breakdown({ priceStructure: 0 }), 16)).toBeCloseTo(0.4, 5);
  });

  it('never reads 100% while any weight is pulling the other way', () => {
    const conflicted = breakdown();
    const score = 1;
    const confidence = calculateGatedConfidence({
      scoreBreakdown: conflicted,
      score,
      bias: 'neutral',
      regimeClarity: 0.02,
      dataDegraded: false,
      earningsProximity: 'unknown',
    });
    expect(confidence.breakdown.conflictPenalty).toBeGreaterThan(0);
    expect(confidence.breakdown.agreement).toBeLessThan(100);
  });

  it('reaches 100% only when every available component agrees', () => {
    expect(agreementRatio(breakdown({ emaTrend: 20, priceStructure: 10, trendStrength: 5 }), 61)).toBe(1);
  });
});

describe('confidence as a product', () => {
  const base = {
    scoreBreakdown: breakdown(),
    score: 1,
    bias: 'neutral' as const,
    dataDegraded: false,
    earningsProximity: 'unknown' as const,
  };

  /*
   * The reported failure: completeness 100%, regime clarity 2%, confidence 64%.
   * Additively the completeness term alone was worth 30 points and nothing could
   * take them back.
   */
  it('does not let complete data pay for an unreadable regime', () => {
    const murky = calculateGatedConfidence({ ...base, regimeClarity: 0.02 });
    const clear = calculateGatedConfidence({ ...base, regimeClarity: 1 });
    expect(murky.breakdown.completeness).toBe(100);
    expect(murky.confidence).toBeLessThan(40);
    expect(murky.confidence).toBeLessThan(clear.confidence);
  });

  it('discounts data the provider did not actually serve fresh', () => {
    const fresh = calculateGatedConfidence({ ...base, regimeClarity: 0.6 });
    const stale = calculateGatedConfidence({ ...base, regimeClarity: 0.6, dataDegraded: true });
    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(stale.breakdown.completeness).toBeLessThan(fresh.breakdown.completeness);
  });

  it('applies each earnings discount as its own factor', () => {
    const clear = calculateGatedConfidence({ ...base, regimeClarity: 0.6, earningsProximity: 'clear' });
    const soon = calculateGatedConfidence({ ...base, regimeClarity: 0.6, earningsProximity: 'soon' });
    const imminent = calculateGatedConfidence({ ...base, regimeClarity: 0.6, earningsProximity: 'imminent' });
    expect(soon.factors.earnings).toBe(MARKET_SIGNAL_GATE.earnings.soonFactor);
    expect(imminent.factors.earnings).toBe(MARKET_SIGNAL_GATE.earnings.imminentFactor);
    expect(imminent.confidence).toBeLessThan(soon.confidence);
    expect(soon.confidence).toBeLessThan(clear.confidence);
  });

  it('reports the multipliers it actually used', () => {
    const result = calculateGatedConfidence({ ...base, regimeClarity: 0.5 });
    const { base: baseFactor, completeness, agreement, regimeClarity, conflict, earnings } = result.factors;
    const product = baseFactor * completeness * agreement * regimeClarity * conflict * earnings;
    expect(Math.abs(product - result.confidence)).toBeLessThan(1);
  });
});

describe('earnings proximity', () => {
  it('classifies by the configured windows and skips silently without a date', () => {
    expect(earningsProximityFrom(null)).toBe('unknown');
    expect(earningsProximityFrom(undefined)).toBe('unknown');
    expect(earningsProximityFrom(0)).toBe('imminent');
    expect(earningsProximityFrom(MARKET_SIGNAL_GATE.earnings.imminentDays)).toBe('imminent');
    expect(earningsProximityFrom(MARKET_SIGNAL_GATE.earnings.imminentDays + 1)).toBe('soon');
    expect(earningsProximityFrom(MARKET_SIGNAL_GATE.earnings.soonDays)).toBe('soon');
    expect(earningsProximityFrom(MARKET_SIGNAL_GATE.earnings.soonDays + 1)).toBe('clear');
  });

  it('flags the window and discounts confidence on a real capture', () => {
    const clear = runIren({ gate: true }, { daysToNextReport: 60 });
    const soon = runIren({ gate: true }, { daysToNextReport: 10 });
    const imminent = runIren({ gate: true }, { daysToNextReport: 2 });

    expect(clear.flags).not.toContain('earnings_soon');
    expect(soon.flags).toContain('earnings_soon');
    expect(imminent.flags).toContain('earnings_imminent');
    expect(imminent.confidence).toBeLessThan(soon.confidence);
    expect(soon.confidence).toBeLessThan(clear.confidence);
  });

  it('leaves confidence untouched when the calendar cannot answer', () => {
    const unknown = runIren({ gate: true }, { daysToNextReport: null });
    const clear = runIren({ gate: true }, { daysToNextReport: 60 });
    expect(unknown.gate?.earningsProximity).toBe('unknown');
    expect(unknown.confidence).toBe(clear.confidence);
    expect(unknown.flags).not.toContain('earnings_soon');
    expect(unknown.flags).not.toContain('earnings_imminent');
  });
});

describe('volume that is not confirming anything', () => {
  it('caps a supportive score on a below-average day', () => {
    const capped = capLowVolumeComponent(component(8, 15), 0.84);
    expect(capped.capped).toBe(true);
    expect(capped.component.points).toBe(MARKET_SIGNAL_GATE.volume.belowAverageMaximumPoints);
    expect(capped.component.normalizedScore).toBeCloseTo(3 / 15, 5);
  });

  it('leaves a busy day and a falling day alone', () => {
    expect(capLowVolumeComponent(component(8, 15), 1.4).capped).toBe(false);
    expect(capLowVolumeComponent(component(-12, 15), 0.5).capped).toBe(false);
    expect(capLowVolumeComponent(component(8, 15), null).capped).toBe(false);
  });
});

describe('divergence weighting', () => {
  it('scores a divergence by the end of the range it belongs to', () => {
    // The reported case: a bullish divergence raised at full strength on RSI 54.86.
    expect(divergenceWeight('bullish', 54.86)).toBe(0);
    expect(divergenceWeight('bullish', 25)).toBe(1);
    expect(divergenceWeight('bearish', 54.86)).toBeLessThan(MARKET_SIGNAL_GATE.divergence.minimumFlagWeight);
    expect(divergenceWeight('bearish', 75)).toBe(1);
    expect(divergenceWeight('bullish', null)).toBe(0);
  });
});

describe('provider health', () => {
  it('names the freshness states that are not today\'s data', () => {
    ['stale', 'cached', 'unknown', 'unavailable'].forEach((status) => expect(isDegradedFreshness(status)).toBe(true));
    ['realtime', 'delayed', 'end-of-day'].forEach((status) => expect(isDegradedFreshness(status)).toBe(false));
  });

  it('flags degraded data on the result', () => {
    const stale = calculateMarketSignal(irenCandles.candles, {
      symbol: 'IREN',
      source: irenCandles.source,
      freshness: { ...irenCandles.freshness, status: 'stale' },
      calculatedAt: '2026-01-01T00:00:00.000Z',
      features: { gate: true },
    });
    expect(stale.flags).toContain('stale_or_partial_data');
    expect(stale.confidence).toBeLessThan(runIren({ gate: true }).confidence);
  });
});

describe('the reported IREN card, with the gate on', () => {
  const gated = runIren({ gate: true });

  it('stops calling a score of eleven a bullish trend', () => {
    expect(gated.score).toBeLessThan(MARKET_SIGNAL_GATE.bands.neutral);
    expect(gated.gate?.band).toBe('neutral');
    expect(gated.bias).toBe('neutral');
    expect(gated.state).toBe('SIDEWAYS');
  });

  it('names the conflict that voided the direction', () => {
    expect(gated.gate?.conflicts).toContain('ema_vs_momentum');
    expect(gated.flags).toContain('conflicting_evidence');
  });

  it('caps the volume component that was claiming support at 0.84x', () => {
    expect(gated.metrics.relativeVolume20).toBeLessThan(1);
    expect(gated.scoreBreakdown.volume.points).toBe(MARKET_SIGNAL_GATE.volume.belowAverageMaximumPoints);
    expect(gated.flags).toContain('low_volume_confirmation');
  });

  it('drops the mid-zone divergence chip but keeps the written caution', () => {
    expect(gated.metrics.divergence).toBe('bullish');
    expect(gated.metrics.rsi14).toBeGreaterThan(50);
    expect(gated.flags).not.toContain('bullish_divergence');
    expect(gated.reasons.some((reason) => reason.id === 'bullish-divergence' && reason.polarity === 'caution')).toBe(true);
  });

  it('reports a confidence that matches how little the evidence agrees', () => {
    expect(gated.confidence).toBeLessThan(runIren().confidence);
    expect(gated.confidenceLabel).toBe('Low');
    expect(gated.confidenceBreakdown.agreement).toBeLessThan(60);
  });

  it('never says the same thing in two categories', () => {
    expect(duplicatedReasonTags(gated.reasons)).toEqual([]);
  });
});

describe('the flag is the rollout contract', () => {
  const symbols = ['IREN', 'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD'];

  it.each(symbols)('%s is untouched with the gate off', (symbol) => {
    const frozen = capture(symbol);
    const context = {
      symbol,
      source: frozen.source,
      freshness: frozen.freshness,
      calculatedAt: '2026-01-01T00:00:00.000Z',
    };
    const golden = JSON.parse(
      readFileSync(join(process.cwd(), '__golden__', 'signal', `${symbol}.json`), 'utf8'),
    ) as Record<string, unknown>;

    // Both the absent-features call and an explicitly-off one, because a caller
    // that passes `{ gate: false }` must be as unaffected as one that passes
    // nothing at all.
    const implicit = calculateMarketSignal(frozen.candles, context);
    const explicit = calculateMarketSignal(frozen.candles, { ...context, features: { gate: false } });

    expect(JSON.parse(JSON.stringify(implicit))).toEqual(golden);
    expect(JSON.parse(JSON.stringify(explicit))).toEqual(golden);
    expect('gate' in implicit).toBe(false);
    expect('gate' in explicit).toBe(false);
  });

  it('emits no P1 flag and no gate block while the gate is off', () => {
    const off = runIren();
    const p1Flags = ['conflicting_evidence', 'low_volume_confirmation', 'stale_or_partial_data', 'earnings_imminent', 'earnings_soon', 'pre_earnings_breakout'];
    expect(off.flags.filter((flag) => p1Flags.includes(flag))).toEqual([]);
    expect(off.gate).toBeUndefined();
  });

  it('ignores an earnings date entirely while the gate is off', () => {
    expect(runIren(undefined, { daysToNextReport: 1 })).toEqual(runIren());
  });
});
