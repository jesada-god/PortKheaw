/**
 * P3.5 — which constant actually decides the zone mix?
 *
 * `MARKET_SIGNAL_ZONE.anchor.lookbackBars` was set to 120 without evidence, and
 * the brief's worry was that it decides the sideways share — which decides
 * whether P3's actionable layer is silent on four instruments in five, which is
 * the base P4 would be calibrated on top of.
 *
 * So it is swept before P4 rather than after. Two other constants are swept
 * beside it, because a sensitivity run that moves one knob can only ever say
 * "this one does nothing" — it cannot say what the knob that matters is:
 *
 *   anchor.lookbackBars   how stale an anchoring pivot may be
 *   walkbackBars          how far back the zone walk replays, and therefore how
 *                         long a zone has to establish itself inside the window
 *   structure.pivotWindow what counts as a swing at all
 *
 * Measured per value, over the 108-instrument corpus:
 *
 *   zone mix          uptrend / sideways / downtrend, plus the atr_band share
 *   invalidations     how many instruments P3 can publish a level for
 *   re-anchors / 250  how sticky the frame is — replayed bar by bar, counting
 *                     the bars whose frame was rebuilt that day
 *   crossings         P2.5's falsification test: closes that landed beyond the
 *                     then-current trigger. Near zero means a frame price never
 *                     reaches, which is the failure the anchor was built to fix.
 *
 * Plus one diagnostic that decides how to read all of it: the AGE of the pivots
 * the frame is actually anchored on. A staleness bound set far above that age
 * cannot be filtering anything.
 *
 * Run: npm run signal:lookback
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { MARKET_SIGNAL_THRESHOLDS, MARKET_SIGNAL_ZONE } from '@/src/config/signal';
import { calculateActionable, calculateTrendZones } from '@/src/lib/analytics/market-signal/calculations';
import { confirmedSwingPivots } from '@/src/lib/analytics/support-resistance/calculations';
import { atrWilder, ema } from '@/src/lib/analytics/technical/calculations';
import type { MarketSignalCandle, MarketSignalZoneName } from '@/src/lib/analytics/market-signal/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');
/** How many as-of bars the re-anchor count is measured over. */
const REPLAY_BARS = 250;
/**
 * Bars handed to the engine per as-of point. The walk starts `walkbackBars` back
 * and `anchorAt` reaches `lookbackBars` behind that, so the largest pair swept
 * here needs 250 + 250 plus an ATR warm-up. 600 covers it and keeps the pivot
 * scan — which dominates the runtime — off five years of bars it cannot use.
 */
const WINDOW = 600;

type Bar = Omit<MarketSignalCandle, 'finalized'>;
interface Frozen { symbol: string; candles: MarketSignalCandle[] }

const zonesOf = (candles: readonly Bar[]) => calculateTrendZones({
  candles,
  ema20: ema(candles.map((candle) => candle.close), 20).at(-1) ?? null,
});

interface Row {
  symbol: string;
  zone: MarketSignalZoneName;
  mode: string;
  crossings: number;
  hasInvalidation: boolean;
  reanchors: number;
}

function measure(instruments: readonly Bar[][], symbols: readonly string[]): Row[] {
  const rows: Row[] = [];
  instruments.forEach((candles, index) => {
    const latest = zonesOf(candles);
    if (!latest) return;
    const actionable = calculateActionable({ zones: latest, atr: atrWilder(candles, 14).at(-1) ?? null });

    // `frameAgeBars === 0` means the frame was rebuilt on the bar being read, so
    // walking the as-of point forward and counting those bars counts re-anchors.
    let reanchors = 0;
    for (let end = candles.length - REPLAY_BARS; end < candles.length; end += 1) {
      const zones = zonesOf(candles.slice(Math.max(0, end + 1 - WINDOW), end + 1));
      if (zones?.frameAgeBars === 0) reanchors += 1;
    }

    rows.push({
      symbol: symbols[index],
      zone: latest.zone,
      mode: latest.mode,
      crossings: latest.triggerCrossings,
      hasInvalidation: actionable.invalidation !== null,
      reanchors,
    });
  });
  return rows;
}

