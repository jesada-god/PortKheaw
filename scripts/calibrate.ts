/**
 * P4a — the calibration harness.
 *
 * This measures whether the Market Signal says anything. It fits nothing and
 * changes nothing in the engine; P4b is where numbers earned here are allowed to
 * move a threshold.
 *
 * ---------------------------------------------------------------------------
 * WHAT "RIGHT" MEANS HERE
 * ---------------------------------------------------------------------------
 * Two criteria, reported side by side, because they answer different questions
 * and either one alone can be made to flatter the engine.
 *
 *   A — barrier   Did price touch the published target before the published
 *                 invalidation? This is the claim the card literally makes. It
 *                 is only defined where P3 published both, so most of its
 *                 buckets are expected to read `insufficient`.
 *
 *   B — close     Is the close N bars later beyond the close at signal time, in
 *                 the direction the zone named? Defined for every directional
 *                 signal, so it carries the statistical weight.
 *
 * Horizons 5 / 10 / 20 bars, every figure reported at all three.
 *
 * INTRABAR AMBIGUITY. Daily OHLC cannot order two touches inside one bar. When a
 * bar reaches both barriers the observation counts as a LOSS, and the ambiguous
 * count is printed next to every criterion-A figure so the rule's effect is
 * visible rather than buried. Assuming the favourable order is the single most
 * common way a backtest flatters itself.
 *
 * SIDEWAYS is excluded from directional hit rate — no direction was claimed, so
 * there is nothing to be right about — and is measured separately on the claim
 * it does make: that price stays inside the frame and the label holds.
 *
 * ---------------------------------------------------------------------------
 * WHAT STOPS THIS FROM BEING A STORY
 * ---------------------------------------------------------------------------
 * BASELINES, PAIRED WITH EVERYTHING. A hit rate alone is unreadable: in a market
 * that rose, every long signal looks skilful. No rate is ever printed alone.
 *   * criterion B pairs against the unconditional rate over the same
 *     instrument-days, weighted to the SAME mix of long and short claims the
 *     signal actually made. Computed exactly, not sampled.
 *   * criterion A pairs against a DATE-SHUFFLED control: same instrument, same
 *     barrier distances, same horizon, placed on other dates drawn at random.
 *     That is the right null — the signal's whole claim is that it picks a
 *     better moment, and this removes the timing and nothing else. An
 *     "always long" control would not, because for an uptrend signal it IS the
 *     signal.
 *   * both split by market regime (SPY above/below its own 200-day average).
 *
 * NO LOOK-AHEAD. Every observation runs the engine over `bars[..t]` only, so
 * nothing after the as-of bar is reachable — including swing pivots, which the
 * engine already refuses to use before `confirmedAtIndex`. A start-up self-check
 * re-runs a sample against the full history to prove `WINDOW` is not truncating
 * the answer.
 *
 * OVERLAP IS REPORTED, NOT HIDDEN. Consecutive observations at a 20-bar horizon
 * share 15 bars of their outcome, so a raw n of 400 is nothing like 400
 * independent facts. Every table carries a clustered n — the largest set of
 * non-overlapping observations it contains — beside the raw one.
 *
 * SAMPLE-SIZE GUARD. A bucket under `MINIMUM_BUCKET` reports `insufficient` and
 * no rate. Buckets are never merged to reach it: merging changes the question
 * being answered without anybody noticing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT TELL YOU
 * ---------------------------------------------------------------------------
 * SURVIVORSHIP. The 108 instruments were chosen in 2026 and every one of them
 * still trades. Names that delisted, were acquired or collapsed are absent, and
 * the corpus has no way to add them. Every figure is conditioned on survival and
 * is optimistic by an unknown amount.
 *
 * NO COSTS. Price moves, not returns. No spread, commission, slippage or borrow.
 * A hit rate here is not money.
 *
 * THE TIME SPLIT IS NOT AN OVERFIT CONTROL. Nothing is fitted in P4a, so a
 * train/test split cannot be protecting against overfitting — there is no fit to
 * over-do. It is reported so that P4b, which does fit, has a held-out half
 * already defined.
 *
 * Run: npm run signal:calibrate
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { calculateMarketSignal } from '@/src/lib/analytics/market-signal/calculations';
import type {
  MarketSignalCandle,
  MarketSignalResult,
  MarketSignalZoneName,
  MarketSignalZoneProximity,
} from '@/src/lib/analytics/market-signal/types';
import type { DataFreshness } from '@/src/lib/market-data/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');
const OUTPUT_ROOT = join(process.cwd(), '__calibration__');

/** Bars ahead that every outcome is measured at. */
const HORIZONS = [5, 10, 20] as const;
/**
 * Bars between as-of points. Chosen to divide every horizon exactly, so the zone
 * at `t + horizon` is itself a sampled observation and the "did the label hold"
 * questions need no second engine run and no nearest-neighbour fudge.
 */
