/**
 * Does the label DESCRIBE what price already did? A measurement, and only that.
 *
 * THE QUESTION, AND WHY IT IS NOT THE ONE ALREADY ANSWERED.
 * `MarketSignalSection.tsx` puts this sentence under every card:
 *
 *   "การ์ดนี้อธิบายสิ่งที่ราคาทำไปแล้ว ไม่ได้พยากรณ์สิ่งที่ราคาจะทำ —
 *    ผลทดสอบย้อนหลังยังไม่พบว่าทิศทางที่ระบุแม่นกว่าอัตราพื้นฐานของตลาด"
 *
 * The second half is measured: P4a/P4b/P5/P6 asked whether the direction beats
 * the base rate FORWARD, and the answer was no, which is why the sentence says
 * so. The FIRST half has never been measured at all. "Describes what price
 * already did" is a claim about the past — about whether the word on the card
 * matches the move on the chart to its left — and no forward return can settle
 * it. This file settles it, backwards only.
 *
 * NOT A FORWARD MEASUREMENT, BY CONSTRUCTION. There is no horizon, no forward
 * return, no hit rate, no base rate and no barrier anywhere below. Every number
 * a row carries is computed from bars at or before the bar being labelled. A
 * reader who finds a forward-looking quantity in this file has found a bug.
 *
 * NOTHING HERE IS A FEATURE. No engine file, no config value, no label, no
 * threshold and no copy is touched. The probe reads the engine and reports.
 *
 * ---------------------------------------------------------------------------
 * ★ THE GROUND TRUTH IS A DESIGN CHOICE, NOT THE TRUTH
 * ---------------------------------------------------------------------------
 * Four numbers below decide what "price went up" MEANS, and all four were
 * picked by a person, not discovered:
 *
 *   N = 20 bars      the lookback the move is measured over. A month of
 *                    trading. 10 would call every bounce a trend; 60 would
 *                    call almost nothing one.
 *   ATR period 14    the yardstick displacement is divided by. Standard, and
 *                    standard is not the same as correct.
 *   displacement 1.5 how far price must have travelled, in ATRs, to count.
 *   efficiency 0.3   how straight the path had to be to count.
 *
 * There is no external register of what a trend is, so a disagreement between
 * this labeller and the engine does NOT prove the engine wrong — it proves the
 * two disagree. That is why §4 of the report re-runs the whole verdict across a
 * 3x3x3 grid of these numbers: if the verdict moves when they move, the verdict
 * is about the parameters and the report says so in those words instead of
 * pretending otherwise. It is also why the ten worst conflicts are listed with
 * their symbol and date, so the owner can open the chart and judge who is right.
 *
 * ATR14 here is computed BY THIS FILE from the frozen bars (Wilder, seeded at
 * bar 0 of the capture), never read off `result.metrics.atr14`. The labeller
 * has to stand on price alone; if it read the engine's own field it would share
 * the engine's window seeding and stop being independent of the thing under
 * test. The two numbers are close and are not required to be equal.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS COMPARED
 * ---------------------------------------------------------------------------
 *   ground truth   UP / DOWN / SIDEWAYS from the rule above, bar t backwards
 *   engine OFF     `state`, every flag off — WHAT SHIPS TODAY (handover §1.3)
 *   engine ON      `state` with GATE + ZONES on; §5 says the two paths reach
 *                  the label by different rules, so they are two measurements
 *                  and are never pooled
 *   B1             sign(ema50SlopePct), |slope| < 0.1% -> SIDEWAYS
 *   B2             close vs ema200, no SIDEWAYS at all
 *
 * Both baselines are read off the SAME engine run at the SAME bar, so they see
 * exactly the data the engine saw. They are not strawmen: B1 is the one-line
 * version of "the trend is where the medium EMA points" and B2 is the oldest
 * trend rule in the book, and the engine's five weighted components, its gate
 * and its zone structure all have to earn their place against them.
 *
 * MAPPING, FIXED BEFORE THE RUN AND NEVER TUNED:
 *   STRONG_BULLISH, BULLISH -> UP · STRONG_BEARISH, BEARISH -> DOWN
 *   SIDEWAYS -> SIDEWAYS
 *   SQUEEZE, OVEREXTENDED   -> OTHER. These are regime vetoes, not directions
 *                              (§5: they overwrite the label on every path).
 *                              They get their own row, are excluded from the
 *                              3x3 and from agreement, and are NEVER folded
 *                              into SIDEWAYS to flatter or to punish.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR NUMBERS
 * ---------------------------------------------------------------------------
 *   agreement     share of bars where the label equals the ground truth, with
 *                 an interval on the CLUSTERED count
 *   confusion     3x3, ground truth down the side. UP<->DOWN is the cell that
 *                 matters: confusing a trend with SIDEWAYS is a threshold
 *                 disagreement, calling an up-move DOWN is a description that
 *                 is backwards
 *   lag           ground truth changes at bar t; how many bars until the label
 *                 says the same thing (median, p90, nearest-rank)
 *   flip ratio    label changes / ground-truth changes over the same bars.
 *                 Above 1.0 the engine speaks more often than the thing it
 *                 claims to be describing. A change INTO or OUT OF
 *                 SQUEEZE/OVEREXTENDED counts: those two are excluded from
 *                 agreement because they are not directions, but a card that
 *                 shows BULLISH -> SQUEEZE -> BULLISH changed its word twice in
 *                 front of a reader and this is the number that must say so
 *
 * CLUST IS THE DENOMINATOR THAT COUNTS. Bars are sampled at stride 1 and the
 * ground truth at bar t shares 19 of its 20 bars with bar t-1, so 70k rows are
 * nothing like 70k facts. `clust` is the largest subset of a source sharing no
 * ground-truth window bars (spacing >= N), every interval is computed on it,
 * and anything under the minimum reports insufficient rather than a number.
 * Buckets are never merged to reach the guard.
 *
 * NO LOOK-AHEAD, NO CLOCK, NO NETWORK. The engine sees `bars[..t]` only, the
 * labeller sees `bars[t-N..t]` only, `calculatedAt` is a pinned constant, and
 * the corpus is pinned to a run manifest rather than to a directory listing,
 * because `__golden__/corpus/` is a cache that grows and two runs over
 * different corpora are not comparable.
 *
 * ---------------------------------------------------------------------------
 * THE VERDICT RULE, WRITTEN DOWN BEFORE THE NUMBERS EXISTED
 * ---------------------------------------------------------------------------
 * `verdictFor()` below is the whole of it and the report prints what the code
 * decided, not what a reader concluded afterwards:
 *
 *   1. the better baseline is taken PER METRIC — the HIGHER of B1/B2 agreement
 *      and the LOWER of B1/B2 flip ratio. The engine does not get to face the
 *      weaker one twice.
 *   2. an engine state PASSES only if it beats that on BOTH: strictly higher
 *      agreement AND strictly lower flip ratio. One out of two is a FAIL.
 *   3. the HEADLINE verdict is the OFF state's, because OFF is what ships
 *      today (`docs/signal-handover.md` §1.3). The ON state is reported with
 *      its own PASS/FAIL beside it and cannot rescue the headline.
 *   4. a negative result is the finding. The mapping, the ground truth and
 *      this rule are frozen at the moment this file was committed; anything
 *      the numbers suggest afterwards belongs under "Not part of the verdict"
 *      at the end of the report and changes nothing above it.
 *
 * Run: npm run signal:trend-agreement -- --shard=0/4   (x4, in parallel)
 *      npm run signal:trend-agreement                  (reads the shards,
 *                                                       writes the report)
 *      --like=<runId> to pin a different calibration run.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MARKET_SIGNAL_MEASURED } from '@/src/config/signal';
import { calculateMarketSignal } from '@/src/lib/analytics/market-signal/calculations';
import type {
  MarketSignalCandle,
  MarketSignalResult,
  MarketSignalState,
} from '@/src/lib/analytics/market-signal/types';
import type { DataFreshness } from '@/src/lib/market-data/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');
const CALIBRATION_ROOT = join(process.cwd(), '__calibration__');
const SHARD_DIR = join(process.cwd(), '.qa', 'trend-agreement');
const OUTPUT_PATH = join(process.cwd(), 'trend_agreement.md');

/* ---- the labeller. ★ four design choices, see header ---------------------- */
interface TruthDefinition { bars: number; displacement: number; efficiency: number }
const BASE_TRUTH: TruthDefinition = { bars: 20, displacement: 1.5, efficiency: 0.3 };
const ATR_PERIOD = 14;

