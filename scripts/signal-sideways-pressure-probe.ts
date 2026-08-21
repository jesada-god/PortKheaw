/**
 * The §6.6 gap, split by `histogramExpanding`. A measurement, and only that.
 *
 * THE QUESTION. `docs/signal-handover.md` §6.6 records the finding that binds
 * P6 hardest: a SIDEWAYS label is still SIDEWAYS 20 bars later 72.6% of the
 * time, while price has stayed inside the frame it was drawn around only 25.7%
 * of the time (n = 10,525). The label outlives the story it tells. This asks
 * one thing about that gap: does `metrics.histogramExpanding` separate the two
 * populations — the sideways calls where price stays put from the ones where it
 * does not?
 *
 * NOTHING HERE IS A FEATURE. No engine file is touched, no label is added, no
 * threshold moves, nothing is fitted. If the answer is no, that is the whole
 * output and it is worth the same as a yes: it is the reason the next round
 * does not spend a week on it.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR BRANCHES AND NOT TWO
 * ---------------------------------------------------------------------------
 * `histogramExpanding` is the ENGINE'S READING of the momentum bar, not the
 * bar's size. It is true when a POSITIVE histogram is longer than the one
 * before it AND when a NEGATIVE histogram is shorter — the two cases where the
 * engine nudges its own score up. BTC-USD in `__golden__/signal/` is the case
 * that makes this concrete: `macdHistogram −84.76` with `histogramExpanding
 * true`, a falling-side bar that shrank.
 *
 * So the flag read alone pools "rising momentum getting stronger" with "falling
 * momentum letting go", which are not the same population and have no reason to
 * behave alike. Every bucket here is `macdHistogram > 0` CROSSED with the flag,
 * four branches, and they are never merged — not to reach the guard, not for a
 * tidier table.
 *
 * ---------------------------------------------------------------------------
 * THE SAME MEASUREMENT AS §6.6, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Population, outcomes and arithmetic are lifted from `scripts/calibrate.ts`
 * so the rows below sit under the same headline they are trying to split:
 *
 *   population        `zones.zone === 'sideways'` at the as-of bar
 *   still sideways    the zone at `index + horizon`, read off the sampled
 *                     observation at that bar — not a second engine call
 *   inside frame      no CLOSE between step 1 and `horizon` outside
 *                     [`zones.support`, `zones.resistance`]
 *   horizons          5 / 10 / 20 bars · stride 5 · 600-bar left window
 *   guard             a branch under the minimum reports `insufficient`
 *   split             train < 2025-06-30 <= test, the P4a boundary, read from
 *                     the pinned manifest rather than chosen here
 *
 * CLUST IS THE DENOMINATOR THAT COUNTS. At a 20-bar horizon with a 5-bar stride
 * four consecutive observations share almost all of their outcome bars, so a
 * raw n of 10,525 is nothing like 10,525 facts. `clust` is the largest subset of
 * a branch sharing no outcome bars, every interval is computed on it, and a
 * branch whose `clust` is under the minimum is dropped rather than quoted.
 *
 * NO LOOK-AHEAD, NO CLOCK, NO NETWORK. The engine sees `bars[..t]` only. The
 * corpus is pinned to a run manifest, not to a directory listing, because
 * `__golden__/corpus/` is a cache that grows and two runs over different corpora
 * are not comparable. Nothing reads the wall clock.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION RULE, WRITTEN DOWN BEFORE THE NUMBERS EXISTED
 * ---------------------------------------------------------------------------
 * Stated here rather than in the report so that it is in the diff that precedes
 * the run. `PAIRINGS` below is the whole of it, and it is applied by code:
 *
 *   1. the `inside frame` gap between the expanding and the contracting branch
 *      OF THE SAME SIGN must be >= 10pp at at least 2 of the 3 horizons;
 *   2. and its sign must agree across the train and test halves;
 *   3. both -> GO. Either one missing -> STOP, and the report ends there.
 *
 * Two pairings are tested — one per side of zero — and each is judged on its
 * own. There is no third, pooled pairing, because pooling across the sign is
 * exactly the misreading the four branches exist to prevent. Six primary looks
 * (2 pairings x 3 horizons), so intervals are printed at the Bonferroni-adjusted
 * level beside the naive one.
 *
 * Run: npm run signal:sideways-pressure
 *      npm run signal:sideways-pressure -- --like=<runId>
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MARKET_SIGNAL_MEASURED } from '@/src/config/signal';
import { calculateMarketSignal } from '@/src/lib/analytics/market-signal/calculations';
import type {
  MarketSignalCandle,
  MarketSignalResult,
  MarketSignalZoneName,
} from '@/src/lib/analytics/market-signal/types';
import type { DataFreshness } from '@/src/lib/market-data/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');
const CALIBRATION_ROOT = join(process.cwd(), '__calibration__');
const OUTPUT_PATH = join(process.cwd(), 'sideways_pressure.md');

/** Identical to the P4a/P4b harness. Changing one of these makes the rows incomparable. */
const HORIZONS = [5, 10, 20] as const;
const STRIDE = 5;
const WINDOW = 600;
const MINIMUM_BUCKET = 30;

