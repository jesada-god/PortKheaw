import { describe, expect, it } from 'vitest';
import type { DataFreshness } from '@/src/lib/market-data/types';
import {
  aggregateDirectionalScore,
  biasFromScore,
  calculateMarketSignal,
  calculateSignalConfidence,
  classifyRegimeEvidence,
  detectConfirmedDivergence,
  breakoutDirection,
  confidenceLabelFromValue,
  hasSufficientScoreCoverage,
  hasVolumeConfirmation,
  isSqueezeOn,
  isHighVolume,
  normalizedSlopeScore,
  presentationState,
  relativeVolumeStrength,
} from './calculations';
import { MARKET_SIGNAL_SCORE_WEIGHTS, MARKET_SIGNAL_THRESHOLDS, MARKET_SIGNAL_TOTAL_WEIGHT } from './config';
import type { MarketSignalCandle, MarketSignalMetrics, MarketSignalScoreBreakdown, MarketSignalScoreComponent } from './types';

const freshness: DataFreshness = {
  status: 'end-of-day',
  asOf: '2026-07-24T20:00:00.000Z',
  maxAgeSeconds: 21_600,
};
const context = {
  symbol: 'TEST',
  source: 'canonical-fixture',
  freshness,
  calculatedAt: '2026-07-25T00:00:00.000Z',
};

function candles(
  length: number,
  closeAt: (index: number) => number,
  volumeAt: (index: number) => number | null = () => 1_000,
  range = 1.6,
): MarketSignalCandle[] {
  return Array.from({ length }, (_, index) => {
    const close = closeAt(index);
    return {
      date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
      open: close - 0.2,
      high: close + range / 2,
      low: close - range / 2,
      close,
      volume: volumeAt(index),
      finalized: true,
    };
  });
}

const blankMetrics = (): MarketSignalMetrics => ({
  close: null,
  ema20: null,
  ema50: null,
  ema200: null,
  ema20SlopePct: null,
  ema50SlopePct: null,
  ema200SlopePct: null,
  emaCompressionRatio: null,
  rsi14: null,
  macd: null,
  macdSignal: null,
  macdHistogram: null,
  adx14: null,
  plusDi14: null,
  minusDi14: null,
  relativeVolume20: null,
  obvTrend: null,
  bollingerUpper: null,
  bollingerMiddle: null,
  bollingerLower: null,
  keltnerUpper: null,
  keltnerMiddle: null,
  keltnerLower: null,
  squeezeOn: false,
  atr14: null,
  ema20DeviationPct: null,
  atrNormalizedDistance: null,
  nearestSupport: null,
  nearestResistance: null,
  divergence: null,
});

function scoreComponent(points: number | null, maxPoints: 30 | 25 | 15, coverage = 1): MarketSignalScoreComponent {
  return {
    points,
    maxPoints,
    normalizedScore: points === null ? null : points / maxPoints,
    coverage,
    factorsUsed: points === null ? 0 : 1,
    available: points !== null,
  };
}

function breakdown(values: Partial<Record<keyof typeof MARKET_SIGNAL_SCORE_WEIGHTS, number | null>> = {}): MarketSignalScoreBreakdown {
  return {
    emaTrend: scoreComponent(values.emaTrend ?? 0, 30),
    momentum: scoreComponent(values.momentum ?? 0, 25),
    trendStrength: scoreComponent(values.trendStrength ?? 0, 15),
    volume: scoreComponent(values.volume ?? 0, 15),
    priceStructure: scoreComponent(values.priceStructure ?? 0, 15),
  };
}