const STRIDE = 5;
/** Bars handed to the engine per as-of point — enough for pivots, the walk and ATR. */
const WINDOW = 600;
/** Below this a bucket reports `insufficient`. Buckets are never merged to reach it. */
const MINIMUM_BUCKET = 30;
/** Draws per observation for the date-shuffled control. */
const CONTROL_DRAWS = 5;
/** Bars either side of the real as-of point that a control draw may not land in. */
const CONTROL_EXCLUSION = 30;
/** Share of the sample period, by date, that counts as `train`. */
const TRAIN_SHARE = 0.6;
const SEED = 20260818;

type Bar = Omit<MarketSignalCandle, 'finalized'>;
interface Frozen { symbol: string; source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] }
interface Instrument { symbol: string; source: string | null; freshness: DataFreshness; bars: Bar[] }

type Regime = 'up' | 'down' | 'unknown';
type Direction = 1 | -1;

interface Observation {
  symbol: string;
  date: string;
  index: number;
  split: 'train' | 'test';
  regime: Regime;
  zone: MarketSignalZoneName;
  proximity: MarketSignalZoneProximity;
  conflict: boolean;
  pendingBreakout: boolean;
  pendingBreakdown: boolean;
  confidence: number;
  confidenceBucket: number;
  close: number;
  support: number;
  resistance: number;
  invalidation: number | null;
  target: number | null;
  invalidationAtr: number | null;
  riskReward: number | null;
}

/* ------------------------------------------------------------------------- */
/* deterministic randomness — the control has to be reproducible              */
/* ------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------- */
/* outcomes                                                                  */
/* ------------------------------------------------------------------------- */

type CloseOutcome = 'win' | 'loss' | 'flat' | 'unavailable';

/** Criterion B. Is the close `horizon` bars later beyond the one we started at? */
function closeOutcome(bars: readonly Bar[], index: number, horizon: number, direction: Direction): CloseOutcome {
  const future = bars[index + horizon];
  if (!future) return 'unavailable';
  const move = future.close - bars[index].close;
  if (move === 0) return 'flat';
  return Math.sign(move) === direction ? 'win' : 'loss';
}

type BarrierResult = 'target' | 'invalidation' | 'unresolved' | 'unavailable';
interface BarrierOutcome { result: BarrierResult; ambiguous: boolean }

/**
 * Criterion A. Walk forward bar by bar until one barrier is reached.
 *
 * When a single bar reaches both, the order inside it is unknowable from daily
 * OHLC, so it resolves as `invalidation` and is counted as ambiguous.
 */
function barrierOutcome(input: {
  bars: readonly Bar[];
  index: number;
  horizon: number;
  direction: Direction;
  target: number;
  invalidation: number;
}): BarrierOutcome {
  const { bars, index, horizon, direction, target, invalidation } = input;
  if (!bars[index + horizon]) return { result: 'unavailable', ambiguous: false };
  for (let step = 1; step <= horizon; step += 1) {
    const bar = bars[index + step];
    const hitTarget = direction === 1 ? bar.high >= target : bar.low <= target;
    const hitStop = direction === 1 ? bar.low <= invalidation : bar.high >= invalidation;
    if (hitTarget && hitStop) return { result: 'invalidation', ambiguous: true };
    if (hitTarget) return { result: 'target', ambiguous: false };
    if (hitStop) return { result: 'invalidation', ambiguous: false };
  }
  return { result: 'unresolved', ambiguous: false };
}

/* ------------------------------------------------------------------------- */
/* tallies                                                                   */
/* ------------------------------------------------------------------------- */

interface Tally {
  wins: number;
  losses: number;
  excluded: number;
  ambiguous: number;
  unresolved: number;
  keys: Array<{ symbol: string; index: number }>;
}

const emptyTally = (): Tally => ({ wins: 0, losses: 0, excluded: 0, ambiguous: 0, unresolved: 0, keys: [] });

function add(tally: Tally, won: boolean | null, key: { symbol: string; index: number }): void {
  if (won === null) { tally.excluded += 1; return; }
  if (won) tally.wins += 1; else tally.losses += 1;
  tally.keys.push(key);
}

/**
 * The largest set of observations in a tally that share no outcome bars.
 *
 * Greedy per instrument: walk the sorted as-of indices and keep one whenever it
 * starts at least `horizon` bars after the last one kept. This is the honest
 * denominator — 400 daily observations at a 20-bar horizon are roughly 100
 * independent facts, and quoting the 400 would overstate every comparison here.
 */
function clusteredCount(tally: Tally, horizon: number): number {
  const bySymbol = new Map<string, number[]>();
  tally.keys.forEach(({ symbol, index }) => {
    const bucket = bySymbol.get(symbol);
    if (bucket) bucket.push(index); else bySymbol.set(symbol, [index]);
  });
  let total = 0;
  bySymbol.forEach((indices) => {
    let last = -Infinity;
    [...indices].sort((left, right) => left - right).forEach((index) => {
      if (index - last >= horizon) { total += 1; last = index; }
    });
  });
  return total;
}

interface Rate {
  n: number;
  clustered: number;
  rate: number | null;
  wins: number;
  losses: number;
  excluded: number;
  ambiguous: number;
  unresolved: number;
}