/** Six primary looks: two pairings at three horizons. */
const LOOKS = 6;
/** Two-sided 95%: z for alpha/2, and for alpha/(2*LOOKS). */
const Z_NAIVE = 1.96;
const Z_ADJUSTED = 2.638;

/** The gap the decision rule needs, in rate units. */
const REQUIRED_GAP = 0.10;
/** How many of the three horizons must carry it. */
const REQUIRED_HORIZONS = 2;

type Bar = Omit<MarketSignalCandle, 'finalized'>;
interface Frozen { symbol: string; source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] }
interface Instrument { symbol: string; source: string | null; freshness: DataFreshness; bars: Bar[] }

/**
 * The four branches, named for what a reader would see on the chart.
 *
 * `expanding` here is the ENGINE's word — see the header. On the falling side it
 * means the bar got SHORTER, which is why the labels say so out loud rather than
 * leaving "expanding" to be read as "bigger".
 */
type Branch = 'rising_extending' | 'rising_fading' | 'falling_deepening' | 'falling_easing';

const BRANCH_LABEL: Record<Branch, string> = {
  rising_extending: 'histogram > 0 · expanding  (bar above zero, getting longer)',
  rising_fading: 'histogram > 0 · contracting (bar above zero, getting shorter)',
  falling_deepening: 'histogram < 0 · contracting (bar below zero, getting longer)',
  falling_easing: 'histogram < 0 · expanding  (bar below zero, getting shorter)',
};

/**
 * The two comparisons the decision rule is applied to, and nothing else.
 *
 * Each pairs the expanding branch against the contracting one ON THE SAME SIDE
 * of zero. A pairing across the sign is not offered: it would be the pooled
 * reading the four-way split exists to refuse.
 */
const PAIRINGS: ReadonlyArray<{ name: string; expanding: Branch; contracting: Branch }> = [
  { name: 'above zero  (rising side)', expanding: 'rising_extending', contracting: 'rising_fading' },
  { name: 'below zero  (falling side)', expanding: 'falling_easing', contracting: 'falling_deepening' },
];

/** The branch an observation falls in, or null when the engine read neither. */
function branchOf(histogram: number | null, expanding: boolean | null): Branch | null {
  if (histogram === null || histogram === 0 || expanding === null) return null;
  if (histogram > 0) return expanding ? 'rising_extending' : 'rising_fading';
  return expanding ? 'falling_easing' : 'falling_deepening';
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
  horizons: number[];
  period: [string, string];
}

function pinnedRunId(): string {
  const flag = process.argv.find((argument) => argument.startsWith('--like='));
  return flag ? flag.slice('--like='.length) : MARKET_SIGNAL_MEASURED.runId;
}

function loadManifest(runId: string): Manifest {
  return JSON.parse(
    readFileSync(join(CALIBRATION_ROOT, runId, 'manifest.json'), 'utf8'),
  ) as Manifest;
}

