/**
 * P5 step (b) — measure the context features BEFORE building any of them.
 *
 * The rule this script exists to enforce: a context source earns its way into
 * the engine by beating the base rate as a standalone signal first. P4a found
 * the engine's own direction worth +0.0/-0.2/-0.4pp against the market's
 * unconditional rate, and the cheapest way to add a fifth way of being wrong is
 * to bolt on a feature nobody measured.
 *
 * So each candidate is computed here as a DIRECTION and nothing else — no
 * engine call, no wiring, no config, no flag. If a feature cannot clear the bar
 * on its own it does not get built, and this file is the whole of the work
 * spent finding that out.
 *
 * ---------------------------------------------------------------------------
 * THE SAME MEASUREMENT AS P4a, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Criterion B: is the close `horizon` bars later beyond the close at signal
 * time, in the direction the feature named? Against the unconditional rate over
 * the same instrument-days, weighted to the SAME long/short mix the feature
 * itself produced — because in a market that rose, every long signal looks
 * skilful. Horizons 5/10/20, stride 5, 600-bar left window, same train/test
 * boundary. Nothing here may be compared against a number computed another way.
 *
 * `clust` is the largest subset of a row's observations sharing no outcome
 * bars. At 20 bars with a 5-bar stride four consecutive observations overlap
 * almost entirely, so the raw n overstates the evidence roughly fourfold. Every
 * interval below is computed on `clust`.
 *
 * ---------------------------------------------------------------------------
 * MULTIPLE TESTING, WHICH IS THE REAL RISK HERE
 * ---------------------------------------------------------------------------
 * Three features by three horizons is nine looks, and the splits underneath are
 * more. At nine looks the chance of at least one 5%-significant result when
 * every feature is worthless is about 37%. So:
 *
 *   * every edge is printed with an interval, never alone;
 *   * `sig?` marks an edge outside its interval at the BONFERRONI-adjusted
 *     level (alpha 0.05 / 9), not the naive one;
 *   * an edge that clears the bar at ONE horizon and not the others is reported
 *     as noise, because a real effect on overlapping windows does not switch
 *     itself off between 10 and 20 bars;
 *   * a feature whose train and test halves disagree in SIGN fails, whatever
 *     the full-sample figure says. That is the shape P4a's headline already has,
 *     and the reason its +2.2pp test half is not quoted anywhere as a finding.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 * Options / Expected Move, the fourth candidate, is absent because it cannot be
 * measured on this corpus at any price: `__golden__/corpus/` is OHLCV and there
 * is no historical options chain behind it. See the P5 report for what that
 * leaves.
 *
 * Run: npm run signal:context
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { MARKET_SIGNAL_MEASURED } from '@/src/config/signal';
import type { MarketSignalCandle } from '@/src/lib/analytics/market-signal/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');
/**
 * The instrument list is taken from the P4a manifest, not from the directory.
 *
 * `__golden__/corpus/` is a cache and it grows: another probe fetching its own
 * instrument list adds files to it, and a run that quietly measured 109
 * instruments while calling itself comparable to a 108-instrument run would be
 * comparing two different things under one heading. Reading the manifest makes
 * the corpus a property of the run being compared against rather than of
 * whatever happens to be on this disk today.
 */
const MANIFEST_PATH = join(
  process.cwd(), '__calibration__', MARKET_SIGNAL_MEASURED.runId, 'manifest.json',
);

/** Identical to the P4a harness, so the two sets of figures are comparable. */
const HORIZONS = [5, 10, 20] as const;
const STRIDE = 5;
const WINDOW = 600;
const MINIMUM_BUCKET = 30;
const TRAIN_BOUNDARY = '2025-06-30';
/** Nine primary looks: three candidates at three horizons. */
const LOOKS = 9;
/** Two-sided 95%, Bonferroni-adjusted for `LOOKS` — z for alpha/(2*LOOKS). */
const Z_ADJUSTED = 2.87;
const Z_NAIVE = 1.96;

