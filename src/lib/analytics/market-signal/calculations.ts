import { calculateSupportResistance, confirmedSwingPivots } from '@/src/lib/analytics/support-resistance/calculations';
import { atrWilder, calculateTechnicalAnalysis } from '@/src/lib/analytics/technical/calculations';
import type { AdxPoint, BollingerPoint, IndicatorPoint, KeltnerPoint, MacdPoint } from '@/src/lib/analytics/technical/types';
import {
  MARKET_SIGNAL_ACTIONABLE,
  MARKET_SIGNAL_EXPECTED_FACTORS,
  MARKET_SIGNAL_GATE,
  MARKET_SIGNAL_MEASURED,
  MARKET_SIGNAL_SCORE_WEIGHTS,
  MARKET_SIGNAL_THRESHOLDS,
  MARKET_SIGNAL_ZONE,
} from '@/src/config/signal';
import type {
  MarketSignalActionable,
  MarketSignalActionableNote,
  MarketSignalBand,
  MarketSignalBias,
  MarketSignalCandle,
  MarketSignalComponentId,
  MarketSignalConfidenceBreakdown,
  MarketSignalConflict,
  MarketSignalContext,
  MarketSignalEarningsProximity,
  MarketSignalFlag,
  MarketSignalGate,
  MarketSignalMetrics,
  MarketSignalReason,
  MarketSignalResult,
  MarketSignalScoreBreakdown,
  MarketSignalScoreComponent,
  MarketSignalInvalidationBasis,
  MarketSignalState,
  MarketSignalZoneEntry,
  MarketSignalZoneName,
  MarketSignalZoneProximity,
  MarketSignalZones,
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
    histogramExpanding: null,
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

/*
 * ---------------------------------------------------------------------------
 * P1 consistency layer (`SIGNAL_GATE`)
 * ---------------------------------------------------------------------------
 * Everything below is reachable only when the caller passes `features.gate`.
 * With the flag off none of it runs and the payload is byte-for-byte what it
 * was before P1 — that equivalence is the whole rollout contract, and
 * `snapshot-signal --check` is what holds it.
 */

/**
 * How much direction a score is actually carrying.
 *
 * The engine published "BULLISH" off a +1 score, which is five components
 * disagreeing and rounding, not a trend. A band is the smallest honest fix:
 * below `neutral` the sign of the total is noise.
 */
export function bandFromScore(score: number): MarketSignalBand {
  const magnitude = Math.abs(score);
  const bands = MARKET_SIGNAL_GATE.bands;
  if (magnitude < bands.neutral) return 'neutral';
  if (magnitude < bands.weak) return 'weak';
  if (magnitude < bands.strong) return 'moderate';
  return 'strong';
}

/**
 * Pairs of components that cannot both be right about direction.
 *
 * Trend and momentum pointing opposite ways is not a weak trend, it is an
 * unresolved one — the average of the two says "mildly bullish" when what the
 * evidence says is "wait". Same for structure against momentum.
 *
 * A component only gets a vote once it is actually using some of its range.
 * Sign alone made silver neutral on a score of 36 because its EMA component sat
 * at -0.11 of full scale while everything else agreed; that is not two parts of
 * the evidence disagreeing, it is one of them rounding.
 */
export function detectComponentConflicts(scoreBreakdown: MarketSignalScoreBreakdown): MarketSignalConflict[] {
  const sign = (component: MarketSignalScoreComponent) => {
    const normalized = component.normalizedScore;
    if (normalized === null || Math.abs(normalized) < MARKET_SIGNAL_GATE.conflictMinimumMagnitude) return 0;
    return Math.sign(normalized);
  };
  const momentum = sign(scoreBreakdown.momentum);
  const conflicts: MarketSignalConflict[] = [];
  if (momentum !== 0) {
    const ema = sign(scoreBreakdown.emaTrend);
    const structure = sign(scoreBreakdown.priceStructure);
    if (ema !== 0 && ema !== momentum) conflicts.push('ema_vs_momentum');
    if (structure !== 0 && structure !== momentum) conflicts.push('structure_vs_momentum');
  }
  return conflicts;
}

/**
 * The share of available component weight whose contribution points the same
 * way as the total.
 *
 * The old definition compared magnitude-weighted positive and negative masses
 * and reported 99% for a case where a quarter of the evidence was pulling the
 * other way. This one answers the question a reader thinks it answers: of the
 * evidence that had a say, how much agreed? It also makes the invariant
 * testable — any opposing weight is excluded from the numerator, so a non-zero
 * conflict penalty can never coexist with 100% agreement.
 */
export function agreementRatio(scoreBreakdown: MarketSignalScoreBreakdown, score: number): number {
  const entries = Object.entries(scoreBreakdown) as Array<[MarketSignalComponentId, MarketSignalScoreComponent]>;
  const availableWeight = entries.reduce((sum, [id, item]) => sum + (item.available ? MARKET_SIGNAL_SCORE_WEIGHTS[id] : 0), 0);
  if (availableWeight === 0) return 0;
  const direction = Math.sign(score);
  const aligned = entries.reduce((sum, [id, item]) => sum
    + (item.available && Math.sign(item.points ?? 0) === direction ? MARKET_SIGNAL_SCORE_WEIGHTS[id] : 0), 0);
  return aligned / availableWeight;
}

/**
 * How much a divergence is worth, given where RSI sits.
 *
 * A bullish divergence is a statement about exhausted selling, so it means
 * something near the oversold end and almost nothing at RSI 54.86 — which is
 * where the engine was raising it at full strength. Weighting is DIRECTIONAL on
 * purpose: distance from the midpoint alone would score a bullish divergence
 * highest at RSI 80.
 */
export function divergenceWeight(direction: 'bullish' | 'bearish', rsi14: number | null): number {
  if (rsi14 === null) return 0;
  const thresholds = MARKET_SIGNAL_THRESHOLDS.momentum;
  return direction === 'bullish'
    ? clamp((50 - rsi14) / (50 - thresholds.rsiBearishExtreme), 0, 1)
    : clamp((rsi14 - 50) / (thresholds.rsiBullishExtreme - 50), 0, 1);
}

export function earningsProximityFrom(daysToNextReport: number | null | undefined): MarketSignalEarningsProximity {
  if (daysToNextReport == null || !Number.isFinite(daysToNextReport) || daysToNextReport < 0) return 'unknown';
  if (daysToNextReport <= MARKET_SIGNAL_GATE.earnings.imminentDays) return 'imminent';
  if (daysToNextReport <= MARKET_SIGNAL_GATE.earnings.soonDays) return 'soon';
  return 'clear';
}

const earningsFactorFor = (proximity: MarketSignalEarningsProximity) => proximity === 'imminent'
  ? MARKET_SIGNAL_GATE.earnings.imminentFactor
  : proximity === 'soon' ? MARKET_SIGNAL_GATE.earnings.soonFactor : 1;

/** Map [0,1] onto [floor,1]: a bad term hurts a lot without zeroing the product. */
const withFloor = (value: number, floor: number) => floor + (1 - floor) * clamp(value, 0, 1);

/** Freshness states in which the provider did not actually give us today's data. */
const DEGRADED_FRESHNESS = new Set(['stale', 'cached', 'unknown', 'unavailable']);
export const isDegradedFreshness = (status: string) => DEGRADED_FRESHNESS.has(status);

/**
 * Confidence as a product rather than a sum.
 *
 * Additively, completeness carried 30 of the 100 points available, so a symbol
 * with every indicator present started at 30% no matter how incoherent the
 * reading was: IREN reported 64% while regime clarity was 2%. Multiplied, each
 * term is a veto in proportion to how bad it is, and a 2% clarity cannot be
 * paid for by anything.
 *
 * The six displayed breakdown numbers keep their meanings so the dialog does
 * not change shape; `factors` reports the multipliers themselves, in order.
 */
export function calculateGatedConfidence(input: {
  scoreBreakdown: MarketSignalScoreBreakdown;
  score: number;
  bias: MarketSignalBias;
  regimeClarity: number;
  dataDegraded: boolean;
  earningsProximity: MarketSignalEarningsProximity;
}): { confidence: number; breakdown: MarketSignalConfidenceBreakdown; factors: MarketSignalGate['confidenceFactors'] } {
  const { scoreBreakdown, score, bias, regimeClarity, dataDegraded, earningsProximity } = input;
  const entries = Object.entries(scoreBreakdown) as Array<[MarketSignalComponentId, MarketSignalScoreComponent]>;
  const availableWeight = entries.reduce((sum, [id, item]) => sum + (item.available ? MARKET_SIGNAL_SCORE_WEIGHTS[id] : 0), 0);
  const positiveWeight = entries.reduce((sum, [id, item]) => sum + ((item.normalizedScore ?? 0) > 0 ? MARKET_SIGNAL_SCORE_WEIGHTS[id] * Math.abs(item.normalizedScore as number) : 0), 0);
  const negativeWeight = entries.reduce((sum, [id, item]) => sum + ((item.normalizedScore ?? 0) < 0 ? MARKET_SIGNAL_SCORE_WEIGHTS[id] * Math.abs(item.normalizedScore as number) : 0), 0);

  /*
   * Completeness is about the DATA, not about how many optional patterns
   * happened to occur.
   *
   * The additive version measured factor coverage, so a symbol that simply had
   * no breakout scored 93% "complete" — reporting missing data where there was
   * none, and reporting nothing at all when the provider served a week-old
   * cache. Here it is the share of component weight whose indicators actually
   * computed, discounted when the provider's own freshness says the bars are
   * stale, cached or of unknown age.
   */
  const completeness = (availableWeight / 100)
    * (dataDegraded ? MARKET_SIGNAL_GATE.confidence.degradedDataFactor : 1);
  const agreement = agreementRatio(scoreBreakdown, score);
  const evidenceStrength = entries.reduce((sum, [id, item]) => sum + Math.abs(item.normalizedScore ?? 0) * MARKET_SIGNAL_SCORE_WEIGHTS[id], 0) / 100;
  const conflictPenalty = availableWeight === 0 ? 1 : bias === 'bullish'
    ? negativeWeight / availableWeight
    : bias === 'bearish' ? positiveWeight / availableWeight : Math.min(positiveWeight, negativeWeight) / availableWeight;
  const volumeScore = scoreBreakdown.volume.normalizedScore;
  const volumeConfirmation = volumeScore === null ? 0 : bias === 'neutral'
    ? 1 - Math.abs(volumeScore)
    : clamp((bias === 'bullish' ? volumeScore : -volumeScore), 0, 1);

  const floors = MARKET_SIGNAL_GATE.confidence;
  const factors = {
    base: round(withFloor(evidenceStrength, floors.evidenceFloor) * 100, 2),
    completeness: round(withFloor(completeness, floors.completenessFloor), 4),
    agreement: round(withFloor(agreement, floors.agreementFloor), 4),
    regimeClarity: round(withFloor(regimeClarity, floors.regimeClarityFloor), 4),
    conflict: round(clamp(1 - conflictPenalty, 0, 1), 4),
    earnings: earningsFactorFor(earningsProximity),
  };
  const confidence = Math.round(clamp(
    factors.base * factors.completeness * factors.agreement * factors.regimeClarity * factors.conflict * factors.earnings,
    0,
    100,
  ));
  return {
    confidence,
    breakdown: {
      completeness: Math.round(completeness * 100),
      agreement: Math.round(agreement * 100),
      evidenceStrength: Math.round(evidenceStrength * 100),
      volumeConfirmation: Math.round(volumeConfirmation * 100),
      regimeClarity: Math.round(regimeClarity * 100),
      conflictPenalty: Math.round(conflictPenalty * 100),
    },
    factors,
  };
}

/**
 * The direction the card is allowed to claim.
 *
 * An unresolved conflict or a sub-band score means no direction, whatever the
 * arithmetic sign of the total says.
 */
export function gatedBias(score: number, band: MarketSignalBand, conflicts: readonly MarketSignalConflict[]): MarketSignalBias {
  if (conflicts.length > 0 || band === 'neutral') return 'neutral';
  return score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
}

/**
 * The v1 state machine, then two extra conditions a STRONG label has to clear:
 * the score must actually be in the top band, and there must not be an earnings
 * print inside three days — a technical read cannot see across a gap.
 */
export function gatedPresentationState(input: {
  score: number;
  bias: MarketSignalBias;
  regime: RegimeEvidence;
  scoreBreakdown: MarketSignalScoreBreakdown;
  adx: number | null;
  relativeVolume: number | null;
  band: MarketSignalBand;
  earningsProximity: MarketSignalEarningsProximity;
}): MarketSignalState {
  const { score, bias, regime, scoreBreakdown, adx, relativeVolume, band, earningsProximity } = input;
  if (regime.squeeze) return 'SQUEEZE';
  if (regime.overextended) return 'OVEREXTENDED';
  if (bias === 'neutral') return 'SIDEWAYS';
  const base = presentationState(score, bias, regime, scoreBreakdown, adx, relativeVolume);
  if ((base === 'STRONG_BULLISH' || base === 'STRONG_BEARISH')
    && (band !== 'strong' || earningsProximity === 'imminent')) {
    return score >= 0 ? 'BULLISH' : 'BEARISH';
  }
  return base;
}

/**
 * Cap a volume component that is claiming support it does not have.
 *
 * Relative volume below its own average means the day was quieter than usual.
 * The component could still reach +8/15 on a rising OBV alone, so the card said
 * participation backed the move on a 0.84x day. Only the supportive side is
 * capped: a decline on light volume is still a decline.
 */
export function capLowVolumeComponent(
  component: MarketSignalScoreComponent,
  relativeVolume: number | null,
): { component: MarketSignalScoreComponent; capped: boolean } {
  const limit = MARKET_SIGNAL_GATE.volume.belowAverageMaximumPoints;
  if (relativeVolume === null || relativeVolume >= MARKET_SIGNAL_GATE.volume.belowAverageThreshold) {
    return { component, capped: false };
  }
  if (component.points === null || component.points <= limit) return { component, capped: false };
  return {
    component: { ...component, points: limit, normalizedScore: round(limit / component.maxPoints, 4) },
    capped: true,
  };
}

/**
 * Tags that say two different things about the same fact.
 *
 * A reader who sees one id argued as support and the same id argued as a
 * warning has no way to resolve it, and the card has no way to be right. This
 * is a cheap invariant to hold and an easy one to break by accident when adding
 * reasons, so it is checked rather than assumed.
 */
export function duplicatedReasonTags(reasons: readonly MarketSignalReason[]): string[] {
  const polarities = new Map<string, Set<string>>();
  reasons.forEach((reason) => {
    const seen = polarities.get(reason.id) ?? new Set<string>();
    seen.add(reason.polarity === 'caution' ? 'caution' : reason.polarity === 'information' ? 'information' : 'directional');
    polarities.set(reason.id, seen);
  });
  return [...polarities.entries()].filter(([, seen]) => seen.size > 1).map(([id]) => id).sort();
}

/*
 * ---------------------------------------------------------------------------
 * P2 trend zones (`SIGNAL_ZONES`)
 * ---------------------------------------------------------------------------
 * The card published a direction and, a few centimetres below it, a support and
 * a resistance showing price sitting in the middle of its own range. Only one of
 * those can be the headline. Here the structure decides the label and the score
 * is demoted to describing the lean INSIDE the zone.
 */

/** Relative volume for one bar against the twenty bars before it. */
function relativeVolumeAt(candles: readonly Omit<MarketSignalCandle, 'finalized'>[], index: number): number | null {
  if (index < 20) return null;
  const trailing = candles.slice(index - 20, index).map((candle) => candle.volume);
  if (!trailing.every((volume): volume is number => volume !== null)) return null;
  const average = trailing.reduce((sum, volume) => sum + volume, 0) / 20;
  const current = candles[index].volume;
  return average > 0 && current !== null ? current / average : null;
}

/**
 * Does a close beyond a trigger count as a break yet?
 *
 * One close is enough when the day carried real volume; otherwise the break has
 * to hold for two consecutive closes. Everything is measured on CLOSES — an
 * intraday spike through a level is not a break of it, and treating it as one is
 * how a zone bar starts flickering.
 */
function breakConfirmed(
  candles: readonly Omit<MarketSignalCandle, 'finalized'>[],
  index: number,
  beyond: (close: number) => boolean,
): boolean {
  if (!beyond(candles[index].close)) return false;
  const volume = relativeVolumeAt(candles, index);
  if (volume !== null && volume >= MARKET_SIGNAL_ZONE.confirmation.highVolumeRelative) return true;
  for (let back = 1; back < MARKET_SIGNAL_ZONE.confirmation.barsWithoutVolume; back += 1) {
    const previous = candles[index - back];
    if (!previous || !beyond(previous.close)) return false;
  }
  return true;
}

/**
 * Which zone the latest close sits in, and how it got there.
 *
 * Returns `null` rather than throwing whenever the inputs cannot support a zone
 * — no ATR, no levels, no EMA20 to fall back to. A card missing its zone bar is
 * a smaller failure than a card that invents one.
 *
 * The walk applies TODAY's boundaries to the last `walkbackBars` bars. That is
 * deliberately not a replay of where the boundaries used to be: the question
 * `zoneAgeBars` answers is "how long has price been on this side of the lines we
 * are drawing now", which is what a reader looking at the bar is asking.
 */
export function calculateTrendZones(input: {
  candles: readonly Omit<MarketSignalCandle, 'finalized'>[];
  ema20: number | null;
}): MarketSignalZones | null {
  const { candles, ema20 } = input;
  const latest = candles.at(-1);
  if (!latest) return null;
  const atrSeries = atrWilder(candles, MARKET_SIGNAL_THRESHOLDS.squeeze.keltnerAtrPeriod);
  const atrLatest = atrSeries.at(-1);
  if (atrLatest === null || atrLatest === undefined || !Number.isFinite(atrLatest) || atrLatest <= 0) return null;

  const pivots = confirmedSwingPivots(candles, MARKET_SIGNAL_THRESHOLDS.structure.pivotWindow);
  const lookback = MARKET_SIGNAL_ZONE.anchor.lookbackBars;

  /**
   * The frame as it would have been drawn at `index`, from the pivots that were
   * confirmed by then.
   *
   * Causal on purpose: `confirmedAtIndex <= index` is what keeps the walk from
   * anchoring on a swing the market had not yet finished making, which would
   * make every historical trigger look easier to cross than it was.
   */
  const anchorAt = (index: number): { support: number; resistance: number } | null => {
    const usable = pivots.filter((pivot) => pivot.confirmedAtIndex <= index && index - pivot.confirmedAtIndex <= lookback);
    const high = usable.filter((pivot) => pivot.kind === 'high').at(-1);
    const low = usable.filter((pivot) => pivot.kind === 'low').at(-1);
    if (!high || !low) return null;
    // The two most recent pivots can arrive in either order, and a recent low
    // above an older high would invert the frame. Order them rather than
    // publishing a resistance beneath its own support.
    return { support: Math.min(high.price, low.price), resistance: Math.max(high.price, low.price) };
  };

  const bandAt = (index: number, atr: number) => {
    const centre = ema20 !== null && Number.isFinite(ema20) ? ema20 : candles[index].close;
    const half = MARKET_SIGNAL_ZONE.narrowRange.atrBandMultiplier * atr;
    return { support: centre - half, resistance: centre + half };
  };

  interface Frame { support: number; resistance: number; mode: MarketSignalZones['mode']; anchoredAt: number }

  const frameAt = (index: number): Frame => {
    const atr = atrSeries[index] ?? atrLatest;
    const anchored = anchorAt(index);
    if (anchored && anchored.resistance - anchored.support >= MARKET_SIGNAL_ZONE.narrowRange.minimumAtrWidth * atr) {
      return { ...anchored, mode: 'structural', anchoredAt: index };
    }
    return { ...bandAt(index, atr), mode: 'atr_band', anchoredAt: index };
  };

  /*
   * An ATR band has no height worth projecting. Its width is 3 ATR by
   * construction, so a "measured move" taken from it is an ATR multiple with a
   * structural-sounding name — the exact thing P3 refuses to publish.
   */
  const frameHeight = (candidate: Frame): number | null =>
    candidate.mode === 'atr_band' ? null : candidate.resistance - candidate.support;

  const from = Math.max(1, candles.length - MARKET_SIGNAL_ZONE.walkbackBars);
  let frame = frameAt(from);
  let zone: MarketSignalZoneName = 'sideways';
  let zoneSince = from;
  let crossings = 0;
  let lastTouch = from;
  /*
   * The frame that was broken to enter the current zone, recorded AT the break.
   *
   * It has to be captured here because the very next statements re-anchor the
   * frame: a bar or two later the boundaries price crossed exist nowhere in this
   * function, and reconstructing them afterwards would mean guessing. Cleared
   * when hysteresis returns the zone to sideways, because a sideways zone was
   * not entered by breaking anything.
   */
  let entry: (Omit<MarketSignalZoneEntry, 'barsAgo'> & { atIndex: number }) | null = null;

  for (let index = from; index < candles.length; index += 1) {
    const atr = atrSeries[index] ?? atrLatest;
    const buffer = MARKET_SIGNAL_ZONE.triggerAtrMultiple * atr;
    const upper = frame.resistance + buffer;
    const lower = frame.support - buffer;
    const close = candles[index].close;
    const previous: MarketSignalZoneName = zone;

    /*
     * Hysteresis: entry needs `level + 0.25 ATR`, leaving needs only the level
     * itself. Without the gap a price grinding across one number relabels the
     * card on alternate days, which teaches a reader that the label is noise.
     */
    if (zone === 'uptrend' && close < frame.resistance) { zone = 'sideways'; entry = null; }
    else if (zone === 'downtrend' && close > frame.support) { zone = 'sideways'; entry = null; }

    let reanchor = false;
    if (zone === 'sideways') {
      if (breakConfirmed(candles, index, (value) => value > upper)) {
        zone = 'uptrend';
        entry = { level: frame.resistance, height: frameHeight(frame), mode: frame.mode, atIndex: index };
        reanchor = true;
      } else if (breakConfirmed(candles, index, (value) => value < lower)) {
        zone = 'downtrend';
        entry = { level: frame.support, height: frameHeight(frame), mode: frame.mode, atIndex: index };
        reanchor = true;
      }
    }
    if (close > upper || close < lower) crossings += 1;

    /*
     * Sticky. A frame that has been set stays set — that is what makes the
     * trigger an answer to "how far does price have to go" rather than a number
     * that retreats as price approaches it. It moves for exactly two reasons: a
     * confirmed break of it, or a newly confirmed pivot that lies outside it and
     * so proves the market is now trading somewhere the frame does not describe.
     */
    const freshPivot = pivots.some((pivot) => pivot.confirmedAtIndex === index
      && (pivot.price > frame.resistance || pivot.price < frame.support));
    const touchTolerance = MARKET_SIGNAL_ZONE.expiry.touchToleranceAtrMultiple * atr;
    if (candles[index].high >= frame.resistance - touchTolerance
      || candles[index].low <= frame.support + touchTolerance) {
      lastTouch = index;
    }
    // A wide frame is self-perpetuating under the first two rules alone,
    // because almost no pivot forms outside it. Once neither edge has been
    // tested for this long it has stopped describing the market, so rebuild it
    // from current structure rather than waiting for permission.
    const untested = index - lastTouch > MARKET_SIGNAL_ZONE.anchor.untestedReanchorBars;
    if (reanchor || freshPivot || untested) {
      frame = frameAt(index);
      if (untested) lastTouch = index;
    }

    if (zone !== previous) zoneSince = index;
  }

  const atr = atrLatest;
  const buffer = MARKET_SIGNAL_ZONE.triggerAtrMultiple * atr;
  const upperTrigger = frame.resistance + buffer;
  const lowerTrigger = frame.support - buffer;
  const close = latest.close;

  const tolerance = MARKET_SIGNAL_ZONE.expiry.touchToleranceAtrMultiple * atr;
  let lastTestedBarsAgo: number | null = null;
  for (let index = candles.length - 1; index >= from; index -= 1) {
    const bar = candles[index];
    if (bar.high >= frame.resistance - tolerance || bar.low <= frame.support + tolerance) {
      lastTestedBarsAgo = candles.length - 1 - index;
      break;
    }
  }

  /*
   * Signed, so a reader can tell "0.2 ATR short of the trigger" from "0.2 ATR
   * past it" — but the BAND is taken on the absolute distance, because what it
   * describes is how fragile the current label is. Within half an ATR of a
   * boundary the label can change on any close, either side of it; three ATR
   * from every boundary it is going nowhere. Silver sitting 3 ATR beyond its
   * trigger is firmly in its zone, not near one.
   */
  const nearestTriggerAtr = Math.min((upperTrigger - close) / atr, (close - lowerTrigger) / atr);
  const distanceFromBoundary = Math.abs(nearestTriggerAtr);
  const proximity: MarketSignalZoneProximity = distanceFromBoundary < MARKET_SIGNAL_ZONE.proximity.nearTriggerAtr
    ? 'near_trigger'
    : distanceFromBoundary > MARKET_SIGNAL_ZONE.proximity.deepRangeAtr ? 'deep_range' : 'mid_range';

  const width = frame.resistance - frame.support;
  return {
    mode: frame.mode,
    proximity,
    nearestTriggerAtr: round(nearestTriggerAtr, 2),
    zone,
    support: round(frame.support, 4),
    resistance: round(frame.resistance, 4),
    upperTrigger: round(upperTrigger, 4),
    lowerTrigger: round(lowerTrigger, 4),
    // Unclamped: past 100 is price above its own frame, which is the reading
    // that matters and the one a clamp would hide.
    positionPct: round(width > 0 ? ((close - frame.support) / width) * 100 : 0, 1),
    upperDistance: round(upperTrigger - close, 4),
    upperDistanceAtr: round((upperTrigger - close) / atr, 2),
    lowerDistance: round(close - lowerTrigger, 4),
    lowerDistanceAtr: round((close - lowerTrigger) / atr, 2),
    frameAgeBars: candles.length - 1 - frame.anchoredAt,
    zoneAgeBars: candles.length - 1 - zoneSince,
    lastTestedBarsAgo,
    triggerCrossings: crossings,
    // "Pending" is the honest state between a close clearing a trigger and the
    // confirmation rule accepting it: the zone has not moved, and the reader is
    // told why it has not moved yet rather than being shown nothing.
    pendingBreakout: zone !== 'uptrend' && close > upperTrigger,
    pendingBreakdown: zone !== 'downtrend' && close < lowerTrigger,
    entry: entry === null ? null : {
      level: round(entry.level, 4),
      height: entry.height === null ? null : round(entry.height, 4),
      mode: entry.mode,
      barsAgo: candles.length - 1 - entry.atIndex,
    },
    referenceClose: close,
    referenceDate: latest.date,
  };
}

/*
 * ---------------------------------------------------------------------------
 * P3 actionable layer (`SIGNAL_ACTIONABLE`)
 * ---------------------------------------------------------------------------
 */

/**
 * Where the published zone stops being true, and where it would have got to.
 *
 * Two decisions in here are deliberate departures from the obvious reading, and
 * both are about making the number answer the question the card actually asks.
 *
 * INVALIDATION IS THE ZONE'S NEAR EDGE, NOT THE FRAME'S FAR ONE.
 * An uptrend is entered by closing above `resistance + buffer` and — by the
 * engine's own hysteresis, in `calculateTrendZones` — it ENDS on the first close
 * back below `resistance`. So `resistance` is the price at which the card
 * changes what it says. Taking the frame's lower edge instead would publish a
 * level far below the one the label actually depends on: the card would have
 * read "sideways" for weeks by the time price got there, while the invalidation
 * row still claimed the uptrend was intact. A stop that the engine's own rules
 * disagree with is worse than no stop, and it is not testable — nothing in the
 * output would ever confirm or refute it.
 *
 * NO TARGET WITHOUT AN INVALIDATION, AND NO TARGET FROM A BAND.
 * A target alone is half a trade and cannot form a ratio. And the only
 * derivation allowed is a measured move — the broken frame's own height,
 * projected from the level that broke. It is a CONVENTION and is labelled as
 * one; what it is not is a constant of ours dressed up as arithmetic. When the
 * broken frame was an ATR band its height is 3 ATR by construction, so
 * projecting it would be precisely that, and the target is withheld instead.
 *
 * NOTHING AT ALL IN `atr_band` MODE — a departure from the brief, on evidence.
 * The brief asked for the band edge with the fallback named in a reason. It was
 * measured before it was published, by appending one bar that closes a tenth of
 * a percent either side of the level and re-running the zone. A structural
 * invalidation passes that: close through it and the zone ends, close short of
 * it and the zone holds. The band edge fails it — NVDA on 2026-08-17 left the
 * uptrend for a close on EITHER side, because the band is centred on EMA20 and
 * re-centres every bar, so the level drifts for reasons that have nothing to do
 * with the market. It is also, literally, the ATR multiple this layer refuses to
 * publish as a target: 1.5 ATR from a moving average. A footnote cannot rescue a
 * number that does not survive one bar, so the mode yields `null` and says
 * `atr_band_fallback`. It costs 1 instrument in 108 today.
 */
export function calculateActionable(input: {
  zones: MarketSignalZones;
  atr: number | null;
}): MarketSignalActionable {
  const { zones } = input;
  const atr = input.atr !== null && Number.isFinite(input.atr) && input.atr > 0 ? input.atr : null;
  const close = zones.referenceClose;
  const notes: MarketSignalActionableNote[] = [];
  const directional = zones.zone === 'uptrend' || zones.zone === 'downtrend';

  // A volatility envelope is not a level anybody traded against, and it moves
  // with EMA20 every bar. Nothing downstream may be derived from it.
  const envelope = zones.mode === 'atr_band';
  if (envelope && directional) notes.push('atr_band_fallback');

  // `null` for a sideways zone (nothing to invalidate) and for an envelope
  // (nothing that was traded against). See the note on this function for why the
  // edge is the one the zone STANDS on rather than the far side of the frame.
  const edge: { level: number; basis: MarketSignalInvalidationBasis } | null = envelope ? null
    : zones.zone === 'uptrend' ? { level: zones.resistance, basis: 'zone_floor' }
      : zones.zone === 'downtrend' ? { level: zones.support, basis: 'zone_ceiling' }
        : null;
  let invalidation = edge?.level ?? null;
  let invalidationBasis = edge?.basis ?? null;
  if (!directional) notes.push('no_direction_to_invalidate');

  /*
   * The frame re-anchors on the breakout bar, and the new frame is built from
   * pivots rather than from where price happens to be. So the edge can land on
   * the wrong side of the close — for an uptrend, at or above it. A "stop" above
   * the current price is not a stop; withhold it and say which refusal it was.
   */
  if (invalidation !== null) {
    const behind = zones.zone === 'uptrend' ? close <= invalidation : close >= invalidation;
    if (behind) {
      invalidation = null;
      invalidationBasis = null;
      notes.push('invalidation_behind_close');
    }
  }

  let target: number | null = null;
  let targetBasis: MarketSignalActionable['targetBasis'] = null;
  if (invalidation !== null) {
    const broken = zones.entry;
    if (!broken || broken.height === null) {
      notes.push('no_measurable_frame');
    } else {
      const projected = zones.zone === 'uptrend'
        ? broken.level + broken.height
        : broken.level - broken.height;
      // A projection price has already run past is behind the reader, not ahead
      // of them, and reporting it would make the reward leg negative.
      const reached = zones.zone === 'uptrend' ? close >= projected : close <= projected;
      if (reached) notes.push('measured_move_reached');
      else {
        target = round(projected, 4);
        targetBasis = 'measured_move';
      }
    }
  }

  const risk = invalidation === null ? null : Math.abs(close - invalidation);
  const reward = target === null ? null : Math.abs(target - close);

  /*
   * The ratio is published, and labelled, when its risk leg is inside noise.
   *
   * A freshly entered zone sits ON its own floor by construction, so the risk
   * leg goes to nearly nothing and the ratio explodes: the four largest ratios
   * in the corpus (17.79, 17.51, 13.78, 7.94) were the four instruments closest
   * to their invalidation, all entered within two bars, with ordinary reward
   * legs. ORCL's 17.79 would read about 4 if its close were half an ATR higher —
   * same structure, same target, same everything a reader can see.
   *
   * It is NOT withheld, because unlike the numbers P3 refuses to print this one
   * is arithmetically correct; it is unstable, which calls for a label rather
   * than a deletion. P4a settled which: the sub-0.5-ATR bucket carries an edge
   * of +0.5 / +0.5 / -0.8pp over base — these signals are not better, so the
   * ratio must not be allowed to read as though they were. The threshold is
   * `proximity.nearTriggerAtr`, reused rather than re-invented.
   */
  const noisyRiskLeg = risk !== null && reward !== null && atr !== null
    && risk / atr < MARKET_SIGNAL_ZONE.proximity.nearTriggerAtr;
  if (noisyRiskLeg) notes.push('risk_leg_inside_noise');

  return {
    invalidation: invalidation === null ? null : round(invalidation, 4),
    // Magnitudes, not signed distances: which way the level lies is already
    // fully determined by `invalidationBasis`, and a sign here reads as a
    // direction the number does not have.
    invalidationAtr: risk === null || atr === null ? null : round(risk / atr, 2),
    invalidationPct: risk === null || close === 0 ? null : round((risk / Math.abs(close)) * 100, 2),
    invalidationBasis,
    target,
    targetAtr: reward === null || atr === null ? null : round(reward / atr, 2),
    targetBasis,
    targetIsConvention: targetBasis !== null,
    riskReward: risk === null || reward === null || risk <= 0 ? null : round(reward / risk, 2),
    notes,
  };
}

/**
 * The label a zone implies.
 *
 * Regime states still win. A squeeze is a statement about volatility that a
 * zone does not contradict, and "coiling" serves a reader better than
 * "sideways" when both are true.
 */
export function zonePresentationState(input: {
  zone: MarketSignalZoneName;
  regime: RegimeEvidence;
  score: number;
  scoreBreakdown: MarketSignalScoreBreakdown;
  adx: number | null;
  relativeVolume: number | null;
}): MarketSignalState {
  const { zone, regime, score, scoreBreakdown, adx, relativeVolume } = input;
  if (regime.squeeze) return 'SQUEEZE';
  if (regime.overextended) return 'OVEREXTENDED';
  if (zone === 'sideways') return 'SIDEWAYS';
  const bias: MarketSignalBias = zone === 'uptrend' ? 'bullish' : 'bearish';
  const confirmed = presentationState(score, bias, regime, scoreBreakdown, adx, relativeVolume);
  if (confirmed === 'STRONG_BULLISH' || confirmed === 'STRONG_BEARISH') return confirmed;
  return zone === 'uptrend' ? 'BULLISH' : 'BEARISH';
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
    evidenceAgreement: 0,
    evidenceAgreementLabel: 'Insufficient',
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
  /*
   * The histogram's own direction, lifted out of the momentum factor so the
   * payload can carry the same answer the factor's sentence is built from.
   *
   * It stays ONE expression, read twice. The reason row says the histogram is
   * growing or shrinking off the sign of this product, and
   * `metrics.histogramExpanding` is that same sign published; computing it a
   * second time next to the metrics object would let the two drift apart on a
   * day the guards disagree, which is the drift the copy layer exists to stop.
   *
   * Three states, not two, because the engine's sentence has three branches.
   * `null` is "the engine said neither" - no previous bar to compare against, a
   * histogram sitting on zero, or a bar that matched the one before it - and it
   * is the state that tells the copy layer to leave the clause off rather than
   * to print a direction nobody measured.
   */
  const histogramExpansionSign = macdHistogram === null || previousHistogram === null ? 0
    : Math.sign(macdHistogram) * Math.sign(Math.abs(macdHistogram) - Math.abs(previousHistogram));
  const histogramExpanding = histogramExpansionSign === 0 ? null : histogramExpansionSign > 0;
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
    const expansion = histogramExpansionSign * 0.25;
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

  /*
   * Structure is read from RECENT pivots only. A confirmed swing keeps its place
   * in the record forever, but it stops describing the market long before that:
   * searching the whole history for "the nearest low below the previous close"
   * once picked a level from nine months earlier and then announced that price
   * had broken it, on a day price was above every EMA.
   */
  const structureHorizon = finalized.length - 1 - MARKET_SIGNAL_THRESHOLDS.structure.pivotLookbackBars;
  const pivots = confirmedSwingPivots(finalized, MARKET_SIGNAL_THRESHOLDS.structure.pivotWindow)
    .filter((pivot) => pivot.confirmedAtIndex >= structureHorizon);
  const highs = pivots.filter((pivot) => pivot.kind === 'high');
  const lows = pivots.filter((pivot) => pivot.kind === 'low');
  const resistance = highs.filter((pivot) => pivot.price >= previousClose).sort((left, right) => left.price - right.price)[0] ?? null;
  const support = lows.filter((pivot) => pivot.price <= previousClose).sort((left, right) => right.price - left.price)[0] ?? null;
  const structureBreak = breakoutDirection(previousClose, close, support?.price ?? null, resistance?.price ?? null);
  const breakout = structureBreak === 1;
  const breakdown = structureBreak === -1;
  const structureFactors: Factor[] = [];
  const swingScores: number[] = [];
  /*
   * The latest close takes part in the swing sequence as a PROVISIONAL extreme.
   *
   * A pivot cannot be confirmed until its right-hand window has closed, so the
   * confirmed set always lags price by `pivotWindow` bars. Comparing only the
   * two newest confirmed highs therefore reports "lower highs" for several days
   * after price has already traded clean through both of them — which is how a
   * close at 44.06, above the last two confirmed highs of 42.24 and 43.72, was
   * scored as a fully bearish structure. Folding the close in as the newest
   * (unconfirmed) extreme costs nothing when price is inside the range and
   * removes the lag when it is not.
   */
  if (highs.length >= 2) swingScores.push(Math.sign(Math.max(highs.at(-1)!.price, close) - highs.at(-2)!.price));
  if (lows.length >= 2) swingScores.push(Math.sign(Math.min(lows.at(-1)!.price, close) - lows.at(-2)!.price));
  if (swingScores.length) {
    const score = swingScores.reduce((sum, value) => sum + value, 0) / swingScores.length;
    structureFactors.push({ id: 'swing-structure', score, text: score > 0 ? 'Swing price ยกสูงขึ้น' : score < 0 ? 'Swing price ลดต่ำลง' : 'Swing price ยังผสมกัน' });
  }
  if (breakout || breakdown) structureFactors.push({ id: breakout ? 'structure-breakout' : 'structure-breakdown', score: breakout ? 1 : -1, text: `${breakout ? 'Breakout แนวต้าน' : 'Breakdown แนวรับ'} จาก confirmed pivot` });

  const gateOn = context.features?.gate === true;
  const zonesOn = context.features?.zones === true;
  const actionableOn = context.features?.actionable === true;
  const lowVolume = capLowVolumeComponent(component('volume', volumeFactors), relativeVolume20);
  const volumeCapped = gateOn && lowVolume.capped;
  const scoreBreakdown: MarketSignalScoreBreakdown = {
    emaTrend: component('emaTrend', trendFactors),
    momentum: component('momentum', momentumFactors),
    trendStrength: component('trendStrength', trendStrengthFactors),
    volume: volumeCapped ? lowVolume.component : component('volume', volumeFactors),
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
    histogramExpanding,
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

  /*
   * P1 decisions. Every one of these is computed only when the gate is on and
   * every consumer below falls back to the v1 value when it is off, so the
   * flags-OFF payload keeps every field it had, unchanged.
   */
  const band = gateOn ? bandFromScore(score) : null;
  const conflicts = gateOn ? detectComponentConflicts(scoreBreakdown) : [];
  const earningsProximity = gateOn ? earningsProximityFrom(context.earnings?.daysToNextReport) : 'unknown';
  const dataDegraded = gateOn && isDegradedFreshness(context.freshness.status);
  const gatedBiasValue = gateOn ? gatedBias(score, band as MarketSignalBand, conflicts) : bias;

  /*
   * P2. The frame is anchored to swing structure, deliberately NOT to
   * `nearestSupport`/`nearestResistance`: those are defined as the levels
   * closest to the current price, so a trigger built from them retreats as
   * price approaches and can never be crossed. They remain in `metrics` as
   * context, and the card labels them as the nearest levels rather than as the
   * frame.
   */
  const zones = zonesOn ? calculateTrendZones({ candles: finalized, ema20 }) : null;

  /*
   * P3 reads the zone and nothing else, so it is silent whenever P2 is — turning
   * `SIGNAL_ACTIONABLE` on by itself changes no byte of the payload. That is not
   * a guard against misconfiguration, it is the actual dependency: an
   * invalidation is defined as the price at which the ZONE stops being true, and
   * without a zone the sentence has no subject.
   */
  const actionable = actionableOn && zones ? calculateActionable({ zones, atr: atr14 }) : null;

  /*
   * When zones are on, STRUCTURE names the label and the score is demoted to
   * describing the lean inside it. The gate keeps its veto: a conflict is a
   * statement that the evidence cannot be read, which survives price being on
   * one side of a line.
   */
  const zoneState = zones
    ? zonePresentationState({
      zone: zones.zone,
      regime,
      score,
      scoreBreakdown,
      adx: metrics.adx14,
      relativeVolume: metrics.relativeVolume20,
    })
    : null;
  /*
   * Precedence when both phases are on.
   *
   * The zone answers "where has price actually got to", which is a fact. The
   * gate answers "how well does the evidence support it", which is a quality.
   * Those are different questions and the card should show both rather than let
   * one erase the other — so a conflict no longer overwrites the direction. It
   * does two narrower things instead: it forbids a STRONG label, and it keeps
   * damping confidence through the same multiplicative formula. A reader sees
   * the direction price is in AND that the evidence behind it disagrees.
   */
  const demoteStrong = (state: MarketSignalState): MarketSignalState => state === 'STRONG_BULLISH' ? 'BULLISH'
    : state === 'STRONG_BEARISH' ? 'BEARISH' : state;
  const zoneBias: MarketSignalBias | null = zones
    ? (zones.zone === 'uptrend' ? 'bullish' : zones.zone === 'downtrend' ? 'bearish' : 'neutral')
    : null;
  const gateVetoes = gateOn && conflicts.length > 0;

  const state = zoneState !== null
    ? (gateVetoes ? demoteStrong(zoneState) : zoneState)
    : gateOn
      ? gatedPresentationState({
        score,
        bias: gatedBiasValue,
        regime,
        scoreBreakdown,
        adx: metrics.adx14,
        relativeVolume: metrics.relativeVolume20,
        band: band as MarketSignalBand,
        earningsProximity,
      })
      : presentationState(score, bias, regime, scoreBreakdown, metrics.adx14, metrics.relativeVolume20);
  const regimeClarity = regime.squeeze ? 1
    : regime.overextended ? clamp(regime.overextensionEvidence / 3, 0, 1)
      : state === 'SIDEWAYS' ? clamp(regime.sidewaysTrue / Math.max(regime.sidewaysAvailable, 1), 0, 1)
        : clamp(Math.abs(score) / 60, 0, 1);
  const gatedConfidenceResult = gateOn
    ? calculateGatedConfidence({ scoreBreakdown, score, bias: gatedBiasValue, regimeClarity, dataDegraded, earningsProximity })
    : null;
  const confidenceResult = gatedConfidenceResult ?? calculateSignalConfidence(scoreBreakdown, bias, regimeClarity);
  const confidenceLabel = confidenceLabelFromValue(confidenceResult.confidence);
  // The bias follows the zone even under a conflict: price is where it is.
  const effectiveBias = zoneBias !== null ? zoneBias : gateOn ? gatedBiasValue : bias;

  // A divergence in the middle of the RSI range is not worth a chip of its own;
  // it stays a written caution, which is also what keeps one fact from being
  // shown as support and as a warning on the same card.
  const divergenceStrength = gateOn && divergence ? divergenceWeight(divergence, rsi14) : 1;
  const showDivergenceFlag = divergence !== null
    && (!gateOn || divergenceStrength >= MARKET_SIGNAL_GATE.divergence.minimumFlagWeight);

  const flags: MarketSignalFlag[] = [];
  if (regime.squeeze) flags.push('squeeze');
  if (regime.overextended) flags.push('overextended');
  if (isHighVolume(relativeVolume20)) flags.push('high_volume');
  if (divergence === 'bullish' && showDivergenceFlag) flags.push('bullish_divergence');
  if (divergence === 'bearish' && showDivergenceFlag) flags.push('bearish_divergence');
  if (Math.abs(scoreBreakdown.momentum.normalizedScore ?? 0) >= 0.7) flags.push('strong_momentum');
  const hasConflict = confidenceResult.breakdown.conflictPenalty >= 15;
  const weakVolume = scoreBreakdown.volume.normalizedScore === null || Math.abs(scoreBreakdown.volume.normalizedScore) < 0.2;
  if (hasConflict || weakVolume) flags.push('weak_confirmation');
  if (zones) {
    if (zones.pendingBreakout) flags.push('pending_breakout');
    if (zones.pendingBreakdown) flags.push('pending_breakdown');
    if (zones.mode === 'atr_band') flags.push('narrow_range');
    if (zones.lastTestedBarsAgo === null
      || zones.lastTestedBarsAgo > MARKET_SIGNAL_ZONE.expiry.maximumUntestedBars) {
      flags.push('stale_zone');
    }
  }
  if (actionable !== null
    && actionable.riskReward !== null
    && actionable.riskReward < MARKET_SIGNAL_ACTIONABLE.unfavorableRiskReward) {
    flags.push('unfavorable_risk_reward');
  }
  if (actionable?.notes.includes('risk_leg_inside_noise')) flags.push('risk_leg_inside_noise');
  if (gateOn) {
    if (conflicts.length) flags.push('conflicting_evidence');
    if (volumeCapped) flags.push('low_volume_confirmation');
    if (dataDegraded) flags.push('stale_or_partial_data');
    if (earningsProximity === 'imminent') flags.push('earnings_imminent');
    if (earningsProximity === 'soon') flags.push('earnings_soon');
    // Breakouts into a print are the ones that most often do not hold, because
    // what resolves them is an event the chart has not seen.
    if ((breakout || breakdown) && (earningsProximity === 'imminent' || earningsProximity === 'soon')) {
      flags.push('pre_earnings_breakout');
    }
  }

  if (regime.squeeze) supplementalReasons.push({ id: 'squeeze-on', polarity: 'caution', text: 'Bollinger Bands อยู่ภายใน Keltner Channels: ความผันผวนกำลังบีบตัว', impact: 6 });
  if (regime.overextended) supplementalReasons.push({ id: 'overextended', polarity: 'caution', text: `ราคาอยู่ห่าง EMA20 มากกว่าปกติทาง${regime.overextensionDirection > 0 ? 'ด้านบน' : 'ด้านล่าง'}`, impact: 6 });
  if (divergence) {
    supplementalReasons.push({
      id: `${divergence}-divergence`,
      polarity: 'caution',
      text: `พบ ${divergence === 'bullish' ? 'Bullish' : 'Bearish'} divergence จาก confirmed historical pivots${gateOn && divergenceStrength < MARKET_SIGNAL_GATE.divergence.minimumFlagWeight ? ` (RSI ${round(rsi14 ?? 0, 1)} อยู่กลางโซน จึงถ่วงน้ำหนักต่ำ)` : ''}`,
      impact: gateOn
        ? round(4 * (MARKET_SIGNAL_GATE.divergence.minimumImpactShare
          + (1 - MARKET_SIGNAL_GATE.divergence.minimumImpactShare) * divergenceStrength), 2)
        : 4,
    });
  }
  if (gateOn && conflicts.length) {
    supplementalReasons.push({
      id: 'component-conflict',
      polarity: 'caution',
      text: conflicts.includes('ema_vs_momentum')
        ? 'ทิศทางของ EMA/Trend กับ Momentum ขัดกัน จึงยังไม่สรุปเป็นขาขึ้นหรือขาลง'
        : 'ทิศทางของ Price Structure กับ Momentum ขัดกัน จึงยังไม่สรุปเป็นขาขึ้นหรือขาลง',
      impact: 7,
    });
  }
  if (gateOn && earningsProximity !== 'clear' && earningsProximity !== 'unknown') {
    supplementalReasons.push({
      id: 'earnings-proximity',
      polarity: 'caution',
      text: `อีก ${context.earnings?.daysToNextReport} วันจะประกาศงบ ซึ่งเป็นเหตุการณ์ที่กราฟยังมองไม่เห็น`,
      impact: earningsProximity === 'imminent' ? 8 : 5,
    });
  }
  if (zones && (zones.pendingBreakout || zones.pendingBreakdown)) {
    supplementalReasons.push({
      id: 'pending-zone-break',
      polarity: 'caution',
      /*
       * The measured outcome, said out loud. This state used to be described
       * only as "not confirmed yet", which a reader completes as "not confirmed
       * YET" — an event on its way. Most of them are not: see
       * `MARKET_SIGNAL_MEASURED.pendingBreakout`.
       */
      text: `ราคาปิดผ่านแนว${zones.pendingBreakout ? 'ต้าน' : 'รับ'}แล้ว แต่ยังไม่ผ่านเงื่อนไขยืนยัน จึงยังไม่เปลี่ยนโซน`
        + ` — จากการวัดย้อนหลัง ${MARKET_SIGNAL_MEASURED.pendingBreakout.sampleSize} ครั้ง มีราว`
        + ` ${MARKET_SIGNAL_MEASURED.pendingBreakout.confirmedWithinFiveBars}% ที่ยืนยันภายใน 5 แท่ง`
        + ` และเหลือราว ${MARKET_SIGNAL_MEASURED.pendingBreakout.stillDirectionalAtTwentyBars}% ที่ยังเป็นแนวโน้มอยู่เมื่อครบ 20 แท่ง`,
      impact: 6,
    });
  }
  if (zones && zones.mode === 'atr_band') {
    supplementalReasons.push({
      id: 'narrow-range-band',
      polarity: 'information',
      text: 'แนวรับและแนวต้านห่างกันน้อยกว่า 1 ATR จึงใช้กรอบ ATR รอบ EMA20 แทน',
      impact: 2,
    });
  }
  if (actionable?.notes.includes('atr_band_fallback')) {
    supplementalReasons.push({
      id: 'invalidation-from-band',
      polarity: 'information',
      text: 'กรอบตอนนี้เป็นกรอบ ATR รอบ EMA20 ซึ่งขยับทุกแท่งตามค่าเฉลี่ย ไม่ใช่แนวที่ตลาดเคยเทรดจริง จึงยังไม่ระบุระดับที่ทำให้สัญญาณเป็นโมฆะ',
      impact: 2,
    });
  }
  if (actionable !== null && actionable.invalidation !== null && actionable.target === null) {
    supplementalReasons.push({
      id: 'no-defensible-target',
      polarity: 'information',
      text: actionable.notes.includes('measured_move_reached')
        ? 'ราคาไปถึงระยะที่กรอบเดิมวัดได้แล้ว จึงยังไม่มีเป้าถัดไปที่อ้างอิงโครงสร้างได้'
        : 'ยังไม่มีกรอบที่วัดความสูงได้เป็นที่มาของเป้า จึงไม่แสดงเป้าและอัตราส่วน',
      impact: 2,
    });
  }
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
  if (gateOn && dataDegraded) warnings.push(`ข้อมูลจากผู้ให้บริการอยู่ในสถานะ ${context.freshness.status} จึงลดความมั่นใจลง`);
  if (volumeCapped) warnings.push(`Relative Volume ${round(relativeVolume20 ?? 0, 2)}× ต่ำกว่าค่าเฉลี่ย จึงจำกัดคะแนน Volume`);

  const gate: MarketSignalGate | undefined = gateOn && band !== null && gatedConfidenceResult !== null
    ? {
      band,
      conflicts,
      forcedNeutral: effectiveBias === 'neutral' && bias !== 'neutral',
      earningsProximity,
      daysToEarnings: context.earnings?.daysToNextReport ?? null,
      confidenceFactors: gatedConfidenceResult.factors,
    }
    : undefined;

  return {
    ...base,
    status: 'available',
    state,
    bias: effectiveBias,
    score,
    /*
     * The same number twice, under two names, on purpose. `confidence` is
     * deprecated and cannot be deleted without breaking the additive rule, and
     * `evidenceAgreement` is what it always measured: how well the five
     * components agree, not the chance price does anything. P4a measured the
     * gap — the 90-99 band hits 53-55%, the same as the 20-29 band — which is
     * why the card no longer prints it as a headline percentage.
     */
    confidence: confidenceResult.confidence,
    confidenceLabel,
    evidenceAgreement: confidenceResult.confidence,
    evidenceAgreementLabel: confidenceLabel,
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
    // Spread rather than assigned, so the key is absent (not `undefined`) with
    // the flag off — `JSON.stringify` keeps an explicit `undefined` out too, but
    // deep-equality assertions and the golden gate both see the difference.
    ...(gate ? { gate } : {}),
    ...(zones ? { zones } : {}),
    ...(actionable ? { actionable } : {}),
  };
}