describe('directional score contract', () => {
  it('keeps the five independent weights at an absolute total of 100', () => {
    expect(MARKET_SIGNAL_SCORE_WEIGHTS).toEqual({ emaTrend: 30, momentum: 25, trendStrength: 15, volume: 15, priceStructure: 15 });
    expect(MARKET_SIGNAL_TOTAL_WEIGHT).toBe(100);
  });

  it('clamps exact category sums to +100 and -100 and preserves zero/mixed evidence', () => {
    expect(aggregateDirectionalScore(breakdown({ emaTrend: 30, momentum: 25, trendStrength: 15, volume: 15, priceStructure: 15 }))).toBe(100);
    expect(aggregateDirectionalScore(breakdown({ emaTrend: -30, momentum: -25, trendStrength: -15, volume: -15, priceStructure: -15 }))).toBe(-100);
    expect(aggregateDirectionalScore(breakdown({ emaTrend: 20, momentum: -20, trendStrength: 0, volume: 0, priceStructure: 0 }))).toBe(0);
  });

  it('does not re-normalize a missing category or double count it in the sum', () => {
    const missingVolume = breakdown({ emaTrend: 30, momentum: 25, trendStrength: 15, priceStructure: 15 });
    missingVolume.volume = scoreComponent(null, 15, 0);
    expect(aggregateDirectionalScore(missingVolume)).toBe(85);
    expect(Object.values(missingVolume).reduce((sum, item) => sum + (item.points ?? 0), 0)).toBe(85);
  });

  it.each([
    [19, 'neutral'], [20, 'bullish'], [21, 'bullish'],
    [-19, 'neutral'], [-20, 'bearish'], [-21, 'bearish'],
    [59, 'bullish'], [60, 'bullish'], [61, 'bullish'],
    [-59, 'bearish'], [-60, 'bearish'], [-61, 'bearish'],
  ] as const)('applies directional threshold boundaries at score %s', (score, expected) => {
    expect(biasFromScore(score)).toBe(expected);
  });

  it('applies strong-state and ADX confirmation boundaries without using score alone', () => {
    const alignedBullish = breakdown({ emaTrend: 20, momentum: 15, trendStrength: 10, volume: 8, priceStructure: 7 });
    const alignedBearish = breakdown({ emaTrend: -20, momentum: -15, trendStrength: -10, volume: -8, priceStructure: -7 });
    const regime = { squeeze: false, overextended: false, sideways: false, overextensionDirection: 0 as const, sidewaysTrue: 0, sidewaysAvailable: 5, overextensionEvidence: 0 };
    const adxThreshold = MARKET_SIGNAL_THRESHOLDS.trendStrength.adxTrendMinimum;
    const highVolume = MARKET_SIGNAL_THRESHOLDS.volume.relativeVolumeHigh;
    expect(presentationState(59, 'bullish', regime, alignedBullish, adxThreshold, highVolume)).toBe('BULLISH');
    expect(presentationState(60, 'bullish', regime, alignedBullish, adxThreshold - 0.01, highVolume)).toBe('BULLISH');
    expect(presentationState(60, 'bullish', regime, alignedBullish, adxThreshold, highVolume - 0.01)).toBe('BULLISH');
    expect(presentationState(60, 'bullish', regime, alignedBullish, adxThreshold, highVolume)).toBe('STRONG_BULLISH');
    expect(presentationState(61, 'bullish', regime, alignedBullish, adxThreshold + 0.01, highVolume + 0.01)).toBe('STRONG_BULLISH');
    expect(presentationState(-59, 'bearish', regime, alignedBearish, adxThreshold, highVolume)).toBe('BEARISH');
    expect(presentationState(-60, 'bearish', regime, alignedBearish, adxThreshold, highVolume)).toBe('STRONG_BEARISH');
    expect(presentationState(-61, 'bearish', regime, alignedBearish, adxThreshold + 0.01, highVolume + 0.01)).toBe('STRONG_BEARISH');
  });

  it('tests slope, volume, coverage, breakout, and confidence-label boundaries', () => {
    const t = MARKET_SIGNAL_THRESHOLDS;
    expect(normalizedSlopeScore(t.ema.strongSlopeRatio - 0.0001)).toBeLessThan(1);
    expect(normalizedSlopeScore(t.ema.strongSlopeRatio)).toBe(1);
    expect(normalizedSlopeScore(t.ema.strongSlopeRatio + 0.0001)).toBe(1);

    expect(relativeVolumeStrength(t.volume.relativeVolumeBaseline - 0.01)).toBe(0);
    expect(relativeVolumeStrength(t.volume.relativeVolumeBaseline)).toBe(0);
    expect(relativeVolumeStrength(t.volume.relativeVolumeBaseline + 0.01)).toBeGreaterThan(0);
    expect(relativeVolumeStrength(t.volume.relativeVolumeHigh)).toBe(1);
    expect(hasVolumeConfirmation(t.volume.relativeVolumeConfirmation - 0.01)).toBe(false);
    expect(hasVolumeConfirmation(t.volume.relativeVolumeConfirmation)).toBe(true);
    expect(hasVolumeConfirmation(t.volume.relativeVolumeConfirmation + 0.01)).toBe(true);
    expect(isHighVolume(t.volume.relativeVolumeHigh - 0.01)).toBe(false);
    expect(isHighVolume(t.volume.relativeVolumeHigh)).toBe(true);
    expect(isHighVolume(t.volume.relativeVolumeHigh + 0.01)).toBe(true);

    expect(hasSufficientScoreCoverage(t.minimumAvailableWeight - 1)).toBe(false);
    expect(hasSufficientScoreCoverage(t.minimumAvailableWeight)).toBe(true);
    expect(hasSufficientScoreCoverage(t.minimumAvailableWeight + 1)).toBe(true);

    const resistance = 100;
    const bullishBoundary = resistance * (1 + t.structure.breakoutBufferRatio);
    expect(breakoutDirection(99, bullishBoundary - 0.0001, null, resistance)).toBe(0);
    expect(breakoutDirection(99, bullishBoundary, null, resistance)).toBe(1);
    expect(breakoutDirection(99, bullishBoundary + 0.0001, null, resistance)).toBe(1);
    const support = 100;
    const bearishBoundary = support * (1 - t.structure.breakoutBufferRatio);
    expect(breakoutDirection(101, bearishBoundary + 0.0001, support, null)).toBe(0);
    expect(breakoutDirection(101, bearishBoundary, support, null)).toBe(-1);
    expect(breakoutDirection(101, bearishBoundary - 0.0001, support, null)).toBe(-1);

    expect(confidenceLabelFromValue(t.confidence.mediumMinimum - 1)).toBe('Low');
    expect(confidenceLabelFromValue(t.confidence.mediumMinimum)).toBe('Medium');
    expect(confidenceLabelFromValue(t.confidence.mediumMinimum + 1)).toBe('Medium');
    expect(confidenceLabelFromValue(t.confidence.highMinimum - 1)).toBe('Medium');
    expect(confidenceLabelFromValue(t.confidence.highMinimum)).toBe('High');
    expect(confidenceLabelFromValue(t.confidence.highMinimum + 1)).toBe('High');
  });
});