type Bar = Omit<MarketSignalCandle, 'finalized'>;
interface Frozen { symbol: string; candles: MarketSignalCandle[] }
interface Instrument { symbol: string; bars: Bar[] }
type Direction = 1 | -1;
type Regime = 'up' | 'down' | 'unknown';

/* ------------------------------------------------------------------------- */
/* loading                                                                   */
/* ------------------------------------------------------------------------- */

function loadCorpus(): { instruments: Instrument[]; expected: number; missing: string[] } {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { instruments: string[] };
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
    instruments.push({ symbol: frozen.symbol, bars });
  }
  return { instruments, expected: manifest.instruments.length, missing };
}

/** SPY above or below its own 200-day average, by date. Same definition as P4a. */
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

/* ------------------------------------------------------------------------- */
/* indicators the candidates are built from                                  */
/* ------------------------------------------------------------------------- */

/** Simple ATR at `index`, over the bars up to and including it. */
function atrAt(bars: readonly Bar[], index: number, period = 14): number | null {
  if (index < period) return null;
  let total = 0;
  for (let step = index - period + 1; step <= index; step += 1) {
    const previous = bars[step - 1];
    const bar = bars[step];
    total += Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    );
  }
  return total / period;
}

/* ------------------------------------------------------------------------- */
/* the candidates                                                            */
/* ------------------------------------------------------------------------- */

/**
 * 1. Relative strength against SPY.
 *
 * The classic form: the instrument's own 63-bar (one quarter) return divided by
 * SPY's over the same dates, so the reading means outperformance rather than
 * merely a rising price. A 2% band keeps the sign away from parity, where it is
 * a rounding of two nearly identical returns.
 *
 * SPY itself is excluded — its relative strength against itself is 1.0 by
 * construction and would enter the sample as hundreds of observations of
 * nothing.
 */
const RS_LOOKBACK = 63;
const RS_BAND = 0.02;

function relativeStrength(
  bars: readonly Bar[],
  index: number,
  spyByDate: ReadonlyMap<string, number>,
): Direction | null {
  if (index < RS_LOOKBACK) return null;
  const spyNow = spyByDate.get(bars[index].date);
  const spyThen = spyByDate.get(bars[index - RS_LOOKBACK].date);
  if (spyNow === undefined || spyThen === undefined || spyThen === 0) return null;
  const own = bars[index].close / bars[index - RS_LOOKBACK].close;
  const ratio = own / (spyNow / spyThen);
  if (Math.abs(ratio - 1) < RS_BAND) return null;
  return ratio > 1 ? 1 : -1;
}

/**
 * 2. Volatility regime.
 *
 * A regime is NOT a direction, and pretending otherwise is how a volatility
 * feature gets built without ever being tested. What IS testable is the claim
 * traders make about it: that a compressed regime precedes an expansion which
 * continues the prevailing move. So the candidate is "the 20-bar move, but only
 * while ATR% sits in the bottom quartile of its own trailing year", and the
 * thing it has to beat is not only the market but the SAME 20-bar move taken
 * unconditionally, which is the row underneath it.
 *
 * If compression carries information the gated version beats the ungated one.
 * If it does not, the regime is decoration on a momentum signal.
 */
const VOL_PERCENTILE_WINDOW = 252;
const VOL_COMPRESSED_QUANTILE = 0.25;
const VOL_MOVE_LOOKBACK = 20;

function volatilityPercentile(bars: readonly Bar[], index: number, atrByIndex: readonly (number | null)[]): number | null {
  if (index < VOL_PERCENTILE_WINDOW + 14) return null;
  const current = atrByIndex[index];
  if (current === null || bars[index].close === 0) return null;
  const currentPct = current / bars[index].close;
  let below = 0;
  let counted = 0;
  for (let step = index - VOL_PERCENTILE_WINDOW; step < index; step += 1) {
    const past = atrByIndex[step];
    if (past === null || bars[step].close === 0) continue;
    counted += 1;
    if (past / bars[step].close < currentPct) below += 1;
  }
  return counted === 0 ? null : below / counted;
}