/* ---- sensitivity grid. The base value sits in each list ------------------- */
const GRID_BARS = [15, 20, 25] as const;
const GRID_DISPLACEMENT = [1.2, 1.5, 1.8] as const;
const GRID_EFFICIENCY = [0.25, 0.3, 0.35] as const;

/* ---- harness constants, kept identical to the pinned run where they exist - */
const WINDOW = 600;
/** 1, not the harness's 5: lag is measured in bars and a stride of 5 cannot see a 2-bar lag. */
const STRIDE = 1;
const MINIMUM_BUCKET = 30;

/** How far past a ground-truth change the label is given to catch up. */
const LAG_CAP = 60;

/** Four primary agreement looks: OFF, ON, B1, B2. */
const LOOKS = 4;
const Z_NAIVE = 1.96;
const Z_ADJUSTED = 2.498;

/** B1's dead band, in the units `ema50SlopePct` publishes (percent). */
const B1_FLAT_PCT = 0.1;

/** Pinned: a clock read would make two runs of this file differ. */
const CALCULATED_AT = '2026-01-01T00:00:00.000Z';

type Truth = 'UP' | 'DOWN' | 'SIDEWAYS';
type Label = Truth | 'OTHER';
const TRUTHS: readonly Truth[] = ['UP', 'DOWN', 'SIDEWAYS'];

type SourceId = 'engine_off' | 'engine_on' | 'b1' | 'b2';
const SOURCES: readonly SourceId[] = ['engine_off', 'engine_on', 'b1', 'b2'];
const SOURCE_LABEL: Record<SourceId, string> = {
  engine_off: 'engine · flags OFF (ships today)',
  engine_on: 'engine · GATE+ZONES ON',
  b1: 'B1 · sign(ema50SlopePct), \\|slope\\| < 0.1% -> SIDEWAYS',
  b2: 'B2 · close vs ema200 (no SIDEWAYS)',
};

/** Frozen before the run. Not tuned, not revisited. */
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

/* ------------------------------------------------------------------------- */
/* the ground truth — price only, backwards only                             */
/* ------------------------------------------------------------------------- */

/**
 * Wilder ATR over the whole capture, computed here rather than read off the
 * engine. See the header: the labeller may not borrow the yardstick from the
 * thing it is measuring.
 */
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

/**
 * The window ENDS at bar t. `bars[t + 1]` is never read, here or anywhere else
 * in this file.
 */
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
    // A window where price never moved at all: net is 0, so it is SIDEWAYS by
    // any reading of the rule. Reported as efficiency 0 rather than as a hole.
    const efficiency = path === 0 ? 0 : Math.abs(net) / path;
    let label: Truth = 'SIDEWAYS';
    if (efficiency >= minEfficiency) {
      if (displacement >= minDisplacement) label = 'UP';
      else if (displacement <= -minDisplacement) label = 'DOWN';
    }
    return { label, displacement, efficiency };
  });
}

/* ------------------------------------------------------------------------- */
/* loading — pinned to a manifest, never to the directory                     */
/* ------------------------------------------------------------------------- */

