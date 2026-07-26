import { calculateSupportResistance, confirmedSwingPivots } from '@/src/lib/analytics/support-resistance/calculations';
import { calculateTechnicalAnalysis } from '@/src/lib/analytics/technical/calculations';
import type { AdxPoint, BollingerPoint, IndicatorPoint, KeltnerPoint, MacdPoint } from '@/src/lib/analytics/technical/types';
import {
  MARKET_SIGNAL_EXPECTED_FACTORS,
  MARKET_SIGNAL_SCORE_WEIGHTS,
  MARKET_SIGNAL_THRESHOLDS,
} from './config';
import type {
  MarketSignalBias,
  MarketSignalCandle,
  MarketSignalComponentId,
  MarketSignalConfidenceBreakdown,
  MarketSignalContext,
  MarketSignalFlag,
  MarketSignalMetrics,
  MarketSignalReason,
  MarketSignalResult,
  MarketSignalScoreBreakdown,
  MarketSignalScoreComponent,
  MarketSignalState,
} from './types';

interface Factor {
  id: string;
  score: number;
  text: string;
}

export interface RegimeEvidence {
  squeeze: boolean;
  overextended: boolean;
  sideways: boolean;
  overextensionDirection: 1 | -1 | 0;
  sidewaysTrue: number;
  sidewaysAvailable: number;
  overextensionEvidence: number;
}