describe('regime threshold boundaries', () => {
  it('requires BB to be fully inside or equal to KC for squeeze-on', () => {
    expect(isSqueezeOn({ upper: 109.99, lower: 90.01 }, { upper: 110, lower: 90 })).toBe(true);
    expect(isSqueezeOn({ upper: 110, lower: 90 }, { upper: 110, lower: 90 })).toBe(true);
    expect(isSqueezeOn({ upper: 110.01, lower: 90 }, { upper: 110, lower: 90 })).toBe(false);
    expect(isSqueezeOn(null, { upper: 110, lower: 90 })).toBeNull();
  });

  it('uses at least two same-side normalized overextension signals at below/equal/above boundaries', () => {
    const t = MARKET_SIGNAL_THRESHOLDS;
    const below = classifyRegimeEvidence({ ...blankMetrics(), ema20DeviationPct: t.overextended.ema20DeviationPct - 0.01, rsi14: t.momentum.rsiBullishExtreme - 0.01, atrNormalizedDistance: 0 });
    const equal = classifyRegimeEvidence({ ...blankMetrics(), ema20DeviationPct: t.overextended.ema20DeviationPct, rsi14: t.momentum.rsiBullishExtreme, atrNormalizedDistance: 0 });
    const above = classifyRegimeEvidence({ ...blankMetrics(), ema20DeviationPct: t.overextended.ema20DeviationPct + 0.01, rsi14: t.momentum.rsiBullishExtreme + 0.01, atrNormalizedDistance: 0 });
    expect([below.overextended, equal.overextended, above.overextended]).toEqual([false, true, true]);
    expect(equal.overextensionDirection).toBe(1);

    const bearishEqual = classifyRegimeEvidence({ ...blankMetrics(), ema20DeviationPct: -t.overextended.ema20DeviationPct, rsi14: t.momentum.rsiBearishExtreme, atrNormalizedDistance: 0 });
    expect(bearishEqual).toMatchObject({ overextended: true, overextensionDirection: -1 });
  });

  it('applies the ATR-normalized overextension boundary and rejects one-signal extremes', () => {
    const t = MARKET_SIGNAL_THRESHOLDS;
    const oneSignal = classifyRegimeEvidence({ ...blankMetrics(), atrNormalizedDistance: t.overextended.atrDistance, rsi14: 50, ema20DeviationPct: 0 });
    const below = classifyRegimeEvidence({ ...blankMetrics(), atrNormalizedDistance: t.overextended.atrDistance - 0.01, rsi14: t.momentum.rsiBullishExtreme, ema20DeviationPct: 0 });
    const equal = classifyRegimeEvidence({ ...blankMetrics(), atrNormalizedDistance: t.overextended.atrDistance, rsi14: t.momentum.rsiBullishExtreme, ema20DeviationPct: 0 });
    const above = classifyRegimeEvidence({ ...blankMetrics(), atrNormalizedDistance: t.overextended.atrDistance + 0.01, rsi14: t.momentum.rsiBullishExtreme, ema20DeviationPct: 0 });
    expect([oneSignal.overextended, below.overextended, equal.overextended, above.overextended]).toEqual([false, false, true, true]);
  });

  it.each([
    ['EMA compression', 'emaCompressionRatio', MARKET_SIGNAL_THRESHOLDS.ema.sidewaysCompressionRatio],
    ['ADX', 'adx14', MARKET_SIGNAL_THRESHOLDS.trendStrength.adxSidewaysMaximum],
    ['MACD histogram / ATR', 'macdHistogram', MARKET_SIGNAL_THRESHOLDS.momentum.histogramFlatAtrRatio],
  ] as const)('applies below/equal/above inclusive sideways boundary for %s', (_name, field, threshold) => {
    const common: MarketSignalMetrics = {
      ...blankMetrics(),
      emaCompressionRatio: 0.01,
      ema20SlopePct: 0,
      ema50SlopePct: 0,
      adx14: 10,
      rsi14: 60,
      macdHistogram: 1,
      atr14: 1,
    };
    if (field === 'emaCompressionRatio') {
      common.ema20SlopePct = 1;
      common.ema50SlopePct = 1;
      common.rsi14 = 50;
      common.macdHistogram = 0;
    } else if (field === 'adx14') {
      common.ema20SlopePct = 1;
      common.ema50SlopePct = 1;
      common.rsi14 = 50;
      common.macdHistogram = 0;
    }
    const below = classifyRegimeEvidence({ ...common, [field]: threshold - 0.0001 });
    const equal = classifyRegimeEvidence({ ...common, [field]: threshold });
    const above = classifyRegimeEvidence({ ...common, [field]: threshold + 0.0001 });
    expect([below.sideways, equal.sideways, above.sideways]).toEqual([true, true, false]);
  });

  it('uses inclusive 45..55 RSI boundaries and the configured EMA-slope boundary', () => {
    const t = MARKET_SIGNAL_THRESHOLDS;
    const common = { ...blankMetrics(), emaCompressionRatio: 0.01, ema20SlopePct: 0, ema50SlopePct: 0, adx14: 10, macdHistogram: 1, atr14: 1 };
    expect(classifyRegimeEvidence({ ...common, rsi14: t.momentum.rsiSidewaysMinimum - 0.01 }).sideways).toBe(false);
    expect(classifyRegimeEvidence({ ...common, rsi14: t.momentum.rsiSidewaysMinimum }).sideways).toBe(true);
    expect(classifyRegimeEvidence({ ...common, rsi14: t.momentum.rsiSidewaysMaximum }).sideways).toBe(true);
    expect(classifyRegimeEvidence({ ...common, rsi14: t.momentum.rsiSidewaysMaximum + 0.01 }).sideways).toBe(false);

    const slopeCommon = { ...blankMetrics(), emaCompressionRatio: 0.01, adx14: 10, rsi14: 50, macdHistogram: 1, atr14: 1 };
    const boundaryPct = t.ema.sidewaysSlopeRatio * 100;
    expect(classifyRegimeEvidence({ ...slopeCommon, ema20SlopePct: boundaryPct - 0.001, ema50SlopePct: 0 }).sideways).toBe(true);
    expect(classifyRegimeEvidence({ ...slopeCommon, ema20SlopePct: boundaryPct, ema50SlopePct: 0 }).sideways).toBe(true);
    expect(classifyRegimeEvidence({ ...slopeCommon, ema20SlopePct: boundaryPct + 0.001, ema50SlopePct: 0 }).sideways).toBe(false);
  });
});