const prevailingMove = (bars: readonly Bar[], index: number): Direction | null => {
  if (index < VOL_MOVE_LOOKBACK) return null;
  const move = bars[index].close - bars[index - VOL_MOVE_LOOKBACK].close;
  return move === 0 ? null : (move > 0 ? 1 : -1);
};

/**
 * 3. Volume profile — the point of control.
 *
 * Each bar's volume is spread evenly across the price bins its high-low range
 * covers, over a 120-bar window, and the fullest bin is the price the most
 * business was done at. The claim is the standard one: price accepted above the
 * POC continues up, price accepted below it continues down. The half-ATR band
 * keeps the sign away from prices sitting ON the POC, where "above" and "below"
 * are the same place.
 */
const VPVR_LOOKBACK = 120;
const VPVR_BINS = 24;
const VPVR_BAND_ATR = 0.5;

function pointOfControl(bars: readonly Bar[], index: number): number | null {
  if (index < VPVR_LOOKBACK) return null;
  let low = Infinity;
  let high = -Infinity;
  for (let step = index - VPVR_LOOKBACK + 1; step <= index; step += 1) {
    if (bars[step].low < low) low = bars[step].low;
    if (bars[step].high > high) high = bars[step].high;
  }
  if (!(high > low)) return null;
  const width = (high - low) / VPVR_BINS;
  const volume = new Array<number>(VPVR_BINS).fill(0);
  // A bar whose volume the provider did not report contributes nothing rather
  // than zero-at-a-price: a profile built partly from absent volume is a
  // profile of which days happened to be reported.
  let reported = 0;
  for (let step = index - VPVR_LOOKBACK + 1; step <= index; step += 1) {
    const bar = bars[step];
    if (bar.volume === null || !Number.isFinite(bar.volume)) continue;
    reported += 1;
    const first = Math.max(0, Math.min(VPVR_BINS - 1, Math.floor((bar.low - low) / width)));
    const last = Math.max(0, Math.min(VPVR_BINS - 1, Math.floor((bar.high - low) / width)));
    const share = bar.volume / (last - first + 1);
    for (let bin = first; bin <= last; bin += 1) volume[bin] += share;
  }
  // Half the window is the least a point of control can be read from without
  // describing a different instrument from the one on the chart.
  if (reported < VPVR_LOOKBACK / 2) return null;
  let best = 0;
  volume.forEach((amount, bin) => { if (amount > volume[best]) best = bin; });
  return low + (best + 0.5) * width;
}

function vpvrDirection(bars: readonly Bar[], index: number, atr: number | null): Direction | null {
  const poc = pointOfControl(bars, index);
  if (poc === null || atr === null || atr === 0) return null;
  const distance = (bars[index].close - poc) / atr;
  if (Math.abs(distance) < VPVR_BAND_ATR) return null;
  return distance > 0 ? 1 : -1;
}

/* ------------------------------------------------------------------------- */
/* outcomes and tallies — same shapes as the P4a harness                     */
/* ------------------------------------------------------------------------- */

type CloseOutcome = 'win' | 'loss' | 'flat' | 'unavailable';

function closeOutcome(bars: readonly Bar[], index: number, horizon: number, direction: Direction): CloseOutcome {
  const future = bars[index + horizon];
  if (!future) return 'unavailable';
  const move = future.close - bars[index].close;
  if (move === 0) return 'flat';
  return Math.sign(move) === direction ? 'win' : 'loss';
}

interface Sample { symbol: string; index: number; date: string; regime: Regime; split: 'train' | 'test' }
interface Tally { wins: number; losses: number; keys: Sample[] }
const emptyTally = (): Tally => ({ wins: 0, losses: 0, keys: [] });

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

interface Rate { n: number; clustered: number; rate: number | null }
const rateOf = (tally: Tally, horizon: number): Rate => {
  const n = tally.wins + tally.losses;
  return { n, clustered: clusteredCount(tally, horizon), rate: n >= MINIMUM_BUCKET ? tally.wins / n : null };
};

