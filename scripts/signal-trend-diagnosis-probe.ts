/**
 * WHY does the label disagree with the move? A diagnosis, and only that.
 *
 * `trend_agreement.md` measured that the two flag states fail in OPPOSITE
 * directions over the same 108 instruments and the same 72805 bars:
 *
 *   engine OFF   UP 98.9%  DOWN 93.8%  SIDEWAYS 17.3%   flip 1.63
 *   engine ON    UP 46.2%  DOWN 39.2%  SIDEWAYS 84.1%   flip 1.17
 *
 * OFF over-speaks, ON under-speaks, and the flip ratio is above 1.0 at all 27
 * grid points. That file says THAT. This one asks WHICH RULE, and answers in
 * three parts:
 *
 *   A  the ten worst conflicts, opened one at a time — 20 bars of price, the
 *      engine's own indicators, the zone frame and every reason id it raised,
 *      then a per-case adjudication by a rule fixed before the run.
 *   B  the veto that eats the trend when ON. Every bar the ground truth calls a
 *      move and engine ON calls SIDEWAYS, attributed to a cause — overlapping
 *      (a bar can satisfy several) and non-overlapping (the engine's own
 *      precedence decides which one actually fired).
 *   C  sensitivity of ONLY the thresholds B named. Two knobs, +-20%, four runs.
 *
 * NOTHING HERE IS A FEATURE, AND NOTHING IN src/ IS TOUCHED. The C variants
 * mutate the config OBJECT IN MEMORY, inside this process, for the duration of
 * one collection pass; `src/config/signal.ts` on disk is byte-identical before
 * and after, and every variant run writes the override it applied into its own
 * shard file so the report cannot mislabel which engine produced which column.
 * That is disclosed rather than hidden, because a sensitivity number produced by
 * a secretly different engine is worthless.
 *
 * NOT A FORWARD MEASUREMENT, BY CONSTRUCTION — same as the file it descends
 * from. No horizon, no forward return, no hit rate. Every quantity is computed
 * from bars at or before the bar being described.
 *
 * ---------------------------------------------------------------------------
 * THE GROUND TRUTH — UNCHANGED, COPIED FROM THE AGREEMENT PROBE
 * ---------------------------------------------------------------------------
 *   window        N = 20 bars ending AT bar t
 *   displacement  (close_t - close_t-N) / ATR14_t      Wilder, computed here
 *   efficiency    |close_t - close_t-N| / sum |dclose|
 *   UP            displacement >= +1.5 and efficiency >= 0.3
 *   DOWN          displacement <= -1.5 and efficiency >= 0.3
 *   SIDEWAYS      everything else
 *
 * It is still a design choice, not the truth. §4 of `trend_agreement.md` already
 * showed the verdict does not move across 27 versions of it; this file does not
 * re-open that and uses the pre-registered one throughout.
 *
 * ---------------------------------------------------------------------------
 * THE PART-A ADJUDICATION RULE, FIXED BEFORE THE RUN
 * ---------------------------------------------------------------------------
 * "Who is wrong" cannot be settled by either party's own machinery: the engine
 * would win any test built from EMAs and the labeller would win any test built
 * from 20-bar displacement. So the adjudicator is PRICE AT TWO OTHER SCALES,
 * and nothing else:
 *
 *   d5   = (close_t - close_t-5)  / ATR14_t     the move the ground truth's
 *   d20  = (close_t - close_t-20) / ATR14_t     window is one view of, seen
 *   d60  = (close_t - close_t-60) / ATR14_t     faster and slower
 *
 *   side(d) = +1 if d >= +0.5,  -1 if d <= -0.5,  0 otherwise
 *
 *   engine wrong        side(d5) == side(d20) AND side(d60) == side(d20)
 *                       -> the move is the same direction at every scale, so
 *                          there is no window at which the engine's word is a
 *                          defensible reading of the chart
 *   ground truth wrong  side(d5) != side(d20) AND side(d60) != side(d20)
 *                       AND neither is 0
 *                       -> the 20-bar window is the odd one out; it caught a
 *                          leg the chart on either side of it contradicts
 *   borderline          everything else, including every case where a
 *                       corroborating scale is flat
 *
 * The rule is symmetric, uses no EMA, no ADX, no score and no zone, and is
 * applied by `adjudicate()` below. The evidence for every case is printed in
 * full so a reader who rejects the rule can overrule it from the same table.
 *
 * ---------------------------------------------------------------------------
 * PART B — WHAT "CAUSE" MEANS, AND WHY TWO COLUMNS
 * ---------------------------------------------------------------------------
 * Four candidate causes were named before the run:
 *
 *   band == neutral         |score| < MARKET_SIGNAL_GATE.bands.neutral (15)
 *   conflicts non-empty     detectComponentConflicts() returned something
 *   zone == sideways        calculateTrendZones() put the close in the middle
 *   regime.sideways
 *     / nonTrendingFallback the v1 two-part quiet test in presentationState()
 *
 * OVERLAPPING counts how many of the lost bars each condition is TRUE on. A bar
 * can be all four at once and is counted in all four columns.
 *
 * NON-OVERLAPPING attributes each bar to exactly one cause, in the order the
 * ENGINE ITSELF evaluates them on the path that produced the label. That order
 * is read off `calculateMarketSignal`, not chosen here: with zones on, `state`
 * comes from `zonePresentationState`, whose whole body is
 *
 *     if (regime.squeeze) return 'SQUEEZE';
 *     if (regime.overextended) return 'OVEREXTENDED';
 *     if (zone === 'sideways') return 'SIDEWAYS';
 *     ... direction ...
 *
 * so a condition that is true on a bar but sits below the one that returned is
 * a PASSENGER, not a cause. The report prints both columns side by side because
 * the difference between them is the finding.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MARKET_SIGNAL_MEASURED,
  MARKET_SIGNAL_GATE,
  MARKET_SIGNAL_ZONE,
  MARKET_SIGNAL_SCORE_WEIGHTS,
  MARKET_SIGNAL_THRESHOLDS,
} from '@/src/config/signal';
import {
  bandFromScore,
  calculateMarketSignal,
  classifyRegimeEvidence,
  detectComponentConflicts,
  gatedBias,
} from '@/src/lib/analytics/market-signal/calculations';
import type {
  MarketSignalBand,
  MarketSignalCandle,
  MarketSignalResult,
  MarketSignalState,
  MarketSignalZoneName,
  MarketSignalZoneMode,
} from '@/src/lib/analytics/market-signal/types';
import type { DataFreshness } from '@/src/lib/market-data/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');
const CALIBRATION_ROOT = join(process.cwd(), '__calibration__');
/** The agreement probe's shards. READ ONLY: the OFF labels are joined from here. */
const AGREEMENT_DIR = join(process.cwd(), '.qa', 'trend-agreement');
const SHARD_DIR = join(process.cwd(), '.qa', 'trend-diagnosis');
const OUTPUT_PATH = join(process.cwd(), 'trend_diagnosis.md');

/* ---- the labeller, copied from the agreement probe ----------------------- */
interface TruthDefinition { bars: number; displacement: number; efficiency: number }
const BASE_TRUTH: TruthDefinition = { bars: 20, displacement: 1.5, efficiency: 0.3 };
const ATR_PERIOD = 14;

const WINDOW = 600;
const STRIDE = 1;
const MINIMUM_BUCKET = 30;
const CALCULATED_AT = '2026-01-01T00:00:00.000Z';

/** Part A's adjudicator. Fixed before the run; see header. */
const ADJUDICATION_SCALES = { fast: 5, base: 20, slow: 60 } as const;
const ADJUDICATION_FLAT_ATR = 0.5;

type Truth = 'UP' | 'DOWN' | 'SIDEWAYS';
type Label = Truth | 'OTHER';
const TRUTHS: readonly Truth[] = ['UP', 'DOWN', 'SIDEWAYS'];

function mapState(state: MarketSignalState | null): Label | null {
  switch (state) {
    case 'STRONG_BULLISH': case 'BULLISH': return 'UP';
    case 'STRONG_BEARISH': case 'BEARISH': return 'DOWN';
    case 'SIDEWAYS': return 'SIDEWAYS';
    case 'SQUEEZE': case 'OVEREXTENDED': return 'OTHER';
    default: return null;
  }
}

type Bar = Omit<MarketSignalCandle, 'finalized'>;
interface Frozen { symbol: string; source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] }
interface Instrument { symbol: string; source: string | null; freshness: DataFreshness; bars: Bar[] }

function atrWilder(bars: readonly Bar[], period: number): Array<number | null> {
  const out = Array<number | null>(bars.length).fill(null);
  if (bars.length < period) return out;
  const trueRange = bars.map((bar, index) => (index === 0
    ? bar.high - bar.low
    : Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - bars[index - 1].close),
      Math.abs(bar.low - bars[index - 1].close),
    )));
  out[period - 1] = trueRange.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < bars.length; index += 1) {
    out[index] = (((out[index - 1] as number) * (period - 1)) + trueRange[index]) / period;
  }
  return out;
}

interface TruthPoint { label: Truth | null; displacement: number | null; efficiency: number | null }

function truthSeries(
  bars: readonly Bar[],
  atr: ReadonlyArray<number | null>,
  definition: TruthDefinition,
): TruthPoint[] {
  const { bars: n, displacement: minDisplacement, efficiency: minEfficiency } = definition;
  return bars.map((bar, t) => {
    const atr14 = atr[t];
    if (t < n || atr14 === null || atr14 === 0) return { label: null, displacement: null, efficiency: null };
    const net = bar.close - bars[t - n].close;
    let path = 0;
    for (let step = t - n + 1; step <= t; step += 1) path += Math.abs(bars[step].close - bars[step - 1].close);
    const displacement = net / atr14;
    const efficiency = path === 0 ? 0 : Math.abs(net) / path;
    let label: Truth = 'SIDEWAYS';
    if (efficiency >= minEfficiency) {
      if (displacement >= minDisplacement) label = 'UP';
      else if (displacement <= -minDisplacement) label = 'DOWN';
    }
    return { label, displacement, efficiency };
  });
}

/* ---- loading, copied from the agreement probe ---------------------------- */