describe('confidence contract', () => {
  it('changes with evidence completeness/agreement and is not abs(score)', () => {
    const aligned = breakdown({ emaTrend: 24, momentum: 20, trendStrength: 10, volume: 10, priceStructure: 9 });
    const conflicting = breakdown({ emaTrend: 24, momentum: -20, trendStrength: 10, volume: -10, priceStructure: 9 });
    const complete = calculateSignalConfidence(aligned, 'bullish', 0.8);
    const conflict = calculateSignalConfidence(conflicting, 'bullish', 0.8);
    const missing = breakdown({ emaTrend: 24, momentum: 20, trendStrength: 10, volume: 10, priceStructure: 9 });
    missing.volume = scoreComponent(null, 15, 0);
    const incomplete = calculateSignalConfidence(missing, 'bullish', 0.8);
    expect(conflict.confidence).toBeLessThan(complete.confidence);
    expect(incomplete.confidence).toBeLessThan(complete.confidence);
    expect(complete.confidence).not.toBe(Math.abs(aggregateDirectionalScore(aligned)));
    expect(complete.breakdown).toMatchObject({ completeness: 100 });
    expect(conflict.breakdown.conflictPenalty).toBeGreaterThan(complete.breakdown.conflictPenalty);
  });
});

describe('causal confirmed-pivot divergence', () => {
  it('does not emit divergence until the second historical pivot is causally confirmed', () => {
    const input = candles(22, () => 100).map((candle, index) => index === 5
      ? { ...candle, low: 90, close: 92, open: 93 }
      : index === 15 ? { ...candle, low: 85, close: 88, open: 89 } : candle);
    const rsi = input.map((candle, index) => ({ date: candle.date, value: index === 5 ? 30 : index === 15 ? 36 : 50 }));
    const withoutConfirmation = detectConfirmedDivergence(input.slice(0, 18), rsi.slice(0, 18), [], 2);
    const confirmed = detectConfirmedDivergence(input.slice(0, 19), rsi.slice(0, 19), [], 2);
    expect(withoutConfirmation).toBeNull();
    expect(confirmed).toBe('bullish');
  });
});