export function isSqueezeOn(
  bollinger: Pick<BollingerPoint, 'upper' | 'lower'> | null,
  keltner: Pick<KeltnerPoint, 'upper' | 'lower'> | null,
): boolean | null {
  return bollinger && keltner
    ? bollinger.upper <= keltner.upper && bollinger.lower >= keltner.lower
    : null;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const finiteOrNull = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? null : value;

export function normalizedSlopeScore(value: number): number {
  return clamp(value / MARKET_SIGNAL_THRESHOLDS.ema.strongSlopeRatio, -1, 1);
}

export function relativeVolumeStrength(relativeVolume: number): number {
  return clamp((relativeVolume - MARKET_SIGNAL_THRESHOLDS.volume.relativeVolumeBaseline)
    / (MARKET_SIGNAL_THRESHOLDS.volume.relativeVolumeHigh - MARKET_SIGNAL_THRESHOLDS.volume.relativeVolumeBaseline), 0, 1);
}

export const hasVolumeConfirmation = (relativeVolume: number | null) => relativeVolume !== null
  && relativeVolume >= MARKET_SIGNAL_THRESHOLDS.volume.relativeVolumeConfirmation;

export const isHighVolume = (relativeVolume: number | null) => relativeVolume !== null
  && relativeVolume >= MARKET_SIGNAL_THRESHOLDS.volume.relativeVolumeHigh;

export const hasSufficientScoreCoverage = (availableWeight: number) => availableWeight
  >= MARKET_SIGNAL_THRESHOLDS.minimumAvailableWeight;

export function breakoutDirection(
  previousClose: number,
  close: number,
  support: number | null,
  resistance: number | null,
): -1 | 0 | 1 {
  const buffer = MARKET_SIGNAL_THRESHOLDS.structure.breakoutBufferRatio;
  if (resistance !== null && previousClose <= resistance && close >= resistance * (1 + buffer)) return 1;
  if (support !== null && previousClose >= support && close <= support * (1 - buffer)) return -1;
  return 0;
}

export function confidenceLabelFromValue(confidence: number): 'Low' | 'Medium' | 'High' {
  return confidence >= MARKET_SIGNAL_THRESHOLDS.confidence.highMinimum
    ? 'High' : confidence >= MARKET_SIGNAL_THRESHOLDS.confidence.mediumMinimum ? 'Medium' : 'Low';
}

function latest<T extends IndicatorPoint>(result: { status: string; latest?: T }): T | null {
  return result.status === 'available' && result.latest ? result.latest : null;
}

function slopeRatio(points: readonly IndicatorPoint[], lookback: number): number | null {
  if (points.length <= lookback) return null;
  const current = points.at(-1)!.value;
  const previous = points.at(-(lookback + 1))!.value;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

function component(id: MarketSignalComponentId, factors: readonly Factor[]): MarketSignalScoreComponent {
  const maxPoints = MARKET_SIGNAL_SCORE_WEIGHTS[id];
  const normalizedScore = factors.length
    ? round(clamp(factors.reduce((sum, factor) => sum + factor.score, 0) / factors.length, -1, 1), 4)
    : null;
  return {
    points: normalizedScore === null ? null : round(normalizedScore * maxPoints, 0),
    maxPoints,
    normalizedScore,
    coverage: round(Math.min(1, factors.length / MARKET_SIGNAL_EXPECTED_FACTORS[id]), 4),
    factorsUsed: factors.length,
    available: normalizedScore !== null,
  };
}

function emptyScoreBreakdown(): MarketSignalScoreBreakdown {
  return {
    emaTrend: component('emaTrend', []),
    momentum: component('momentum', []),
    trendStrength: component('trendStrength', []),
    volume: component('volume', []),
    priceStructure: component('priceStructure', []),
  };
}

function emptyMetrics(): MarketSignalMetrics {
  return {
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
    squeezeOn: null,
    atr14: null,
    ema20DeviationPct: null,
    atrNormalizedDistance: null,
    nearestSupport: null,
    nearestResistance: null,
    divergence: null,
  };
}

const emptyConfidenceBreakdown = (): MarketSignalConfidenceBreakdown => ({
  completeness: 0,
  agreement: 0,
  evidenceStrength: 0,
  volumeConfirmation: 0,
  regimeClarity: 0,
  conflictPenalty: 0,
});

export function aggregateDirectionalScore(scoreBreakdown: MarketSignalScoreBreakdown): number {
  return round(clamp(
    Object.values(scoreBreakdown).reduce((sum, item) => sum + (item.points ?? 0), 0),
    -100,
    100,
  ), 0);
}

export function biasFromScore(score: number): MarketSignalBias {
  const threshold = MARKET_SIGNAL_THRESHOLDS.directional;
  if (score >= threshold.bullish) return 'bullish';
  if (score <= threshold.bearish) return 'bearish';
  return 'neutral';
}

function factorReasons(
  groups: ReadonlyArray<{ factors: readonly Factor[]; weight: number }>,
  supplemental: readonly MarketSignalReason[],
): MarketSignalReason[] {
  const directional = groups.flatMap(({ factors, weight }) => factors.map((factor): MarketSignalReason => ({
    id: factor.id,
    polarity: factor.score > 0 ? 'positive' : factor.score < 0 ? 'negative' : 'information',
    text: factor.text,
    impact: round(Math.abs(factor.score) * weight / Math.max(factors.length, 1), 2),
  }))).filter((reason) => reason.impact > 0);
  return [...directional, ...supplemental]
    .sort((left, right) => right.impact - left.impact || left.id.localeCompare(right.id))
    .slice(0, 12);
}

function indicatorMap(points: readonly IndicatorPoint[]): Map<string, number> {
  return new Map(points.map((point) => [point.date, point.value]));
}

export function detectConfirmedDivergence(
  candles: readonly Omit<MarketSignalCandle, 'finalized'>[],
  rsiPoints: readonly IndicatorPoint[],
  macdPoints: readonly MacdPoint[],
  atr: number | null,
): 'bullish' | 'bearish' | null {
  const thresholds = MARKET_SIGNAL_THRESHOLDS.divergence;
  const pivots = confirmedSwingPivots(candles, MARKET_SIGNAL_THRESHOLDS.structure.pivotWindow)
    .filter((pivot) => pivot.confirmedAtIndex < candles.length);
  const rsi = indicatorMap(rsiPoints);
  const macd = indicatorMap(macdPoints);
  const candidates: Array<{ direction: 'bullish' | 'bearish'; confirmedAtIndex: number }> = [];

  (['low', 'high'] as const).forEach((kind) => {
    const sameKind = pivots.filter((pivot) => pivot.kind === kind);
    for (let index = 1; index < sameKind.length; index += 1) {
      const previous = sameKind[index - 1];
      const current = sameKind[index];
      if (current.index - previous.index < thresholds.minimumPivotSeparation) continue;
      const previousDate = candles[previous.index].date;
      const currentDate = candles[current.index].date;
      const previousRsi = rsi.get(previousDate);
      const currentRsi = rsi.get(currentDate);
      const previousMacd = macd.get(previousDate);
      const currentMacd = macd.get(currentDate);
      const oscillatorBullish = (previousRsi !== undefined && currentRsi !== undefined
          && currentRsi - previousRsi >= thresholds.rsiMinimumDifference)
        || (atr !== null && atr > 0 && previousMacd !== undefined && currentMacd !== undefined
          && (currentMacd - previousMacd) / atr >= thresholds.macdAtrMinimumDifference);
      const oscillatorBearish = (previousRsi !== undefined && currentRsi !== undefined
          && previousRsi - currentRsi >= thresholds.rsiMinimumDifference)
        || (atr !== null && atr > 0 && previousMacd !== undefined && currentMacd !== undefined
          && (previousMacd - currentMacd) / atr >= thresholds.macdAtrMinimumDifference);
      if (kind === 'low' && current.price < previous.price && oscillatorBullish) {
        candidates.push({ direction: 'bullish', confirmedAtIndex: current.confirmedAtIndex });
      }
      if (kind === 'high' && current.price > previous.price && oscillatorBearish) {
        candidates.push({ direction: 'bearish', confirmedAtIndex: current.confirmedAtIndex });
      }
    }
  });
  return candidates.sort((left, right) => right.confirmedAtIndex - left.confirmedAtIndex)[0]?.direction ?? null;
}

export function classifyRegimeEvidence(metrics: MarketSignalMetrics): RegimeEvidence {
  const t = MARKET_SIGNAL_THRESHOLDS;
  const squeeze = metrics.squeezeOn === true;
  const upwardEvidence = [
    metrics.ema20DeviationPct !== null && metrics.ema20DeviationPct >= t.overextended.ema20DeviationPct,
    metrics.atrNormalizedDistance !== null && metrics.atrNormalizedDistance >= t.overextended.atrDistance,
    metrics.rsi14 !== null && metrics.rsi14 >= t.momentum.rsiBullishExtreme,
  ].filter(Boolean).length;
  const downwardEvidence = [
    metrics.ema20DeviationPct !== null && metrics.ema20DeviationPct <= -t.overextended.ema20DeviationPct,
    metrics.atrNormalizedDistance !== null && metrics.atrNormalizedDistance <= -t.overextended.atrDistance,
    metrics.rsi14 !== null && metrics.rsi14 <= t.momentum.rsiBearishExtreme,
  ].filter(Boolean).length;
  const overextensionDirection = upwardEvidence >= t.overextended.evidenceRequired
    ? 1 as const : downwardEvidence >= t.overextended.evidenceRequired ? -1 as const : 0 as const;
  const sidewaysEvidence: Array<boolean | null> = [
    metrics.emaCompressionRatio === null ? null : metrics.emaCompressionRatio <= t.ema.sidewaysCompressionRatio,
    [metrics.ema20SlopePct, metrics.ema50SlopePct].some((value) => value !== null)
      ? [metrics.ema20SlopePct, metrics.ema50SlopePct].every((value) => value === null || Math.abs(value / 100) <= t.ema.sidewaysSlopeRatio)
      : null,
    metrics.adx14 === null ? null : metrics.adx14 <= t.trendStrength.adxSidewaysMaximum,
    metrics.rsi14 === null ? null : metrics.rsi14 >= t.momentum.rsiSidewaysMinimum && metrics.rsi14 <= t.momentum.rsiSidewaysMaximum,
    metrics.macdHistogram === null || metrics.atr14 === null || metrics.atr14 === 0
      ? null : Math.abs(metrics.macdHistogram / metrics.atr14) <= t.momentum.histogramFlatAtrRatio,
  ];
  const sidewaysAvailable = sidewaysEvidence.filter((value) => value !== null).length;
  const sidewaysTrue = sidewaysEvidence.filter((value) => value === true).length;
  return {
    squeeze,
    overextended: overextensionDirection !== 0,
    sideways: sidewaysAvailable >= t.sideways.minimumAvailableEvidence && sidewaysTrue >= t.sideways.evidenceRequired,
    overextensionDirection,
    sidewaysTrue,
    sidewaysAvailable,
    overextensionEvidence: Math.max(upwardEvidence, downwardEvidence),
  };
}

export function calculateSignalConfidence(
  scoreBreakdown: MarketSignalScoreBreakdown,
  bias: MarketSignalBias,
  regimeClarity: number,
): { confidence: number; breakdown: MarketSignalConfidenceBreakdown } {
  const entries = Object.entries(scoreBreakdown) as Array<[MarketSignalComponentId, MarketSignalScoreComponent]>;
  const availableWeight = entries.reduce((sum, [id, item]) => sum + (item.available ? MARKET_SIGNAL_SCORE_WEIGHTS[id] : 0), 0);
  const positiveWeight = entries.reduce((sum, [id, item]) => sum + ((item.normalizedScore ?? 0) > 0 ? MARKET_SIGNAL_SCORE_WEIGHTS[id] * Math.abs(item.normalizedScore as number) : 0), 0);
  const negativeWeight = entries.reduce((sum, [id, item]) => sum + ((item.normalizedScore ?? 0) < 0 ? MARKET_SIGNAL_SCORE_WEIGHTS[id] * Math.abs(item.normalizedScore as number) : 0), 0);
  const completeness = entries.reduce((sum, [id, item]) => sum + item.coverage * MARKET_SIGNAL_SCORE_WEIGHTS[id], 0) / 100;
  const agreement = availableWeight === 0 ? 0 : bias === 'bullish'
    ? positiveWeight / availableWeight
    : bias === 'bearish' ? negativeWeight / availableWeight : 1 - Math.abs(positiveWeight - negativeWeight) / availableWeight;
  const evidenceStrength = entries.reduce((sum, [id, item]) => sum + Math.abs(item.normalizedScore ?? 0) * MARKET_SIGNAL_SCORE_WEIGHTS[id], 0) / 100;
  const conflictPenalty = availableWeight === 0 ? 1 : bias === 'bullish'
    ? negativeWeight / availableWeight
    : bias === 'bearish' ? positiveWeight / availableWeight : Math.min(positiveWeight, negativeWeight) / availableWeight;
  const volumeScore = scoreBreakdown.volume.normalizedScore;
  const volumeConfirmation = volumeScore === null ? 0 : bias === 'neutral'
    ? 1 - Math.abs(volumeScore)
    : clamp((bias === 'bullish' ? volumeScore : -volumeScore), 0, 1);
  const weights = MARKET_SIGNAL_THRESHOLDS.confidence;
  const ratio = clamp(
    completeness * weights.completenessWeight
      + agreement * weights.agreementWeight
      + evidenceStrength * weights.strengthWeight
      + volumeConfirmation * weights.volumeWeight
      + regimeClarity * weights.regimeClarityWeight
      - conflictPenalty * weights.conflictPenaltyWeight,
    0,
    1,
  );
  return {
    confidence: Math.round(ratio * 100),
    breakdown: {
      completeness: Math.round(completeness * 100),
      agreement: Math.round(agreement * 100),
      evidenceStrength: Math.round(evidenceStrength * 100),
      volumeConfirmation: Math.round(volumeConfirmation * 100),
      regimeClarity: Math.round(regimeClarity * 100),
      conflictPenalty: Math.round(conflictPenalty * 100),
    },
  };
}

export function presentationState(
  score: number,
  bias: MarketSignalBias,
  regime: RegimeEvidence,
  scoreBreakdown: MarketSignalScoreBreakdown,
  adx: number | null = null,
  relativeVolume: number | null = null,
): MarketSignalState {
  if (regime.squeeze) return 'SQUEEZE';
  if (regime.overextended) return 'OVEREXTENDED';
  const nonTrendingFallback = bias === 'neutral'
    && Math.abs(scoreBreakdown.emaTrend.points ?? 0) < MARKET_SIGNAL_SCORE_WEIGHTS.emaTrend / 2
    && (scoreBreakdown.trendStrength.normalizedScore ?? 0) <= 0;
  if (regime.sideways || nonTrendingFallback) return 'SIDEWAYS';
  const categoriesInDirection = Object.values(scoreBreakdown)
    .filter((item) => bias === 'bullish' ? (item.points ?? 0) > 0 : (item.points ?? 0) < 0).length;
  const strongConfirmed = categoriesInDirection >= 4
    && adx !== null
    && adx >= MARKET_SIGNAL_THRESHOLDS.trendStrength.adxTrendMinimum
    && isHighVolume(relativeVolume)
    && (bias === 'bullish' ? (scoreBreakdown.trendStrength.points ?? 0) > 0 : (scoreBreakdown.trendStrength.points ?? 0) < 0);
  if (score >= MARKET_SIGNAL_THRESHOLDS.directional.strongBullish && strongConfirmed) return 'STRONG_BULLISH';
  if (score <= MARKET_SIGNAL_THRESHOLDS.directional.strongBearish && strongConfirmed) return 'STRONG_BEARISH';
  return score >= 0 ? 'BULLISH' : 'BEARISH';
}

export function calculateMarketSignal(
  candles: readonly MarketSignalCandle[],
  context: MarketSignalContext,
): MarketSignalResult {
  const finalized = candles
    .filter((candle) => candle.finalized)
    .map(({ finalized: _finalized, ...candle }) => candle);
  const base = {
    symbol: context.symbol,
    timeframe: '1D' as const,
    calculatedAt: context.calculatedAt,
    latestCandleAt: finalized.at(-1)?.date ?? null,
    source: context.source,
    freshness: context.freshness,
    dataPoints: { received: candles.length, finalized: finalized.length },
  };
  const insufficient = (reason: string, scoreBreakdown = emptyScoreBreakdown(), warnings: string[] = []): MarketSignalResult => ({
    ...base,
    status: 'insufficient-data',
    state: null,
    bias: null,
    score: null,
    confidence: 0,
    confidenceLabel: 'Insufficient',
    scoreBreakdown,
    reasons: [],
    warnings,
    flags: [],
    metrics: emptyMetrics(),
    confidenceBreakdown: emptyConfidenceBreakdown(),
    reason,
  });

  if (finalized.length < MARKET_SIGNAL_THRESHOLDS.minimumSignalCandles) {
    return insufficient(`ต้องมี finalized 1D candles อย่างน้อย ${MARKET_SIGNAL_THRESHOLDS.minimumSignalCandles} แท่ง แต่มี ${finalized.length} แท่ง`);
  }

  const technicalContext = {
    symbol: context.symbol,
    source: context.source,
    freshness: context.freshness,
    calculatedAt: context.calculatedAt,
  };
  const technical = calculateTechnicalAnalysis(finalized, technicalContext, {
    keltnerPeriod: MARKET_SIGNAL_THRESHOLDS.squeeze.keltnerPeriod,
    keltnerAtrPeriod: MARKET_SIGNAL_THRESHOLDS.squeeze.keltnerAtrPeriod,
    keltnerAtrMultiplier: MARKET_SIGNAL_THRESHOLDS.squeeze.keltnerAtrMultiplier,
  });
  if (technical.status !== 'available') return insufficient(technical.reason);

  const close = finalized.at(-1)!.close;
  const previousClose = finalized.at(-2)!.close;
  const ema20Result = technical.indicators.ema;
  const ema50Result = technical.indicators.ema50;
  const ema200Result = technical.indicators.ema200;
  const ema20 = latest<IndicatorPoint>(ema20Result)?.value ?? null;
  const ema50 = latest<IndicatorPoint>(ema50Result)?.value ?? null;
  const ema200 = latest<IndicatorPoint>(ema200Result)?.value ?? null;
  const ema20Slope = ema20Result.status === 'available' ? slopeRatio(ema20Result.points, MARKET_SIGNAL_THRESHOLDS.ema.shortSlopeLookback) : null;
  const ema50Slope = ema50Result.status === 'available' ? slopeRatio(ema50Result.points, MARKET_SIGNAL_THRESHOLDS.ema.mediumSlopeLookback) : null;
  const ema200Slope = ema200Result.status === 'available' ? slopeRatio(ema200Result.points, MARKET_SIGNAL_THRESHOLDS.ema.longSlopeLookback) : null;
  const emaValues = [ema20, ema50, ema200].filter((value): value is number => value !== null);
  const emaCompressionRatio = emaValues.length === 3 && close !== 0
    ? (Math.max(...emaValues) - Math.min(...emaValues)) / Math.abs(close) : null;
  const rsi14 = latest<IndicatorPoint>(technical.indicators.rsi)?.value ?? null;
  const macdLatest = latest<MacdPoint>(technical.indicators.macd);
  const macdPoints = technical.indicators.macd.status === 'available' ? technical.indicators.macd.points : [];
  const previousHistogram = finiteOrNull(macdPoints.at(-2)?.histogram);
  const macdHistogram = finiteOrNull(macdLatest?.histogram);
  const atr14 = latest<IndicatorPoint>(technical.indicators.atr)?.value ?? null;
  const adxLatest = latest<AdxPoint>(technical.indicators.adx);
  const bollingerLatest = latest<BollingerPoint>(technical.indicators.bollinger);
  const keltnerLatest = latest<KeltnerPoint>(technical.indicators.keltner);
  const squeezeOn = isSqueezeOn(bollingerLatest, keltnerLatest);
  const ema20DeviationPct = ema20 !== null && ema20 !== 0 ? (close - ema20) / Math.abs(ema20) * 100 : null;
  const atrNormalizedDistance = ema20 !== null && atr14 !== null && atr14 > 0 ? (close - ema20) / atr14 : null;

  const trailingVolumes = finalized.slice(-21, -1).map((candle) => candle.volume);
  const averageVolume20 = trailingVolumes.length === 20 && trailingVolumes.every((volume): volume is number => volume !== null)
    ? trailingVolumes.reduce((sum, volume) => sum + volume, 0) / 20 : null;
  const latestVolume = finalized.at(-1)!.volume;
  const relativeVolume20 = latestVolume !== null && averageVolume20 !== null && averageVolume20 > 0
    ? latestVolume / averageVolume20 : null;
  const obvPoints = technical.indicators.obv.status === 'available' ? technical.indicators.obv.points : [];
  const obvLookback = MARKET_SIGNAL_THRESHOLDS.volume.obvSlopeLookback;
  const obvDelta = obvPoints.length > obvLookback
    ? obvPoints.at(-1)!.value - obvPoints.at(-(obvLookback + 1))!.value : null;
  const obvTrend = obvDelta === null ? null : obvDelta > 0 ? 'rising' as const : obvDelta < 0 ? 'falling' as const : 'flat' as const;

  const trendFactors: Factor[] = [];
  const emaRelationships: number[] = [];
  if (ema20 !== null) emaRelationships.push(Math.sign(close - ema20));
  if (ema20 !== null && ema50 !== null) emaRelationships.push(Math.sign(ema20 - ema50));
  if (ema50 !== null && ema200 !== null) emaRelationships.push(Math.sign(ema50 - ema200));
  if (emaRelationships.length) {
    const score = emaRelationships.reduce((sum, value) => sum + value, 0) / emaRelationships.length;
    trendFactors.push({ id: 'ema-structure', score, text: score > 0 ? 'ราคาและ EMA เรียงตัวเอนขึ้น' : score < 0 ? 'ราคาและ EMA เรียงตัวเอนลง' : 'ราคาและ EMA ยังเรียงตัวผสมกัน' });
  }
  ([['ema20-slope', ema20Slope, 'EMA20'], ['ema50-slope', ema50Slope, 'EMA50'], ['ema200-slope', ema200Slope, 'EMA200']] as const)
    .forEach(([id, value, label]) => {
      if (value === null) return;
      trendFactors.push({ id, score: normalizedSlopeScore(value), text: `${label} ${value > 0 ? 'ชันขึ้น' : value < 0 ? 'ชันลง' : 'ทรงตัว'} ${round(value * 100, 2)}%` });
    });

  const momentumFactors: Factor[] = [];
  const supplementalReasons: MarketSignalReason[] = [];
  if (rsi14 !== null) {
    momentumFactors.push({ id: 'rsi14', score: clamp((rsi14 - 50) / 25, -1, 1), text: `RSI14 อยู่ที่ ${round(rsi14, 1)}` });
    if (rsi14 >= MARKET_SIGNAL_THRESHOLDS.momentum.rsiBullishExtreme || rsi14 <= MARKET_SIGNAL_THRESHOLDS.momentum.rsiBearishExtreme) {
      supplementalReasons.push({ id: 'rsi-extreme', polarity: 'caution', text: `RSI ${round(rsi14, 1)} อยู่ในเขตสุดขั้ว`, impact: 0 });
    }
  }
  const macdScale = atr14 !== null && atr14 > 0 ? atr14 * MARKET_SIGNAL_THRESHOLDS.momentum.macdAtrScale : null;
  if (macdLatest?.signal !== null && macdLatest?.signal !== undefined && macdScale !== null) {
    momentumFactors.push({ id: 'macd-signal', score: clamp((macdLatest.value - macdLatest.signal) / macdScale, -1, 1), text: macdLatest.value > macdLatest.signal ? 'MACD อยู่เหนือ Signal' : macdLatest.value < macdLatest.signal ? 'MACD อยู่ต่ำกว่า Signal' : 'MACD เท่ากับ Signal' });
  }
  if (macdHistogram !== null && macdScale !== null) {
    const baseScore = clamp(macdHistogram / macdScale, -1, 1) * 0.75;
    const expansion = previousHistogram === null ? 0
      : Math.sign(macdHistogram) * Math.sign(Math.abs(macdHistogram) - Math.abs(previousHistogram)) * 0.25;
    momentumFactors.push({ id: 'macd-histogram', score: clamp(baseScore + expansion, -1, 1), text: `MACD Histogram ${macdHistogram > 0 ? 'เป็นบวก' : macdHistogram < 0 ? 'เป็นลบ' : 'เป็นศูนย์'}${expansion > 0 ? 'และขยายตัว' : expansion < 0 ? 'แต่หดตัว' : ''}` });
  }

  const trendStrengthFactors: Factor[] = [];
  if (adxLatest) {
    const direction = Math.sign(adxLatest.plusDi - adxLatest.minusDi);
    const strength = clamp((adxLatest.value - MARKET_SIGNAL_THRESHOLDS.trendStrength.adxSidewaysMaximum)
      / (MARKET_SIGNAL_THRESHOLDS.trendStrength.adxStrong - MARKET_SIGNAL_THRESHOLDS.trendStrength.adxSidewaysMaximum), 0, 1);
    trendStrengthFactors.push({ id: 'adx-dmi', score: direction * strength, text: `ADX ${round(adxLatest.value, 1)} โดย ${direction > 0 ? '+DI เหนือ -DI' : direction < 0 ? '-DI เหนือ +DI' : 'DMI สมดุล'}` });
  }

  const volumeFactors: Factor[] = [];
  if (relativeVolume20 !== null) {
    const lookback = MARKET_SIGNAL_THRESHOLDS.volume.directionLookback;
    const priceDirection = Math.sign(close - finalized.at(-(lookback + 1))!.close);
    const strength = relativeVolumeStrength(relativeVolume20);
    volumeFactors.push({ id: 'relative-volume', score: priceDirection * strength, text: `Relative Volume 20 วัน = ${round(relativeVolume20, 2)}×${strength === 0 ? ' ยังไม่ยืนยันทิศทาง' : ''}` });
  }
  if (obvTrend !== null) {
    volumeFactors.push({ id: 'obv-trend', score: obvTrend === 'rising' ? 1 : obvTrend === 'falling' ? -1 : 0, text: `OBV ${obvTrend === 'rising' ? 'มีแนวโน้มสูงขึ้น' : obvTrend === 'falling' ? 'มีแนวโน้มลดลง' : 'ทรงตัว'}` });
  }

  const pivots = confirmedSwingPivots(finalized, MARKET_SIGNAL_THRESHOLDS.structure.pivotWindow);
  const highs = pivots.filter((pivot) => pivot.kind === 'high');
  const lows = pivots.filter((pivot) => pivot.kind === 'low');
  const resistance = highs.filter((pivot) => pivot.price >= previousClose).sort((left, right) => left.price - right.price)[0] ?? null;
  const support = lows.filter((pivot) => pivot.price <= previousClose).sort((left, right) => right.price - left.price)[0] ?? null;
  const structureBreak = breakoutDirection(previousClose, close, support?.price ?? null, resistance?.price ?? null);
  const breakout = structureBreak === 1;
  const breakdown = structureBreak === -1;
  const structureFactors: Factor[] = [];
  const swingScores: number[] = [];
  if (highs.length >= 2) swingScores.push(Math.sign(highs.at(-1)!.price - highs.at(-2)!.price));
  if (lows.length >= 2) swingScores.push(Math.sign(lows.at(-1)!.price - lows.at(-2)!.price));
  if (swingScores.length) {
    const score = swingScores.reduce((sum, value) => sum + value, 0) / swingScores.length;
    structureFactors.push({ id: 'swing-structure', score, text: score > 0 ? 'Swing price ยกสูงขึ้น' : score < 0 ? 'Swing price ลดต่ำลง' : 'Swing price ยังผสมกัน' });
  }
  if (breakout || breakdown) structureFactors.push({ id: breakout ? 'structure-breakout' : 'structure-breakdown', score: breakout ? 1 : -1, text: `${breakout ? 'Breakout แนวต้าน' : 'Breakdown แนวรับ'} จาก confirmed pivot` });

  const scoreBreakdown: MarketSignalScoreBreakdown = {
    emaTrend: component('emaTrend', trendFactors),
    momentum: component('momentum', momentumFactors),
    trendStrength: component('trendStrength', trendStrengthFactors),
    volume: component('volume', volumeFactors),
    priceStructure: component('priceStructure', structureFactors),
  };
  const availableWeight = (Object.entries(scoreBreakdown) as Array<[MarketSignalComponentId, MarketSignalScoreComponent]>)
    .reduce((sum, [id, value]) => sum + (value.available ? MARKET_SIGNAL_SCORE_WEIGHTS[id] : 0), 0);
  if (!hasSufficientScoreCoverage(availableWeight)) {
    return insufficient('ข้อมูล indicator ที่คำนวณได้ยังครอบคลุมน้ำหนักไม่ถึงเกณฑ์ขั้นต่ำ', scoreBreakdown);
  }

  const score = aggregateDirectionalScore(scoreBreakdown);
  const bias = biasFromScore(score);
  const divergence = detectConfirmedDivergence(
    finalized,
    technical.indicators.rsi.status === 'available' ? technical.indicators.rsi.points : [],
    macdPoints,
    atr14,
  );
  const supportResistance = calculateSupportResistance(finalized, technicalContext);
  const nearestSupport = supportResistance.status === 'available'
    ? supportResistance.zones.find((zone) => zone.type === 'support')?.midpoint ?? null : null;
  const nearestResistance = supportResistance.status === 'available'
    ? supportResistance.zones.find((zone) => zone.type === 'resistance')?.midpoint ?? null : null;
  const metrics: MarketSignalMetrics = {
    close,
    ema20,
    ema50,
    ema200,
    ema20SlopePct: ema20Slope === null ? null : round(ema20Slope * 100, 4),
    ema50SlopePct: ema50Slope === null ? null : round(ema50Slope * 100, 4),
    ema200SlopePct: ema200Slope === null ? null : round(ema200Slope * 100, 4),
    emaCompressionRatio: emaCompressionRatio === null ? null : round(emaCompressionRatio, 6),
    rsi14,
    macd: macdLatest?.value ?? null,
    macdSignal: macdLatest?.signal ?? null,
    macdHistogram,
    adx14: adxLatest?.value ?? null,
    plusDi14: adxLatest?.plusDi ?? null,
    minusDi14: adxLatest?.minusDi ?? null,
    relativeVolume20,
    obvTrend,
    bollingerUpper: bollingerLatest?.upper ?? null,
    bollingerMiddle: bollingerLatest?.middle ?? null,
    bollingerLower: bollingerLatest?.lower ?? null,
    keltnerUpper: keltnerLatest?.upper ?? null,
    keltnerMiddle: keltnerLatest?.middle ?? null,
    keltnerLower: keltnerLatest?.lower ?? null,
    squeezeOn,
    atr14,
    ema20DeviationPct,
    atrNormalizedDistance,
    nearestSupport,
    nearestResistance,
    divergence,
  };
  const regime = classifyRegimeEvidence(metrics);
  const state = presentationState(score, bias, regime, scoreBreakdown, metrics.adx14, metrics.relativeVolume20);
  const regimeClarity = regime.squeeze ? 1
    : regime.overextended ? clamp(regime.overextensionEvidence / 3, 0, 1)
      : state === 'SIDEWAYS' ? clamp(regime.sidewaysTrue / Math.max(regime.sidewaysAvailable, 1), 0, 1)
        : clamp(Math.abs(score) / 60, 0, 1);
  const confidenceResult = calculateSignalConfidence(scoreBreakdown, bias, regimeClarity);
  const confidenceLabel = confidenceLabelFromValue(confidenceResult.confidence);

  const flags: MarketSignalFlag[] = [];
  if (regime.squeeze) flags.push('squeeze');
  if (regime.overextended) flags.push('overextended');
  if (isHighVolume(relativeVolume20)) flags.push('high_volume');
  if (divergence === 'bullish') flags.push('bullish_divergence');
  if (divergence === 'bearish') flags.push('bearish_divergence');
  if (Math.abs(scoreBreakdown.momentum.normalizedScore ?? 0) >= 0.7) flags.push('strong_momentum');
  const hasConflict = confidenceResult.breakdown.conflictPenalty >= 15;
  const weakVolume = scoreBreakdown.volume.normalizedScore === null || Math.abs(scoreBreakdown.volume.normalizedScore) < 0.2;
  if (hasConflict || weakVolume) flags.push('weak_confirmation');

  if (regime.squeeze) supplementalReasons.push({ id: 'squeeze-on', polarity: 'caution', text: 'Bollinger Bands อยู่ภายใน Keltner Channels: ความผันผวนกำลังบีบตัว', impact: 6 });
  if (regime.overextended) supplementalReasons.push({ id: 'overextended', polarity: 'caution', text: `ราคาอยู่ห่าง EMA20 มากกว่าปกติทาง${regime.overextensionDirection > 0 ? 'ด้านบน' : 'ด้านล่าง'}`, impact: 6 });
  if (divergence) supplementalReasons.push({ id: `${divergence}-divergence`, polarity: 'caution', text: `พบ ${divergence === 'bullish' ? 'Bullish' : 'Bearish'} divergence จาก confirmed historical pivots`, impact: 4 });
  if ((breakout || breakdown) && !hasVolumeConfirmation(relativeVolume20)) {
    supplementalReasons.push({ id: 'structure-volume-unconfirmed', polarity: 'caution', text: `${breakout ? 'Breakout' : 'Breakdown'} ยังไม่มี Relative Volume ยืนยัน`, impact: 3 });
  }

  const warnings: string[] = [];
  const missing = [
    ['EMA200', ema200],
    ['ADX/DMI', adxLatest],
    ['Relative Volume', relativeVolume20],
    ['Bollinger Bands', bollingerLatest],
    ['Keltner Channels', keltnerLatest],
    ['ATR', atr14],
  ].filter(([, value]) => value === null).map(([label]) => label);
  if (missing.length) warnings.push(`ข้อมูลไม่พร้อมใช้: ${missing.join(', ')}`);
  if (weakVolume) warnings.push('Volume confirmation ยังอ่อนหรือไม่มีข้อมูล');
  if (hasConflict) warnings.push('หลักฐานบางหมวดขัดแย้งกัน');
  if (divergence === null) warnings.push('ยังไม่ยืนยัน RSI/MACD divergence จาก historical pivots');

  return {
    ...base,
    status: 'available',
    state,
    bias,
    score,
    confidence: confidenceResult.confidence,
    confidenceLabel,
    scoreBreakdown,
    reasons: factorReasons([
      { factors: trendFactors, weight: MARKET_SIGNAL_SCORE_WEIGHTS.emaTrend },
      { factors: momentumFactors, weight: MARKET_SIGNAL_SCORE_WEIGHTS.momentum },
      { factors: trendStrengthFactors, weight: MARKET_SIGNAL_SCORE_WEIGHTS.trendStrength },
      { factors: volumeFactors, weight: MARKET_SIGNAL_SCORE_WEIGHTS.volume },
      { factors: structureFactors, weight: MARKET_SIGNAL_SCORE_WEIGHTS.priceStructure },
    ], supplementalReasons),
    warnings,
    flags,
    metrics,
    confidenceBreakdown: confidenceResult.breakdown,
  };
}