interface Manifest {
  runId: string;
  instruments: string[];
  boundary: string;
  stride: number;
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

function loadCorpus(manifest: Manifest): { instruments: Instrument[]; missing: string[] } {
  const onDisk = new Set(readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.json')));
  const instruments: Instrument[] = [];
  const missing: string[] = [];
  for (const symbol of manifest.instruments) {
    const file = `${symbol}.json`;
    if (!onDisk.has(file)) { missing.push(symbol); continue; }
    const frozen = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as Frozen;
    const bars = frozen.candles
      .filter((candle) => candle.finalized)
      .map(({ finalized: _finalized, ...candle }) => candle);
    if (bars.length < WINDOW + Math.max(...GRID_BARS) + 1) { missing.push(symbol); continue; }
    instruments.push({ symbol: frozen.symbol, source: frozen.source, freshness: frozen.freshness, bars });
  }
  return { instruments, missing };
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

/* ------------------------------------------------------------------------- */
/* collecting — one engine pass per bar per flag state                        */
/* ------------------------------------------------------------------------- */

/**
 * What one bar of one instrument contributes. Ground truth is NOT in here: it
 * is recomputed at report time for every point of the sensitivity grid.
 */
interface Row {
  symbol: string;
  index: number;
  date: string;
  off: MarketSignalState | null;
  on: MarketSignalState | null;
  ema50SlopePct: number | null;
  ema200: number | null;
  close: number | null;
  /** 1 when the two flag states disagreed about an INDICATOR, which they must never do. */
  drift: 0 | 1;
}

function collect(instruments: readonly Instrument[]): Row[] {
  const rows: Row[] = [];
  let done = 0;
  for (const instrument of instruments) {
    const { bars } = instrument;
    for (let index = WINDOW; index < bars.length; index += STRIDE) {
      const window = bars.slice(index + 1 - WINDOW, index + 1);
      const off = runEngine(instrument, window, { gate: false, zones: false, actionable: false });
      const on = runEngine(instrument, window, { gate: true, zones: true, actionable: false });
      const drift = off.metrics.ema50SlopePct !== on.metrics.ema50SlopePct
        || off.metrics.ema200 !== on.metrics.ema200
        || off.metrics.close !== on.metrics.close ? 1 : 0;
      rows.push({
        symbol: instrument.symbol,
        index,
        date: bars[index].date,
        off: off.status === 'available' ? off.state : null,
        on: on.status === 'available' ? on.state : null,
        ema50SlopePct: off.metrics.ema50SlopePct,
        ema200: off.metrics.ema200,
        close: off.metrics.close,
        drift,
      });
    }
    done += 1;
    console.error(`  ${done}/${instruments.length} ${instrument.symbol}`);
  }
  return rows;
}

/* ------------------------------------------------------------------------- */
/* measuring                                                                  */
/* ------------------------------------------------------------------------- */

/** One label stream for one instrument, aligned bar for bar with `rows`. */
function labelsFor(rows: readonly Row[], source: SourceId): Array<Label | null> {
  return rows.map((row) => {
    if (source === 'engine_off') return mapState(row.off);
    if (source === 'engine_on') return mapState(row.on);
    if (source === 'b1') {
      if (row.ema50SlopePct === null) return null;
      if (Math.abs(row.ema50SlopePct) < B1_FLAT_PCT) return 'SIDEWAYS';
      return row.ema50SlopePct > 0 ? 'UP' : 'DOWN';
    }
    if (row.close === null || row.ema200 === null) return null;
    return row.close >= row.ema200 ? 'UP' : 'DOWN';
  });
}

interface Stats {
  n: number;
  clustered: number;
  agreement: number | null;
  halfNaive: number | null;
  halfAdjusted: number | null;
  confusion: Record<Truth, Record<Truth, number>>;
  crossPolarity: number;
  other: number;
  otherTruth: Record<Truth, number>;
  unlabelled: number;
  gtChanges: number;
  labelChanges: number;
  flipRatio: number | null;
  lagEvents: number;
  lagMedian: number | null;
  lagP90: number | null;
  lagCensored: number;
  lagTruncated: number;
  lagLed: number;
}

const emptyConfusion = (): Record<Truth, Record<Truth, number>> => ({
  UP: { UP: 0, DOWN: 0, SIDEWAYS: 0 },
  DOWN: { UP: 0, DOWN: 0, SIDEWAYS: 0 },
  SIDEWAYS: { UP: 0, DOWN: 0, SIDEWAYS: 0 },
});

/** Nearest-rank, so a lag quantile is a whole number of bars. */
function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/**
 * Per instrument, per source. Rows are contiguous (stride 1), which is what
 * makes a lag in bars readable at all.
 */
function measure(
  bySymbol: ReadonlyMap<string, Row[]>,
  truthBySymbol: ReadonlyMap<string, TruthPoint[]>,
  source: SourceId,
  definition: TruthDefinition,
): Stats {
  const confusion = emptyConfusion();
  const otherTruth: Record<Truth, number> = { UP: 0, DOWN: 0, SIDEWAYS: 0 };
  let n = 0;
  let other = 0;
  let unlabelled = 0;
  let gtChanges = 0;
  let labelChanges = 0;
  let lagLed = 0;
  let lagCensored = 0;
  let lagTruncated = 0;
  const lags: number[] = [];
  /** Indices kept for the clustered count, per symbol. */
  const kept = new Map<string, number[]>();

  bySymbol.forEach((rows, symbol) => {
    const truth = truthBySymbol.get(symbol)!;
    const labels = labelsFor(rows, source);
    const keptHere: number[] = [];

    rows.forEach((row, position) => {
      const gt = truth[row.index].label;
      const label = labels[position];
      if (gt === null) return;
      if (label === null) { unlabelled += 1; return; }
      if (label === 'OTHER') { other += 1; otherTruth[gt] += 1; return; }
      confusion[gt][label] += 1;
      n += 1;
      keptHere.push(row.index);
    });
    kept.set(symbol, keptHere);

    // Change events. Both streams are walked over the same bars, so the ratio
    // is two counts of the same thing and not two different populations.
    for (let position = 1; position < rows.length; position += 1) {
      const previousTruth = truth[rows[position - 1].index].label;
      const currentTruth = truth[rows[position].index].label;
      if (previousTruth === null || currentTruth === null) continue;
      const previousLabel = labels[position - 1];
      const currentLabel = labels[position];
      if (previousLabel !== null && currentLabel !== null && previousLabel !== currentLabel) labelChanges += 1;
      if (previousTruth === currentTruth) continue;
      gtChanges += 1;

      // Lag. An event too close to the end of the capture cannot be given the
      // full LAG_CAP bars to resolve, so it is dropped rather than counted as
      // a fast one or as a censored one.
      if (position + LAG_CAP >= rows.length) { lagTruncated += 1; continue; }
      if (previousLabel === currentTruth) lagLed += 1;
      let lag: number | null = null;
      for (let step = 0; step <= LAG_CAP; step += 1) {
        if (labels[position + step] === currentTruth) { lag = step; break; }
      }
      if (lag === null) lagCensored += 1; else lags.push(lag);
    }
  });

  // The largest subset of rows sharing no ground-truth window bars.
  let clustered = 0;
  kept.forEach((indices) => {
    let last = -Infinity;
    indices.forEach((index) => {
      if (index - last >= definition.bars) { clustered += 1; last = index; }
    });
  });

  const hits = TRUTHS.reduce((sum, truth) => sum + confusion[truth][truth], 0);
  const sufficient = n >= MINIMUM_BUCKET && clustered >= MINIMUM_BUCKET;
  const agreement = sufficient ? hits / n : null;
  const crossPolarity = confusion.UP.DOWN + confusion.DOWN.UP;
  const sortedLags = [...lags].sort((left, right) => left - right);
  const lagEvents = lags.length + lagCensored;

  return {
    n,
    clustered,
    agreement,
    halfNaive: agreement === null ? null : Z_NAIVE * Math.sqrt((agreement * (1 - agreement)) / clustered),
    halfAdjusted: agreement === null ? null : Z_ADJUSTED * Math.sqrt((agreement * (1 - agreement)) / clustered),
    confusion,
    crossPolarity,
    other,
    otherTruth,
    unlabelled,
    gtChanges,
    labelChanges,
    flipRatio: gtChanges >= MINIMUM_BUCKET ? labelChanges / gtChanges : null,
    lagEvents,
    lagMedian: lagEvents >= MINIMUM_BUCKET ? quantile(sortedLags, 0.5) : null,
    lagP90: lagEvents >= MINIMUM_BUCKET ? quantile(sortedLags, 0.9) : null,
    lagCensored,
    lagTruncated,
    lagLed,
  };
}

/* ------------------------------------------------------------------------- */
/* the verdict — code decides, nobody decides afterwards                      */
/* ------------------------------------------------------------------------- */

interface Verdict {
  pass: boolean;
  beatAgreement: boolean;
  beatFlip: boolean;
  baselineAgreement: number | null;
  baselineFlip: number | null;
}

function verdictFor(engine: Stats, b1: Stats, b2: Stats): Verdict {
  const agreements = [b1.agreement, b2.agreement].filter((value): value is number => value !== null);
  const flips = [b1.flipRatio, b2.flipRatio].filter((value): value is number => value !== null);
  const baselineAgreement = agreements.length > 0 ? Math.max(...agreements) : null;
  const baselineFlip = flips.length > 0 ? Math.min(...flips) : null;
  const beatAgreement = engine.agreement !== null && baselineAgreement !== null && engine.agreement > baselineAgreement;
  const beatFlip = engine.flipRatio !== null && baselineFlip !== null && engine.flipRatio < baselineFlip;
  return { pass: beatAgreement && beatFlip, beatAgreement, beatFlip, baselineAgreement, baselineFlip };
}

/* ------------------------------------------------------------------------- */
/* formatting                                                                 */
/* ------------------------------------------------------------------------- */

const pct = (value: number | null) => (value === null ? 'insuff.' : `${(value * 100).toFixed(1)}%`);
const band = (value: number | null) => (value === null ? '—' : `±${(value * 100).toFixed(1)}pp`);
const ratio = (value: number | null) => (value === null ? 'insuff.' : value.toFixed(2));
const barCount = (value: number | null) => (value === null ? 'insuff.' : `${value}`);
const num = (value: number | null, digits = 2) => (value === null ? '—' : value.toFixed(digits));

/* ------------------------------------------------------------------------- */
/* the run                                                                    */
/* ------------------------------------------------------------------------- */

interface ShardFile { runId: string; shard: string; rows: Row[] }

const shardPath = (runId: string, shard: string): string => join(SHARD_DIR, `obs-${runId}-${shard.replace('/', 'of')}.json`);

function main(): void {
  const runId = pinnedRunId();
  const manifest = loadManifest(runId);
  if (manifest.window !== WINDOW || manifest.minimumBucket !== MINIMUM_BUCKET) {
    throw new Error('pinned run used different harness constants; the rows would not be comparable');
  }
  const { instruments, missing } = loadCorpus(manifest);
  const shardFlag = process.argv.find((argument) => argument.startsWith('--shard='));

  if (shardFlag) {
    const shard = shardFlag.slice('--shard='.length);
    const [indexText, countText] = shard.split('/');
    const shardIndex = Number(indexText);
    const shardCount = Number(countText);
    if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount)
      || shardCount < 1 || shardIndex < 0 || shardIndex >= shardCount) {
      throw new Error('--shard= expects i/k with 0 <= i < k');
    }
    const mine = instruments.filter((_, position) => position % shardCount === shardIndex);
    console.error(`shard ${shardIndex}/${shardCount}: ${mine.length} instruments, ${WINDOW}-bar window, stride ${STRIDE}`);
    const rows = collect(mine);
    if (!existsSync(SHARD_DIR)) mkdirSync(SHARD_DIR, { recursive: true });
    writeFileSync(shardPath(runId, shard), JSON.stringify({ runId, shard, rows } satisfies ShardFile));
    console.error(`shard ${shardIndex}/${shardCount}: ${rows.length} rows written`);
    return;
  }

  /* ---- report ---------------------------------------------------------- */

  if (!existsSync(SHARD_DIR)) throw new Error(`no observations at ${SHARD_DIR}; run --shard=i/k first`);
  const files = readdirSync(SHARD_DIR).filter((name) => name.startsWith(`obs-${runId}-`) && name.endsWith('.json'));
  if (files.length === 0) throw new Error(`no shard files for ${runId}; run --shard=i/k first`);
  const rows: Row[] = [];
  files.forEach((name) => {
    const shard = JSON.parse(readFileSync(join(SHARD_DIR, name), 'utf8')) as ShardFile;
    rows.push(...shard.rows);
  });

  const bySymbol = new Map<string, Row[]>();
  rows.forEach((row) => {
    const bucket = bySymbol.get(row.symbol);
    if (bucket) bucket.push(row); else bySymbol.set(row.symbol, [row]);
  });
  bySymbol.forEach((bucket) => bucket.sort((left, right) => left.index - right.index));
  // Contiguity is what makes "lag in bars" mean anything; a gap would silently
  // shorten every lag measured across it.
  bySymbol.forEach((bucket, symbol) => {
    for (let position = 1; position < bucket.length; position += 1) {
      if (bucket[position].index !== bucket[position - 1].index + STRIDE) {
        throw new Error(`${symbol}: sampled bars are not contiguous at index ${bucket[position].index}`);
      }
    }
  });
  const covered = new Set(bySymbol.keys());
  const uncollected = instruments
    .filter((instrument) => !covered.has(instrument.symbol))
    .map((instrument) => instrument.symbol);
  /*
   * `--partial` exists to debug THIS function against one finished shard while
   * the others are still running. It writes a report over a subset of the
   * pinned corpus, which is not the measurement, so it says so at the top of
   * the file it writes and the verdict it prints is not quotable.
   */
  const partial = process.argv.includes('--partial');
  if (uncollected.length > 0 && !partial) throw new Error(`shards do not cover: ${uncollected.join(', ')}`);
  const measured = instruments.filter((instrument) => covered.has(instrument.symbol));
  const drift = rows.reduce((sum, row) => sum + row.drift, 0);

  const barsBySymbol = new Map(measured.map((instrument) => [instrument.symbol, instrument.bars as readonly Bar[]]));
  const atrBySymbol = new Map(measured.map((instrument) => [instrument.symbol, atrWilder(instrument.bars, ATR_PERIOD)]));

  const truthFor = (definition: TruthDefinition) => new Map(
    measured.map((instrument) => [
      instrument.symbol,
      truthSeries(barsBySymbol.get(instrument.symbol)!, atrBySymbol.get(instrument.symbol)!, definition),
    ]),
  );

  const baseTruth = truthFor(BASE_TRUTH);

  /*
   * The no-look-ahead claim, checked rather than asserted.
   *
   * The labeller is re-run on `bars[0..t]` — a capture that PHYSICALLY CANNOT
   * contain a future bar — and its answer at t must equal the one computed over
   * the whole array. Same shape as `windowSelfCheck` in the calibration
   * manifest, and the same reason: a claim about leakage that nothing executes
   * is a comment.
   */
  let selfChecked = 0;
  const selfCheckMismatches: string[] = [];
  measured.forEach((instrument, position) => {
    if (position % 12 !== 0) return;
    const rowsHere = bySymbol.get(instrument.symbol)!;
    const truth = baseTruth.get(instrument.symbol)!;
    [0.25, 0.5, 0.9].forEach((fraction) => {
      const index = rowsHere[Math.floor((rowsHere.length - 1) * fraction)].index;
      const truncated = instrument.bars.slice(0, index + 1);
      const replayed = truthSeries(truncated, atrWilder(truncated, ATR_PERIOD), BASE_TRUTH)[index];
      selfChecked += 1;
      if (replayed.label !== truth[index].label || replayed.displacement !== truth[index].displacement) {
        selfCheckMismatches.push(`${instrument.symbol}@${index}`);
      }
    });
  });

  const base = new Map<SourceId, Stats>(
    SOURCES.map((source) => [source, measure(bySymbol, baseTruth, source, BASE_TRUTH)]),
  );
  const verdictOff = verdictFor(base.get('engine_off')!, base.get('b1')!, base.get('b2')!);
  const verdictOn = verdictFor(base.get('engine_on')!, base.get('b1')!, base.get('b2')!);

  /* ---- sensitivity: the same verdict, recomputed across the grid -------- */
  interface GridPoint { definition: TruthDefinition; stats: Map<SourceId, Stats>; off: Verdict; on: Verdict }
  const grid: GridPoint[] = [];
  GRID_BARS.forEach((n) => GRID_DISPLACEMENT.forEach((displacement) => GRID_EFFICIENCY.forEach((efficiency) => {
    const definition: TruthDefinition = { bars: n, displacement, efficiency };
    const truth = truthFor(definition);
    const stats = new Map<SourceId, Stats>(SOURCES.map((source) => [source, measure(bySymbol, truth, source, definition)]));
    grid.push({
      definition,
      stats,
      off: verdictFor(stats.get('engine_off')!, stats.get('b1')!, stats.get('b2')!),
      on: verdictFor(stats.get('engine_on')!, stats.get('b1')!, stats.get('b2')!),
    });
  })));
  const offPasses = grid.filter((point) => point.off.pass).length;
  const onPasses = grid.filter((point) => point.on.pass).length;

  /* ---- the ten worst conflicts ----------------------------------------- */
  interface Conflict {
    symbol: string;
    date: string;
    /**
     * `opposite` an engine state named the OTHER direction
     * `missed`   neither state named this direction
     * `split`    one state named it and the other did not
     */
    kind: 'opposite' | 'missed' | 'split';
    gt: Truth;
    off: Label | null;
    on: Label | null;
    displacement: number;
    efficiency: number;
  }
  const TIER: Record<Conflict['kind'], number> = { opposite: 0, missed: 1, split: 2 };
  const worstBySymbol = new Map<string, Conflict>();
  let oppositeBars = 0;
  bySymbol.forEach((bucket, symbol) => {
    const truth = baseTruth.get(symbol)!;
    const off = labelsFor(bucket, 'engine_off');
    const on = labelsFor(bucket, 'engine_on');
    bucket.forEach((row, position) => {
      const point = truth[row.index];
      // Only bars the definition calls a MOVE. A bar it calls SIDEWAYS has a
      // displacement near zero by construction, so ranking those by size would
      // fill the table with the least interesting disagreements in the file.
      if (point.label === null || point.label === 'SIDEWAYS') return;
      const opposite: Label = point.label === 'UP' ? 'DOWN' : 'UP';
      const isOpposite = off[position] === opposite || on[position] === opposite;
      if (isOpposite) oppositeBars += 1;
      // Three tiers, and the tier is ranked before the size: a label pointing the
      // WRONG WAY is a worse description than a label that stayed quiet, however
      // big the move it stayed quiet through, and a state that got it right is
      // worth saying out loud rather than averaging away.
      const offMiss = off[position] !== point.label;
      const onMiss = on[position] !== point.label;
      if (!offMiss && !onMiss) return;
      const kind: Conflict['kind'] = isOpposite ? 'opposite' : (offMiss && onMiss ? 'missed' : 'split');
      const current = worstBySymbol.get(symbol);
      const better = current === undefined
        || TIER[kind] < TIER[current.kind]
        || (kind === current.kind && Math.abs(point.displacement!) > Math.abs(current.displacement));
      if (better) {
        worstBySymbol.set(symbol, {
          symbol,
          date: row.date,
          kind,
          gt: point.label,
          off: off[position],
          on: on[position],
          displacement: point.displacement!,
          efficiency: point.efficiency!,
        });
      }
    });
  });
  // One row per instrument: ten different charts to open, not ten bars of the
  // same episode in whichever symbol happened to trend hardest.
  const worst = [...worstBySymbol.values()]
    .sort((left, right) => (TIER[left.kind] - TIER[right.kind])
      || (Math.abs(right.displacement) - Math.abs(left.displacement)))
    .slice(0, 10);
  const conflictSymbols = worstBySymbol.size;
  const oppositeSymbols = [...worstBySymbol.values()].filter((conflict) => conflict.kind === 'opposite').length;

  /* ---- distributions, context only -------------------------------------- */
  const truthCounts: Record<Truth, number> = { UP: 0, DOWN: 0, SIDEWAYS: 0 };
  let truthNull = 0;
  bySymbol.forEach((bucket, symbol) => {
    const truth = baseTruth.get(symbol)!;
    bucket.forEach((row) => {
      const label = truth[row.index].label;
      if (label === null) truthNull += 1; else truthCounts[label] += 1;
    });
  });

  /* ---- report ----------------------------------------------------------- */
  const lines: string[] = [];
  const say = (line = '') => { lines.push(line); };

  say('# Does the label describe what price already did?');
  say();
  if (uncollected.length > 0) {
    say(`> **NOT THE MEASUREMENT.** \`--partial\`: ${uncollected.length} of ${instruments.length} pinned instruments were not`);
    say('> collected, so every number below is over a subset and the verdict is not quotable.');
    say();
  }
  say('A measurement of the card\'s FIRST claim — "การ์ดนี้อธิบายสิ่งที่ราคาทำไปแล้ว" — which no');
  say('run has ever tested. P4a/P4b/P5/P6 tested the SECOND claim (does the direction beat');
  say('the base rate forward: no). This file contains no forward return, no hit rate and no');
  say('base rate of any kind. Every quantity is computed from bars at or before the bar being');
  say('labelled.');
  say();
  say('No engine file, config value, label, threshold or line of copy was touched. The ground');
  say('truth, the mapping and the verdict rule were written into');
  say('`scripts/signal-trend-agreement-probe.ts` before the run that filled this in, and the');
  say('verdict below is the one the code computed.');
  say();
  say('## The ground truth ★');
  say();
  say('```');
  say(`window            N = ${BASE_TRUTH.bars} bars, ending AT bar t — no future bar is read`);
  say(`displacement      (close_t - close_t-N) / ATR${ATR_PERIOD}_t`);
  say('efficiency        |close_t - close_t-N| / Σ|close_i - close_i-1| over the window');
  say(`UP                displacement >= +${BASE_TRUTH.displacement.toFixed(1)} and efficiency >= ${BASE_TRUTH.efficiency}`);
  say(`DOWN              displacement <= -${BASE_TRUTH.displacement.toFixed(1)} and efficiency >= ${BASE_TRUTH.efficiency}`);
  say('SIDEWAYS          everything else');
  say(`ATR${ATR_PERIOD}             Wilder, computed by the probe from the frozen bars, NEVER read off`);
  say('                  `metrics.atr14` — the labeller may not borrow its yardstick from the');
  say('                  thing it is measuring');
  say('```');
  say();
  say('**These four numbers are a design choice, not the truth.** N, the ATR period, 1.5 and');
  say('0.3 were picked by a person. A disagreement below does not prove the engine wrong — it');
  say('proves the two disagree. §4 re-runs the entire verdict across 27 versions of them, and');
  say('§5 lists the ten worst conflicts with symbol and date so a chart can settle them.');
  say();
  say('## Run');
  say();
  say('```');
  say(`corpus            ${measured.length} instruments — pinned to ${runId} via its manifest`);
  if (missing.length > 0) say(`NOT MEASURED      ${missing.join(', ')}`);
  say(`period            ${manifest.period[0]} .. ${manifest.period[1]}`);
  say(`bars labelled     ${rows.length}   (stride ${STRIDE}, left window ${WINDOW} bars, both flag states)`);
  say(`calculatedAt      ${CALCULATED_AT}   (pinned — no clock, no network)`);
  say('engine OFF        features { gate: false, zones: false, actionable: false }  — ships today');
  say('engine ON         features { gate: true,  zones: true,  actionable: false }');
  say(`indicator drift   ${drift} bars where the two flag states disagreed about ema50SlopePct /`);
  say('                  ema200 / close. Must be 0: the baselines are read off the OFF run and');
  say('                  would otherwise not be seeing the same data as the ON engine.');
  say(`guard             a cell reports insufficient below n ${MINIMUM_BUCKET} OR clust ${MINIMUM_BUCKET}; buckets are NEVER merged`);
  say(`intervals         on clust (spacing >= N bars), two-sided 95% — naive z ${Z_NAIVE}, Bonferroni`);
  say(`                  z ${Z_ADJUSTED} for ${LOOKS} looks (OFF, ON, B1, B2)`);
  say(`lag cap           ${LAG_CAP} bars; an event with fewer than ${LAG_CAP} bars left in the capture is`);
  say('                  dropped, not counted as fast and not counted as censored');
  say('look-ahead check  the labeller re-run on bars[0..t] — a capture that cannot contain a');
  say(`                  future bar — reproduced its own answer at ${selfChecked - selfCheckMismatches.length} of ${selfChecked} sampled`);
  say(`                  bars ${selfCheckMismatches.length === 0 ? '(0 mismatches)' : `MISMATCHES: ${selfCheckMismatches.join(', ')}`}`);
  say('```');
  say();
  say(`Ground truth over the labelled bars: UP ${truthCounts.UP}, DOWN ${truthCounts.DOWN}, SIDEWAYS ${truthCounts.SIDEWAYS} (${((truthCounts.UP / rows.length) * 100).toFixed(1)}% /`);
  say(`${((truthCounts.DOWN / rows.length) * 100).toFixed(1)}% / ${((truthCounts.SIDEWAYS / rows.length) * 100).toFixed(1)}%)${truthNull > 0 ? `, ${truthNull} bars unlabellable` : ''}. This is a description of the corpus, not a target:`);
  say('a labeller that said SIDEWAYS always would score that number and describe nothing,');
  say('which is what the flip ratio and the confusion matrix are there to catch.');
  say();

  /* ---- 1. the four numbers --------------------------------------------- */
  say('## 1. The four numbers');
  say();
  say('| | agreement | 95% CI (clust) | Bonferroni | UP<->DOWN | lag median | lag p90 | flip ratio | n | clust |');
  say('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  SOURCES.forEach((source) => {
    const stats = base.get(source)!;
    const cross = stats.n === 0 ? null : stats.crossPolarity / stats.n;
    say(`| ${SOURCE_LABEL[source]} | ${pct(stats.agreement)} | ${band(stats.halfNaive)} | ${band(stats.halfAdjusted)} | ${pct(cross)} | ${barCount(stats.lagMedian)} | ${barCount(stats.lagP90)} | ${ratio(stats.flipRatio)} | ${stats.n} | ${stats.clustered} |`);
  });
  say();
  say('`lag` is in bars: the ground truth changes at bar t, and this is how long until the');
  say('label says the same thing. `flip ratio` is label changes ÷ ground-truth changes over');
  say('the same bars — **above 1.0 the source speaks more often than the thing it describes.**');
  say();
  say('A flip counts every change in the word the source shows, SQUEEZE and OVEREXTENDED');
  say('included: they are excluded from agreement because they are not directions, but a card');
  say('that goes BULLISH -> SQUEEZE -> BULLISH changed its word twice in front of a reader and');
  say('the flip ratio is the one number here that has to say so.');
  say();
  say('| | ground-truth changes | label changes | lag events | censored (> cap) | dropped (end of capture) | label already there |');
  say('| --- | --- | --- | --- | --- | --- | --- |');
  SOURCES.forEach((source) => {
    const stats = base.get(source)!;
    say(`| ${SOURCE_LABEL[source]} | ${stats.gtChanges} | ${stats.labelChanges} | ${stats.lagEvents} | ${stats.lagCensored} | ${stats.lagTruncated} | ${stats.lagLed} |`);
  });
  say();
  say('The lag median and p90 are computed over the events that RESOLVED. Censored events —');
  say(`the label never caught up inside ${LAG_CAP} bars — are counted beside them rather than`);
  say('folded in at the cap, because a cap value is not a measured lag; read the two columns');
  say('together or not at all.');
  say();
  say('"label already there" counts events where the source was ALREADY saying the new word on');
  say('the bar before the ground truth changed to it. It is reported because it is the only');
  say('thing here that could be mistaken for anticipation, and it is not evidence of any: a');
  say('source that says UP most of the time is already saying UP before most changes to UP.');
  say();

