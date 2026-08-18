/**
 * P2.5 falsification test.
 *
 * The question this has to answer before any UI is written: can price actually
 * close through the trigger the card publishes?
 *
 * The previous design derived the frame from `nearestSupport`/`nearestResistance`,
 * which are defined as the confirmed levels closest to the current price. A
 * trigger built from those retreats every time price advances, so the answer
 * was structurally zero on every instrument that had both levels — the card was
 * answering "is this near an all-time high" instead of "how far to an uptrend".
 *
 * Here the frame is anchored to swing structure and is sticky. If this still
 * reports near-zero crossings across the corpus, the anchor is still
 * price-relative somewhere and the design is wrong again.
 *
 * Run: npm run signal:falsify
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { calculateTrendZones } from '@/src/lib/analytics/market-signal/calculations';
import { ema } from '@/src/lib/analytics/technical/calculations';
import type { MarketSignalCandle } from '@/src/lib/analytics/market-signal/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');
const WINDOW = 250;

interface Frozen { symbol: string; candles: MarketSignalCandle[] }

function main(): void {
  const files = readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.json'));
  const rows: Array<{ symbol: string; crossings: number; zone: string; mode: string; pos: number }> = [];

  for (const file of files) {
    const frozen = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as Frozen;
    const candles = frozen.candles.filter((candle) => candle.finalized)
      .map(({ finalized: _f, ...candle }) => candle);
    if (candles.length < 400) continue;
    // The walk inside `calculateTrendZones` covers `walkbackBars`; give it a
    // 250-bar window by trimming, plus enough history for pivots and EMA20.
    const trimmed = candles.slice(-(WINDOW + 260));
    const ema20 = ema(trimmed.map((candle) => candle.close), 20).at(-1) ?? null;
    const zones = calculateTrendZones({ candles: trimmed, ema20 });
    if (!zones) continue;
    rows.push({
      symbol: frozen.symbol,
      crossings: zones.triggerCrossings,
      zone: zones.zone,
      mode: zones.mode,
      pos: zones.positionPct,
    });
  }

  const crossings = rows.map((row) => row.crossings).sort((left, right) => left - right);
  const quantile = (fraction: number) => crossings[Math.min(crossings.length - 1, Math.floor(fraction * (crossings.length - 1)))];
  const zero = rows.filter((row) => row.crossings === 0);

  console.log(`instruments: ${rows.length}  (window ${WINDOW} bars each)\n`);
  console.log('=== closes beyond the then-current trigger ===');
  console.log(`min ${crossings[0]}  p25 ${quantile(0.25)}  median ${quantile(0.5)}  p75 ${quantile(0.75)}  max ${crossings.at(-1)}`);
  console.log(`mean ${(crossings.reduce((sum, value) => sum + value, 0) / crossings.length).toFixed(1)}`);
  console.log(`instruments with ZERO crossings: ${zero.length} / ${rows.length}${zero.length ? ` (${zero.map((row) => row.symbol).join(', ')})` : ''}`);

  const buckets = [0, 1, 3, 6, 11, 21, 41, 81];
  console.log('\ndistribution:');
  buckets.forEach((low, index) => {
    const high = buckets[index + 1] ?? Infinity;
    const count = rows.filter((row) => row.crossings >= low && row.crossings < high).length;
    const label = high === Infinity ? `${low}+` : `${low}-${high - 1}`;
    console.log(`  ${label.padStart(6)}  ${'#'.repeat(count).padEnd(45)} ${count}`);
  });

  console.log('\n=== zone mix at the latest bar ===');
  (['uptrend', 'sideways', 'downtrend'] as const).forEach((zone) => {
    console.log(`  ${zone.padEnd(10)} ${rows.filter((row) => row.zone === zone).length}`);
  });
  console.log(`  atr_band fallback: ${rows.filter((row) => row.mode === 'atr_band').length}`);

  console.log('\n=== range-bound versus trending (fewest and most crossings) ===');
  const sorted = [...rows].sort((left, right) => left.crossings - right.crossings);
  sorted.slice(0, 8).forEach((row) => console.log(`  ${row.symbol.padEnd(9)} ${String(row.crossings).padStart(3)}  ${row.zone}  pos ${row.pos}`));
  console.log('  ...');
  sorted.slice(-8).forEach((row) => console.log(`  ${row.symbol.padEnd(9)} ${String(row.crossings).padStart(3)}  ${row.zone}  pos ${row.pos}`));

  console.log('\n=== the symbols the review named ===');
  ['IREN', 'QQQ', 'SPY', 'DIA', 'IWM', 'GC-F', 'SI-F', 'CL-F', 'REMX', 'BTC-USD'].forEach((symbol) => {
    const row = rows.find((item) => item.symbol === symbol);
    if (row) console.log(`  ${symbol.padEnd(9)} crossings ${String(row.crossings).padStart(3)}  zone ${row.zone.padEnd(9)} mode ${row.mode.padEnd(11)} pos ${row.pos}`);
  });
}

main();