const rateOf = (tally: Tally, horizon: number): Rate => {
  const n = tally.wins + tally.losses;
  return {
    n,
    clustered: clusteredCount(tally, horizon),
    // The guard is on the raw n exactly as specified. The clustered figure
    // travels beside it so a flattering denominator cannot pass unnoticed.
    rate: n >= MINIMUM_BUCKET ? tally.wins / n : null,
    wins: tally.wins,
    losses: tally.losses,
    excluded: tally.excluded,
    ambiguous: tally.ambiguous,
    unresolved: tally.unresolved,
  };
};

const pct = (value: number | null) => value === null ? 'insuff.'.padStart(7) : `${(value * 100).toFixed(1)}%`.padStart(7);
const gap = (rate: number | null, base: number | null) => rate === null || base === null
  ? '—'.padStart(8)
  : `${(rate - base) >= 0 ? '+' : ''}${((rate - base) * 100).toFixed(1)}pp`.padStart(8);

/* ------------------------------------------------------------------------- */
/* loading                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Which instruments this run measures.
 *
 * By default: whatever is cached. With `--like=<runId>`: exactly the list that
 * run measured, read from its own manifest.
 *
 * `__golden__/corpus/` is a CACHE and it grows — another probe fetching its own
 * instrument list adds files to it. Two runs over different corpora are not
 * comparable, and the whole purpose of a second calibration is comparison, so
 * P4b pins itself to the P4a list rather than to a directory listing. A symbol
 * the manifest names but the cache does not hold is reported and skipped, never
 * silently dropped.
 */
function instrumentList(): { symbols: string[] | null; like: string | null } {
  const flag = process.argv.find((argument) => argument.startsWith('--like='));
  if (!flag) return { symbols: null, like: null };
  const like = flag.slice('--like='.length);
  const manifest = JSON.parse(
    readFileSync(join(OUTPUT_ROOT, like, 'manifest.json'), 'utf8'),
  ) as { instruments: string[] };
  return { symbols: manifest.instruments, like };
}

function loadCorpus(): { instruments: Instrument[]; like: string | null; missing: string[] } {
  const { symbols, like } = instrumentList();
  const wanted = symbols
    ?? readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));

  const instruments: Instrument[] = [];
  const missing: string[] = [];
  for (const symbol of wanted) {
    let frozen: Frozen;
    try {
      frozen = JSON.parse(readFileSync(join(CORPUS_DIR, `${symbol}.json`), 'utf8')) as Frozen;
    } catch {
      missing.push(symbol);
      continue;
    }
    const bars = frozen.candles.filter((candle) => candle.finalized)
      .map(({ finalized: _finalized, ...candle }) => candle);
    if (bars.length < WINDOW + Math.max(...HORIZONS) + STRIDE) { missing.push(symbol); continue; }
    instruments.push({ symbol: frozen.symbol, source: frozen.source, freshness: frozen.freshness, bars });
  }
  return { instruments, like, missing };
}

/** SPY above or below its own 200-day simple average, by date. */
function marketRegime(instruments: readonly Instrument[]): Map<string, Regime> {
  const spy = instruments.find((instrument) => instrument.symbol === 'SPY');
  const regime = new Map<string, Regime>();
  if (!spy) return regime;
  let sum = 0;
  spy.bars.forEach((bar, index) => {
    sum += bar.close;
    if (index >= 200) sum -= spy.bars[index - 200].close;
    if (index >= 199) regime.set(bar.date, bar.close > sum / 200 ? 'up' : 'down');
  });
  return regime;
}

const runEngine = (instrument: Instrument, bars: readonly Bar[]): MarketSignalResult => calculateMarketSignal(
  bars.map((bar) => ({ ...bar, finalized: true })),
  {
    symbol: instrument.symbol,
    source: instrument.source,
    freshness: instrument.freshness,
    calculatedAt: '2026-01-01T00:00:00.000Z',
    features: { gate: true, zones: true, actionable: true },
  },
);

function observe(instruments: readonly Instrument[], regime: ReadonlyMap<string, Regime>): Observation[] {
  const observations: Observation[] = [];
  const longest = Math.max(...HORIZONS);
  let done = 0;

  for (const instrument of instruments) {
    const { bars } = instrument;
    for (let index = WINDOW; index + longest < bars.length; index += STRIDE) {
      const result = runEngine(instrument, bars.slice(index + 1 - WINDOW, index + 1));
      if (result.status !== 'available' || !result.zones) continue;
      const zones = result.zones;
      observations.push({
        symbol: instrument.symbol,
        date: bars[index].date,
        index,
        split: 'train',
        regime: regime.get(bars[index].date) ?? 'unknown',
        zone: zones.zone,
        proximity: zones.proximity,
        conflict: (result.gate?.conflicts.length ?? 0) > 0,
        pendingBreakout: zones.pendingBreakout,
        pendingBreakdown: zones.pendingBreakdown,
        confidence: result.confidence,
        confidenceBucket: Math.min(9, Math.floor(result.confidence / 10)),
        close: zones.referenceClose,
        support: zones.support,
        resistance: zones.resistance,
        invalidation: result.actionable?.invalidation ?? null,
        target: result.actionable?.target ?? null,
        invalidationAtr: result.actionable?.invalidationAtr ?? null,
        riskReward: result.actionable?.riskReward ?? null,
      });
    }
    done += 1;
    if (done % 10 === 0) console.error(`  ${done}/${instruments.length} instruments`);
  }
  return observations;
}