const pct = (value: number | null) => value === null ? 'insuff.'.padStart(7) : `${(value * 100).toFixed(1)}%`.padStart(7);
const pp = (value: number | null) => value === null ? '—'.padStart(7)
  : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`.padStart(7);

/** Half-width of a two-sided interval on the CLUSTERED count, in rate units. */
const interval = (rate: Rate, z: number): number | null => (rate.rate === null || rate.clustered === 0)
  ? null
  : z * Math.sqrt((rate.rate * (1 - rate.rate)) / rate.clustered);

/* ------------------------------------------------------------------------- */
/* the run                                                                   */
/* ------------------------------------------------------------------------- */

type Feature = 'relative_strength' | 'volatility_compression' | 'momentum_ungated' | 'vpvr_poc';
const FEATURES: Feature[] = ['relative_strength', 'volatility_compression', 'momentum_ungated', 'vpvr_poc'];

interface Row extends Sample { directions: Partial<Record<Feature, Direction>> }

function collect(instruments: readonly Instrument[]): { rows: Row[]; barsBySymbol: Map<string, readonly Bar[]> } {
  const regime = marketRegime(instruments);
  const spy = instruments.find((instrument) => instrument.symbol === 'SPY');
  const spyByDate = new Map<string, number>();
  spy?.bars.forEach((bar) => spyByDate.set(bar.date, bar.close));

  const barsBySymbol = new Map<string, readonly Bar[]>();
  const rows: Row[] = [];
  const longest = Math.max(...HORIZONS);

  for (const instrument of instruments) {
    barsBySymbol.set(instrument.symbol, instrument.bars);
    const { bars } = instrument;
    // ATR once per bar rather than once per lookup: the percentile below reads
    // 252 of them per observation, which is the whole cost of the run otherwise.
    const atrByIndex = bars.map((_bar, index) => atrAt(bars, index));

    for (let index = WINDOW; index + longest < bars.length; index += STRIDE) {
      const directions: Partial<Record<Feature, Direction>> = {};

      if (instrument.symbol !== 'SPY') {
        const rs = relativeStrength(bars, index, spyByDate);
        if (rs !== null) directions.relative_strength = rs;
      }

      const move = prevailingMove(bars, index);
      if (move !== null) {
        directions.momentum_ungated = move;
        const quantile = volatilityPercentile(bars, index, atrByIndex);
        if (quantile !== null && quantile <= VOL_COMPRESSED_QUANTILE) {
          directions.volatility_compression = move;
        }
      }

      const vpvr = vpvrDirection(bars, index, atrByIndex[index]);
      if (vpvr !== null) directions.vpvr_poc = vpvr;

      rows.push({
        symbol: instrument.symbol,
        index,
        date: bars[index].date,
        regime: regime.get(bars[index].date) ?? 'unknown',
        split: bars[index].date < TRAIN_BOUNDARY ? 'train' : 'test',
        directions,
      });
    }
  }
  return { rows, barsBySymbol };
}

function signalRate(
  rows: readonly Row[],
  barsBySymbol: ReadonlyMap<string, readonly Bar[]>,
  feature: Feature,
  horizon: number,
): Rate {
  const tally = emptyTally();
  rows.forEach((row) => {
    const direction = row.directions[feature];
    if (direction === undefined) return;
    const outcome = closeOutcome(barsBySymbol.get(row.symbol)!, row.index, horizon, direction);
    if (outcome === 'unavailable' || outcome === 'flat') return;
    if (outcome === 'win') tally.wins += 1; else tally.losses += 1;
    tally.keys.push(row);
  });
  return rateOf(tally, horizon);
}

/**
 * The unconditional rate over the same instrument-days, weighted to the same
 * long/short mix the feature produced. Same construction as P4a's
 * `closeBaseRate`, over `universe` — every sampled day, not only the days the
 * feature chose to speak on.
 */
function baseRate(
  universe: readonly Row[],
  rows: readonly Row[],
  barsBySymbol: ReadonlyMap<string, readonly Bar[]>,
  feature: Feature,
  horizon: number,
): Rate {
  const spoken = rows.filter((row) => row.directions[feature] !== undefined);
  if (spoken.length === 0) return { n: 0, clustered: 0, rate: null };
  const longShare = spoken.filter((row) => row.directions[feature] === 1).length / spoken.length;

  const tally = emptyTally();
  let up = 0;
  let down = 0;
  universe.forEach((row) => {
    const outcome = closeOutcome(barsBySymbol.get(row.symbol)!, row.index, horizon, 1);
    if (outcome === 'unavailable' || outcome === 'flat') return;
    if (outcome === 'win') up += 1; else down += 1;
    tally.keys.push(row);
  });
  const total = up + down;
  if (!total) return rateOf(tally, horizon);
  const weighted = longShare * (up / total) + (1 - longShare) * (down / total);
  tally.wins = Math.round(weighted * total);
  tally.losses = total - tally.wins;
  return rateOf(tally, horizon);
}

interface Comparison { signal: Rate; base: Rate; edge: number | null; band: number | null; significant: boolean }

function compare(
  universe: readonly Row[],
  rows: readonly Row[],
  barsBySymbol: ReadonlyMap<string, readonly Bar[]>,
  feature: Feature,
  horizon: number,
  z: number,
): Comparison {
  const signal = signalRate(rows, barsBySymbol, feature, horizon);
  const base = baseRate(universe, rows, barsBySymbol, feature, horizon);
  const edge = signal.rate === null || base.rate === null ? null : signal.rate - base.rate;
  const band = interval(signal, z);
  return { signal, base, edge, band, significant: edge !== null && band !== null && Math.abs(edge) > band };
}

const LABEL: Record<Feature, string> = {
  relative_strength: 'relative strength vs SPY (63b, 2% band)',
  volatility_compression: 'compressed vol + 20-bar move (ATR% bottom quartile)',
  momentum_ungated: '  the same 20-bar move, UNGATED (its control)',
  vpvr_poc: 'price vs volume POC (120b, 0.5 ATR band)',
};

function main(): void {
  const { instruments, expected, missing } = loadCorpus();
  const { rows, barsBySymbol } = collect(instruments);

  console.log('# P5 context candidates — measured before anything was built\n');
  console.log('```');
  console.log(`run compared to    ${MARKET_SIGNAL_MEASURED.runId}`);
  console.log(`corpus             ${instruments.length} of ${expected} instruments from that run's manifest`);
  if (missing.length > 0) console.log(`NOT MEASURED       ${missing.join(', ')} — absent from the local cache`);
  console.log(`sampled days       ${rows.length}   (stride ${STRIDE} bars, left window ${WINDOW} bars)`);
  console.log(`time split         train < ${TRAIN_BOUNDARY} <= test`);
  console.log(`interval           two-sided, Bonferroni-adjusted for ${LOOKS} looks (z=${Z_ADJUSTED})`);
  FEATURES.forEach((feature) => {
    const spoken = rows.filter((row) => row.directions[feature] !== undefined).length;
    const long = rows.filter((row) => row.directions[feature] === 1).length;
    console.log(`${feature.padEnd(23)} spoke on ${String(spoken).padStart(6)} days  (${((long / Math.max(spoken, 1)) * 100).toFixed(0)}% long)`);
  });
  console.log('```\n');

  console.log('## 1. Each candidate against the base rate\n');
  console.log('```');
  console.log('feature                                              | hor |  signal      n   clust |    base |    edge |    ±adj | sig?');
  console.log('-----------------------------------------------------|-----|------------------------|---------|---------|---------|-----');
  for (const feature of FEATURES) {
    for (const horizon of HORIZONS) {
      const result = compare(rows, rows, barsBySymbol, feature, horizon, Z_ADJUSTED);
      console.log(
        `${LABEL[feature].padEnd(52)} | ${String(horizon).padStart(3)} |`
        + ` ${pct(result.signal.rate)} ${String(result.signal.n).padStart(6)} ${String(result.signal.clustered).padStart(7)} |`
        + ` ${pct(result.base.rate)} | ${pp(result.edge)} | ${pp(result.band)} | ${result.significant ? ' YES' : '  no'}`,
      );
    }
  }
  console.log('```\n');

  console.log('## 2. The same, split at the boundary P4a fixed before any number moved\n');
  console.log('```');
  console.log('feature                 | split | hor |  signal      n   clust |    base |    edge');
  console.log('------------------------|-------|-----|------------------------|---------|--------');
  for (const feature of FEATURES) {
    for (const split of ['train', 'test'] as const) {
      const subset = rows.filter((row) => row.split === split);
      for (const horizon of HORIZONS) {
        const result = compare(subset, subset, barsBySymbol, feature, horizon, Z_NAIVE);
        console.log(
          `${feature.padEnd(23)} | ${split.padEnd(5)} | ${String(horizon).padStart(3)} |`
          + ` ${pct(result.signal.rate)} ${String(result.signal.n).padStart(6)} ${String(result.signal.clustered).padStart(7)} |`
          + ` ${pct(result.base.rate)} | ${pp(result.edge)}`,
        );
      }
    }
  }
  console.log('```\n');

  console.log('## 3. The same, by market regime\n');
  console.log('```');
  console.log('feature                 | regime | hor |  signal      n   clust |    base |    edge');
  console.log('------------------------|--------|-----|------------------------|---------|--------');
  for (const feature of FEATURES) {
    for (const regime of ['up', 'down'] as const) {
      const subset = rows.filter((row) => row.regime === regime);
      for (const horizon of HORIZONS) {
        const result = compare(subset, subset, barsBySymbol, feature, horizon, Z_NAIVE);
        console.log(
          `${feature.padEnd(23)} | ${regime.padEnd(6)} | ${String(horizon).padStart(3)} |`
          + ` ${pct(result.signal.rate)} ${String(result.signal.n).padStart(6)} ${String(result.signal.clustered).padStart(7)} |`
          + ` ${pct(result.base.rate)} | ${pp(result.edge)}`,
        );
      }
    }
  }
  console.log('```\n');

  /*
   * The verdict is printed rather than left to the reader, because "edge < 1pp
   * at every horizon" is the criterion the brief set and a long table invites
   * somebody to go looking for the one cell that clears it.
   */
  console.log('## 4. Verdict against the P5 criterion\n');
  console.log('```');
  for (const feature of FEATURES) {
    const results = HORIZONS.map((horizon) => compare(rows, rows, barsBySymbol, feature, horizon, Z_ADJUSTED));
    const edges = results.map((result) => result.edge).filter((edge): edge is number => edge !== null);
    const largest = edges.length === 0 ? null : Math.max(...edges.map((edge) => Math.abs(edge)));
    const clearsOnePp = edges.some((edge) => Math.abs(edge) >= 0.01);
    const allHorizons = edges.length === HORIZONS.length && edges.every((edge) => Math.abs(edge) >= 0.01);
    const anySignificant = results.some((result) => result.significant);

    const trainEdges = HORIZONS.map((horizon) => {
      const subset = rows.filter((row) => row.split === 'train');
      return compare(subset, subset, barsBySymbol, feature, horizon, Z_NAIVE).edge;
    });
    const testEdges = HORIZONS.map((horizon) => {
      const subset = rows.filter((row) => row.split === 'test');
      return compare(subset, subset, barsBySymbol, feature, horizon, Z_NAIVE).edge;
    });
    const signsAgree = trainEdges.every((train, position) => {
      const test = testEdges[position];
      return train === null || test === null || Math.sign(train) === Math.sign(test);
    });

    const verdict = !clearsOnePp ? 'SKIP — under 1pp at every horizon'
      : !allHorizons ? 'SKIP — clears 1pp at some horizons only, which is the shape of noise'
      : !anySignificant ? 'SKIP — inside its own interval at every horizon'
      : !signsAgree ? 'SKIP — train and test disagree in sign'
      : 'CANDIDATE — stop and consult before wiring';
    // Two decimals, because one puts 0.996pp on the page as "1.0pp" directly
    // beside a verdict saying it is under 1pp.
    console.log(`${feature.padEnd(23)} largest |edge| ${largest === null ? '      —' : `${(largest * 100).toFixed(2)}pp`.padStart(7)}   ${verdict}`);
  }
  console.log('```');
}

main();