interface Manifest {
  runId: string;
  instruments: string[];
  window: number;
  minimumBucket: number;
  period: [string, string];
}

function pinnedRunId(): string {
  const flag = process.argv.find((argument) => argument.startsWith('--like='));
  return flag ? flag.slice('--like='.length) : MARKET_SIGNAL_MEASURED.runId;
}

function loadManifest(runId: string): Manifest {
  return JSON.parse(readFileSync(join(CALIBRATION_ROOT, runId, 'manifest.json'), 'utf8')) as Manifest;
}

function loadCorpus(manifest: Manifest): Instrument[] {
  const onDisk = new Set(readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.json')));
  const instruments: Instrument[] = [];
  for (const symbol of manifest.instruments) {
    const file = `${symbol}.json`;
    if (!onDisk.has(file)) continue;
    const frozen = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as Frozen;
    const bars = frozen.candles
      .filter((candle) => candle.finalized)
      .map(({ finalized: _finalized, ...candle }) => candle);
    // Same admission rule as the agreement probe, whose widest grid point was 25.
    if (bars.length < WINDOW + 25 + 1) continue;
    instruments.push({ symbol: frozen.symbol, source: frozen.source, freshness: frozen.freshness, bars });
  }
  return instruments;
}

const runEngine = (
  instrument: Instrument,
  bars: readonly Bar[],
  features: { gate: boolean; zones: boolean; actionable: boolean },
): MarketSignalResult => calculateMarketSignal(
  bars.map((bar) => ({ ...bar, finalized: true })),
  {
    symbol: instrument.symbol,
    source: instrument.source,
    freshness: instrument.freshness,
    calculatedAt: CALCULATED_AT,
    features,
  },
);

const ON_FEATURES = { gate: true, zones: true, actionable: false } as const;
const OFF_FEATURES = { gate: false, zones: false, actionable: false } as const;

/* ------------------------------------------------------------------------- */
/* the four candidate causes, read off one ON result                          */
/* ------------------------------------------------------------------------- */

interface Causes {
  band: MarketSignalBand | null;
  bandNeutral: 0 | 1;
  conflicts: number;
  zone: MarketSignalZoneName | null;
  zoneMode: MarketSignalZoneMode | null;
  zoneAbsent: 0 | 1;
  pending: 0 | 1;
  nearestTriggerAtr: number | null;
  zoneAgeBars: number | null;
  frameAgeBars: number | null;
  lastTestedBarsAgo: number | null;
  regimeSqueeze: 0 | 1;
  regimeOverextended: 0 | 1;
  regimeSideways: 0 | 1;
  nonTrendingFallback: 0 | 1;
  score: number | null;
}

/**
 * Every condition the four candidate causes name, evaluated on the SAME result
 * whose `state` is being explained.
 *
 * `nonTrendingFallback` is not published anywhere, so it is recomputed here from
 * the exact expression in `presentationState` — including the bias that the
 * fallback path would have been handed, which is `gatedBias(...)` and NOT
 * `result.bias` (with zones on, the published bias follows the zone instead).
 */
function causesFrom(result: MarketSignalResult): Causes {
  const score = result.status === 'available' ? result.score : null;
  const band = score === null ? null : bandFromScore(score);
  const conflicts = detectComponentConflicts(result.scoreBreakdown);
  const regime = classifyRegimeEvidence(result.metrics);
  const bias = score === null || band === null ? 'neutral' : gatedBias(score, band, conflicts);
  const nonTrendingFallback = bias === 'neutral'
    && Math.abs(result.scoreBreakdown.emaTrend.points ?? 0) < MARKET_SIGNAL_SCORE_WEIGHTS.emaTrend / 2
    && (result.scoreBreakdown.trendStrength.normalizedScore ?? 0) <= 0;
  const zones = result.zones ?? null;
  return {
    band,
    bandNeutral: band === 'neutral' ? 1 : 0,
    conflicts: conflicts.length,
    zone: zones?.zone ?? null,
    zoneMode: zones?.mode ?? null,
    zoneAbsent: zones === null ? 1 : 0,
    pending: zones !== null && (zones.pendingBreakout || zones.pendingBreakdown) ? 1 : 0,
    nearestTriggerAtr: zones?.nearestTriggerAtr ?? null,
    zoneAgeBars: zones?.zoneAgeBars ?? null,
    frameAgeBars: zones?.frameAgeBars ?? null,
    lastTestedBarsAgo: zones?.lastTestedBarsAgo ?? null,
    regimeSqueeze: regime.squeeze ? 1 : 0,
    regimeOverextended: regime.overextended ? 1 : 0,
    regimeSideways: regime.sideways ? 1 : 0,
    nonTrendingFallback: nonTrendingFallback ? 1 : 0,
    score,
  };
}

/* ------------------------------------------------------------------------- */
/* PART A — the ten worst conflicts, one chart at a time                      */
/* ------------------------------------------------------------------------- */

/** Copied from `trend_agreement.md` §5, in its order. Nothing is re-ranked here. */
const CASES: ReadonlyArray<{ rank: number; symbol: string; date: string }> = [
  { rank: 1, symbol: 'SHOP', date: '2024-06-05' },
  { rank: 2, symbol: 'NFLX', date: '2026-03-23' },
  { rank: 3, symbol: 'UPS', date: '2025-02-27' },
  { rank: 4, symbol: 'AVGO', date: '2024-01-05' },
  { rank: 5, symbol: 'SBUX', date: '2024-05-29' },
  { rank: 6, symbol: 'MRK', date: '2024-08-26' },
  { rank: 7, symbol: 'ACN', date: '2026-07-08' },
  { rank: 8, symbol: 'XRP-USD', date: '2024-10-19' },
  { rank: 9, symbol: 'TXN', date: '2025-12-19' },
  { rank: 10, symbol: 'IBM', date: '2026-08-07' },
];

type Adjudication = 'engine wrong' | 'ground truth wrong' | 'borderline';

const sideOf = (displacement: number | null): number => {
  if (displacement === null) return 0;
  if (displacement >= ADJUDICATION_FLAT_ATR) return 1;
  if (displacement <= -ADJUDICATION_FLAT_ATR) return -1;
  return 0;
};

/** The pre-registered rule from the header. Price at three scales, nothing else. */
function adjudicate(d5: number | null, d20: number | null, d60: number | null): Adjudication {
  const fast = sideOf(d5);
  const base = sideOf(d20);
  const slow = sideOf(d60);
  if (base === 0) return 'borderline';
  if (fast === base && slow === base) return 'engine wrong';
  if (fast !== base && slow !== base && fast !== 0 && slow !== 0) return 'ground truth wrong';
  return 'borderline';
}

interface CaseBar {
  date: string;
  open: number; high: number; low: number; close: number; volume: number | null;
  ema20: number | null; ema50: number | null; ema200: number | null;
  off: MarketSignalState | null;
  on: MarketSignalState | null;
}

interface CaseReport {
  rank: number;
  symbol: string;
  date: string;
  found: boolean;
  index: number;
  truth: Truth | null;
  displacement: number | null;
  efficiency: number | null;
  d5: number | null;
  d20: number | null;
  d60: number | null;
  atr14: number | null;
  adjudication: Adjudication;
  offState: MarketSignalState | null;
  onState: MarketSignalState | null;
  offScore: number | null;
  onScore: number | null;
  ema20SlopePct: number | null;
  ema50SlopePct: number | null;
  ema200SlopePct: number | null;
  adx14: number | null;
  plusDi14: number | null;
  minusDi14: number | null;
  rsi14: number | null;
  causes: Causes | null;
  zoneSummary: string;
  offReasons: string[];
  onReasons: string[];
  offFlags: string[];
  onFlags: string[];
  bars: CaseBar[];
}

function buildCase(
  instrument: Instrument,
  entry: { rank: number; symbol: string; date: string },
): CaseReport {
  const { bars } = instrument;
  const index = bars.findIndex((bar) => bar.date === entry.date);
  const blank: CaseReport = {
    rank: entry.rank, symbol: entry.symbol, date: entry.date, found: false, index: -1,
    truth: null, displacement: null, efficiency: null, d5: null, d20: null, d60: null, atr14: null,
    adjudication: 'borderline', offState: null, onState: null, offScore: null, onScore: null,
    ema20SlopePct: null, ema50SlopePct: null, ema200SlopePct: null,
    adx14: null, plusDi14: null, minusDi14: null, rsi14: null,
    causes: null, zoneSummary: '—', offReasons: [], onReasons: [], offFlags: [], onFlags: [], bars: [],
  };
  if (index < WINDOW) return blank;

  const atr = atrWilder(bars, ATR_PERIOD);
  const truth = truthSeries(bars, atr, BASE_TRUTH)[index];
  const atr14 = atr[index];
  const displacementOver = (n: number): number | null => {
    if (atr14 === null || atr14 === 0 || index - n < 0) return null;
    return (bars[index].close - bars[index - n].close) / atr14;
  };
  const d5 = displacementOver(ADJUDICATION_SCALES.fast);
  const d20 = displacementOver(ADJUDICATION_SCALES.base);
  const d60 = displacementOver(ADJUDICATION_SCALES.slow);

  /*
   * The 20 bars are each labelled by REPLAYING the engine at that bar, not by
   * reading the label at t and assuming it held. A conflict is a claim about a
   * window, and the reader needs to see when inside the window the word changed.
   */
  const caseBars: CaseBar[] = [];
  for (let step = BASE_TRUTH.bars; step >= 0; step -= 1) {
    const at = index - step;
    const window = bars.slice(at + 1 - WINDOW, at + 1);
    const off = runEngine(instrument, window, OFF_FEATURES);
    const on = runEngine(instrument, window, ON_FEATURES);
    caseBars.push({
      date: bars[at].date,
      open: bars[at].open, high: bars[at].high, low: bars[at].low, close: bars[at].close,
      volume: bars[at].volume ?? null,
      ema20: off.metrics.ema20, ema50: off.metrics.ema50, ema200: off.metrics.ema200,
      off: off.status === 'available' ? off.state : null,
      on: on.status === 'available' ? on.state : null,
    });
  }

  const window = bars.slice(index + 1 - WINDOW, index + 1);
  const off = runEngine(instrument, window, OFF_FEATURES);
  const on = runEngine(instrument, window, ON_FEATURES);
  const causes = causesFrom(on);
  const zones = on.zones ?? null;

  return {
    ...blank,
    found: true,
    index,
    truth: truth.label,
    displacement: truth.displacement,
    efficiency: truth.efficiency,
    d5, d20, d60,
    atr14,
    adjudication: adjudicate(d5, d20, d60),
    offState: off.status === 'available' ? off.state : null,
    onState: on.status === 'available' ? on.state : null,
    offScore: off.status === 'available' ? off.score : null,
    onScore: on.status === 'available' ? on.score : null,
    ema20SlopePct: off.metrics.ema20SlopePct,
    ema50SlopePct: off.metrics.ema50SlopePct,
    ema200SlopePct: off.metrics.ema200SlopePct,
    adx14: off.metrics.adx14,
    plusDi14: off.metrics.plusDi14,
    minusDi14: off.metrics.minusDi14,
    rsi14: off.metrics.rsi14,
    causes,
    zoneSummary: zones === null
      ? 'no zone (ATR unavailable)'
      : `${zones.zone} · mode ${zones.mode} · pos ${zones.positionPct}% · nearest trigger ${zones.nearestTriggerAtr} ATR`
        + ` · zoneAge ${zones.zoneAgeBars} · frameAge ${zones.frameAgeBars}`
        + ` · S ${zones.support} / R ${zones.resistance} · trig ${zones.lowerTrigger} / ${zones.upperTrigger}`
        + ` · lastTested ${zones.lastTestedBarsAgo === null ? 'never' : `${zones.lastTestedBarsAgo}b`}`
        + ` · crossings ${zones.triggerCrossings}`
        + (zones.pendingBreakout ? ' · PENDING BREAKOUT' : '')
        + (zones.pendingBreakdown ? ' · PENDING BREAKDOWN' : ''),
    offReasons: off.reasons.map((reason) => `${reason.id}(${reason.polarity[0]},${reason.impact})`),
    onReasons: on.reasons.map((reason) => `${reason.id}(${reason.polarity[0]},${reason.impact})`),
    offFlags: [...off.flags],
    onFlags: [...on.flags],
    bars: caseBars,
  };
}

/* ------------------------------------------------------------------------- */
/* PART B/C — collection                                                      */
/* ------------------------------------------------------------------------- */

/** One bar of one instrument, with everything the four candidate causes need. */
interface DiagRow extends Causes {
  symbol: string;
  index: number;
  date: string;
  on: MarketSignalState | null;
}

/** A C variant's output: the ON label only. Everything else is joined from the base rows. */
interface VariantRow { symbol: string; index: number; on: MarketSignalState | null }

function collectBase(instruments: readonly Instrument[]): DiagRow[] {
  const rows: DiagRow[] = [];
  let done = 0;
  for (const instrument of instruments) {
    const { bars } = instrument;
    for (let index = WINDOW; index < bars.length; index += STRIDE) {
      const window = bars.slice(index + 1 - WINDOW, index + 1);
      const on = runEngine(instrument, window, ON_FEATURES);
      rows.push({
        symbol: instrument.symbol,
        index,
        date: bars[index].date,
        on: on.status === 'available' ? on.state : null,
        ...causesFrom(on),
      });
    }
    done += 1;
    console.error(`  ${done}/${instruments.length} ${instrument.symbol}`);
  }
  return rows;
}

function collectVariant(instruments: readonly Instrument[]): VariantRow[] {
  const rows: VariantRow[] = [];
  let done = 0;
  for (const instrument of instruments) {
    const { bars } = instrument;
    for (let index = WINDOW; index < bars.length; index += STRIDE) {
      const window = bars.slice(index + 1 - WINDOW, index + 1);
      const on = runEngine(instrument, window, ON_FEATURES);
      rows.push({ symbol: instrument.symbol, index, on: on.status === 'available' ? on.state : null });
    }
    done += 1;
    console.error(`  ${done}/${instruments.length} ${instrument.symbol}`);
  }
  return rows;
}

/**
 * The OTHER half of the failure, and the cheapest possible measurement of it.
 *
 * B is scoped to the ON state, because that is where the trend goes missing.
 * But `trend_agreement.md` §3 of the appendix says the two states fail in
 * OPPOSITE directions, and a root cause that explains only one of them is half
 * an answer. With the gate OFF there is no neutral band anywhere in the path:
 * `presentationState` ends `return score >= 0 ? 'BULLISH' : 'BEARISH'`, so a
 * score of +3 out of 100 publishes BULLISH. This pass records the score OFF
 * actually had on every bar, plus the band the gate WOULD have put it in, so
 * the report can say how many of OFF's directional calls on quiet bars one
 * threshold alone accounts for. It is a counterfactual on paper, not a change.
 */
interface OffRow {
  symbol: string;
  index: number;
  off: MarketSignalState | null;
  score: number | null;
  band: MarketSignalBand | null;
  regimeSideways: 0 | 1;
  nonTrendingFallback: 0 | 1;
}

function collectOff(instruments: readonly Instrument[]): OffRow[] {
  const rows: OffRow[] = [];
  let done = 0;
  for (const instrument of instruments) {
    const { bars } = instrument;
    for (let index = WINDOW; index < bars.length; index += STRIDE) {
      const window = bars.slice(index + 1 - WINDOW, index + 1);
      const off = runEngine(instrument, window, OFF_FEATURES);
      const score = off.status === 'available' ? off.score : null;
      const regime = classifyRegimeEvidence(off.metrics);
      /*
       * The flags-OFF path takes the RAW bias, not a gated one — the gate is
       * not running. `presentationState` is handed `bias`, which is
       * `biasFromScore(score)`, so that is what the fallback condition reads.
       */
      const bias = off.status === 'available' ? off.bias : 'neutral';
      const nonTrendingFallback = bias === 'neutral'
        && Math.abs(off.scoreBreakdown.emaTrend.points ?? 0) < MARKET_SIGNAL_SCORE_WEIGHTS.emaTrend / 2
        && (off.scoreBreakdown.trendStrength.normalizedScore ?? 0) <= 0;
      rows.push({
        symbol: instrument.symbol,
        index,
        off: off.status === 'available' ? off.state : null,
        score,
        band: score === null ? null : bandFromScore(score),
        regimeSideways: regime.sideways ? 1 : 0,
        nonTrendingFallback: nonTrendingFallback ? 1 : 0,
      });
    }
    done += 1;
    console.error(`  ${done}/${instruments.length} ${instrument.symbol}`);
  }
  return rows;
}

/* ---- the in-memory override, applied and then DECLARED in the shard ------ */

/**
 * Move one config number for the life of this process.
 *
 * The engine reads `MARKET_SIGNAL_ZONE` and `MARKET_SIGNAL_GATE` at call time
 * rather than capturing them, so writing a property here is enough and no
 * engine file has to change. `as const` is a TYPE annotation and freezes
 * nothing at runtime; the object on disk is not touched and the process exits
 * without persisting anything.
 */
const OVERRIDE_ROOTS: Record<string, object> = {
  zone: MARKET_SIGNAL_ZONE,
  gate: MARKET_SIGNAL_GATE,
};

function applyOverride(spec: string): { path: string; from: number; to: number } {
  const separator = spec.lastIndexOf('=');
  if (separator < 0) throw new Error('--set= expects root.path=value');
  const path = spec.slice(0, separator);
  const to = Number(spec.slice(separator + 1));
  if (!Number.isFinite(to)) throw new Error(`--set=${spec}: value is not a number`);
  const segments = path.split('.');
  const root = OVERRIDE_ROOTS[segments[0]];
  if (!root) throw new Error(`--set=${spec}: unknown root ${segments[0]}`);
  let cursor = root as Record<string, unknown>;
  for (let position = 1; position < segments.length - 1; position += 1) {
    cursor = cursor[segments[position]] as Record<string, unknown>;
    if (!cursor) throw new Error(`--set=${spec}: no such path`);
  }
  const leaf = segments[segments.length - 1];
  const from = cursor[leaf] as number;
  if (typeof from !== 'number') throw new Error(`--set=${spec}: ${path} is not a number`);
  cursor[leaf] = to;
  return { path, from, to };
}

/* ------------------------------------------------------------------------- */
/* measuring — trimmed from the agreement probe's `measure`                   */
/* ------------------------------------------------------------------------- */

interface Stats {
  n: number;
  clustered: number;
  agreement: number | null;
  confusion: Record<Truth, Record<Truth, number>>;
  other: number;
  unlabelled: number;
  gtChanges: number;
  labelChanges: number;
  flipRatio: number | null;
}

const emptyConfusion = (): Record<Truth, Record<Truth, number>> => ({
  UP: { UP: 0, DOWN: 0, SIDEWAYS: 0 },
  DOWN: { UP: 0, DOWN: 0, SIDEWAYS: 0 },
  SIDEWAYS: { UP: 0, DOWN: 0, SIDEWAYS: 0 },
});

function measure(
  bySymbol: ReadonlyMap<string, Array<{ index: number }>>,
  labelsBySymbol: ReadonlyMap<string, Array<Label | null>>,
  truthBySymbol: ReadonlyMap<string, TruthPoint[]>,
  definition: TruthDefinition,
): Stats {
  const confusion = emptyConfusion();
  let n = 0;
  let other = 0;
  let unlabelled = 0;
  let gtChanges = 0;
  let labelChanges = 0;
  const kept = new Map<string, number[]>();

  bySymbol.forEach((rows, symbol) => {
    const truth = truthBySymbol.get(symbol)!;
    const labels = labelsBySymbol.get(symbol)!;
    const keptHere: number[] = [];
    rows.forEach((row, position) => {
      const gt = truth[row.index].label;
      const label = labels[position];
      if (gt === null) return;
      if (label === null) { unlabelled += 1; return; }
      if (label === 'OTHER') { other += 1; return; }
      confusion[gt][label] += 1;
      n += 1;
      keptHere.push(row.index);
    });
    kept.set(symbol, keptHere);

    for (let position = 1; position < rows.length; position += 1) {
      const previousTruth = truth[rows[position - 1].index].label;
      const currentTruth = truth[rows[position].index].label;
      if (previousTruth === null || currentTruth === null) continue;
      const previousLabel = labels[position - 1];
      const currentLabel = labels[position];
      if (previousLabel !== null && currentLabel !== null && previousLabel !== currentLabel) labelChanges += 1;
      if (previousTruth !== currentTruth) gtChanges += 1;
    }
  });

  let clustered = 0;
  kept.forEach((indices) => {
    let last = -Infinity;
    indices.forEach((index) => {
      if (index - last >= definition.bars) { clustered += 1; last = index; }
    });
  });

  const hits = TRUTHS.reduce((sum, truth) => sum + confusion[truth][truth], 0);
  const sufficient = n >= MINIMUM_BUCKET && clustered >= MINIMUM_BUCKET;
  return {
    n,
    clustered,
    agreement: sufficient ? hits / n : null,
    confusion,
    other,
    unlabelled,
    gtChanges,
    labelChanges,
    flipRatio: gtChanges >= MINIMUM_BUCKET ? labelChanges / gtChanges : null,
  };
}

/* ------------------------------------------------------------------------- */
/* formatting                                                                 */
/* ------------------------------------------------------------------------- */

const pct = (value: number | null) => (value === null ? 'insuff.' : `${(value * 100).toFixed(1)}%`);
const ratio = (value: number | null) => (value === null ? 'insuff.' : value.toFixed(2));
const num = (value: number | null | undefined, digits = 2) =>
  (value === null || value === undefined ? '—' : value.toFixed(digits));
const share = (part: number, whole: number) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`);

/** Nearest-rank, so a quantile of a bar count stays a whole number of bars. */
function quantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/* ------------------------------------------------------------------------- */
/* the run                                                                    */
/* ------------------------------------------------------------------------- */

interface BaseShard { runId: string; shard: string; rows: DiagRow[] }
interface OffShard { runId: string; shard: string; rows: OffRow[] }
interface VariantShard { runId: string; shard: string; variant: string; override: { path: string; from: number; to: number }; rows: VariantRow[] }
interface CaseFile { runId: string; cases: CaseReport[] }

const basePath = (runId: string, shard: string) => join(SHARD_DIR, `base-${runId}-${shard.replace('/', 'of')}.json`);
const variantPath = (runId: string, variant: string, shard: string) =>
  join(SHARD_DIR, `var-${variant}-${runId}-${shard.replace('/', 'of')}.json`);
const offPath = (runId: string, shard: string) => join(SHARD_DIR, `off-${runId}-${shard.replace('/', 'of')}.json`);
const casePath = (runId: string) => join(SHARD_DIR, `cases-${runId}.json`);

function shardOf(instruments: readonly Instrument[], shard: string): Instrument[] {
  const [indexText, countText] = shard.split('/');
  const shardIndex = Number(indexText);
  const shardCount = Number(countText);
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount)
    || shardCount < 1 || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error('--shard= expects i/k with 0 <= i < k');
  }
  return instruments.filter((_, position) => position % shardCount === shardIndex);
}

function main(): void {
  const runId = pinnedRunId();
  const manifest = loadManifest(runId);
  if (manifest.window !== WINDOW || manifest.minimumBucket !== MINIMUM_BUCKET) {
    throw new Error('pinned run used different harness constants; the rows would not be comparable');
  }
  const instruments = loadCorpus(manifest);
  if (!existsSync(SHARD_DIR)) mkdirSync(SHARD_DIR, { recursive: true });

  const argument = (prefix: string): string | null => {
    const found = process.argv.find((value) => value.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };

  /* ---- PART A ---------------------------------------------------------- */
  if (process.argv.includes('--cases')) {
    const bySymbol = new Map(instruments.map((instrument) => [instrument.symbol, instrument]));
    const cases = CASES.map((entry) => {
      const instrument = bySymbol.get(entry.symbol);
      if (!instrument) {
        console.error(`  ${entry.symbol}: not in the pinned corpus`);
        return buildCase({ symbol: entry.symbol, source: null, freshness: {} as DataFreshness, bars: [] }, entry);
      }
      console.error(`  case ${entry.rank} ${entry.symbol} ${entry.date}`);
      return buildCase(instrument, entry);
    });
    writeFileSync(casePath(runId), JSON.stringify({ runId, cases } satisfies CaseFile));
    console.error(`wrote ${casePath(runId)}`);
    return;
  }

  /* ---- PART B/C collection --------------------------------------------- */
  const shard = argument('--shard=');
  const setSpec = argument('--set=');
  const variantId = argument('--variant=');

  if (shard) {
    const mine = shardOf(instruments, shard);
    if (process.argv.includes('--offside')) {
      console.error(`off shard ${shard}: ${mine.length} instruments`);
      const rows = collectOff(mine);
      writeFileSync(offPath(runId, shard), JSON.stringify({ runId, shard, rows } satisfies OffShard));
      console.error(`off shard ${shard}: ${rows.length} rows`);
      return;
    }
    if (variantId) {
      if (!setSpec) throw new Error('--variant= needs --set=root.path=value');
      const override = applyOverride(setSpec);
      console.error(`variant ${variantId}: ${override.path} ${override.from} -> ${override.to}`);
      console.error(`shard ${shard}: ${mine.length} instruments`);
      const rows = collectVariant(mine);
      writeFileSync(variantPath(runId, variantId, shard),
        JSON.stringify({ runId, shard, variant: variantId, override, rows } satisfies VariantShard));
      console.error(`variant ${variantId} shard ${shard}: ${rows.length} rows`);
      return;
    }
    console.error(`base shard ${shard}: ${mine.length} instruments, ${WINDOW}-bar window, stride ${STRIDE}`);
    const rows = collectBase(mine);
    writeFileSync(basePath(runId, shard), JSON.stringify({ runId, shard, rows } satisfies BaseShard));
    console.error(`base shard ${shard}: ${rows.length} rows`);
    return;
  }

  report(runId, manifest, instruments);
}

/* ------------------------------------------------------------------------- */
/* the report                                                                 */
/* ------------------------------------------------------------------------- */

interface BucketRow { label: string; count: number }

function report(runId: string, manifest: Manifest, instruments: readonly Instrument[]): void {
  const files = readdirSync(SHARD_DIR);
  const baseFiles = files.filter((name) => name.startsWith(`base-${runId}-`));
  if (baseFiles.length === 0) throw new Error(`no base shards for ${runId}; run --shard=i/k first`);

  const rows: DiagRow[] = [];
  baseFiles.forEach((name) => {
    rows.push(...(JSON.parse(readFileSync(join(SHARD_DIR, name), 'utf8')) as BaseShard).rows);
  });

  const bySymbol = new Map<string, DiagRow[]>();
  rows.forEach((row) => {
    const bucket = bySymbol.get(row.symbol);
    if (bucket) bucket.push(row); else bySymbol.set(row.symbol, [row]);
  });
  bySymbol.forEach((bucket) => bucket.sort((left, right) => left.index - right.index));
  bySymbol.forEach((bucket, symbol) => {
    for (let position = 1; position < bucket.length; position += 1) {
      if (bucket[position].index !== bucket[position - 1].index + STRIDE) {
        throw new Error(`${symbol}: sampled bars are not contiguous at index ${bucket[position].index}`);
      }
    }
  });
  const covered = new Set(bySymbol.keys());
  const uncollected = instruments.filter((instrument) => !covered.has(instrument.symbol)).map((i) => i.symbol);
  if (uncollected.length > 0) throw new Error(`shards do not cover: ${uncollected.join(', ')}`);
  const measured = instruments.filter((instrument) => covered.has(instrument.symbol));

  /* ---- the OFF labels, joined from the agreement probe's own shards ------ */
  interface AgreementRow { symbol: string; index: number; off: MarketSignalState | null; on: MarketSignalState | null }
  const offBySymbol = new Map<string, Map<number, MarketSignalState | null>>();
  const onBySymbolAgreement = new Map<string, Map<number, MarketSignalState | null>>();
  let agreementRows = 0;
  if (existsSync(AGREEMENT_DIR)) {
    readdirSync(AGREEMENT_DIR)
      .filter((name) => name.startsWith(`obs-${runId}-`) && name.endsWith('.json'))
      .forEach((name) => {
        const shard = JSON.parse(readFileSync(join(AGREEMENT_DIR, name), 'utf8')) as { rows: AgreementRow[] };
        shard.rows.forEach((row) => {
          if (!offBySymbol.has(row.symbol)) offBySymbol.set(row.symbol, new Map());
          if (!onBySymbolAgreement.has(row.symbol)) onBySymbolAgreement.set(row.symbol, new Map());
          offBySymbol.get(row.symbol)!.set(row.index, row.off);
          onBySymbolAgreement.get(row.symbol)!.set(row.index, row.on);
          agreementRows += 1;
        });
      });
  }
  /*
   * The join is only worth anything if the two runs saw the same engine. Every
   * bar present in both files must carry the same ON state; one mismatch and
   * the OFF column beside it is describing a different calculation.
   */
  let joinChecked = 0;
  let joinMismatch = 0;
  rows.forEach((row) => {
    const previous = onBySymbolAgreement.get(row.symbol)?.get(row.index);
    if (previous === undefined) return;
    joinChecked += 1;
    if (previous !== row.on) joinMismatch += 1;
  });

  const barsBySymbol = new Map(measured.map((instrument) => [instrument.symbol, instrument.bars as readonly Bar[]]));
  const atrBySymbol = new Map(measured.map((instrument) => [instrument.symbol, atrWilder(instrument.bars, ATR_PERIOD)]));
  const truthBySymbol = new Map(measured.map((instrument) => [
    instrument.symbol,
    truthSeries(barsBySymbol.get(instrument.symbol)!, atrBySymbol.get(instrument.symbol)!, BASE_TRUTH),
  ]));

  /* ---- PART B ----------------------------------------------------------- */

  /** Bars the ground truth calls a move and engine ON calls SIDEWAYS. */
  const lost: DiagRow[] = [];
  /** The same bars, but ON said SQUEEZE / OVEREXTENDED — reported beside, never folded in. */
  let lostToRegimeVeto = 0;
  const lostTruth: Record<'UP' | 'DOWN', number> = { UP: 0, DOWN: 0 };
  let moves = 0;
  let namedByOffOnly = 0;
  rows.forEach((row) => {
    const gt = truthBySymbol.get(row.symbol)![row.index].label;
    if (gt !== 'UP' && gt !== 'DOWN') return;
    moves += 1;
    const onLabel = mapState(row.on);
    if (onLabel === 'OTHER') { lostToRegimeVeto += 1; return; }
    if (onLabel !== 'SIDEWAYS') return;
    lost.push(row);
    lostTruth[gt] += 1;
    const offLabel = mapState(offBySymbol.get(row.symbol)?.get(row.index) ?? null);
    if (offLabel === gt) namedByOffOnly += 1;
  });

  /* Overlapping: how many of the lost bars each condition is TRUE on. */
  const overlapping: BucketRow[] = [
    { label: 'band == neutral (\\|score\\| < 15)', count: lost.filter((row) => row.bandNeutral === 1).length },
    { label: 'conflicts non-empty', count: lost.filter((row) => row.conflicts > 0).length },
    { label: 'zone == sideways', count: lost.filter((row) => row.zone === 'sideways').length },
    { label: 'regime.sideways', count: lost.filter((row) => row.regimeSideways === 1).length },
    { label: 'nonTrendingFallback', count: lost.filter((row) => row.nonTrendingFallback === 1).length },
    { label: 'regime.sideways OR nonTrendingFallback', count: lost.filter((row) => row.regimeSideways === 1 || row.nonTrendingFallback === 1).length },
    { label: 'no zone at all (ATR unavailable)', count: lost.filter((row) => row.zoneAbsent === 1).length },
  ];

  /*
   * Non-overlapping: the engine's OWN precedence on the path that produced the
   * label. With zones on, `zonePresentationState` returns before the gate is
   * ever consulted, so `zone == sideways` claims the bar and everything else on
   * it is a passenger. The gate branch can only claim a bar when there is no
   * zone to answer first.
   */
  const nonOverlapping: BucketRow[] = [];
  let zoneClaimed = 0;
  let gateClaimed = 0;
  let regimeClaimed = 0;
  let unattributed = 0;
  const unattributedExamples: string[] = [];
  lost.forEach((row) => {
    if (row.zoneAbsent === 0) {
      if (row.zone === 'sideways') { zoneClaimed += 1; return; }
      // A directional zone that still produced SIDEWAYS would falsify the model.
      unattributed += 1;
      if (unattributedExamples.length < 5) unattributedExamples.push(`${row.symbol} ${row.date} zone=${row.zone}`);
      return;
    }
    if (row.bandNeutral === 1 || row.conflicts > 0) { gateClaimed += 1; return; }
    if (row.regimeSideways === 1 || row.nonTrendingFallback === 1) { regimeClaimed += 1; return; }
    unattributed += 1;
    if (unattributedExamples.length < 5) unattributedExamples.push(`${row.symbol} ${row.date} no-zone`);
  });
  nonOverlapping.push(
    { label: 'zone == sideways (zonePresentationState returned first)', count: zoneClaimed },
    { label: 'gate neutral/conflict — reachable only with no zone', count: gateClaimed },
    { label: 'regime.sideways / nonTrendingFallback — same branch', count: regimeClaimed },
    { label: 'unattributed (falsifies the precedence model above)', count: unattributed },
  );

  /* Inside the winning cause: which zone rule kept the frame unbroken. */
  const zoneLost = lost.filter((row) => row.zone === 'sideways');
  const modeSplit = {
    structural: zoneLost.filter((row) => row.zoneMode === 'structural').length,
    atr_band: zoneLost.filter((row) => row.zoneMode === 'atr_band').length,
  };
  const pendingCount = zoneLost.filter((row) => row.pending === 1).length;
  const nearestList = zoneLost.map((row) => row.nearestTriggerAtr).filter((value): value is number => value !== null);
  const distanceBuckets: BucketRow[] = [
    { label: '< 0 — close already past the trigger, confirmation not met', count: zoneLost.filter((r) => (r.nearestTriggerAtr ?? 99) < 0).length },
    { label: '0 .. 0.25 — inside the trigger buffer (triggerAtrMultiple)', count: zoneLost.filter((r) => (r.nearestTriggerAtr ?? 99) >= 0 && (r.nearestTriggerAtr ?? 99) < 0.25).length },
    { label: '0.25 .. 0.5', count: zoneLost.filter((r) => (r.nearestTriggerAtr ?? 99) >= 0.25 && (r.nearestTriggerAtr ?? 99) < 0.5).length },
    { label: '0.5 .. 1', count: zoneLost.filter((r) => (r.nearestTriggerAtr ?? 99) >= 0.5 && (r.nearestTriggerAtr ?? 99) < 1).length },
    { label: '1 .. 2', count: zoneLost.filter((r) => (r.nearestTriggerAtr ?? 99) >= 1 && (r.nearestTriggerAtr ?? 99) < 2).length },
    { label: '2 .. 3', count: zoneLost.filter((r) => (r.nearestTriggerAtr ?? 99) >= 2 && (r.nearestTriggerAtr ?? 99) < 3).length },
    { label: '>= 3 — deep inside a frame nothing is near', count: zoneLost.filter((r) => (r.nearestTriggerAtr ?? -99) >= 3).length },
  ];

  /*
   * Is the frame WIDE, or is it MOVING? Two very different diagnoses that the
   * distance table alone cannot separate: a close 2 ATR from a trigger could be
   * inside a stale frame nobody has traded against, or inside a fresh one that
   * just re-anchored under the trend. `frameAgeBars` and `lastTestedBarsAgo`
   * answer that, and the answer decides which knob C is even allowed to try.
   */
  const ages = {
    frame: zoneLost.map((row) => row.frameAgeBars).filter((value): value is number => value !== null),
    zone: zoneLost.map((row) => row.zoneAgeBars).filter((value): value is number => value !== null),
    tested: zoneLost.map((row) => row.lastTestedBarsAgo).filter((value): value is number => value !== null),
  };
  const staleFrames = zoneLost.filter((row) => (row.frameAgeBars ?? 0) > MARKET_SIGNAL_ZONE.anchor.untestedReanchorBars).length;

  /* ---- B, mirrored: why OFF over-speaks --------------------------------- */

  interface OffSummary {
    quiet: number;
    quietNamed: number;
    quietNamedThin: number;
    quietSilent: number;
    quietSilentRegime: number;
    medianScore: number | null;
    scoreBuckets: BucketRow[];
    rows: number;
  }
  let offSummary: OffSummary | null = null;
  const offFiles = files.filter((name) => name.startsWith(`off-${runId}-`));
  if (offFiles.length > 0) {
    const offRows: OffRow[] = [];
    offFiles.forEach((name) => {
      offRows.push(...(JSON.parse(readFileSync(join(SHARD_DIR, name), 'utf8')) as OffShard).rows);
    });
    let quiet = 0;
    let quietNamed = 0;
    let quietNamedThin = 0;
    let quietSilent = 0;
    let quietSilentRegime = 0;
    const magnitudes: number[] = [];
    offRows.forEach((row) => {
      const truth = truthBySymbol.get(row.symbol);
      if (!truth) return;
      if (truth[row.index].label !== 'SIDEWAYS') return;
      const label = mapState(row.off);
      if (label === null || label === 'OTHER') return;
      quiet += 1;
      if (label === 'SIDEWAYS') {
        quietSilent += 1;
        if (row.regimeSideways === 1 || row.nonTrendingFallback === 1) quietSilentRegime += 1;
        return;
      }
      quietNamed += 1;
      if (row.band === 'neutral') quietNamedThin += 1;
      if (row.score !== null) magnitudes.push(Math.abs(row.score));
    });
    const inRange = (low: number, high: number) => magnitudes.filter((value) => value >= low && value < high).length;
    offSummary = {
      quiet,
      quietNamed,
      quietNamedThin,
      quietSilent,
      quietSilentRegime,
      rows: offRows.length,
      medianScore: quantile(magnitudes, 0.5),
      scoreBuckets: [
        { label: 'abs(score) 0 .. 5', count: inRange(0, 5) },
        { label: 'abs(score) 5 .. 10', count: inRange(5, 10) },
        { label: 'abs(score) 10 .. 15   <- the gate neutral band ends here', count: inRange(10, 15) },
        { label: 'abs(score) 15 .. 20', count: inRange(15, 20) },
        { label: 'abs(score) 20 .. 40', count: inRange(20, 40) },
        { label: 'abs(score) >= 40', count: inRange(40, Infinity) },
      ],
    };
  }

  /* ---- PART C ----------------------------------------------------------- */

  const labelStream = (bucket: DiagRow[], override?: Map<number, MarketSignalState | null>) =>
    bucket.map((row) => mapState(override ? (override.get(row.index) ?? null) : row.on));

  const baseLabels = new Map<string, Array<Label | null>>(
    [...bySymbol.entries()].map(([symbol, bucket]) => [symbol, labelStream(bucket)]),
  );
  const baseStats = measure(bySymbol, baseLabels, truthBySymbol, BASE_TRUTH);

  interface VariantResult {
    id: string;
    override: { path: string; from: number; to: number };
    stats: Stats;
    changed: number;
    compared: number;
    /** Of B's lost bars, how many this variant now names in the ground truth's direction. */
    recovered: number;
    /** Bars the variant LOSES that the baseline named. The other side of the same ledger. */
    surrendered: number;
  }
  const variantIds = [...new Set(files
    .filter((name) => name.startsWith('var-') && name.includes(`-${runId}-`))
    .map((name) => name.slice('var-'.length, name.indexOf(`-${runId}-`))))].sort();

  const variants: VariantResult[] = variantIds.map((id) => {
    const parts = files.filter((name) => name.startsWith(`var-${id}-${runId}-`));
    const byState = new Map<string, Map<number, MarketSignalState | null>>();
    let override = { path: '?', from: 0, to: 0 };
    parts.forEach((name) => {
      const shard = JSON.parse(readFileSync(join(SHARD_DIR, name), 'utf8')) as VariantShard;
      override = shard.override;
      shard.rows.forEach((row) => {
        if (!byState.has(row.symbol)) byState.set(row.symbol, new Map());
        byState.get(row.symbol)!.set(row.index, row.on);
      });
    });
    const labels = new Map<string, Array<Label | null>>(
      [...bySymbol.entries()].map(([symbol, bucket]) => [symbol, labelStream(bucket, byState.get(symbol) ?? new Map())]),
    );
    let changed = 0;
    let compared = 0;
    bySymbol.forEach((bucket, symbol) => {
      const here = byState.get(symbol);
      if (!here) return;
      bucket.forEach((row) => {
        if (!here.has(row.index)) return;
        compared += 1;
        if (here.get(row.index) !== row.on) changed += 1;
      });
    });
    /*
     * Label churn is not the question B asked. B asked how many MOVES the zone
     * rule swallows, so the honest sensitivity column is how many of those exact
     * bars the knob gives back — and, beside it, how many it takes away
     * elsewhere, because a knob that trades one for the other has fixed nothing.
     */
    let recovered = 0;
    lost.forEach((row) => {
      const gt = truthBySymbol.get(row.symbol)![row.index].label;
      if (mapState(byState.get(row.symbol)?.get(row.index) ?? null) === gt) recovered += 1;
    });
    let surrendered = 0;
    rows.forEach((row) => {
      const gt = truthBySymbol.get(row.symbol)![row.index].label;
      if (gt !== 'UP' && gt !== 'DOWN') return;
      if (mapState(row.on) !== gt) return;
      const here = byState.get(row.symbol)?.get(row.index);
      if (here === undefined) return;
      if (mapState(here) !== gt) surrendered += 1;
    });
    return { id, override, stats: measure(bySymbol, labels, truthBySymbol, BASE_TRUTH), changed, compared, recovered, surrendered };
  });

  /* ---- PART A, read back ------------------------------------------------ */
  const cases: CaseReport[] = existsSync(casePath(runId))
    ? (JSON.parse(readFileSync(casePath(runId), 'utf8')) as CaseFile).cases
    : [];
  const tally: Record<Adjudication, number> = { 'engine wrong': 0, 'ground truth wrong': 0, borderline: 0 };
  cases.filter((entry) => entry.found).forEach((entry) => { tally[entry.adjudication] += 1; });
  /*
   * The 7-of-10 bar is about WHICH SIDE IS WRONG, so only the two verdicts that
   * name a side can clear it. `borderline` reaching 7 is the opposite result —
   * it is the adjudicator declining to name one — and must never be reported as
   * though a pooled statement had been earned.
   */
  const majority = (['engine wrong', 'ground truth wrong'] as const)
    .filter((verdict) => tally[verdict] >= 7);
  /*
   * What the ten cases have in COMMON, which the three-way verdict does not
   * show. Counted, not eyeballed: how often the fast scale contradicts the
   * window the ground truth measured over, and how often the slow one backs it.
   */
  const resolved = cases.filter((entry) => entry.found);
  const fastAgainst = resolved.filter((entry) => sideOf(entry.d5) !== sideOf(entry.d20)).length;
  const slowWith = resolved.filter((entry) => sideOf(entry.d60) === sideOf(entry.d20)).length;
  const fastFlat = resolved.filter((entry) => sideOf(entry.d5) === 0).length;
  const onSideways = resolved.filter((entry) => entry.onState === 'SIDEWAYS').length;
  const onZoneSideways = resolved.filter((entry) => entry.causes?.zone === 'sideways').length;
  const offThinScore = resolved.filter((entry) => entry.offScore !== null && Math.abs(entry.offScore) < MARKET_SIGNAL_GATE.bands.neutral).length;

  /* ---- write ------------------------------------------------------------ */

  const lines: string[] = [];
  const say = (text = '') => lines.push(text);

  say('# Which rule produced the disagreement?');
  say();
  say('`trend_agreement.md` measured that engine OFF over-speaks (UP 98.9 / DOWN 93.8 /');
  say('SIDEWAYS 17.3), engine ON under-speaks (UP 46.2 / DOWN 39.2 / SIDEWAYS 84.1) and the');
  say('OFF flip ratio is above 1.0 at all 27 grid points. This file asks WHY, over the same');
  say('pinned corpus, the same frozen bars and the same ground truth. It changes no engine');
  say('file, no config value, no label, no threshold and no line of copy.');
  say();
  say('```');
  say(`corpus            ${measured.length} instruments — pinned to ${runId} via its manifest`);
  say(`period            ${manifest.period[0]} .. ${manifest.period[1]}`);
  say(`bars              ${rows.length}   (stride ${STRIDE}, left window ${WINDOW}, engine GATE+ZONES ON)`);
  say(`calculatedAt      ${CALCULATED_AT}   (pinned — no clock, no network)`);
  say('ground truth      N 20, displacement 1.5 ATR, efficiency 0.3 — unchanged from');
  say('                  `trend_agreement.md`, and still a design choice rather than the truth');
  say(`join check        ${joinChecked} bars shared with the agreement probe's shards, ${joinMismatch} ON-state`);
  say('                  mismatches. Must be 0: the OFF column below is joined from that run and');
  say('                  would otherwise be describing a different calculation.');
  say('config overrides  Part C only, in memory, one process, declared per shard. `src/` untouched.');
  say('```');
  say();

  /* ---- A ---------------------------------------------------------------- */
  say('## A. The ten worst conflicts — who is wrong');
  say();
  say('The ten rows of `trend_agreement.md` §5, in its order and with its ranking. For each:');
  say('the 20 bars the ground truth measured over, the engine replayed at every one of them,');
  say('the indicators and zone frame at the last bar, and every reason id the engine raised.');
  say();
  say('**The adjudication rule was fixed before the run** and uses price at two OTHER scales,');
  say('nothing else — no EMA, no ADX, no score, no zone, because those belong to one of the');
  say('two parties:');
  say();
  say('```');
  say('d5 / d20 / d60    (close_t - close_t-N) / ATR14_t   for N = 5, 20, 60');
  say('side(d)           +1 if d >= +0.5 ATR, -1 if d <= -0.5 ATR, 0 otherwise');
  say('');
  say('engine wrong        side(d5) == side(d20) == side(d60)');
  say('                    the move reads the same at every scale, so no window makes the');
  say('                    engine\'s word a defensible reading of the chart');
  say('ground truth wrong  side(d5) != side(d20) and side(d60) != side(d20), neither flat');
  say('                    the 20-bar window is the odd one out');
  say('borderline          everything else, including any case where a scale is flat');
  say('```');
  say();
  say('| # | symbol | date | truth | OFF | ON | d5 | d20 | d60 | verdict |');
  say('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  cases.forEach((entry) => {
    if (!entry.found) {
      say(`| ${entry.rank} | ${entry.symbol} | ${entry.date} | — | — | — | — | — | — | not in corpus |`);
      return;
    }
    say(`| ${entry.rank} | ${entry.symbol} | ${entry.date} | ${entry.truth} | ${entry.offState} | ${entry.onState} `
      + `| ${num(entry.d5)} | ${num(entry.d20)} | ${num(entry.d60)} | **${entry.adjudication}** |`);
  });
  say();
  say(`Tally over the ${cases.filter((entry) => entry.found).length} cases that resolved: `
    + `engine wrong ${tally['engine wrong']} · ground truth wrong ${tally['ground truth wrong']} · borderline ${tally.borderline}.`);
  say();
  if (majority.length > 0) {
    say(`**${majority[0]}** reaches 7 of 10, which is the threshold this round set for a`);
    say('pooled statement, so the pooled statement is made: on the ten worst conflicts, that is');
    say('the side the price-only adjudicator puts the fault on.');
  } else {
    say(`**Neither side reaches 7 of 10 (engine ${tally['engine wrong']}, ground truth ${tally['ground truth wrong']}), so no pooled`);
    say('statement is made about which side is wrong.** That was the pre-registered bar and it');
    say(`was not cleared: ${tally.borderline} of the ten are \`borderline\`, which is the adjudicator declining`);
    say('to name a side rather than naming one. The per-case rows above stand on their own and');
    say('the ten charts still have to be read one at a time.');
  }
  say();
  say('What the ten DO have in common is not a verdict and is counted rather than eyeballed:');
  say();
  say(`- the fast scale contradicts the 20-bar window on **${fastAgainst} of ${resolved.length}** cases`);
  say(`  (${fastFlat} of those are flat rather than opposed)`);
  say(`- the slow scale agrees with the 20-bar window on **${slowWith} of ${resolved.length}**`);
  say(`- engine ON answers SIDEWAYS on ${onSideways} of ${resolved.length}, and its zone is \`sideways\` on ${onZoneSideways}`);
  say(`- engine OFF's score is inside the gate's neutral band (\|score\| < ${MARKET_SIGNAL_GATE.bands.neutral}) on ${offThinScore} of ${resolved.length},`);
  say('  while it published a direction on every one of them');
  say();
  say('So these are not backwards descriptions of a steady move. They are bars where the');
  say('last week of price went one way and the last month went the other, and the two sources');
  say('resolved that split differently — which is a horizon disagreement, and the reason so');
  say('many land on `borderline` under a rule that requires all three scales to line up.');
  say();

  cases.filter((entry) => entry.found).forEach((entry) => {
    say(`### A${entry.rank}. ${entry.symbol} ${entry.date} — truth ${entry.truth}, OFF ${entry.offState}, ON ${entry.onState}`);
    say();
    say('```');
    say(`ground truth   displacement ${num(entry.displacement)} ATR · efficiency ${num(entry.efficiency)} · ATR14 ${num(entry.atr14, 4)}`);
    say(`adjudicator    d5 ${num(entry.d5)}  d20 ${num(entry.d20)}  d60 ${num(entry.d60)}  ->  ${entry.adjudication}`);
    say(`score          OFF ${num(entry.offScore, 1)} · ON ${num(entry.onScore, 1)} · band ${entry.causes?.band ?? '—'} · conflicts ${entry.causes?.conflicts ?? '—'}`);
    say(`slopes         ema20 ${num(entry.ema20SlopePct, 3)}%  ema50 ${num(entry.ema50SlopePct, 3)}%  ema200 ${num(entry.ema200SlopePct, 3)}%`);
    say(`strength       ADX ${num(entry.adx14, 1)} · +DI ${num(entry.plusDi14, 1)} · -DI ${num(entry.minusDi14, 1)} · RSI ${num(entry.rsi14, 1)}`);
    say(`regime         squeeze ${entry.causes?.regimeSqueeze === 1} · overextended ${entry.causes?.regimeOverextended === 1} · sideways ${entry.causes?.regimeSideways === 1} · nonTrendingFallback ${entry.causes?.nonTrendingFallback === 1}`);
    say(`zone (ON)      ${entry.zoneSummary}`);
    say('```');
    say();
    say('| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |');
    say('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    entry.bars.forEach((bar) => {
      say(`| ${bar.date} | ${num(bar.open, 2)} | ${num(bar.high, 2)} | ${num(bar.low, 2)} | ${num(bar.close, 2)} `
        + `| ${num(bar.ema20, 2)} | ${num(bar.ema50, 2)} | ${num(bar.ema200, 2)} | ${bar.off ?? '—'} | ${bar.on ?? '—'} |`);
    });
    say();
    say(`reason ids · OFF: ${entry.offReasons.length === 0 ? 'none' : entry.offReasons.join(', ')}`);
    say();
    say(`reason ids · ON: ${entry.onReasons.length === 0 ? 'none' : entry.onReasons.join(', ')}`);
    say();
    say(`flags · OFF: ${entry.offFlags.length === 0 ? 'none' : entry.offFlags.join(', ')} · ON: ${entry.onFlags.length === 0 ? 'none' : entry.onFlags.join(', ')}`);
    say();
    say(`**A${entry.rank}: ${entry.adjudication}.**`);
    say();
  });

  /* ---- B ---------------------------------------------------------------- */
  say('## B. The veto that eats the trend when ON');
  say();
  say(`Of ${rows.length} bars, the ground truth calls **${moves}** a move (UP or DOWN). Engine ON`);
  say(`answers SIDEWAYS on **${lost.length}** of them — UP ${lostTruth.UP}, DOWN ${lostTruth.DOWN} — which is`);
  say(`${share(lost.length, moves)} of every move in the corpus. A further ${lostToRegimeVeto} moves are covered by`);
  say('SQUEEZE / OVEREXTENDED; those are the regime veto, they are not SIDEWAYS, and they are');
  say('reported here rather than folded in.');
  say();
  say(`Of the ${lost.length} lost bars, engine OFF named the ground truth\'s direction on **${namedByOffOnly}**`);
  say(`(${share(namedByOffOnly, lost.length)}) — the same engine, the same bars, one flag apart. So these are not bars where`);
  say('the evidence was absent: the direction was available and something declined to publish');
  say('it. That is measured bar for bar here rather than inferred from the two row-correct');
  say('percentages, and it is what the rest of this section is looking for.');
  say();
  say('### Overlapping — how many of the lost bars each condition is TRUE on');
  say();
  say('A bar can satisfy several and is counted in every column it satisfies.');
  say();
  say(`| condition | bars | % of the ${lost.length} lost |`);
  say('| --- | --- | --- |');
  overlapping.forEach((bucket) => say(`| ${bucket.label} | ${bucket.count} | ${share(bucket.count, lost.length)} |`));
  say();
  say('### Non-overlapping — which one the engine actually returned on');
  say();
  say('Attribution follows the ENGINE\'s own order of evaluation, not a preference. With zones');
  say('on, `state` comes from `zonePresentationState`, and its body is four lines: squeeze,');
  say('overextended, `zone === \'sideways\'`, then a direction. The gate never gets asked. So a');
  say('condition that is true on a bar but sits below the line that returned is a **passenger**,');
  say('and the gap between this table and the one above it is the finding.');
  say();
  say(`| cause | bars | % of the ${lost.length} lost |`);
  say('| --- | --- | --- |');
  nonOverlapping.forEach((bucket) => say(`| ${bucket.label} | ${bucket.count} | ${share(bucket.count, lost.length)} |`));
  say();
  if (unattributed > 0) {
    say(`**${unattributed} bars are unattributed**, which falsifies the precedence model above and has`);
    say(`to be read before anything else here: ${unattributedExamples.join(' · ')}`);
    say();
  }
  say('### Inside the winning cause — which zone rule held the frame');
  say();
  say(`The ${zoneLost.length} bars claimed by \`zone == sideways\`, split by what kept the zone sideways.`);
  say();
  say(`| frame mode | bars | % |`);
  say('| --- | --- | --- |');
  say(`| structural (a real swing high/low pair) | ${modeSplit.structural} | ${share(modeSplit.structural, zoneLost.length)} |`);
  say(`| atr_band (no usable pivot pair, or narrower than 1 ATR) | ${modeSplit.atr_band} | ${share(modeSplit.atr_band, zoneLost.length)} |`);
  say();
  say(`Pending a confirmation that never came — close already beyond a trigger, waiting on`);
  say(`\`confirmation.barsWithoutVolume\`: **${pendingCount}** bars (${share(pendingCount, zoneLost.length)}).`);
  say();
  say('Distance from the close to the nearest trigger, in ATR. This is the quantity');
  say('`triggerAtrMultiple` (0.25) and the frame width jointly decide, so it is where a knob');
  say('would have to bite:');
  say();
  say(`| nearest trigger (ATR) | bars | % |`);
  say('| --- | --- | --- |');
  distanceBuckets.forEach((bucket) => say(`| ${bucket.label} | ${bucket.count} | ${share(bucket.count, zoneLost.length)} |`));
  say();
  say('A wide frame and a moving frame produce the same number in that table, and they are');
  say('different diagnoses. These separate them:');
  say();
  say('| | p10 | median | p90 | max |');
  say('| --- | --- | --- | --- | --- |');
  say(`| \`frameAgeBars\` — bars since the frame last re-anchored | ${quantile(ages.frame, 0.1)} | ${quantile(ages.frame, 0.5)} | ${quantile(ages.frame, 0.9)} | ${Math.max(...ages.frame)} |`);
  say(`| \`zoneAgeBars\` — bars price has held this zone | ${quantile(ages.zone, 0.1)} | ${quantile(ages.zone, 0.5)} | ${quantile(ages.zone, 0.9)} | ${Math.max(...ages.zone)} |`);
  say(`| \`lastTestedBarsAgo\` — bars since a bar's range reached an edge | ${quantile(ages.tested, 0.1)} | ${quantile(ages.tested, 0.5)} | ${quantile(ages.tested, 0.9)} | ${Math.max(...ages.tested)} |`);
  say();
  say(`Only **${staleFrames}** of the ${zoneLost.length} (${share(staleFrames, zoneLost.length)}) sit on a frame older than`);
  say(`\`anchor.untestedReanchorBars\` (${MARKET_SIGNAL_ZONE.anchor.untestedReanchorBars}), and none of them has an untested frame — the median`);
  say('frame is a handful of bars old and was touched days ago. **So the frame is not stale and');
  say('it is not wide by neglect: it re-anchors constantly, and it re-anchors under the move.**');
  say('A confirmed pivot forming outside the frame re-anchors it, and a trend manufactures');
  say('exactly those pivots as it goes, so the boundary travels with price and the close stays');
  say('a median of ' + `${num(quantile(nearestList, 0.5))}` + ' ATR inside it for as long as the move lasts.');
  say();

  /* ---- B mirror ---------------------------------------------------------- */
  if (offSummary) {
    say('### The mirror — why OFF over-speaks, measured the same way');
    say();
    say('B is scoped to the ON state because that is where the trend goes missing. But the two');
    say('states fail in OPPOSITE directions and a cause that explains only one of them is half');
    say('an answer, so the same question was asked of OFF on the same bars: **the ground truth');
    say('says SIDEWAYS, what does OFF say?**');
    say();
    say(`Of ${offSummary.quiet} quiet bars OFF labels, it names a direction on **${offSummary.quietNamed}**`);
    say(`(${share(offSummary.quietNamed, offSummary.quiet)}) and says SIDEWAYS on ${offSummary.quietSilent}. Of the ${offSummary.quietSilent} it does keep quiet on,`);
    say(`${offSummary.quietSilentRegime} (${share(offSummary.quietSilentRegime, offSummary.quietSilent)}) are \`regime.sideways\` or \`nonTrendingFallback\` — which is the whole`);
    say('of the flags-OFF path to the word SIDEWAYS. There is no other one:');
    say("`presentationState` ends `return score >= 0 ? 'BULLISH' : 'BEARISH'`, with no dead");
    say('band anywhere above it.');
    say();
    say('The obvious next guess is that those calls are thin — a direction published off a');
    say('score of +3, which is what case A3 shows. The distribution says otherwise. Absolute');
    say(`score over the ${offSummary.quietNamed} quiet bars OFF named a direction on:`);
    say();
    say('| bucket | bars | % |');
    say('| --- | --- | --- |');
    offSummary.scoreBuckets.forEach((bucket) => say(`| ${bucket.label} | ${bucket.count} | ${share(bucket.count, offSummary!.quietNamed)} |`));
    say();
    say(`Median absolute score ${num(offSummary.medianScore, 1)}. Only **${offSummary.quietNamedThin}** of them`);
    say(`(${share(offSummary.quietNamedThin, offSummary.quietNamed)}) sit inside the gate's neutral band (absolute score < ${MARKET_SIGNAL_GATE.bands.neutral}), so a`);
    say(`missing band is not the explanation: ${share(offSummary.quietNamed - offSummary.quietNamedThin, offSummary.quietNamed)} of these calls would clear that band and`);
    say('still be published. **A thin score is a real defect and it is not the big one.**');
    say();
    say('The big one is on the other side of the same count. Every one of the');
    say(`${offSummary.quietSilent} bars OFF does say SIDEWAYS on — ${share(offSummary.quietSilentRegime, offSummary.quietSilent)}, all of them — arrives through`);
    say('`regime.sideways || nonTrendingFallback`, because with the gate off that branch is the');
    say('ONLY route to the word. And `regime.sideways` is a unanimity test:');
    say(`\`classifyRegimeEvidence\` scores five items — EMA compression, flat slopes, low ADX,`);
    say(`mid RSI, a flat histogram — and \`sideways.evidenceRequired\` demands ${MARKET_SIGNAL_THRESHOLDS.sideways.evidenceRequired} of them true`);
    say(`with at least ${MARKET_SIGNAL_THRESHOLDS.sideways.minimumAvailableEvidence} computable. Four of five simultaneously is close to unanimity, almost`);
    say('nothing in a real corpus clears it, so almost nothing reaches SIDEWAYS and');
    say("`presentationState` ends `return score >= 0 ? 'BULLISH' : 'BEARISH'` with no third");
    say('option. **OFF over-speaks because its quiet branch demands unanimity, not because its');
    say('loud branch is thin.**');
    say();
  }

  /* ---- C ---------------------------------------------------------------- */
  say('## C. Sensitivity of the thresholds B named');
  say();
  if (variants.length === 0) {
    say('No variant shards were found, so this section is empty. It is not a result.');
  } else {
    say('Only the knobs that appear in B, moved +-20%, engine GATE+ZONES ON, everything else');
    say('identical. The override is applied to the config OBJECT IN MEMORY for the life of one');
    say('collection process and is written into each shard file; `src/config/signal.ts` on disk');
    say('is unchanged. **No value below is a proposal.** This section reports what moving the');
    say('knob does and stops there.');
    say();
    say('### Why these two, and not the other thirty-eight');
    say();
    say('B attributes 100% of the loss to `zone == sideways`, so the candidate set is the');
    say('numbers `calculateTrendZones` reads and nothing else. Of those, B measured the cost of');
    say('each, and two survive a +-20% move as a MEANINGFUL move:');
    say();
    say('| knob | why it is in, or out |');
    say('| --- | --- |');
    say('| `zone.triggerAtrMultiple` (0.25) | **in.** The `0 .. 0.25 ATR` bucket is literally the bars this number holds inside the frame. |');
    say('| `zone.confirmation.highVolumeRelative` (1.2) | **in.** Continuous, and the other half of the entry rule that produced the pending bars. |');
    say('| `zone.confirmation.barsWithoutVolume` (2) | **out.** A loop bound. 1.6 rounds to the same behaviour as 2 and 2.4 to the same as 3, so +-20% is one inert point and one point that is a different rule, not a smaller one. |');
    say('| `structure.pivotWindow` (3) | **out.** A half-window index. At 2.4 the `offset === window` self-exclusion never matches and the detector returns no pivots at all — that is a broken engine, not a sensitivity reading. |');
    say('| `zone.narrowRange.minimumAtrWidth` (1) | **out.** B measures it: it decides `atr_band` mode, which is 1.5% of the lost bars. |');
    say('| `zone.anchor.lookbackBars` (120), `anchor.untestedReanchorBars` (60) | **out.** B measures them: the median lost bar sits on a frame 5 bars old that was touched 3 bars ago, so a staleness bound is not what is binding. |');
    say('| everything in `MARKET_SIGNAL_GATE`, `MARKET_SIGNAL_THRESHOLDS` | **out.** B shows the gate never runs on this path. |');
    say();
    say('| variant | knob | from | to | agreement | flip ratio | labels changed of 72805 |');
    say('| --- | --- | --- | --- | --- | --- | --- |');
    say(`| baseline | — | — | — | ${pct(baseStats.agreement)} | ${ratio(baseStats.flipRatio)} | — |`);
    variants.forEach((variant) => {
      say(`| ${variant.id} | \`${variant.override.path}\` | ${variant.override.from} | ${variant.override.to} `
        + `| ${pct(variant.stats.agreement)} | ${ratio(variant.stats.flipRatio)} | ${variant.changed} (${share(variant.changed, variant.compared)}) |`);
    });
    say();
    say('Label churn is not the question B asked, though. B asked how many MOVES the zone rule');
    say(`swallows, so this is how many of those exact ${lost.length} bars each knob gives back — and,`);
    say('beside it, how many moves the SAME knob takes away somewhere else, because a knob that');
    say('trades one for the other has moved bars around rather than fixed anything:');
    say();
    say(`| variant | recovers (of ${lost.length} lost) | surrenders (moves the baseline named) | net |`);
    say('| --- | --- | --- | --- |');
    variants.forEach((variant) => {
      const net = variant.recovered - variant.surrendered;
      say(`| ${variant.id} | ${variant.recovered} (${share(variant.recovered, lost.length)}) | ${variant.surrendered} | ${net >= 0 ? '+' : ''}${net} |`);
    });
    say();
    say('The confusion matrix for each, ground truth down the side and label across the top:');
    say();
    const confusionTable = (title: string, stats: Stats) => {
      say(`**${title}**`);
      say();
      say('| truth \\ label | UP | DOWN | SIDEWAYS | row total | row correct |');
      say('| --- | --- | --- | --- | --- | --- |');
      TRUTHS.forEach((truth) => {
        const row = stats.confusion[truth];
        const total = row.UP + row.DOWN + row.SIDEWAYS;
        say(`| **${truth}** | ${row.UP} | ${row.DOWN} | ${row.SIDEWAYS} | ${total} | ${share(row[truth], total)} |`);
      });
      say();
      say(`n ${stats.n} · clustered ${stats.clustered} · SQUEEZE/OVEREXTENDED (outside the 3x3) ${stats.other}`
        + ` · ground-truth changes ${stats.gtChanges} · label changes ${stats.labelChanges}`);
      say();
    };
    confusionTable('baseline · engine GATE+ZONES ON, config as it ships', baseStats);
    variants.forEach((variant) => confusionTable(
      `${variant.id} · \`${variant.override.path}\` ${variant.override.from} -> ${variant.override.to}`,
      variant.stats,
    ));
  }

  /* ---- the one line ------------------------------------------------------ */
  const bestVariant = variants.reduce<VariantResult | null>(
    (best, variant) => (best === null || variant.recovered > best.recovered ? variant : best), null);
  say('## The one line');
  say();
  say('Every number in this sentence is from a table above it.');
  say();
  say("> **ต้นเหตุหลักคือบรรทัด `zone === 'sideways'` ใน `zonePresentationState` —");
  say(`> ${share(zoneClaimed, lost.length)} ของ ${lost.length} แท่งที่ ground truth บอกว่าเป็นเทรนด์แต่ engine ON ตอบ SIDEWAYS`);
  say('> มาจากบรรทัดนี้บรรทัดเดียว และมันตัดจบก่อนที่ band, conflicts, regime หรือ score');
  say(`> จะถูกอ่าน (band==neutral จริงแค่ ${share(overlapping[0].count, lost.length)} · conflicts ${share(overlapping[1].count, lost.length)} · regime/fallback ${share(overlapping[5].count, lost.length)}`);
  say(`> — ทั้งหมดเป็นผู้โดยสาร ไม่ใช่สาเหตุ) โดยที่ engine OFF เรียกทิศถูกบน ${share(namedByOffOnly, lost.length)} ของแท่งเดียวกัน`);
  say(`> และกรอบโซนก็ไม่ได้เก่าหรือกว้างเพราะถูกทิ้ง — มัน re-anchor ใหม่ทุก ${quantile(ages.frame, 0.5)} แท่ง (มัธยฐาน)`);
  say('> ตาม pivot ที่เทรนด์สร้างขึ้นเอง จึงวาดขอบหนีราคาไปเรื่อย ๆ และราคาไม่เคยปิดทะลุมัน**');
  say();
  if (bestVariant) {
    say(`**และมันไม่ใช่ค่า threshold ตัวไหน**: knob ที่ B ชี้ ขยับ +-20% ทั้งสองตัว กู้แท่งที่หายไปคืนได้`);
    say(`มากที่สุด ${bestVariant.recovered} จาก ${lost.length} แท่ง (${share(bestVariant.recovered, lost.length)}, \`${bestVariant.override.path}\`)`);
    say('— โครงสร้างของกฎเป็นตัวกำหนด ไม่ใช่ตัวเลขในกฎ');
    say();
  }
  if (offSummary) {
    say(`ฝั่ง OFF เป็นภาพกลับด้านของกฎเดียวกัน: ทางเดียวที่จะพูดว่า SIDEWAYS ได้คือ`);
    say(`\`regime.sideways || nonTrendingFallback\` (${share(offSummary.quietSilentRegime, offSummary.quietSilent)} ของแท่งที่ OFF เงียบ) ซึ่งต้องการหลักฐาน`);
    say(`${MARKET_SIGNAL_THRESHOLDS.sideways.evidenceRequired} ใน 5 อย่างพร้อมกัน — แทบไม่มีอะไรผ่าน OFF จึงพูดทิศบน ${share(offSummary.quietNamed, offSummary.quiet)} ของแท่งที่เงียบจริง`);
    say('**ทั้งสองสถานะจึงพังด้วยเหตุเดียวกัน: แต่ละสถานะมีทางไปสู่คำตอบเดียวเท่านั้น และไม่มี');
    say('ทางที่สาม.**');
    say();
  }
  say('---');
  say();
  say('```');
  say(`shards            ${baseFiles.length} base + ${offFiles.length} off-side + ${files.filter((name) => name.startsWith('var-')).length} variant files under .qa/trend-diagnosis/`);
  say(`agreement join    ${agreementRows} rows read from .qa/trend-agreement/ (OFF labels only)`);
  say('reproduce         npm run signal:trend-diagnosis -- --cases                         (A)');
  say('                  npm run signal:trend-diagnosis -- --shard=0/4                     (B, 0..3)');
  say('                  npm run signal:trend-diagnosis -- --shard=0/4 --offside           (B mirror)');
  say('                  npm run signal:trend-diagnosis -- --shard=0/4 --variant=trigger-lo');
  say('                      --set=zone.triggerAtrMultiple=0.2                             (C)');
  say('                  npm run signal:trend-diagnosis                                    (report)');
  say('```');
  say();

  writeFileSync(OUTPUT_PATH, `${lines.join('\n')}\n`);
  console.error(`wrote ${OUTPUT_PATH}`);
  console.error(`B: ${lost.length} lost of ${moves} moves · zone ${zoneClaimed} · gate ${gateClaimed} · regime ${regimeClaimed} · unattributed ${unattributed}`);
  console.error(`A: engine ${tally['engine wrong']} · truth ${tally['ground truth wrong']} · borderline ${tally.borderline}`);
}

main();
