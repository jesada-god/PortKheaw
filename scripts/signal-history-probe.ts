/**
 * P6 step 0 — is a label that has held for a long time worth more than a fresh
 * one?
 *
 * The brief is explicit that this has to be answered before the feature is
 * built, and that the answer decides what the feature is ALLOWED to say. A
 * 30-day history strip is a disclosure either way; what is at stake is whether
 * the UI may imply that an old label is a better one.
 *
 * The suspicion it exists to test comes out of P4a: a SIDEWAYS label is still
 * SIDEWAYS twenty bars later 72.6% of the time, while price is still inside the
 * frame that label described only 25.7% of the time. So a label persists far
 * longer than the thing it is a statement about — which is exactly the setup
 * where "this has held for 40 days" reads as corroboration and is in fact
 * inertia.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED
 * ---------------------------------------------------------------------------
 * The same replay as P4a — same corpus, window, stride, horizons and split, and
 * the same criterion B against the same weighted base rate — with one extra
 * column per observation: how long the current label had already been standing
 * when it was published. Directional observations are then bucketed by that age
 * and each bucket is compared against the base rate separately.
 *
 * If age carries information, the older buckets beat the younger ones. If the
 * buckets are indistinguishable, the age is a fact about the label and not
 * about the market, and the UI may state it but may not rank by it.
 *
 * SIDEWAYS is measured on its own claim instead, because no direction was
 * offered: does an older sideways label keep price inside the frame any better
 * than a fresh one?
 *
 * ---------------------------------------------------------------------------
 * THE GRANULARITY LIMIT, SAID UP FRONT
 * ---------------------------------------------------------------------------
 * The replay samples every 5th bar, so an age is known to within 5 bars and
 * never more precisely. The `recent_flip` flag the brief specifies is a 3-day
 * window, which is FINER than this probe can see: the youngest bucket here is
 * "changed at or since the previous sample", i.e. 5 bars or less. Nothing below
 * is evidence about a 3-day threshold specifically, and the report says so
 * rather than letting a 5-bar figure stand in for a 3-day one.
 *
 * Run: npm run signal:history
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { MARKET_SIGNAL_MEASURED } from '@/src/config/signal';
import { calculateMarketSignal } from '@/src/lib/analytics/market-signal/calculations';
import type {
  MarketSignalCandle,
  MarketSignalState,
  MarketSignalZoneName,
} from '@/src/lib/analytics/market-signal/types';
import type { DataFreshness } from '@/src/lib/market-data/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');
const MANIFEST_PATH = join(
  process.cwd(), '__calibration__', MARKET_SIGNAL_MEASURED.runId, 'manifest.json',
);

const HORIZONS = [5, 10, 20] as const;
const STRIDE = 5;
const WINDOW = 600;
const MINIMUM_BUCKET = 30;
const TRAIN_BOUNDARY = '2025-06-30';
/** Five age buckets by three horizons. */
const LOOKS = 15;
const Z_ADJUSTED = 3.03;

type Bar = Omit<MarketSignalCandle, 'finalized'>;
interface Frozen { symbol: string; source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] }
interface Instrument { symbol: string; source: string | null; freshness: DataFreshness; bars: Bar[] }
type Direction = 1 | -1;

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
    instruments.push({ symbol: frozen.symbol, source: frozen.source, freshness: frozen.freshness, bars });
  }
  return { instruments, expected: manifest.instruments.length, missing };
}

const runEngine = (instrument: Instrument, bars: readonly Bar[]) => calculateMarketSignal(
  bars.map((bar) => ({ ...bar, finalized: true })),
  {
    symbol: instrument.symbol,
    source: instrument.source,
    freshness: instrument.freshness,
    calculatedAt: '2026-01-01T00:00:00.000Z',
    features: { gate: true, zones: true, actionable: true },
  },
);

/* ------------------------------------------------------------------------- */
/* observations, carrying the age of the label that produced them            */
/* ------------------------------------------------------------------------- */

interface Observation {
  symbol: string;
  index: number;
  date: string;
  split: 'train' | 'test';
  state: MarketSignalState;
  zone: MarketSignalZoneName;
  /** Bars the CURRENT state has been unbroken, at 5-bar resolution. 0 = just changed. */
  stateAgeBars: number;
  /** The same for the zone, which is what the label is derived from once P2 is on. */
  zoneAgeBars: number;
  close: number;
  support: number;
  resistance: number;
}

