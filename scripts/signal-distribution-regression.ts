/**
 * Distribution regression: the OLD Options Signal model against the NEW one,
 * over the same real inputs, on the same day.
 *
 * Three models over the same real inputs:
 *
 *   pre-B      the engine before any of this work
 *   post-B     + side-aware Risk/Reward, geometric-mean confidence, logistic RVOL
 *   post-curve + the widened Risk/Reward tilt band (2:1 -> 4.5:1)
 *
 * The rework changed three things that move published numbers:
 *
 *   1. confidence became a weighted GEOMETRIC mean instead of a weighted average;
 *   2. Risk/Reward is scored for the side the other factors lead toward, and is
 *      damped when nothing leads, instead of always taking the call frame;
 *   3. RVOL confirmation became a logistic curve instead of a linear ramp that
 *      started at exactly 1.00x.
 *
 * A geometric mean cannot be argued about in the abstract — it either keeps
 * enough signals above the PRIME bar to be a model or it does not. This script
 * answers that with counts rather than with reasoning, and it CHANGES NO
 * THRESHOLD: it reports, and any retune is a separate, deliberate decision.
 *
 * The legacy model is reimplemented here, explicitly, rather than reconstructed
 * from the new diagnostics. That is the point of a regression harness: if the
 * old arithmetic is not written down somewhere it cannot be compared against.
 *
 *   npm run signal:distribution
 */

import { computeOptionsSupportResistance, type OptionsSrResult } from '@/src/lib/analytics/options-sr';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import { assembleOptionsSignalInput } from '@/src/lib/analytics/options-signal/assemble';
import {
  calculateOptionsSignal,
  classifyIvLevel,
  scoreMacro,
  scoreMomentum,
  scoreRiskReward,
  scoreSentiment,
  scoreTrend,
} from '@/src/lib/analytics/options-signal/calculations';
import {
  OPTIONS_SIGNAL_CONFIG,
  OPTIONS_SIGNAL_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_WEIGHTS,
} from '@/src/lib/analytics/options-signal/config';
import { loadOptionsSignalContext } from '@/src/lib/analytics/options-signal/service';
import type {
  OptionsSignalFactorId,
  OptionsSignalInput,
  OptionsSignalType,
  UnderlyingBias,
} from '@/src/lib/analytics/options-signal/types';
import { REGRESSION_TICKERS } from './signal-regression-tickers';

// The same thirty every Options Signal regression is read on. Shared so two
// harnesses cannot end up reporting on two different universes.
const TICKERS = REGRESSION_TICKERS;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

// ---------------------------------------------------------------------------
// The OLD model, written out
// ---------------------------------------------------------------------------

/** Pre-rework RVOL confirmation: a linear ramp starting at exactly 1.00x. */
function legacyConfirmation(relativeVolume: number | null): number | null {
  if (relativeVolume === null || !Number.isFinite(relativeVolume)) return null;
  return clamp((relativeVolume - 1) / (1.5 - 1), 0, 1);
}

/** Pre-rework momentum: same shape, but scaled by the legacy ramp. */
function legacyMomentum(input: OptionsSignalInput): number | null {
  if (input.momentum.status !== 'available') return null;
  const value = input.momentum.value;
  const config = OPTIONS_SIGNAL_CONFIG.momentum;
  const normalized = value.squeezeMomentum !== null && value.atr !== null && value.atr > 0
    ? clamp(value.squeezeMomentum / value.atr, -1, 1)
    : null;
  let base = normalized;
  if (value.squeeze === 'ON' && base !== null) base *= config.squeezeOnDamping;
  if (value.squeeze === 'FIRED_BULLISH') base = clamp((base ?? 0) + config.firedBonus, -1, 1);
  if (value.squeeze === 'FIRED_BEARISH') base = clamp((base ?? 0) - config.firedBonus, -1, 1);
  if (base === null) return null;
  const confirmation = legacyConfirmation(value.relativeVolume);
  const multiplier = confirmation === null
    ? config.unconfirmedMultiplier
    : config.minimumConfirmation + (1 - config.minimumConfirmation) * confirmation;
  return clamp(base * multiplier, -1, 1);
}