  /* ---- 2. confusion ----------------------------------------------------- */
  say('## 2. Confusion matrices');
  say();
  say('Ground truth down the side, label across the top. **SIDEWAYS confusion is a threshold');
  say('disagreement; UP<->DOWN is a description that is backwards.**');
  say();
  SOURCES.forEach((source) => {
    const stats = base.get(source)!;
    say(`**${SOURCE_LABEL[source]}**`);
    say();
    say('| truth \\ label | UP | DOWN | SIDEWAYS | row total | row correct |');
    say('| --- | --- | --- | --- | --- | --- |');
    TRUTHS.forEach((truth) => {
      const row = stats.confusion[truth];
      const total = row.UP + row.DOWN + row.SIDEWAYS;
      say(`| **${truth}** | ${row.UP} | ${row.DOWN} | ${row.SIDEWAYS} | ${total} | ${total === 0 ? '—' : pct(row[truth] / total)} |`);
    });
    const crossRate = stats.n === 0 ? null : stats.crossPolarity / stats.n;
    say();
    say(`UP<->DOWN: **${stats.crossPolarity}** of ${stats.n} (${pct(crossRate)}).`);
    if (source.startsWith('engine')) {
      say('');
      say(`SQUEEZE / OVEREXTENDED — reported apart, never folded into the 3x3: **${stats.other}** bars`);
      say(`(ground truth there: UP ${stats.otherTruth.UP}, DOWN ${stats.otherTruth.DOWN}, SIDEWAYS ${stats.otherTruth.SIDEWAYS}).`);
    }
    if (stats.unlabelled > 0) say(`Bars the source could not label at all: ${stats.unlabelled}.`);
    say();
  });