function observe(instruments: readonly Instrument[]): { rows: Observation[]; barsBySymbol: Map<string, readonly Bar[]> } {
  const rows: Observation[] = [];
  const barsBySymbol = new Map<string, readonly Bar[]>();
  const longest = Math.max(...HORIZONS);
  let done = 0;

  for (const instrument of instruments) {
    barsBySymbol.set(instrument.symbol, instrument.bars);
    const { bars } = instrument;
    let previousState: MarketSignalState | null = null;
    let previousZone: MarketSignalZoneName | null = null;
    let stateRun = 0;
    let zoneRun = 0;

    for (let index = WINDOW; index + longest < bars.length; index += STRIDE) {
      const result = runEngine(instrument, bars.slice(index + 1 - WINDOW, index + 1));
      if (result.status !== 'available' || !result.zones) {
        previousState = null;
        previousZone = null;
        stateRun = 0;
        zoneRun = 0;
        continue;
      }
      stateRun = result.state === previousState ? stateRun + 1 : 0;
      zoneRun = result.zones.zone === previousZone ? zoneRun + 1 : 0;
      previousState = result.state;
      previousZone = result.zones.zone;

      rows.push({
        symbol: instrument.symbol,
        index,
        date: bars[index].date,
        split: bars[index].date < TRAIN_BOUNDARY ? 'train' : 'test',
        state: result.state,
        zone: result.zones.zone,
        stateAgeBars: stateRun * STRIDE,
        zoneAgeBars: zoneRun * STRIDE,
        close: result.zones.referenceClose,
        support: result.zones.support,
        resistance: result.zones.resistance,
      });
    }
    done += 1;
    if (done % 10 === 0) console.error(`  ${done}/${instruments.length} instruments`);
  }
  return { rows, barsBySymbol };
}

/* ------------------------------------------------------------------------- */
/* outcomes — identical to P4a's criterion B                                 */
/* ------------------------------------------------------------------------- */

type CloseOutcome = 'win' | 'loss' | 'flat' | 'unavailable';

function closeOutcome(bars: readonly Bar[], index: number, horizon: number, direction: Direction): CloseOutcome {
  const future = bars[index + horizon];
  if (!future) return 'unavailable';
  const move = future.close - bars[index].close;
  if (move === 0) return 'flat';
  return Math.sign(move) === direction ? 'win' : 'loss';
}

const directionOf = (zone: MarketSignalZoneName): Direction | null =>
  zone === 'uptrend' ? 1 : zone === 'downtrend' ? -1 : null;

interface Tally { wins: number; losses: number; keys: Array<{ symbol: string; index: number }> }
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
const interval = (rate: Rate, z: number): number | null => (rate.rate === null || rate.clustered === 0)
  ? null
  : z * Math.sqrt((rate.rate * (1 - rate.rate)) / rate.clustered);

function directionalRate(
  rows: readonly Observation[],
  barsBySymbol: ReadonlyMap<string, readonly Bar[]>,
  horizon: number,
): Rate {
  const tally = emptyTally();
  rows.forEach((row) => {
    const direction = directionOf(row.zone);
    if (direction === null) return;
    const outcome = closeOutcome(barsBySymbol.get(row.symbol)!, row.index, horizon, direction);
    if (outcome === 'unavailable' || outcome === 'flat') return;
    if (outcome === 'win') tally.wins += 1; else tally.losses += 1;
    tally.keys.push(row);
  });
  return rateOf(tally, horizon);
}