function loadCorpus(manifest: Manifest): { instruments: Instrument[]; missing: string[] } {
  const onDisk = new Set(readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.json')));
  const instruments: Instrument[] = [];
  const missing: string[] = [];
  for (const symbol of manifest.instruments) {
    const file = `${symbol}.json`;
    if (!onDisk.has(file)) { missing.push(symbol); continue; }
    const frozen = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as Frozen;
    const bars = frozen.candles.filter((candle) => candle.finalized)
      .map(({ finalized: _finalized, ...candle }) => candle);
    if (bars.length < WINDOW + Math.max(...HORIZONS) + STRIDE) { missing.push(symbol); continue; }
    instruments.push({ symbol: frozen.symbol, source: frozen.source, freshness: frozen.freshness, bars });
  }
  return { instruments, missing };
}

const runEngine = (instrument: Instrument, bars: readonly Bar[]): MarketSignalResult => calculateMarketSignal(
  bars.map((bar) => ({ ...bar, finalized: true })),
  {
    symbol: instrument.symbol,
    source: instrument.source,
    freshness: instrument.freshness,
    // A pinned instant, not a clock read: `calculatedAt` is echoed into the
    // result and a live one would make two runs of this file differ.
    calculatedAt: '2026-01-01T00:00:00.000Z',
    features: { gate: true, zones: true, actionable: true },
  },
);

/* ------------------------------------------------------------------------- */
/* observing                                                                 */
/* ------------------------------------------------------------------------- */

interface Observation {
  symbol: string;
  date: string;
  index: number;
  split: 'train' | 'test';
  zone: MarketSignalZoneName;
  support: number;
  resistance: number;
  branch: Branch | null;
  macdHistogram: number | null;
  histogramExpanding: boolean | null;
}

function observe(instruments: readonly Instrument[], boundary: string): Observation[] {
  const observations: Observation[] = [];
  const longest = Math.max(...HORIZONS);
  let done = 0;
  for (const instrument of instruments) {
    const { bars } = instrument;
    for (let index = WINDOW; index + longest < bars.length; index += STRIDE) {
      const result = runEngine(instrument, bars.slice(index + 1 - WINDOW, index + 1));
      if (result.status !== 'available' || !result.zones) continue;
      observations.push({
        symbol: instrument.symbol,
        date: bars[index].date,
        index,
        split: bars[index].date < boundary ? 'train' : 'test',
        zone: result.zones.zone,
        support: result.zones.support,
        resistance: result.zones.resistance,
        branch: branchOf(result.metrics.macdHistogram, result.metrics.histogramExpanding),
        macdHistogram: result.metrics.macdHistogram,
        histogramExpanding: result.metrics.histogramExpanding,
      });
    }
    done += 1;
    if (done % 10 === 0) console.error(`  ${done}/${instruments.length} instruments`);
  }
  return observations;
}

/* ------------------------------------------------------------------------- */
/* outcomes — the two §6.6 asks, unchanged                                    */
/* ------------------------------------------------------------------------- */

interface Sample { symbol: string; index: number }

/** The largest subset sharing no outcome bars. Same greedy walk as the harness. */
function clusteredCount(keys: readonly Sample[], horizon: number): number {
  const bySymbol = new Map<string, number[]>();
  keys.forEach(({ symbol, index }) => {
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

interface Outcome {
  n: number;
  clustered: number;
  /** `null` when a guard suppressed it. */
  held: number | null;
  inside: number | null;
  /** Lookups where `index + horizon` was never sampled, so "still sideways" could not be read. */
  unsampled: number;
}

function measure(
  rows: readonly Observation[],
  barsBySymbol: ReadonlyMap<string, readonly Bar[]>,
  byKey: ReadonlyMap<string, Observation>,
  horizon: number,
): Outcome {
  const keys: Sample[] = [];
  let held = 0;
  let inside = 0;
  let unsampled = 0;
  rows.forEach((row) => {
    const bars = barsBySymbol.get(row.symbol)!;
    if (!bars[row.index + horizon]) return;
    keys.push({ symbol: row.symbol, index: row.index });
    const later = byKey.get(`${row.symbol}@${row.index + horizon}`);
    if (later === undefined) unsampled += 1;
    if (later?.zone === 'sideways') held += 1;
    let breached = false;
    for (let step = 1; step <= horizon; step += 1) {
      const bar = bars[row.index + step];
      if (bar.close > row.resistance || bar.close < row.support) { breached = true; break; }
    }
    if (!breached) inside += 1;
  });
  const n = keys.length;
  const clustered = clusteredCount(keys, horizon);
  // BOTH guards. The harness suppresses on raw n; this file additionally drops a
  // branch whose independent count is under the minimum, because every interval
  // below is computed on `clust` and one built from 20 facts is not a reading.
  const sufficient = n >= MINIMUM_BUCKET && clustered >= MINIMUM_BUCKET;
  return {
    n,
    clustered,
    held: sufficient ? held / n : null,
    inside: sufficient ? inside / n : null,
    unsampled,
  };
}

/* ------------------------------------------------------------------------- */
/* intervals                                                                 */
/* ------------------------------------------------------------------------- */

/** Half-width on the CLUSTERED count, in rate units. */
const halfWidth = (rate: number | null, clustered: number, z: number): number | null =>
  rate === null || clustered === 0 ? null : z * Math.sqrt((rate * (1 - rate)) / clustered);

/** Half-width on a difference of two independent proportions, on clustered counts. */
function gapHalfWidth(
  left: { rate: number | null; clustered: number },
  right: { rate: number | null; clustered: number },
  z: number,
): number | null {
  if (left.rate === null || right.rate === null || left.clustered === 0 || right.clustered === 0) return null;
  return z * Math.sqrt(
    (left.rate * (1 - left.rate)) / left.clustered
    + (right.rate * (1 - right.rate)) / right.clustered,
  );
}

const pct = (value: number | null) => value === null ? 'insuff.' : `${(value * 100).toFixed(1)}%`;
const pp = (value: number | null) => value === null ? '—'
  : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;
const band = (value: number | null) => value === null ? '—' : `±${(value * 100).toFixed(1)}pp`;

/* ------------------------------------------------------------------------- */
/* the run                                                                   */
/* ------------------------------------------------------------------------- */

function main(): void {
  const runId = pinnedRunId();
  const manifest = loadManifest(runId);
  const { instruments, missing } = loadCorpus(manifest);

  console.error(`corpus: ${instruments.length} instruments (pinned to ${runId})`);
  if (missing.length > 0) console.error(`  NOT MEASURED: ${missing.join(', ')}`);
  if (manifest.stride !== STRIDE || manifest.window !== WINDOW || manifest.minimumBucket !== MINIMUM_BUCKET) {
    throw new Error('pinned run used different harness constants; the rows would not be comparable');
  }

  console.error('observing ...');
  const observations = observe(instruments, manifest.boundary);
  const barsBySymbol = new Map<string, readonly Bar[]>(
    instruments.map((instrument) => [instrument.symbol, instrument.bars as readonly Bar[]]),
  );
  const byKey = new Map(observations.map((row) => [`${row.symbol}@${row.index}`, row]));
  const sideways = observations.filter((row) => row.zone === 'sideways');
  const unbucketable = sideways.filter((row) => row.branch === null);

  const lines: string[] = [];
  const say = (line = '') => { lines.push(line); };

  const subset = (branch: Branch, split?: 'train' | 'test') => sideways.filter(
    (row) => row.branch === branch && (split === undefined || row.split === split),
  );

  say('# `histogramExpanding` against the §6.6 sideways gap');
  say();
  say('A measurement. No engine file, config value, label or feature was touched to');
  say('produce it, and the decision rule below was written into');
  say('`scripts/signal-sideways-pressure-probe.ts` before the run that filled this in.');
  say();
  say('## The question');
  say();
  say('`docs/signal-handover.md` §6.6:');
  say();
  say('```');
  say('horizon | still sideways | stayed inside frame |      n');
  say('     20 |          72.6% |               25.7% |  10525');
  say('```');
  say();
  say('The label outlives the story it tells. Does `metrics.histogramExpanding` separate');
  say('the sideways calls where price stays put from the ones where it does not?');
  say();
  say('## Run');
  say();
  say('```');
  say(`corpus            ${instruments.length} instruments — pinned to ${runId} via its manifest`);
  if (missing.length > 0) say(`NOT MEASURED      ${missing.join(', ')}`);
  say(`period            ${manifest.period[0]} .. ${manifest.period[1]}`);
  say(`observations      ${observations.length}   (stride ${STRIDE} bars, left window ${WINDOW} bars)`);
  say(`sideways rows     ${sideways.length}   — the §6.6 population`);
  say(`time split        train < ${manifest.boundary} <= test   (the P4a boundary, read from the manifest)`);
  say(`guard             a branch reports insufficient below n ${MINIMUM_BUCKET} OR clust ${MINIMUM_BUCKET}; branches are NEVER merged`);
  say(`intervals         on clust, two-sided 95% — naive z ${Z_NAIVE}, Bonferroni z ${Z_ADJUSTED} for ${LOOKS} looks`);
  say('```');
  say();
  say(`**Rows the four-way split cannot place: ${unbucketable.length}** of ${sideways.length}`);
  say('(`histogramExpanding === null` — no previous bar, or a bar identical to it — or a');
  say('histogram sitting exactly on zero). They are excluded and not redistributed.');
  say();

  /* ---- the four branches ------------------------------------------------ */

  say('## 1. The four branches');
  say();
  say('`expanding` is the ENGINE\'s reading, not the bar\'s size: true when a bar ABOVE');
  say('zero gets longer and when a bar BELOW zero gets shorter. Read with');
  say('`macdHistogram > 0`, never alone.');
  say();
  say('| branch | still sideways @5 / @10 / @20 | stayed inside frame @5 / @10 / @20 | n | clust @5 / @10 / @20 |');
  say('| --- | --- | --- | --- | --- |');
  const branches: Branch[] = ['rising_extending', 'rising_fading', 'falling_easing', 'falling_deepening'];
  const cell = new Map<string, Outcome>();
  branches.forEach((branch) => {
    const rows = subset(branch);
    const outcomes = HORIZONS.map((horizon) => {
      const outcome = measure(rows, barsBySymbol, byKey, horizon);
      cell.set(`${branch}@${horizon}`, outcome);
      return outcome;
    });
    say(`| \`${branch}\`<br>${BRANCH_LABEL[branch]} | ${outcomes.map((o) => pct(o.held)).join(' / ')} | ${outcomes.map((o) => pct(o.inside)).join(' / ')} | ${outcomes[0].n} | ${outcomes.map((o) => o.clustered).join(' / ')} |`);
  });
  say();
  say('### The same table with intervals, on `clust`');
  say();
  say('| branch | horizon | still sideways | 95% | Bonf. | inside frame | 95% | Bonf. | clust |');
  say('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  branches.forEach((branch) => {
    HORIZONS.forEach((horizon) => {
      const outcome = cell.get(`${branch}@${horizon}`)!;
      say(`| \`${branch}\` | ${horizon} | ${pct(outcome.held)} | ${band(halfWidth(outcome.held, outcome.clustered, Z_NAIVE))} | ${band(halfWidth(outcome.held, outcome.clustered, Z_ADJUSTED))} | ${pct(outcome.inside)} | ${band(halfWidth(outcome.inside, outcome.clustered, Z_NAIVE))} | ${band(halfWidth(outcome.inside, outcome.clustered, Z_ADJUSTED))} | ${outcome.clustered} |`);
    });
  });
  say();

  /* ---- the pairings the rule is applied to ------------------------------ */

  say('## 2. The gap the decision rule asks about');
  say();
  say('`inside frame`, expanding branch minus contracting branch, within one side of');
  say('zero. The interval is on the DIFFERENCE of two independent proportions, computed');
  say('on the clustered counts.');
  say();
  say('| pairing | horizon | expanding | contracting | gap | 95% | Bonf. | >= 10pp |');
  say('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const gapAt = new Map<string, number | null>();
  PAIRINGS.forEach((pairing) => {
    HORIZONS.forEach((horizon) => {
      const left = cell.get(`${pairing.expanding}@${horizon}`)!;
      const right = cell.get(`${pairing.contracting}@${horizon}`)!;
      const gap = left.inside === null || right.inside === null ? null : left.inside - right.inside;
      gapAt.set(`${pairing.name}@${horizon}`, gap);
      const met = gap === null ? '—' : (Math.abs(gap) >= REQUIRED_GAP ? '**yes**' : 'no');
      say(`| ${pairing.name} | ${horizon} | ${pct(left.inside)} | ${pct(right.inside)} | ${pp(gap)} | ${band(gapHalfWidth({ rate: left.inside, clustered: left.clustered }, { rate: right.inside, clustered: right.clustered }, Z_NAIVE))} | ${band(gapHalfWidth({ rate: left.inside, clustered: left.clustered }, { rate: right.inside, clustered: right.clustered }, Z_ADJUSTED))} | ${met} |`);
    });
  });
  say();

  /* ---- train / test ----------------------------------------------------- */

  say('## 3. Train and test, on the P4a boundary');
  say();
  say(`Split by DATE at \`${manifest.boundary}\` — the line P4a drew, read out of its manifest`);
  say('rather than chosen here. The rule asks only whether the gap keeps its SIGN.');
  say();
  say('| pairing | horizon | train gap | clust (exp / con) | test gap | clust (exp / con) | same sign |');
  say('| --- | --- | --- | --- | --- | --- | --- |');
  const signAgrees = new Map<string, boolean | null>();
  PAIRINGS.forEach((pairing) => {
    HORIZONS.forEach((horizon) => {
      const halves = (['train', 'test'] as const).map((split) => {
        const left = measure(subset(pairing.expanding, split), barsBySymbol, byKey, horizon);
        const right = measure(subset(pairing.contracting, split), barsBySymbol, byKey, horizon);
        const gap = left.inside === null || right.inside === null ? null : left.inside - right.inside;
        return { gap, left, right };
      });
      const [train, test] = halves;
      const agree = train.gap === null || test.gap === null ? null
        : Math.sign(train.gap) === Math.sign(test.gap);
      signAgrees.set(`${pairing.name}@${horizon}`, agree);
      say(`| ${pairing.name} | ${horizon} | ${pp(train.gap)} | ${train.left.clustered} / ${train.right.clustered} | ${pp(test.gap)} | ${test.left.clustered} / ${test.right.clustered} | ${agree === null ? '—' : agree ? 'yes' : '**no**'} |`);
    });
  });
  say();

  /* ---- verdict ---------------------------------------------------------- */

  say('## VERDICT');
  say();
  say('The rule, as it was written before the run:');
  say();
  say(`1. the \`inside frame\` gap between the expanding and the contracting branch of the`);
  say(`   SAME sign is >= ${(REQUIRED_GAP * 100).toFixed(0)}pp at at least ${REQUIRED_HORIZONS} of the 3 horizons; **and**`);
  say('2. that gap keeps its sign across the train and the test half;');
  say('3. both -> GO. Either missing -> STOP.');
  say();
  let anyPass = false;
  const verdicts: string[] = [];
  PAIRINGS.forEach((pairing) => {
    const gaps = HORIZONS.map((horizon) => gapAt.get(`${pairing.name}@${horizon}`) ?? null);
    const cleared = gaps.filter((gap) => gap !== null && Math.abs(gap) >= REQUIRED_GAP).length;
    const signs = HORIZONS.map((horizon) => signAgrees.get(`${pairing.name}@${horizon}`) ?? null);
    const signsOk = signs.every((value) => value === true);
    const pass = cleared >= REQUIRED_HORIZONS && signsOk;
    if (pass) anyPass = true;
    verdicts.push(`- **${pairing.name}** — condition 1: ${cleared}/${HORIZONS.length} horizons at >= ${(REQUIRED_GAP * 100).toFixed(0)}pp (needs ${REQUIRED_HORIZONS}) → ${cleared >= REQUIRED_HORIZONS ? 'MET' : 'NOT MET'}. condition 2: sign agreement ${signs.map((value) => value === null ? '—' : value ? 'yes' : 'no').join(' / ')} → ${signsOk ? 'MET' : 'NOT MET'}. **${pass ? 'PASS' : 'FAIL'}**`);
  });
  verdicts.forEach(say);
  say();
  say(anyPass ? '## VERDICT: GO' : '## VERDICT: STOP');
  say();

  writeFileSync(OUTPUT_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.error(`written to ${OUTPUT_PATH}`);
  console.log(lines.join('\n'));
}

main();
