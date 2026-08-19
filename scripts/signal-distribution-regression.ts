/**
 * Distribution regression: the OLD Options Signal model against the NEW one,
 * over the same real inputs, on the same day.
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

const TICKERS: Array<{ symbol: string; cap: 'mega' | 'mid' | 'small' }> = [
  { symbol: 'AAPL', cap: 'mega' }, { symbol: 'MSFT', cap: 'mega' },
  { symbol: 'NVDA', cap: 'mega' }, { symbol: 'GOOGL', cap: 'mega' },
  { symbol: 'AMZN', cap: 'mega' }, { symbol: 'META', cap: 'mega' },
  { symbol: 'AVGO', cap: 'mega' }, { symbol: 'TSLA', cap: 'mega' },
  { symbol: 'JPM', cap: 'mega' }, { symbol: 'XOM', cap: 'mega' },

  { symbol: 'RKLB', cap: 'mid' }, { symbol: 'SOFI', cap: 'mid' },
  { symbol: 'PLTR', cap: 'mid' }, { symbol: 'ROKU', cap: 'mid' },
  { symbol: 'DKNG', cap: 'mid' }, { symbol: 'ENPH', cap: 'mid' },
  { symbol: 'CROX', cap: 'mid' }, { symbol: 'RIVN', cap: 'mid' },
  { symbol: 'AFRM', cap: 'mid' }, { symbol: 'U', cap: 'mid' },

  { symbol: 'IONQ', cap: 'small' }, { symbol: 'ACHR', cap: 'small' },
  { symbol: 'JOBY', cap: 'small' }, { symbol: 'BBAI', cap: 'small' },
  { symbol: 'LUNR', cap: 'small' }, { symbol: 'RGTI', cap: 'small' },
  { symbol: 'OPEN', cap: 'small' }, { symbol: 'WULF', cap: 'small' },
  { symbol: 'BTBT', cap: 'small' }, { symbol: 'SMCI', cap: 'small' },
];

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
    // The old model always measured the CALL side, undamped. That is exactly
    // what the call frame of reference returns.
    riskReward: input.riskReward.status === 'available'
      ? scoreRiskReward(input.riskReward.value, { direction: 'bullish' }).normalized
      : null,
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

  const normalizedScore = Math.round(clamp(directionScore / availableWeight * 100, -100, 100));
  const coverage = availableWeight / OPTIONS_SIGNAL_TOTAL_WEIGHT;
  const agreement = absoluteScore > 0 ? Math.abs(directionScore) / absoluteScore : 0;
  const strength = clamp(absoluteScore / availableWeight, 0, 1);

  // The old weighted average, and the old penalties (unchanged by the rework).
  const confidenceBase = 0.3 * coverage + 0.35 * agreement + 0.35 * strength;
  const confidence = Math.round(clamp(confidenceBase - current.diagnostics.penaltyTotal, 0, 1) * 100);

  const bias: UnderlyingBias = normalizedScore >= OPTIONS_SIGNAL_CONFIG.direction.bullish
    ? 'bullish'
    : normalizedScore <= OPTIONS_SIGNAL_CONFIG.direction.bearish ? 'bearish' : 'neutral';

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
    && Math.abs(normalizedScore) >= quality.primeScore
    && confidence >= quality.primeConfidence
    && agreement >= quality.primeAgreement;

  let signalType: OptionsSignalType;
  if (bias === 'neutral' || Math.abs(normalizedScore) < quality.watchScore) signalType = 'SIDEWAYS';
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

async function loadNearestChain(symbol: string): Promise<{ chain: OptionsChain; result: OptionsSrResult } | null> {
  try {
    const service = getOptionsMarketDataService();
    const expirations = await service.getExpirations(symbol);
    const today = new Date().toISOString().slice(0, 10);
    const nearest = [...new Set(expirations.data.expirations)].filter((value) => value >= today).sort()[0];
    if (!nearest) return null;
    const chainResult = await service.getChain(symbol, nearest);
    const chain = chainResult.data;
    return {
      chain,
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
  oldScore: number | null;
  newScore: number | null;
  oldConfidence: number;
  newConfidence: number;
  oldType: OptionsSignalType | null;
  newType: OptionsSignalType | null;
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
        // No history yet by construction: this is the cold-start distribution,
        // which is the one that ships.
        ownHistory: { atmIv: [], putCallRatio: [] },
      });
      const next = calculateOptionsSignal(input);
      const previous = legacyReading(input);
      rows.push({
        symbol, cap,
        status: next.status,
        oldScore: previous.score,
        newScore: next.status === 'available' ? next.score : null,
        oldConfidence: previous.confidence,
        newConfidence: next.confidenceScore,
        oldType: previous.signalType,
        newType: next.signalType,
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
  const oldScores = usable.map((row) => row.oldScore).filter((value): value is number => value !== null);
  const newScores = usable.map((row) => row.newScore).filter((value): value is number => value !== null);
  const oldConfidence = usable.map((row) => row.oldConfidence);
  const newConfidence = usable.map((row) => row.newConfidence);

  console.log('\n## Per-symbol\n');
  console.log('| symbol | cap | old score | new score | old conf | new conf | old type | new type | agreement | coverage |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |');
  for (const row of rows) {
    console.log(`| ${row.symbol} | ${row.cap} | ${row.oldScore ?? '—'} | ${row.newScore ?? '—'} | `
      + `${row.oldConfidence} | ${row.newConfidence} | ${row.oldType ?? '—'} | ${row.newType ?? '—'} | `
      + `${round(row.agreement * 100, 0)}% | ${round(row.coverage * 100, 0)}% |`);
  }

  console.log('\n## Distribution\n');
  console.log('| metric | n | mean | median | p10 | p90 |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const summary of [
    describe('score · OLD', oldScores),
    describe('score · NEW', newScores),
    describe('confidence · OLD', oldConfidence),
    describe('confidence · NEW', newConfidence),
  ]) {
    console.log(`| ${summary.metric} | ${summary.n} | ${summary.mean} | ${summary.median} | ${summary.p10} | ${summary.p90} |`);
  }

  const oldPrime = usable.filter((row) => row.oldType && PRIME.has(row.oldType));
  const newPrime = usable.filter((row) => row.newType && PRIME.has(row.newType));
  console.log('\n## PRIME\n');
  console.log(`| model | PRIME_CALL | PRIME_PUT | total | of ${usable.length} usable |`);
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const [label, set] of [['OLD', oldPrime], ['NEW', newPrime]] as const) {
    const calls = set.filter((row) => (label === 'OLD' ? row.oldType : row.newType) === 'PRIME_CALL').length;
    const puts = set.filter((row) => (label === 'OLD' ? row.oldType : row.newType) === 'PRIME_PUT').length;
    console.log(`| ${label} | ${calls} | ${puts} | ${set.length} | ${round(set.length / Math.max(1, usable.length) * 100, 0)}% |`);
  }
  const lost = oldPrime.length === 0 ? 0 : (oldPrime.length - newPrime.length) / oldPrime.length * 100;
  console.log(`\nPRIME lost vs old model: ${round(lost, 0)}%`);

  console.log('\n## Label changes\n');
  const changed = usable.filter((row) => row.oldType !== row.newType);
  console.log(`${changed.length} of ${usable.length} labels changed`);
  for (const row of changed) console.log(`  ${row.symbol}: ${row.oldType} -> ${row.newType}`);

  if (failures.length) {
    console.log('\n## Failed to load\n');
    for (const failure of failures) console.log(`  ${failure}`);
  }

  // What a retune WOULD have to be, reported and not applied.
  if (lost > 80 && oldPrime.length > 0) {
    const confidences = usable
      .filter((row) => row.oldType && PRIME.has(row.oldType))
      .map((row) => row.newConfidence)
      .sort((left, right) => right - left);
    console.log('\n## Suggested thresholds (NOT applied)\n');
    console.log(`  new confidence of the symbols the OLD model called PRIME: ${confidences.join(', ')}`);
    console.log(`  primeConfidence that would restore half of them: ${quantile(confidences, 0.5)}`);
  }
}

void main();