/** Same construction as P4a: unconditional, weighted to the subset's own mix. */
function baseRate(
  universe: readonly Observation[],
  rows: readonly Observation[],
  barsBySymbol: ReadonlyMap<string, readonly Bar[]>,
  horizon: number,
): Rate {
  const directional = rows.filter((row) => directionOf(row.zone) !== null);
  if (directional.length === 0) return { n: 0, clustered: 0, rate: null };
  const longShare = directional.filter((row) => row.zone === 'uptrend').length / directional.length;

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

/* ------------------------------------------------------------------------- */
/* buckets                                                                   */
/* ------------------------------------------------------------------------- */

const AGE_BUCKETS = [
  { label: '0-5 bars  (just changed)', min: 0, max: 5 },
  { label: '10-15 bars', min: 10, max: 15 },
  { label: '20-30 bars', min: 20, max: 30 },
  { label: '35-60 bars', min: 35, max: 60 },
  { label: '65+ bars', min: 65, max: Infinity },
] as const;

function main(): void {
  const { instruments, expected, missing } = loadCorpus();
  console.error(`replaying ${instruments.length} instruments…`);
  const { rows, barsBySymbol } = observe(instruments);

  console.log('# P6 step 0 — does a label that has stood for longer say more?\n');
  console.log('```');
  console.log(`run compared to    ${MARKET_SIGNAL_MEASURED.runId}`);
  console.log(`corpus             ${instruments.length} of ${expected} instruments from that run's manifest`);
  if (missing.length > 0) console.log(`NOT MEASURED       ${missing.join(', ')}`);
  console.log(`observations       ${rows.length}   (stride ${STRIDE} bars, left window ${WINDOW} bars)`);
  console.log(`directional        ${rows.filter((row) => directionOf(row.zone) !== null).length}`);
  console.log(`age resolution     ${STRIDE} bars — FINER THRESHOLDS ARE NOT MEASURABLE HERE`);
  console.log(`interval           two-sided 95%, Bonferroni-adjusted for ${LOOKS} looks (z=${Z_ADJUSTED})`);
  console.log('```\n');

  console.log('## 1. Directional accuracy by how long the label had already stood\n');
  console.log('```');
  console.log('label age                | hor |  signal      n   clust |    base |    edge |    ±adj | sig?');
  console.log('-------------------------|-----|------------------------|---------|---------|---------|-----');
  for (const bucket of AGE_BUCKETS) {
    const subset = rows.filter((row) => row.zoneAgeBars >= bucket.min && row.zoneAgeBars <= bucket.max);
    for (const horizon of HORIZONS) {
      const signal = directionalRate(subset, barsBySymbol, horizon);
      const base = baseRate(rows, subset, barsBySymbol, horizon);
      const edge = signal.rate === null || base.rate === null ? null : signal.rate - base.rate;
      const band = interval(signal, Z_ADJUSTED);
      const significant = edge !== null && band !== null && Math.abs(edge) > band;
      console.log(
        `${bucket.label.padEnd(24)} | ${String(horizon).padStart(3)} |`
        + ` ${pct(signal.rate)} ${String(signal.n).padStart(6)} ${String(signal.clustered).padStart(7)} |`
        + ` ${pct(base.rate)} | ${pp(edge)} | ${pp(band)} | ${significant ? ' YES' : '  no'}`,
      );
    }
  }
  console.log('```\n');

  console.log('## 2. The sideways claim, by age — does an older frame hold price better?\n');
  console.log('```');
  console.log('label age                | hor | still sideways | inside frame |      n');
  console.log('-------------------------|-----|----------------|--------------|-------');
  const byKey = new Map<string, Observation>();
  rows.forEach((row) => byKey.set(`${row.symbol}:${row.index}`, row));
  for (const bucket of AGE_BUCKETS) {
    const subset = rows.filter((row) => row.zone === 'sideways'
      && row.zoneAgeBars >= bucket.min && row.zoneAgeBars <= bucket.max);
    for (const horizon of HORIZONS) {
      let held = 0;
      let inside = 0;
      let counted = 0;
      subset.forEach((row) => {
        const later = byKey.get(`${row.symbol}:${row.index + horizon}`);
        const bars = barsBySymbol.get(row.symbol)!;
        const future = bars[row.index + horizon];
        if (!later || !future) return;
        counted += 1;
        if (later.zone === 'sideways') held += 1;
        if (future.close >= row.support && future.close <= row.resistance) inside += 1;
      });
      if (counted < MINIMUM_BUCKET) {
        console.log(`${bucket.label.padEnd(24)} | ${String(horizon).padStart(3)} |        insuff. |      insuff. | ${String(counted).padStart(6)}`);
        continue;
      }
      console.log(
        `${bucket.label.padEnd(24)} | ${String(horizon).padStart(3)} |`
        + ` ${`${((held / counted) * 100).toFixed(1)}%`.padStart(14)} |`
        + ` ${`${((inside / counted) * 100).toFixed(1)}%`.padStart(12)} | ${String(counted).padStart(6)}`,
      );
    }
  }
  console.log('```\n');

  console.log('## 3. How often a label is younger than the flag would catch\n');
  console.log('```');
  const directional = rows.filter((row) => directionOf(row.zone) !== null);
  const fresh = directional.filter((row) => row.zoneAgeBars === 0).length;
  console.log(`directional observations               ${directional.length}`);
  console.log(`whose zone changed at this sample      ${fresh}  (${((fresh / Math.max(directional.length, 1)) * 100).toFixed(1)}%)`);
  const stateFresh = rows.filter((row) => row.stateAgeBars === 0).length;
  console.log(`all observations whose STATE changed   ${stateFresh}  (${((stateFresh / Math.max(rows.length, 1)) * 100).toFixed(1)}%)`);
  console.log('');
  console.log('At a 5-bar sampling resolution these are upper bounds on a 3-day flag:');
  console.log('a change seen at this sample happened somewhere in the last 5 bars, and');
  console.log('the share that happened in the last 3 cannot be recovered from this run.');
  console.log('```\n');

  console.log('## 4. The same split, so a single-half result cannot pass as a finding\n');
  console.log('```');
  console.log('label age                | split | hor |  signal      n   clust |    base |    edge');
  console.log('-------------------------|-------|-----|------------------------|---------|--------');
  for (const bucket of AGE_BUCKETS) {
    for (const split of ['train', 'test'] as const) {
      const subset = rows.filter((row) => row.split === split
        && row.zoneAgeBars >= bucket.min && row.zoneAgeBars <= bucket.max);
      const universe = rows.filter((row) => row.split === split);
      for (const horizon of HORIZONS) {
        const signal = directionalRate(subset, barsBySymbol, horizon);
        const base = baseRate(universe, subset, barsBySymbol, horizon);
        const edge = signal.rate === null || base.rate === null ? null : signal.rate - base.rate;
        console.log(
          `${bucket.label.padEnd(24)} | ${split.padEnd(5)} | ${String(horizon).padStart(3)} |`
          + ` ${pct(signal.rate)} ${String(signal.n).padStart(6)} ${String(signal.clustered).padStart(7)} |`
          + ` ${pct(base.rate)} | ${pp(edge)}`,
        );
      }
    }
  }
  console.log('```');
}

main();