const quantile = (sorted: readonly number[], fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];

const describe = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return `${String(sorted[0]).padStart(3)}${String(quantile(sorted, 0.25)).padStart(5)}${String(quantile(sorted, 0.5)).padStart(8)}${String(quantile(sorted, 0.75)).padStart(5)}${String(sorted.at(-1)).padStart(5)} | ${mean.toFixed(1).padStart(5)}`;
};

function report(label: string, values: readonly number[], results: ReadonlyMap<number, Row[]>): void {
  const share = (count: number, of: number) => `${((count / of) * 100).toFixed(1)}%`;

  console.log(`\n\n############ ${label} ############`);

  console.log('\n=== zone mix at the latest bar ===');
  console.log(`${label.padEnd(9)}|  uptrend  sideways downtrend |  atr_band | sideways share`);
  console.log('---------|-----------------------------|-----------|---------------');
  values.forEach((value) => {
    const rows = results.get(value)!;
    const count = (zone: MarketSignalZoneName) => rows.filter((row) => row.zone === zone).length;
    const band = rows.filter((row) => row.mode === 'atr_band').length;
    console.log(`${String(value).padStart(8)} | ${String(count('uptrend')).padStart(8)}${String(count('sideways')).padStart(10)}${String(count('downtrend')).padStart(10)}  | ${String(band).padStart(9)} | ${share(count('sideways'), rows.length).padStart(14)}`);
  });

  console.log('\n=== invalidations P3 can publish ===');
  console.log(`${label.padEnd(9)}| published | null | null share`);
  console.log('---------|-----------|------|-----------');
  values.forEach((value) => {
    const rows = results.get(value)!;
    const published = rows.filter((row) => row.hasInvalidation).length;
    console.log(`${String(value).padStart(8)} | ${String(published).padStart(9)} | ${String(rows.length - published).padStart(4)} | ${share(rows.length - published, rows.length).padStart(10)}`);
  });

  console.log(`\n=== re-anchors per ${REPLAY_BARS} bars (frame stickiness) ===`);
  console.log(`${label.padEnd(9)}| min  p25  median  p75  max |  mean | never re-anchoring`);
  console.log('---------|----------------------------|-------|-------------------');
  values.forEach((value) => {
    const rows = results.get(value)!;
    const never = rows.filter((row) => row.reanchors === 0).length;
    console.log(`${String(value).padStart(8)} | ${describe(rows.map((row) => row.reanchors))} | ${String(never).padStart(18)}`);
  });

  console.log('\n=== trigger crossings (P2.5 falsification: can price reach the trigger) ===');
  console.log(`${label.padEnd(9)}| min  p25  median  p75  max |  mean | instruments with ZERO`);
  console.log('---------|----------------------------|-------|----------------------');
  values.forEach((value) => {
    const rows = results.get(value)!;
    const zero = rows.filter((row) => row.crossings === 0).length;
    console.log(`${String(value).padStart(8)} | ${describe(rows.map((row) => row.crossings))} | ${String(zero).padStart(21)}`);
  });

  console.log('\n=== instruments changing zone between adjacent values ===');
  for (let index = 1; index < values.length; index += 1) {
    const previous = new Map(results.get(values[index - 1])!.map((row) => [row.symbol, row.zone]));
    const current = results.get(values[index])!;
    const moved = current.filter((row) => previous.get(row.symbol) !== row.zone);
    console.log(`  ${values[index - 1]} -> ${values[index]}: ${moved.length}${moved.length && moved.length <= 12 ? ` (${moved.map((row) => row.symbol).join(', ')})` : ''}`);
  }
}

/**
 * How old are the pivots the frame is actually standing on?
 *
 * `anchorAt` takes the most recent confirmed high and the most recent confirmed
 * low, then drops anything older than `lookbackBars`. If those two are routinely
 * a handful of bars old, a bound of 60 — let alone 250 — never removes a
 * candidate, and sweeping it is sweeping a parameter that is not connected to
 * anything.
 */