/**
 * Does a 600-bar left window give the same answer as the whole history?
 *
 * If it does not, every figure below is measuring the window rather than the
 * engine. Checked on a sample rather than assumed.
 */
function verifyWindow(instruments: readonly Instrument[]): { checked: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let checked = 0;
  instruments.slice(0, 12).forEach((instrument) => {
    [0, 60, 140].forEach((offset) => {
      const end = instrument.bars.length - offset;
      if (end < WINDOW) return;
      const windowed = runEngine(instrument, instrument.bars.slice(end - WINDOW, end));
      const full = runEngine(instrument, instrument.bars.slice(0, end));
      checked += 1;
      if (windowed.status !== 'available' || full.status !== 'available') return;
      if (windowed.zones?.zone !== full.zones?.zone || windowed.state !== full.state) {
        mismatches.push(`${instrument.symbol} -${offset}: windowed ${windowed.state}/${windowed.zones?.zone} vs full ${full.state}/${full.zones?.zone}`);
      }
    });
  });
  return { checked, mismatches };
}

const directionOf = (zone: MarketSignalZoneName): Direction | null =>
  zone === 'uptrend' ? 1 : zone === 'downtrend' ? -1 : null;

/* ------------------------------------------------------------------------- */
/* measurement                                                               */
/* ------------------------------------------------------------------------- */

interface Context {
  observations: readonly Observation[];
  barsBySymbol: ReadonlyMap<string, readonly Bar[]>;
  random: () => number;
}

/** Criterion B over an arbitrary subset. */
function closeRate(context: Context, rows: readonly Observation[], horizon: number): Rate {
  const tally = emptyTally();
  rows.forEach((observation) => {
    const direction = directionOf(observation.zone);
    if (direction === null) return;
    const bars = context.barsBySymbol.get(observation.symbol)!;
    const outcome = closeOutcome(bars, observation.index, horizon, direction);
    if (outcome === 'unavailable') return;
    add(tally, outcome === 'flat' ? null : outcome === 'win', observation);
  });
  return rateOf(tally, horizon);
}

/**
 * The unconditional rate, weighted to the same mix of long and short claims the
 * subset actually made.
 *
 * Computed exactly rather than by sampling directions: `pUp` is measured once
 * over every sampled instrument-day, and the two are combined by the subset's
 * own long/short shares. Sampling here would add noise to the very number the
 * signal is being judged against.
 */
function closeBaseRate(context: Context, rows: readonly Observation[], horizon: number): Rate {
  const directional = rows.filter((observation) => directionOf(observation.zone) !== null);
  const longShare = directional.filter((observation) => observation.zone === 'uptrend').length
    / Math.max(directional.length, 1);

  const tally = emptyTally();
  let up = 0;
  let down = 0;
  context.observations.forEach((observation) => {
    const bars = context.barsBySymbol.get(observation.symbol)!;
    const outcome = closeOutcome(bars, observation.index, horizon, 1);
    if (outcome === 'unavailable') return;
    if (outcome === 'flat') { tally.excluded += 1; return; }
    if (outcome === 'win') up += 1; else down += 1;
    tally.keys.push(observation);
  });
  const total = up + down;
  if (!total) return rateOf(tally, horizon);
  const weighted = longShare * (up / total) + (1 - longShare) * (down / total);
  tally.wins = Math.round(weighted * total);
  tally.losses = total - tally.wins;
  return rateOf(tally, horizon);
}

interface BarrierRates { signal: Rate; control: Rate }

/** Criterion A over a subset, with its date-shuffled control. */
function barrierRates(context: Context, rows: readonly Observation[], horizon: number): BarrierRates {
  const signal = emptyTally();
  const control = emptyTally();

  rows.forEach((observation) => {
    const direction = directionOf(observation.zone);
    if (direction === null || observation.target === null || observation.invalidation === null) return;
    const bars = context.barsBySymbol.get(observation.symbol)!;
    const outcome = barrierOutcome({
      bars,
      index: observation.index,
      horizon,
      direction,
      target: observation.target,
      invalidation: observation.invalidation,
    });
    if (outcome.result === 'unavailable') return;
    if (outcome.ambiguous) signal.ambiguous += 1;
    if (outcome.result === 'unresolved') { signal.unresolved += 1; signal.excluded += 1; return; }
    add(signal, outcome.result === 'target', observation);

    /*
     * The control. Same instrument, same barrier DISTANCES, same horizon, on
     * other dates. It answers the only question that matters about a barrier
     * test: did the signal pick a better moment, or would these barriers have
     * resolved this way on any day of the year?
     */
    const reward = Math.abs(observation.target - observation.close);
    const risk = Math.abs(observation.close - observation.invalidation);
    const first = WINDOW;
    const last = bars.length - horizon - 1;
    for (let draw = 0; draw < CONTROL_DRAWS; draw += 1) {
      if (last <= first) break;
      const at = first + Math.floor(context.random() * (last - first));
      if (Math.abs(at - observation.index) < CONTROL_EXCLUSION) continue;
      const close = bars[at].close;
      const drawn = barrierOutcome({
        bars,
        index: at,
        horizon,
        direction,
        target: direction === 1 ? close + reward : close - reward,
        invalidation: direction === 1 ? close - risk : close + risk,
      });
      if (drawn.result === 'unavailable') continue;
      if (drawn.ambiguous) control.ambiguous += 1;
      if (drawn.result === 'unresolved') { control.unresolved += 1; control.excluded += 1; continue; }
      add(control, drawn.result === 'target', { symbol: observation.symbol, index: at });
    }
  });

  return { signal: rateOf(signal, horizon), control: rateOf(control, horizon) };
}