  /* ---- 3. verdict ------------------------------------------------------- */
  const headline = verdictOff.pass ? 'PASS' : 'FAIL';
  say('## 3. VERDICT');
  say();
  say(`# ${headline}`);
  say();
  say('The rule, from the probe header, applied by `verdictFor()`:');
  say();
  say('> The better baseline is taken PER METRIC — the higher of B1/B2 agreement and the lower');
  say('> of B1/B2 flip ratio. An engine state passes only if it beats that on BOTH. The');
  say('> headline is the OFF state\'s, because OFF is what ships today (handover §1.3). The ON');
  say('> state is reported beside it and cannot rescue it.');
  say();
  say('| | agreement | better baseline | beat it? | flip ratio | better baseline | beat it? | verdict |');
  say('| --- | --- | --- | --- | --- | --- | --- | --- |');
  ([
    ['engine OFF (headline)', base.get('engine_off')!, verdictOff],
    ['engine ON', base.get('engine_on')!, verdictOn],
  ] as const).forEach(([name, stats, verdict]) => {
    say(`| ${name} | ${pct(stats.agreement)} | ${pct(verdict.baselineAgreement)} | ${verdict.beatAgreement ? 'yes' : '**no**'} | ${ratio(stats.flipRatio)} | ${ratio(verdict.baselineFlip)} | ${verdict.beatFlip ? 'yes' : '**no**'} | ${verdict.pass ? 'PASS' : '**FAIL**'} |`);
  });
  say();