function anchorAges(instruments: readonly Bar[][]): void {
  const ages: number[] = [];
  instruments.forEach((candles) => {
    const pivots = confirmedSwingPivots(candles, MARKET_SIGNAL_THRESHOLDS.structure.pivotWindow);
    const index = candles.length - 1;
    const usable = pivots.filter((pivot) => pivot.confirmedAtIndex <= index);
    const high = usable.filter((pivot) => pivot.kind === 'high').at(-1);
    const low = usable.filter((pivot) => pivot.kind === 'low').at(-1);
    if (high) ages.push(index - high.confirmedAtIndex);
    if (low) ages.push(index - low.confirmedAtIndex);
  });
  const sorted = ages.sort((left, right) => left - right);
  console.log('\n=== age, in bars, of the pivots the frame anchors on ===');
  console.log(`n ${sorted.length}  min ${sorted[0]}  median ${quantile(sorted, 0.5)}  p75 ${quantile(sorted, 0.75)}  p90 ${quantile(sorted, 0.9)}  p99 ${quantile(sorted, 0.99)}  max ${sorted.at(-1)}`);
  [30, 60, 90, 120, 180, 250].forEach((bound) => {
    const kept = sorted.filter((age) => age <= bound).length;
    console.log(`  a bound of ${String(bound).padStart(3)} keeps ${String(kept).padStart(4)} / ${sorted.length}  (${((kept / sorted.length) * 100).toFixed(1)}%)`);
  });
}

function main(): void {
  const files = readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.json'));
  const symbols: string[] = [];
  const instruments: Bar[][] = [];
  for (const file of files) {
    const frozen = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as Frozen;
    const candles = frozen.candles.filter((candle) => candle.finalized)
      .map(({ finalized: _finalized, ...candle }) => candle);
    if (candles.length < 400) continue;
    symbols.push(frozen.symbol);
    instruments.push(candles);
  }
  console.error(`corpus: ${symbols.length} instruments`);

  anchorAges(instruments);

  /*
   * The engine reads these constants directly, and measuring anything else would
   * measure a copy of the rule rather than the rule. `as const` is a
   * compile-time assertion, not a runtime freeze, so the overrides are safe and
   * are confined to this script — each is restored before the next sweep.
   */
  const anchor = MARKET_SIGNAL_ZONE.anchor as { lookbackBars: number };
  const zone = MARKET_SIGNAL_ZONE as { walkbackBars: number };
  const structure = MARKET_SIGNAL_THRESHOLDS.structure as { pivotWindow: number };
  const original = { lookback: anchor.lookbackBars, walkback: zone.walkbackBars, pivot: structure.pivotWindow };

  const sweep = (values: readonly number[], apply: (value: number) => void, label: string) => {
    const results = new Map<number, Row[]>();
    values.forEach((value) => {
      apply(value);
      console.error(`  ${label} = ${value} ...`);
      results.set(value, measure(instruments, symbols));
    });
    return results;
  };

  // Deliberately reaching well below the brief's range. If the answer is "inert
  // across 60-250" the next question is where it stops being inert, and 10-45 is
  // where the pivot ages above say it should start to bite.
  const lookbacks = [10, 20, 30, 45, 60, 90, 120, 180, 250];
  const byLookback = sweep(lookbacks, (value) => { anchor.lookbackBars = value; }, 'anchor.lookbackBars');
  anchor.lookbackBars = original.lookback;

  const walkbacks = [60, 90, 120, 180, 250];
  const byWalkback = sweep(walkbacks, (value) => { zone.walkbackBars = value; }, 'walkbackBars');
  zone.walkbackBars = original.walkback;

  const pivotWindows = [2, 3, 4, 5, 7];
  const byPivotWindow = sweep(pivotWindows, (value) => { structure.pivotWindow = value; }, 'structure.pivotWindow');
  structure.pivotWindow = original.pivot;

  report('lookback', lookbacks, byLookback);
  report('walkback', walkbacks, byWalkback);
  report('pivotWin', pivotWindows, byPivotWindow);
}

main();