interface ModelReading {
  score: number | null;
  confidence: number;
  signalType: OptionsSignalType | null;
  bias: UnderlyingBias | null;
  agreement: number;
}

/**
 * The Risk/Reward tilt as the PRE-CURVE engine computed it: always the call
 * frame, saturating at 2:1 either way.
 *
 * Reimplemented here rather than reached for through a config override, because
 * a regression harness that cannot state the old arithmetic is not comparing
 * anything.
 */
function preCurveCallTilt(input: OptionsSignalInput): number | null {
  if (input.riskReward.status !== 'available') return null;
  const outcome = scoreRiskReward(input.riskReward.value, { direction: 'bullish' });
  if (outcome.callRewardRisk === null || outcome.upsidePercent === null || outcome.downsidePercent === null) {
    // The unbounded and touching-a-level branches are unchanged by the widening.
    return outcome.normalized;
  }
  if (outcome.upsidePercent === 0 || outcome.downsidePercent === 0) return outcome.normalized;
  return clamp(Math.log(outcome.callRewardRisk) / Math.log(2), -1, 1);
}

/**
 * The pre-rework model over a post-rework input.
 *
 * Everything the rework did NOT change — the weights, the penalties, the IV and
 * event gates, the non-score PRIME blockers — is taken from the new engine's own
 * diagnostics rather than duplicated, so any difference reported below is one of
 * the three changes above and not a transcription slip.
 */
function legacyReading(input: OptionsSignalInput): ModelReading {
  const current = calculateOptionsSignal(input);
  if (current.status !== 'available') {
    return { score: null, confidence: 0, signalType: null, bias: null, agreement: 0 };
  }

  const normalized: Partial<Record<OptionsSignalFactorId, number | null>> = {
    macro: input.macro.status === 'available' ? scoreMacro(input.macro.value).normalized : null,
    trend: input.trend.status === 'available' ? scoreTrend(input.trend.value).normalized : null,
    momentum: legacyMomentum(input),
    sentiment: input.sentiment.status === 'available'
      // The absolute-band read, which is what the old model always used.
      ? scoreSentiment({ ...input.sentiment.value, ownPercentile: null, percentileObservations: 0 }).normalized
      : null,
    // The old model always measured the CALL side, undamped, on the 2:1 band.
    riskReward: preCurveCallTilt(input),
  };

  let availableWeight = 0;
  let directionScore = 0;
  let absoluteScore = 0;
  for (const id of Object.keys(OPTIONS_SIGNAL_WEIGHTS) as OptionsSignalFactorId[]) {
    const value = normalized[id];
    if (value === null || value === undefined) continue;
    const points = Math.round(value * OPTIONS_SIGNAL_WEIGHTS[id]);
    availableWeight += OPTIONS_SIGNAL_WEIGHTS[id];
    directionScore += points;
    absoluteScore += Math.abs(points);
  }
  if (availableWeight === 0) {
    return { score: null, confidence: 0, signalType: null, bias: null, agreement: 0 };
  }

  const legacyBalance = Math.round(clamp(directionScore / availableWeight * 100, -100, 100));
  const coverage = availableWeight / OPTIONS_SIGNAL_TOTAL_WEIGHT;
  const agreement = absoluteScore > 0 ? Math.abs(directionScore) / absoluteScore : 0;
  const strength = clamp(absoluteScore / availableWeight, 0, 1);

  // The old weighted average, and the old penalties (unchanged by the rework).
  const confidenceBase = 0.3 * coverage + 0.35 * agreement + 0.35 * strength;
  const confidence = Math.round(clamp(confidenceBase - current.diagnostics.penaltyTotal, 0, 1) * 100);

  const bias: UnderlyingBias = legacyBalance >= OPTIONS_SIGNAL_CONFIG.direction.bullish
    ? 'bullish'
    : legacyBalance <= OPTIONS_SIGNAL_CONFIG.direction.bearish ? 'bearish' : 'neutral';

  const quality = OPTIONS_SIGNAL_CONFIG.quality;
  const scoreDrivenBlockers = new Set([
    'score-below-prime', 'confidence-below-prime', 'agreement-below-prime', 'trend-opposes-bias',
  ]);
  const structuralBlockers = current.diagnostics.dataSufficiency.primeBlockers
    .filter((blocker) => !scoreDrivenBlockers.has(blocker));
  const trendPoints = current.diagnostics.factors.trend.points;
  const trendOpposes = bias !== 'neutral' && trendPoints !== null
    && Math.sign(trendPoints) !== (bias === 'bullish' ? 1 : -1);

  const primeEligible = structuralBlockers.length === 0
    && bias !== 'neutral'
    && !trendOpposes
    && Math.abs(legacyBalance) >= quality.primeScore
    && confidence >= quality.primeConfidence
    && agreement >= quality.primeAgreement;

  let signalType: OptionsSignalType;
  if (bias === 'neutral' || Math.abs(legacyBalance) < quality.watchScore) signalType = 'SIDEWAYS';
  else if (primeEligible) signalType = bias === 'bullish' ? 'PRIME_CALL' : 'PRIME_PUT';
  else signalType = bias === 'bullish' ? 'CALL_WATCH' : 'PUT_WATCH';

  // The risk gate is unchanged, so the new engine's verdict on it applies.
  const gates = current.diagnostics.gates;
  if (gates.ivWarning) signalType = 'IV_WARNING';
  else if ((signalType === 'PRIME_CALL' || signalType === 'PRIME_PUT') && gates.downgrades.length) {
    signalType = signalType === 'PRIME_CALL' ? 'CALL_WATCH' : 'PUT_WATCH';
  }

  /*
   * The old card had no 0-100 direction score — that is the defect the rework
   * fixed. Its modal showed the bipolar figure, so the comparable number is that
   * figure put on the same 0-100 scale, which is what a reader would have been
   * looking at had the two surfaces ever agreed.
   */
  const score = Math.round((directionScore + availableWeight) / (2 * availableWeight) * 100);
  return { score, confidence, signalType, bias, agreement };
}