/* ------------------------------------------------------------------------- */
/* report                                                                    */
/* ------------------------------------------------------------------------- */

function main(): void {
  const { instruments, like, missing } = loadCorpus();
  console.error(`corpus: ${instruments.length} instruments${like ? ` (pinned to ${like})` : ''}`);
  if (missing.length > 0) console.error(`  NOT MEASURED: ${missing.join(', ')}`);

  console.error('verifying the left window is long enough ...');
  const windowCheck = verifyWindow(instruments);
  console.error(`  ${windowCheck.checked} comparisons, ${windowCheck.mismatches.length} mismatches`);

  const regime = marketRegime(instruments);
  console.error('observing ...');
  const observations = observe(instruments, regime);

  // Split by DATE, not by row, so train and test are periods rather than an
  // interleaving that would let the same week sit on both sides.
  const dates = [...new Set(observations.map((observation) => observation.date))].sort();
  const boundary = dates[Math.floor(dates.length * TRAIN_SHARE)];
  observations.forEach((observation) => { observation.split = observation.date < boundary ? 'train' : 'test'; });

  const context: Context = {
    observations,
    barsBySymbol: new Map(instruments.map((instrument) => [instrument.symbol, instrument.bars])),
    random: mulberry32(SEED),
  };

  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const outputDir = join(OUTPUT_ROOT, runId);
  mkdirSync(outputDir, { recursive: true });

  const lines: string[] = [];
  const say = (line = '') => { lines.push(line); };

  const directional = observations.filter((observation) => directionOf(observation.zone) !== null);
  const withBarriers = directional.filter((observation) => observation.target !== null && observation.invalidation !== null);

  say(`# Market Signal calibration — ${runId}`);
  say();
  say('P4a. Nothing here is fitted and nothing here feeds the engine.');
  say();
  say('```');
  say(`corpus             ${instruments.length} instruments${like ? ` — pinned to the list run ${like} measured` : ''}`);
  if (missing.length > 0) say(`NOT MEASURED       ${missing.join(', ')} — named by that manifest, absent from the cache`);
  say(`observations       ${observations.length}   (stride ${STRIDE} bars, left window ${WINDOW} bars)`);
  say(`period             ${dates[0]} .. ${dates.at(-1)}   (${dates.length} distinct as-of dates)`);
  say(`time split         train < ${boundary} <= test   (${observations.filter((row) => row.split === 'train').length} / ${observations.filter((row) => row.split === 'test').length})`);
  say(`directional        ${directional.length}   (${((directional.length / observations.length) * 100).toFixed(1)}% — the rest are sideways)`);
  say(`both barriers      ${withBarriers.length}   (${((withBarriers.length / observations.length) * 100).toFixed(1)}% of all observations)`);
  say(`window self-check  ${windowCheck.checked} comparisons, ${windowCheck.mismatches.length} mismatches`);
  windowCheck.mismatches.forEach((line) => say(`                   ${line}`));
  say(`bucket guard       n < ${MINIMUM_BUCKET} reports insufficient; buckets are NEVER merged to reach it`);
  say('```');
  say();
  say('**Known limits.** Survivorship: all 108 instruments still trade and the corpus');
  say('has no delisted names, so every figure is conditioned on survival and optimistic');
  say('by an unknown amount. No fees, spread or slippage — these are price moves, not');
  say('returns. The train/test split is **not** an overfit control: nothing is fitted at');
  say('this stage, so there is no fit for it to protect. It exists so P4b inherits a');
  say('held-out period that was defined before any number moved.');
  say();
  say('`n` is raw observations; `clust` is the largest non-overlapping subset of them,');
  say('which is the honest count of independent facts at that horizon.');
  say();

  /* ---- headline ------------------------------------------------------- */

  say('## 1. Does the signal beat doing nothing?');
  say();
  say('Criterion B, all directional signals, against the unconditional rate over the');
  say('same instrument-days weighted to the same long/short mix.');
  say();
  say('```');
  say('horizon |  signal      n   clust |    base      n |     edge');
  say('--------|------------------------|----------------|---------');
  const headline = new Map<number, { signal: Rate; base: Rate }>();
  HORIZONS.forEach((horizon) => {
    const signal = closeRate(context, directional, horizon);
    const base = closeBaseRate(context, directional, horizon);
    headline.set(horizon, { signal, base });
    say(`${String(horizon).padStart(7)} | ${pct(signal.rate)} ${String(signal.n).padStart(6)} ${String(signal.clustered).padStart(7)} | ${pct(base.rate)} ${String(base.n).padStart(6)} | ${gap(signal.rate, base.rate)}`);
  });
  say('```');
  say();

  say('### The same, by market regime');
  say();
  say('Split so a rising tape cannot make every long signal look predictive.');
  say();
  say('```');
  say('regime | horizon |  signal      n   clust |    base      n |     edge');
  say('-------|---------|------------------------|----------------|---------');
  (['up', 'down'] as const).forEach((state) => {
    const rows = directional.filter((observation) => observation.regime === state);
    HORIZONS.forEach((horizon) => {
      const signal = closeRate(context, rows, horizon);
      const base = closeBaseRate({ ...context, observations: observations.filter((row) => row.regime === state) }, rows, horizon);
      say(`${state.padEnd(6)} | ${String(horizon).padStart(7)} | ${pct(signal.rate)} ${String(signal.n).padStart(6)} ${String(signal.clustered).padStart(7)} | ${pct(base.rate)} ${String(base.n).padStart(6)} | ${gap(signal.rate, base.rate)}`);
    });
  });
  say('```');
  say();

  say('### The same, by time split');
  say();
  say('```');
  say('split | horizon |  signal      n   clust |    base      n |     edge');
  say('------|---------|------------------------|----------------|---------');
  (['train', 'test'] as const).forEach((split) => {
    const rows = directional.filter((observation) => observation.split === split);
    HORIZONS.forEach((horizon) => {
      const signal = closeRate(context, rows, horizon);
      const base = closeBaseRate({ ...context, observations: observations.filter((row) => row.split === split) }, rows, horizon);
      say(`${split.padEnd(5)} | ${String(horizon).padStart(7)} | ${pct(signal.rate)} ${String(signal.n).padStart(6)} ${String(signal.clustered).padStart(7)} | ${pct(base.rate)} ${String(base.n).padStart(6)} | ${gap(signal.rate, base.rate)}`);
    });
  });
  say('```');
  say();

  /* ---- criterion A ---------------------------------------------------- */

  say('## 2. Criterion A — target before invalidation');
  say();
  say('The claim the card literally makes. Control is the same instrument and the same');
  say('barrier distances placed on other dates, so only the timing is removed.');
  say('`unres.` is observations where neither barrier was reached inside the horizon;');
  say('`amb.` is bars that reached both, which resolve as losses.');
  say();
  say('At the short horizons most observations reach neither barrier, so `signal` is a');
  say('rate over the RESOLVED ones only. `target/all` is the share of every observation');
  say('that reached its target, which is the number a reader waiting for one would feel.');
  say();
  say('```');
  say('horizon |  signal      n   clust | control      n |     edge | unres. amb. | target/all');
  say('--------|------------------------|----------------|----------|-------------|-----------');
  HORIZONS.forEach((horizon) => {
    const { signal, control } = barrierRates(context, withBarriers, horizon);
    const all = signal.n + signal.unresolved;
    const overAll = all ? `${((signal.wins / all) * 100).toFixed(1)}%` : '—';
    say(`${String(horizon).padStart(7)} | ${pct(signal.rate)} ${String(signal.n).padStart(6)} ${String(signal.clustered).padStart(7)} | ${pct(control.rate)} ${String(control.n).padStart(6)} | ${gap(signal.rate, control.rate)} | ${String(signal.unresolved).padStart(6)} ${String(signal.ambiguous).padStart(4)} | ${overAll.padStart(10)}`);
  });
  say('```');
  say();

  /* ---- dimensions ----------------------------------------------------- */

  const dimension = (
    title: string,
    note: string,
    buckets: ReadonlyArray<{ label: string; rows: readonly Observation[] }>,
  ) => {
    say(`### ${title}`);
    say();
    if (note) { say(note); say(); }
    say('```');
    say('bucket           | horizon |  signal      n   clust |    base |     edge');
    say('-----------------|---------|------------------------|---------|---------');
    buckets.forEach(({ label, rows }) => {
      HORIZONS.forEach((horizon) => {
        const signal = closeRate(context, rows, horizon);
        const base = closeBaseRate(context, rows, horizon);
        say(`${label.padEnd(16)} | ${String(horizon).padStart(7)} | ${pct(signal.rate)} ${String(signal.n).padStart(6)} ${String(signal.clustered).padStart(7)} | ${pct(base.rate)} | ${gap(signal.rate, base.rate)}`);
      });
    });
    say('```');
    say();
  };

  say('## 3. The dimensions P4a has to cut by');
  say();
  say('Marginals first. The full cross of zone x proximity x conflict x confidence is');
  say('180 cells and almost all of them are under the guard, so it is printed last with');
  say('`insufficient` wherever it belongs rather than merged into something readable.');
  say();

  dimension('By zone', '', [
    { label: 'uptrend', rows: directional.filter((row) => row.zone === 'uptrend') },
    { label: 'downtrend', rows: directional.filter((row) => row.zone === 'downtrend') },
  ]);

  dimension(
    'By proximity — the P2.6 assumption, tested',
    'P2.6 asserted that `near_trigger` marks a FRAGILE label. It never said fragile\n'
    + 'means wrong, and nothing has checked either reading. Both are below: this table\n'
    + 'is whether the direction is less often right, and the one after it is whether the\n'
    + 'label itself is less likely to survive.',
    (['near_trigger', 'mid_range', 'deep_range'] as const).map((value) => ({
      label: value,
      rows: directional.filter((row) => row.proximity === value),
    })),
  );

  say('#### Does `near_trigger` actually mark a fragile label?');
  say();
  say('The claim P2.6 made, measured directly: how often the zone is something else');
  say('`horizon` bars later. Read from the sampled grid, which is why the stride divides');
  say('every horizon.');
  say();
  say('```');
  say('proximity    | horizon | zone changed |      n | changed to sideways');
  say('-------------|---------|--------------|--------|--------------------');
  const byKey = new Map(observations.map((row) => [`${row.symbol}@${row.index}`, row]));
  (['near_trigger', 'mid_range', 'deep_range'] as const).forEach((value) => {
    const rows = directional.filter((row) => row.proximity === value);
    HORIZONS.forEach((horizon) => {
      let changed = 0;
      let toSideways = 0;
      let total = 0;
      rows.forEach((row) => {
        const later = byKey.get(`${row.symbol}@${row.index + horizon}`);
        if (!later) return;
        total += 1;
        if (later.zone !== row.zone) changed += 1;
        if (later.zone === 'sideways') toSideways += 1;
      });
      const rate = total >= MINIMUM_BUCKET ? `${((changed / total) * 100).toFixed(1)}%`.padStart(12) : 'insuff.'.padStart(12);
      const sideways = total >= MINIMUM_BUCKET ? `${((toSideways / total) * 100).toFixed(1)}%`.padStart(19) : 'insuff.'.padStart(19);
      say(`${value.padEnd(12)} | ${String(horizon).padStart(7)} | ${rate} | ${String(total).padStart(6)} | ${sideways}`);
    });
  });
  say('```');
  say();

  dimension(
    'By conflict — is the P1 gate earning its confidence penalty?',
    'If a conflicted signal is no worse than an unconflicted one, then `SIGNAL_GATE`\n'
    + 'is damping confidence for a reason that does not exist, and that is a thing to\n'
    + 'know before P4b calibrates on top of it.',
    [
      { label: 'conflict', rows: directional.filter((row) => row.conflict) },
      { label: 'no conflict', rows: directional.filter((row) => !row.conflict) },
    ],
  );

  dimension(
    'By risk leg — the P3.5 outlier question',
    'R:R runs away when the close sits almost on its own invalidation, which is exactly\n'
    + 'when a zone is freshest. This is whether those signals are actually better.',
    [
      { label: '< 0.5 ATR', rows: directional.filter((row) => row.invalidationAtr !== null && row.invalidationAtr < 0.5) },
      { label: '0.5-1.5 ATR', rows: directional.filter((row) => row.invalidationAtr !== null && row.invalidationAtr >= 0.5 && row.invalidationAtr < 1.5) },
      { label: '1.5-3 ATR', rows: directional.filter((row) => row.invalidationAtr !== null && row.invalidationAtr >= 1.5 && row.invalidationAtr < 3) },
      { label: '>= 3 ATR', rows: directional.filter((row) => row.invalidationAtr !== null && row.invalidationAtr >= 3) },
    ],
  );

  /* ---- reliability ---------------------------------------------------- */

  say('### Reliability — reported confidence against measured hit rate');
  say();
  say('A confidence number is a promise. This is whether it is kept. `uncalibrated` is');
  say('what the UI says today, and these rows are why it has to keep saying it until P4b.');
  say();
  say('```');
  say('confidence | horizon | reported |     hit |      n   clust |     gap');
  say('-----------|---------|----------|---------|----------------|--------');
  for (let bucket = 0; bucket < 10; bucket += 1) {
    const rows = directional.filter((row) => row.confidenceBucket === bucket);
    if (!rows.length) continue;
    const reported = rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length / 100;
    HORIZONS.forEach((horizon) => {
      const signal = closeRate(context, rows, horizon);
      say(`${`${bucket * 10}-${bucket * 10 + 9}`.padStart(10)} | ${String(horizon).padStart(7)} | ${pct(reported)} | ${pct(signal.rate)} | ${String(signal.n).padStart(6)} ${String(signal.clustered).padStart(7)} | ${gap(signal.rate, reported)}`);
    });
  }
  say('```');
  say();

  /* ---- sideways and pending ------------------------------------------- */

  say('## 4. The claims that are not directional');
  say();
  say('### Sideways');
  say();
  say('Excluded from every hit rate above: no direction was claimed, so there is nothing');
  say('to be right about. It does make a claim, though — that price stays in the frame');
  say('and the label holds — and that is checkable.');
  say();
  say('```');
  say('horizon | still sideways | stayed inside frame |      n');
  say('--------|----------------|---------------------|-------');
  const sideways = observations.filter((row) => row.zone === 'sideways');
  HORIZONS.forEach((horizon) => {
    let held = 0;
    let inside = 0;
    let total = 0;
    sideways.forEach((row) => {
      const bars = context.barsBySymbol.get(row.symbol)!;
      if (!bars[row.index + horizon]) return;
      total += 1;
      const later = byKey.get(`${row.symbol}@${row.index + horizon}`);
      if (later?.zone === 'sideways') held += 1;
      let breached = false;
      for (let step = 1; step <= horizon; step += 1) {
        const bar = bars[row.index + step];
        if (bar.close > row.resistance || bar.close < row.support) { breached = true; break; }
      }
      if (!breached) inside += 1;
    });
    const share = (count: number) => total >= MINIMUM_BUCKET ? `${((count / total) * 100).toFixed(1)}%` : 'insuff.';
    say(`${String(horizon).padStart(7)} | ${share(held).padStart(14)} | ${share(inside).padStart(19)} | ${String(total).padStart(6)}`);
  });
  say('```');
  say();

  say('### `pending_breakout` — how many are confirmed');
  say();
  say('A close is already past the trigger and the confirmation rule has not accepted it');
  say('yet. The card tells a reader that. This is what happens next.');
  say();
  say('```');
  say('flag              | horizon | confirmed | reverted to sideways |      n');
  say('------------------|---------|-----------|----------------------|-------');
  ([
    ['pending_breakout', (row: Observation) => row.pendingBreakout, 'uptrend'],
    ['pending_breakdown', (row: Observation) => row.pendingBreakdown, 'downtrend'],
  ] as const).forEach(([label, predicate, becomes]) => {
    const rows = observations.filter(predicate);
    HORIZONS.forEach((horizon) => {
      let confirmed = 0;
      let reverted = 0;
      let total = 0;
      rows.forEach((row) => {
        const later = byKey.get(`${row.symbol}@${row.index + horizon}`);
        if (!later) return;
        total += 1;
        if (later.zone === becomes) confirmed += 1;
        if (later.zone === 'sideways') reverted += 1;
      });
      const share = (count: number) => total >= MINIMUM_BUCKET ? `${((count / total) * 100).toFixed(1)}%` : 'insuff.';
      say(`${label.padEnd(17)} | ${String(horizon).padStart(7)} | ${share(confirmed).padStart(9)} | ${share(reverted).padStart(20)} | ${String(total).padStart(6)}`);
    });
  });
  say('```');
  say();

  /* ---- the full cross ------------------------------------------------- */

  say('## 5. The full cross');
  say();
  say('zone x proximity x conflict x confidence bucket, at the 10-bar horizon. Printed');
  say('whole, with `insufficient` wherever the guard bites, because merging cells to');
  say('reach 30 would change the question being answered without anybody noticing.');
  say();
  say('```');
  say('zone      proximity     conflict  conf   |     hit      n   clust |    base |     edge');
  say('----------------------------------------|------------------------|---------|---------');
  let printed = 0;
  let suppressed = 0;
  (['uptrend', 'downtrend'] as const).forEach((zone) => {
    (['near_trigger', 'mid_range', 'deep_range'] as const).forEach((proximity) => {
      [false, true].forEach((conflict) => {
        for (let bucket = 0; bucket < 10; bucket += 1) {
          const rows = directional.filter((row) => row.zone === zone
            && row.proximity === proximity
            && row.conflict === conflict
            && row.confidenceBucket === bucket);
          if (!rows.length) continue;
          const signal = closeRate(context, rows, 10);
          const base = closeBaseRate(context, rows, 10);
          if (signal.rate === null) suppressed += 1; else printed += 1;
          say(`${zone.padEnd(9)} ${proximity.padEnd(13)} ${(conflict ? 'yes' : 'no').padEnd(9)} ${`${bucket * 10}s`.padEnd(6)} | ${pct(signal.rate)} ${String(signal.n).padStart(6)} ${String(signal.clustered).padStart(7)} | ${pct(base.rate)} | ${gap(signal.rate, base.rate)}`);
        }
      });
    });
  });
  say('```');
  say();
  say(`Cells with a number: ${printed}. Cells suppressed by the n < ${MINIMUM_BUCKET} guard: ${suppressed}.`);
  say();

  const report = `${lines.join('\n')}\n`;
  writeFileSync(join(outputDir, 'report.md'), report, 'utf8');
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
    runId,
    horizons: HORIZONS,
    stride: STRIDE,
    window: WINDOW,
    minimumBucket: MINIMUM_BUCKET,
    controlDraws: CONTROL_DRAWS,
    controlExclusion: CONTROL_EXCLUSION,
    trainShare: TRAIN_SHARE,
    seed: SEED,
    instruments: instruments.map((instrument) => instrument.symbol),
    observations: observations.length,
    directional: directional.length,
    withBarriers: withBarriers.length,
    period: [dates[0], dates.at(-1)],
    boundary,
    windowSelfCheck: windowCheck,
    headline: Object.fromEntries([...headline.entries()].map(([horizon, value]) => [horizon, value])),
  }, null, 2)}\n`, 'utf8');

  console.log(report);
  console.error(`written to ${outputDir}`);
}

main();