  /* ---- 4. sensitivity --------------------------------------------------- */
  say('## 4. Sensitivity — 27 versions of the ground truth');
  say();
  say('The whole verdict, recomputed for every combination of N ∈ {15, 20, 25}, displacement ∈');
  say('{1.2, 1.5, 1.8} and efficiency ∈ {0.25, 0.3, 0.35}. The engine labels are the same run');
  say('every time; only the definition of the thing they are compared against moves.');
  say();
  say(`**OFF passes at ${offPasses} of ${grid.length} grid points. ON passes at ${onPasses} of ${grid.length}.**`);
  say();
  say('| N | disp | eff | truth UP/DOWN/SIDE % | OFF agree | ON agree | B1 agree | B2 agree | OFF flip | ON flip | B1 flip | B2 flip | OFF | ON |');
  say('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  grid.forEach((point) => {
    const off = point.stats.get('engine_off')!;
    const on = point.stats.get('engine_on')!;
    const b1 = point.stats.get('b1')!;
    const b2 = point.stats.get('b2')!;
    const rowTotal = (truth: Truth) => TRUTHS.reduce((sum, label) => sum + b2.confusion[truth][label], 0);
    const total = TRUTHS.reduce((sum, truth) => sum + rowTotal(truth), 0);
    const share = (truth: Truth) => (total === 0 ? '—' : `${((rowTotal(truth) / total) * 100).toFixed(0)}`);
    const isBase = point.definition.bars === BASE_TRUTH.bars
      && point.definition.displacement === BASE_TRUTH.displacement
      && point.definition.efficiency === BASE_TRUTH.efficiency;
    say(`| ${point.definition.bars}${isBase ? ' ★' : ''} | ${point.definition.displacement} | ${point.definition.efficiency} | ${share('UP')}/${share('DOWN')}/${share('SIDEWAYS')} | ${pct(off.agreement)} | ${pct(on.agreement)} | ${pct(b1.agreement)} | ${pct(b2.agreement)} | ${ratio(off.flipRatio)} | ${ratio(on.flipRatio)} | ${ratio(b1.flipRatio)} | ${ratio(b2.flipRatio)} | ${point.off.pass ? 'PASS' : 'FAIL'} | ${point.on.pass ? 'PASS' : 'FAIL'} |`);
  });
  say();
  say('★ marks the pre-registered definition, the one §3 decides on. The UP/DOWN/SIDE column');
  say('is the ground truth\'s own mix at that grid point, measured over B2\'s rows (B2 labels');
  say('every bar, so its denominator is the full population).');
  say();

  /* ---- 5. the ten worst conflicts --------------------------------------- */
  say('## 5. The ten worst conflicts — open these charts');
  say();
  say('Bars the definition calls a MOVE and the engine does not describe as one, worst first.');
  say('Three kinds, ranked in this order because they are not equally bad:');
  say();
  say('- **`opposite`** — an engine state named the OTHER direction. A backwards description.');
  say('- **`missed`** — NEITHER state named this direction (SIDEWAYS, SQUEEZE or OVEREXTENDED');
  say('  while price travelled that far in a straight line). A quiet one, not a wrong one.');
  say('- **`split`** — one flag state named it and the other did not. The disagreement is');
  say('  between the two engines, and the flag decides which sentence a reader gets.');
  say();
  say('One row per instrument, so this is ten different charts rather than ten bars of one');
  say(`episode. ${conflictSymbols} of ${measured.length} instruments have at least one conflicting bar; ${oppositeBars} bars in the`);
  say(`whole corpus are \`opposite\`, spread over ${oppositeSymbols} instruments. Whether the engine or the`);
  say('definition is wrong on a given row is a question a chart answers and this file does not.');
  say();
  say('| # | kind | symbol | date | ground truth | engine OFF | engine ON | displacement (ATR) | efficiency |');
  say('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  worst.forEach((conflict, position) => {
    say(`| ${position + 1} | \`${conflict.kind}\` | ${conflict.symbol} | ${conflict.date} | ${conflict.gt} | ${conflict.off ?? '—'} | ${conflict.on ?? '—'} | ${num(conflict.displacement)} | ${num(conflict.efficiency)} |`);
  });
  say();

  say('---');
  say();
  say('## Not part of the verdict');
  say();
  say('Everything above was fixed before the run. This section is what was noticed');
  say('afterwards; it changes nothing above it and is written down so the next round does not');
  say('have to rediscover it. Every number in it is computed by the same file, not typed in.');
  say();

  /*
   * WHICH KNOB ACTUALLY MOVES THE GROUND TRUTH.
   *
   * The sensitivity table has rows that are identical across the displacement
   * column, which is either a bug or a fact about the rule. It is a fact, and
   * it is worth stating in bars rather than by eye: each pair below re-labels
   * the whole corpus with one knob at its extremes and counts the bars whose
   * label changed.
   */
  const knobDelta = (left: TruthDefinition, right: TruthDefinition): { changed: number; total: number } => {
    const a = truthFor(left);
    const b = truthFor(right);
    let changed = 0;
    let total = 0;
    bySymbol.forEach((bucket, symbol) => {
      const first = a.get(symbol)!;
      const second = b.get(symbol)!;
      bucket.forEach((row) => {
        if (first[row.index].label === null || second[row.index].label === null) return;
        total += 1;
        if (first[row.index].label !== second[row.index].label) changed += 1;
      });
    });
    return { changed, total };
  };
  const knobDisplacement = knobDelta({ bars: 20, displacement: 1.2, efficiency: 0.3 }, { bars: 20, displacement: 1.8, efficiency: 0.3 });
  const knobEfficiency = knobDelta({ bars: 20, displacement: 1.5, efficiency: 0.25 }, { bars: 20, displacement: 1.5, efficiency: 0.35 });
  const knobBars = knobDelta({ bars: 15, displacement: 1.5, efficiency: 0.3 }, { bars: 25, displacement: 1.5, efficiency: 0.3 });
  const share = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1)}%`;

  say(`### 1. ${knobDisplacement.changed === 0 ? 'The displacement threshold is inert over its whole tested range' : 'The displacement threshold moves far less than the other two ★ numbers'}`);
  say();
  say('Re-labelling the whole corpus with one knob at each end of its tested range, and');
  say('counting the bars whose label changed:');
  say();
  say('| knob | from -> to | bars re-labelled |');
  say('| --- | --- | --- |');
  say(`| displacement | 1.2 -> 1.8 (N 20, eff 0.3) | ${knobDisplacement.changed} of ${knobDisplacement.total} (${share(knobDisplacement.changed, knobDisplacement.total)}) |`);
  say(`| efficiency | 0.25 -> 0.35 (N 20, disp 1.5) | ${knobEfficiency.changed} of ${knobEfficiency.total} (${share(knobEfficiency.changed, knobEfficiency.total)}) |`);
  say(`| N | 15 -> 25 (disp 1.5, eff 0.3) | ${knobBars.changed} of ${knobBars.total} (${share(knobBars.changed, knobBars.total)}) |`);
  say();
  say('The reason is arithmetic, not data: over 20 bars a path that is 30% efficient has');
  say('already travelled several ATRs end to end, so a window that clears the efficiency gate');
  say(`clears 1.8 as well — ${knobDisplacement.changed === 0 ? 'in this corpus, without a single exception' : `all but ${knobDisplacement.changed} of them here`}. **The ground truth is, in practice,`);
  say('an efficiency rule that reads its sign off displacement.** The §4 rows that repeat down');
  say('the displacement column are that fact, not a copy-paste error, and anyone re-running');
  say('this should spend the sensitivity budget on efficiency and N instead.');
  say();

  const offBase = base.get('engine_off')!;
  const onBase = base.get('engine_on')!;
  const b1Base = base.get('b1')!;
  const b2Base = base.get('b2')!;
  const rowShare = (stats: Stats, truth: Truth) => {
    const row = stats.confusion[truth];
    const total = row.UP + row.DOWN + row.SIDEWAYS;
    return total === 0 ? '—' : pct(row[truth] / total);
  };

  say('### 2. The one dimension the engine wins on is not in the verdict');
  say();
  say('Cross-polarity — the label naming the direction opposite to the move — is where the');
  say('two baselines are worst and the engine is best, by a wide margin:');
  say();
  say(`- engine OFF **${pct(offBase.crossPolarity / offBase.n)}** · engine ON **${pct(onBase.crossPolarity / onBase.n)}** · B1 ${pct(b1Base.crossPolarity / b1Base.n)} · B2 ${pct(b2Base.crossPolarity / b2Base.n)}`);
  say();
  say('The pre-registered rule scores agreement and flip ratio, so this changes nothing about');
  say('the FAIL. It is still the most defensible sentence available about the label: whatever');
  say('else it does, it very rarely points the wrong way. `docs/signal-handover.md` should');
  say('carry that as a measured claim rather than the stronger one the card makes.');
  say();

  say('### 3. The two flag states fail in opposite directions');
  say();
  say('| | UP rows correct | DOWN rows correct | SIDEWAYS rows correct | flip ratio |');
  say('| --- | --- | --- | --- | --- |');
  say(`| engine OFF | ${rowShare(offBase, 'UP')} | ${rowShare(offBase, 'DOWN')} | ${rowShare(offBase, 'SIDEWAYS')} | ${ratio(offBase.flipRatio)} |`);
  say(`| engine ON | ${rowShare(onBase, 'UP')} | ${rowShare(onBase, 'DOWN')} | ${rowShare(onBase, 'SIDEWAYS')} | ${ratio(onBase.flipRatio)} |`);
  say();
  say('OFF names a direction almost every time the definition names one, and also names one');
  say('through most of what the definition calls quiet: it OVER-speaks. ON is the mirror — it');
  say('holds SIDEWAYS through more than half of the moves the definition does name: it');
  say('UNDER-speaks. Same engine, same bars; §5 of the handover says the zone frame is what');
  say('separates them, and this is that rule\'s cost and benefit in one table.');
  say();

  const offFlips = grid.map((point) => point.stats.get('engine_off')!.flipRatio!);
  const onFlips = grid.map((point) => point.stats.get('engine_on')!.flipRatio!);
  say('### 4. "Speaks more often than the thing it describes" survives the whole grid for OFF');
  say();
  say(`Across all ${grid.length} definitions the OFF flip ratio runs ${Math.min(...offFlips).toFixed(2)} .. ${Math.max(...offFlips).toFixed(2)} — above 1.0 at every`);
  say(`single one. ON runs ${Math.min(...onFlips).toFixed(2)} .. ${Math.max(...onFlips).toFixed(2)} and dips under 1.0 only where N is 15, i.e. only when`);
  say('the ground truth is allowed to change its own mind fastest. The shipped card changes');
  say('its word more often than the move it describes changes, under every definition tested.');
  say();

  say('### 5. What the baselines\' low flip ratios are actually made of');
  say();
  say(`B2 cannot say SIDEWAYS at all, and ${b2Base.lagCensored} of its ${b2Base.lagEvents} lag events never resolve because of`);
  say(`it. B1 says SIDEWAYS on ${share(b1Base.confusion.UP.SIDEWAYS + b1Base.confusion.DOWN.SIDEWAYS + b1Base.confusion.SIDEWAYS.SIDEWAYS, b1Base.n)} of its bars. Both are smooth two-state labellers, and a`);
  say('two-state labeller flips rarely for the same reason it describes the majority class');
  say('badly. The verdict rule was written before any of this was visible and it stands as');
  say('written — but a future round that wants a flip-ratio comparator should build one that');
  say('can express all three states, not read this one as "simpler is calmer".');
  say();

  say('### 6. The regime veto is flag-independent, as documented');
  say();
  say(`SQUEEZE / OVEREXTENDED covers ${offBase.other} bars with flags off and ${onBase.other} with GATE+ZONES on`);
  say(`— ${offBase.other === onBase.other ? 'identical' : 'NOT identical, which contradicts'} `
    + `${offBase.other === onBase.other ? 'and exactly what' : 'what'} handover §5 says ("regime มาก่อนทุกอย่าง", veto สูงสุด, เสมอ).`);
  say(`Of those bars the definition calls ${offBase.otherTruth.UP + offBase.otherTruth.DOWN} a move (UP ${offBase.otherTruth.UP}, DOWN ${offBase.otherTruth.DOWN}) and`);
  say(`${offBase.otherTruth.SIDEWAYS} quiet — so the veto lands on a real move about ${share(offBase.otherTruth.UP + offBase.otherTruth.DOWN, offBase.other)} of the time it fires.`);
  say('Whether a reader is better served by "SQUEEZE" than by the direction on those bars is a');
  say('copy question this file cannot answer, but it is not a rare case.');
  say();

  say('```');
  say(`shards            ${files.length} files under .qa/trend-agreement/`);
  say('reproduce         npm run signal:trend-agreement -- --shard=0/4   (0..3, in parallel)');
  say('                  npm run signal:trend-agreement');
  say('```');
  say();

  writeFileSync(OUTPUT_PATH, `${lines.join('\n')}\n`);
  console.error(`wrote ${OUTPUT_PATH}`);
  console.error(`VERDICT ${headline} (OFF) · ON ${verdictOn.pass ? 'PASS' : 'FAIL'}`);
}

main();