/**
 * post-B: everything from the rework EXCEPT the widened tilt band.
 *
 * Built by taking the current engine's answer and substituting the Risk/Reward
 * factor the 2:1 band would have produced for the side the engine actually
 * chose, then re-running the arithmetic that depends on it. Confidence and the
 * gates are the current ones — this isolates the curve change alone.
 */
function postBReading(input: OptionsSignalInput): ModelReading {
  const current = calculateOptionsSignal(input);
  if (current.status !== 'available') {
    return { score: null, confidence: 0, signalType: null, bias: null, agreement: 0 };
  }
  const diagnostics = current.diagnostics;
  const side = diagnostics.riskReward.scoredSide;
  const rr = diagnostics.factors.riskReward;
  if (!rr.available || rr.normalized === null || input.riskReward.status !== 'available') {
    return {
      score: diagnostics.directionScore0to100,
      confidence: current.confidenceScore,
      signalType: current.signalType,
      bias: current.underlyingBias,
      agreement: diagnostics.agreement,
    };
  }

  const ratio = side === 'put' ? diagnostics.riskReward.putRewardRisk : diagnostics.riskReward.callRewardRisk;
  let normalized = rr.normalized;
  if (ratio !== null && ratio > 0 && diagnostics.riskReward.upsidePercent
    && diagnostics.riskReward.downsidePercent) {
    const narrow = clamp(Math.log(ratio) / Math.log(2), -1, 1);
    normalized = side === 'put' ? -narrow : side === 'call' ? narrow
      : clamp(Math.log(diagnostics.riskReward.callRewardRisk ?? 1) / Math.log(2), -1, 1)
        * OPTIONS_SIGNAL_CONFIG.riskReward.sidewaysDamping;
  }

  const points = Math.round(normalized * OPTIONS_SIGNAL_WEIGHTS.riskReward);
  const others = (Object.values(diagnostics.factors) as Array<{ id: string; points: number | null }>)
    .filter((factor) => factor.id !== 'riskReward');
  const directionScore = others.reduce((sum, factor) => sum + (factor.points ?? 0), 0) + points;
  const absoluteScore = others.reduce((sum, factor) => sum + Math.abs(factor.points ?? 0), 0) + Math.abs(points);
  const availableWeight = diagnostics.availableWeight;

  const balance = Math.round(clamp(directionScore / availableWeight * 100, -100, 100));
  const agreement = absoluteScore > 0 ? Math.abs(directionScore) / absoluteScore : 0;
  const strength = clamp(absoluteScore / availableWeight, 0, 1);
  const floorAt = (value: number) => Math.max(OPTIONS_SIGNAL_CONFIG.confidence.termFloor, clamp(value, 0, 1));
  const exponents = OPTIONS_SIGNAL_CONFIG.confidence.exponents;
  const confidenceBase = Math.exp(
    exponents.coverage * Math.log(floorAt(diagnostics.coverage))
    + exponents.agreement * Math.log(floorAt(agreement))
    + exponents.strength * Math.log(floorAt(strength)),
  );
  const confidence = Math.round(clamp(confidenceBase - diagnostics.penaltyTotal, 0, 1) * 100);

  const quality = OPTIONS_SIGNAL_CONFIG.quality;
  const bias: UnderlyingBias = balance >= OPTIONS_SIGNAL_CONFIG.direction.bullish
    ? 'bullish'
    : balance <= OPTIONS_SIGNAL_CONFIG.direction.bearish ? 'bearish' : 'neutral';
  const scoreDriven = new Set(['score-below-prime', 'confidence-below-prime', 'agreement-below-prime', 'trend-opposes-bias']);
  const structural = diagnostics.dataSufficiency.primeBlockers.filter((blocker) => !scoreDriven.has(blocker));
  const trendPoints = diagnostics.factors.trend.points;
  const trendOpposes = bias !== 'neutral' && trendPoints !== null
    && Math.sign(trendPoints) !== (bias === 'bullish' ? 1 : -1);
  const primeEligible = structural.length === 0 && bias !== 'neutral' && !trendOpposes
    && Math.abs(balance) >= quality.primeScore && confidence >= quality.primeConfidence
    && agreement >= quality.primeAgreement;

  let signalType: OptionsSignalType;
  if (bias === 'neutral' || Math.abs(balance) < quality.watchScore) signalType = 'SIDEWAYS';
  else if (primeEligible) signalType = bias === 'bullish' ? 'PRIME_CALL' : 'PRIME_PUT';
  else signalType = bias === 'bullish' ? 'CALL_WATCH' : 'PUT_WATCH';
  if (diagnostics.gates.ivWarning) signalType = 'IV_WARNING';
  else if ((signalType === 'PRIME_CALL' || signalType === 'PRIME_PUT') && diagnostics.gates.downgrades.length) {
    signalType = signalType === 'PRIME_CALL' ? 'CALL_WATCH' : 'PUT_WATCH';
  }

  return {
    score: Math.round((directionScore + availableWeight) / (2 * availableWeight) * 100),
    confidence,
    signalType,
    bias,
    agreement,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function quantile(values: readonly number[], fraction: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;

function describe(label: string, values: readonly number[]) {
  return {
    metric: label,
    n: values.length,
    mean: round(mean(values), 1),
    median: round(quantile(values, 0.5), 1),
    p10: round(quantile(values, 0.1), 1),
    p90: round(quantile(values, 0.9), 1),
  };
}

const PRIME = new Set<OptionsSignalType>(['PRIME_CALL', 'PRIME_PUT']);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

async function loadNearestChain(
  symbol: string,
): Promise<{ chain: OptionsChain; result: OptionsSrResult; expectedMoveChain: OptionsChain | null } | null> {
  try {
    const service = getOptionsMarketDataService();
    const expirations = await service.getExpirations(symbol);
    const today = new Date().toISOString().slice(0, 10);
    const future = [...new Set(expirations.data.expirations)].filter((value) => value >= today).sort();
    const nearest = future[0];
    if (!nearest) return null;
    const chainResult = await service.getChain(symbol, nearest);
    const chain = chainResult.data;
    // Same second chain the server reads the expected move from, or the run
    // would be measuring a model the product does not ship.
    const horizon = OPTIONS_SIGNAL_CONFIG.expectedMove.horizonDays;
    const target = future.reduce((best, value) => (
      Math.abs(daysBetween(today, value) - horizon) < Math.abs(daysBetween(today, best) - horizon) ? value : best
    ), nearest);
    const expectedMoveChain = target === nearest
      ? null
      : (await service.getChain(symbol, target).catch(() => null))?.data ?? null;
    return {
      chain,
      expectedMoveChain,
      result: computeOptionsSupportResistance({
        symbol: chain.underlyingSymbol, expiration: chain.expiration, acceptedPrice: chain.spot,
        calls: chain.calls, puts: chain.puts, provider: chain.provider, asOf: chain.asOf, status: chain.status,
      }),
    };
  } catch {
    return null;
  }
}

interface Row {
  symbol: string;
  cap: string;
  status: string;
  preBScore: number | null;
  postBScore: number | null;
  curveScore: number | null;
  preBConfidence: number;
  postBConfidence: number;
  curveConfidence: number;
  preBType: OptionsSignalType | null;
  postBType: OptionsSignalType | null;
  curveType: OptionsSignalType | null;
  agreement: number;
  coverage: number;
}

async function main() {
  const rows: Row[] = [];
  const failures: string[] = [];

  for (const { symbol, cap } of TICKERS) {
    try {
      const [context, options] = await Promise.all([
        loadOptionsSignalContext(symbol),
        loadNearestChain(symbol),
      ]);
      const input = assembleOptionsSignalInput(context, {
        chain: options?.chain ?? null,
        optionsSr: options?.result ?? null,
        acceptedPrice: options?.chain.spot ?? null,
        expectedMoveChain: options?.expectedMoveChain ?? null,
        // No history yet by construction: this is the cold-start distribution,
        // which is the one that ships.
        ownHistory: { atmIv: [], putCallRatio: [] },
      });
      const next = calculateOptionsSignal(input);
      const preB = legacyReading(input);
      const postB = postBReading(input);
      rows.push({
        symbol, cap,
        status: next.status,
        preBScore: preB.score,
        postBScore: postB.score,
        curveScore: next.status === 'available' ? next.directionScore0to100 : null,
        preBConfidence: preB.confidence,
        postBConfidence: postB.confidence,
        curveConfidence: next.confidenceScore,
        preBType: preB.signalType,
        postBType: postB.signalType,
        curveType: next.signalType,
        agreement: next.diagnostics.agreement,
        coverage: next.diagnostics.coverage,
      });
      process.stderr.write(`.`);
    } catch (error) {
      failures.push(`${symbol}: ${(error as Error).message.slice(0, 80)}`);
      process.stderr.write(`x`);
    }
  }
  process.stderr.write('\n');

  const usable = rows.filter((row) => row.status === 'available');
  const scoresOf = (key: 'preBScore' | 'postBScore' | 'curveScore') =>
    usable.map((row) => row[key]).filter((value): value is number => value !== null);

  console.log('\n## Per-symbol\n');
  console.log('| symbol | cap | score pre-B | score post-B | score post-curve | conf pre-B | conf post-B | conf post-curve | type pre-B | type post-B | type post-curve |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |');
  for (const row of rows) {
    console.log(`| ${row.symbol} | ${row.cap} | ${row.preBScore ?? '—'} | ${row.postBScore ?? '—'} | ${row.curveScore ?? '—'} `
      + `| ${row.preBConfidence} | ${row.postBConfidence} | ${row.curveConfidence} `
      + `| ${row.preBType ?? '—'} | ${row.postBType ?? '—'} | ${row.curveType ?? '—'} |`);
  }

  console.log('\n## Distribution\n');
  console.log('| metric | n | mean | median | p10 | p90 |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const summary of [
    describe('score · pre-B', scoresOf('preBScore')),
    describe('score · post-B', scoresOf('postBScore')),
    describe('score · post-curve', scoresOf('curveScore')),
    describe('confidence · pre-B', usable.map((row) => row.preBConfidence)),
    describe('confidence · post-B', usable.map((row) => row.postBConfidence)),
    describe('confidence · post-curve', usable.map((row) => row.curveConfidence)),
  ]) {
    console.log(`| ${summary.metric} | ${summary.n} | ${summary.mean} | ${summary.median} | ${summary.p10} | ${summary.p90} |`);
  }

  console.log('\n## PRIME\n');
  console.log(`| model | PRIME_CALL | PRIME_PUT | total | of ${usable.length} usable |`);
  console.log('| --- | ---: | ---: | ---: | ---: |');
  const primeCounts: Record<string, number> = {};
  for (const [label, key] of [
    ['pre-B', 'preBType'], ['post-B', 'postBType'], ['post-curve', 'curveType'],
  ] as const) {
    const calls = usable.filter((row) => row[key] === 'PRIME_CALL').length;
    const puts = usable.filter((row) => row[key] === 'PRIME_PUT').length;
    primeCounts[label] = calls + puts;
    console.log(`| ${label} | ${calls} | ${puts} | ${calls + puts} | ${round((calls + puts) / Math.max(1, usable.length) * 100, 0)}% |`);
  }

  const change = primeCounts['post-B'] === 0
    ? 0
    : (primeCounts['post-curve'] - primeCounts['post-B']) / primeCounts['post-B'] * 100;
  console.log(`\nPRIME change from the curve widening: ${round(change, 0)}%`);
  console.log(Math.abs(change) > 30
    ? '=> OVER the 30% line. Reported, not acted on: no threshold is changed here.'
    : '=> within the 30% line.');

  console.log('\n## Label changes\n');
  for (const [label, from, to] of [
    ['pre-B -> post-B', 'preBType', 'postBType'],
    ['post-B -> post-curve', 'postBType', 'curveType'],
  ] as const) {
    const changed = usable.filter((row) => row[from] !== row[to]);
    console.log(`${label}: ${changed.length} of ${usable.length}`);
    for (const row of changed) console.log(`  ${row.symbol}: ${row[from]} -> ${row[to]}`);
  }

  if (failures.length) {
    console.log('\n## Failed to load\n');
    for (const failure of failures) console.log(`  ${failure}`);
  }

  /*
   * What a retune would have to be, reported and never applied. This script
   * exists to measure the model, not to move it — a threshold that moves to make
   * a distribution look better is a threshold fitted to one day of tape.
   */
  const primeUnderCurve = usable.filter((row) => row.curveType && PRIME.has(row.curveType));
  const lostByCurve = usable.filter((row) => row.postBType && PRIME.has(row.postBType)
    && !(row.curveType && PRIME.has(row.curveType)));
  if (lostByCurve.length) {
    console.log('\n## Symbols the curve widening moved out of PRIME (NOT acted on)\n');
    for (const row of lostByCurve) {
      console.log(`  ${row.symbol}: score ${row.postBScore} -> ${row.curveScore}`
        + ` · confidence ${row.postBConfidence} -> ${row.curveConfidence}`);
    }
    console.log(`\n  primeScore is ${OPTIONS_SIGNAL_CONFIG.quality.primeScore} on the bipolar scale`);
    console.log('  (reported only — changing it is a separate, deliberate decision)');
  } else {
    console.log(`\nNo symbol left PRIME because of the curve. PRIME under the current engine: ${primeUnderCurve.length}.`);
  }
}

void main();