describe('calculateMarketSignal integration', () => {
  it('classifies strong bullish, bullish, bearish, and strong bearish evidence with signed breakdowns', () => {
    const strongBullish = calculateMarketSignal(candles(260, (index) => 80 + index * 0.08, (index) => index === 259 ? 1_600 : 1_000, 0.4), context);
    const bullish = calculateMarketSignal(candles(260, (index) => 100 + index * 0.08 + Math.sin(index * 0.45) * 4, () => 1_000, 0.4), context);
    const bearish = calculateMarketSignal(candles(260, (index) => 140 - index * 0.08 + Math.sin(index * 0.45) * 4, () => 1_000, 0.4), context);
    const strongBearish = calculateMarketSignal(candles(260, (index) => 160 - index * 0.08, (index) => index === 259 ? 1_600 : 1_000, 0.4), context);
    for (const result of [strongBullish, bullish, bearish, strongBearish]) expect(result.status).toBe('available');
    if (strongBullish.status !== 'available' || bullish.status !== 'available' || bearish.status !== 'available' || strongBearish.status !== 'available') return;
    expect(strongBullish.bias).toBe('bullish');
    expect(strongBullish.state).toBe('STRONG_BULLISH');
    expect(strongBullish.score).toBeGreaterThanOrEqual(MARKET_SIGNAL_THRESHOLDS.directional.strongBullish);
    expect(bullish.bias).toBe('bullish');
    expect(['BULLISH', 'STRONG_BULLISH']).toContain(bullish.state);
    expect(bearish.bias).toBe('bearish');
    expect(['BEARISH', 'STRONG_BEARISH']).toContain(bearish.state);
    expect(strongBearish.bias).toBe('bearish');
    expect(strongBearish.state).toBe('STRONG_BEARISH');
    expect(strongBearish.score).toBeLessThanOrEqual(MARKET_SIGNAL_THRESHOLDS.directional.strongBearish);
    expect(aggregateDirectionalScore(strongBullish.scoreBreakdown)).toBe(strongBullish.score);
    expect(aggregateDirectionalScore(strongBearish.scoreBreakdown)).toBe(strongBearish.score);
  });

  it('keeps squeeze state independent from bullish, bearish, and neutral bias', () => {
    const bullish = calculateMarketSignal(candles(260, (index) => 100 + index * 0.01, () => 1_000, 2), context);
    const bearish = calculateMarketSignal(candles(260, (index) => 105 - index * 0.01, () => 1_000, 2), context);
    const neutral = calculateMarketSignal(candles(260, () => 100, () => 1_000, 2), context);
    for (const result of [bullish, bearish, neutral]) {
      expect(result.status).toBe('available');
      if (result.status === 'available') expect(result.state).toBe('SQUEEZE');
    }
    if (bullish.status === 'available') expect(['bullish', 'neutral']).toContain(bullish.bias);
    if (bearish.status === 'available') expect(['bearish', 'neutral']).toContain(bearish.bias);
    if (neutral.status === 'available') expect(neutral.bias).toBe('neutral');
  });

  it('classifies a multi-factor non-trending fixture as SIDEWAYS', () => {
    const result = calculateMarketSignal(candles(260, (index) => 100 + Math.sin(index * 0.55) * 3, () => 1_000, 1), context);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.state).toBe('SIDEWAYS');
    expect(result.bias).toBe('neutral');
  });

  it('preserves directional bias and score when bullish or bearish price is overextended', () => {
    const bullishInput = candles(260, (index) => index < 240 ? 100 + index * 0.02 : 104.8 + (index - 240) * 1.2, () => 1_000, 2);
    const bearishInput = candles(260, (index) => index < 240 ? 140 - index * 0.02 : 135.2 - (index - 240) * 1.2, () => 1_000, 2);
    const bullish = calculateMarketSignal(bullishInput, context);
    const bearish = calculateMarketSignal(bearishInput, context);
    expect(bullish.status).toBe('available');
    expect(bearish.status).toBe('available');
    if (bullish.status !== 'available' || bearish.status !== 'available') return;
    expect(bullish).toMatchObject({ state: 'OVEREXTENDED', bias: 'bullish' });
    expect(bullish.score).toBeGreaterThan(0);
    expect(bullish.flags).toContain('overextended');
    expect(bearish).toMatchObject({ state: 'OVEREXTENDED', bias: 'bearish' });
    expect(bearish.score).toBeLessThan(0);
    expect(bearish.flags).toContain('overextended');
  });

  it('uses finalized candles only, resets the symbol in the result, and is deterministic', () => {
    const finalized = candles(260, (index) => 80 + index * 0.08, () => 1_000, 4);
    const baseline = calculateMarketSignal(finalized, context);
    const withPartialCrash = calculateMarketSignal([...finalized, { ...finalized.at(-1)!, date: '2026-07-26', close: 2, low: 1, high: 11, volume: 9_000_000, finalized: false }], { ...context, symbol: 'NEXT' });
    expect(calculateMarketSignal(finalized, context)).toEqual(baseline);
    expect(withPartialCrash.symbol).toBe('NEXT');
    expect(withPartialCrash.score).toBe(baseline.score);
    expect(withPartialCrash.metrics).toEqual(baseline.metrics);
    expect(withPartialCrash.latestCandleAt).toBe(baseline.latestCandleAt);
    expect(withPartialCrash.dataPoints).toEqual({ received: 261, finalized: 260 });
  });

  it('degrades safely for insufficient history and missing EMA200/volume without NaN or fabricated metrics', () => {
    const minimum = MARKET_SIGNAL_THRESHOLDS.minimumSignalCandles;
    const insufficient = calculateMarketSignal(candles(minimum - 1, (index) => 100 + index), context);
    expect(insufficient).toMatchObject({ status: 'insufficient-data', state: null, bias: null, score: null, confidence: 0 });
    expect(calculateMarketSignal(candles(minimum, (index) => 100 + index * 0.05), context).status).toBe('available');
    expect(calculateMarketSignal(candles(minimum + 1, (index) => 100 + index * 0.05), context).status).toBe('available');
    const partial = calculateMarketSignal(candles(80, (index) => 80 + index * 0.05, () => null, 3), context);
    expect(partial.status).toBe('available');
    if (partial.status !== 'available') return;
    expect(partial.metrics.ema200).toBeNull();
    expect(partial.metrics.relativeVolume20).toBeNull();
    expect(partial.scoreBreakdown.volume.points).toBeNull();
    expect(partial.warnings.join(' ')).toContain('EMA200');
    expect(partial.warnings.join(' ')).toContain('Relative Volume');
    expect(JSON.stringify(partial)).not.toMatch(/NaN|Infinity/);
  });
});
