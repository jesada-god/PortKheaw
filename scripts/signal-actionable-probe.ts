/**
 * P3 measurement — how often can the actionable layer say anything at all?
 *
 * The layer is built to return `null` rather than manufacture a level, so the
 * number that decides whether it was worth building is the share of instruments
 * that get a figure. This counts them, split by the reason each refusal happened,
 * over the same 108-instrument corpus the rest of the phase measurements use.
 *
 * Run: node --conditions=react-server --import=tsx scripts/signal-actionable-probe.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { calculateMarketSignal } from '@/src/lib/analytics/market-signal/calculations';
import type { MarketSignalCandle, MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import type { DataFreshness } from '@/src/lib/market-data/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');
const PINNED_CALCULATED_AT = '2026-01-01T00:00:00.000Z';

interface Frozen { symbol: string; source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] }

function main(): void {
  const files = readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.json'));
  const rows: Array<{ symbol: string; result: MarketSignalResult }> = [];

  for (const file of files) {
    const frozen = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as Frozen;
    const result = calculateMarketSignal(frozen.candles, {
      symbol: frozen.symbol,
      source: frozen.source,
      freshness: frozen.freshness,
      calculatedAt: PINNED_CALCULATED_AT,
      features: { gate: true, zones: true, actionable: true },
    });
    if (result.status !== 'available') continue;
    rows.push({ symbol: frozen.symbol, result });
  }

  const withZone = rows.filter((row) => row.result.zones);
  const withActionable = rows.filter((row) => row.result.actionable);
  const pct = (count: number, of: number) => `${((count / of) * 100).toFixed(1)}%`;

  console.log(`instruments with an available signal: ${rows.length}`);
  console.log(`  with a zone:       ${withZone.length}`);
  console.log(`  with an actionable block: ${withActionable.length}`);

  const invalid = withActionable.filter((row) => row.result.actionable!.invalidation !== null);
  const target = withActionable.filter((row) => row.result.actionable!.target !== null);
  const rr = withActionable.filter((row) => row.result.actionable!.riskReward !== null);
  console.log('\n=== how many get a number ===');
  console.log(`invalidation  ${String(invalid.length).padStart(3)} / ${withActionable.length}   null ${String(withActionable.length - invalid.length).padStart(3)}  (${pct(withActionable.length - invalid.length, withActionable.length)} null)`);
  console.log(`target        ${String(target.length).padStart(3)} / ${withActionable.length}   null ${String(withActionable.length - target.length).padStart(3)}  (${pct(withActionable.length - target.length, withActionable.length)} null)`);
  console.log(`risk:reward   ${String(rr.length).padStart(3)} / ${withActionable.length}   null ${String(withActionable.length - rr.length).padStart(3)}  (${pct(withActionable.length - rr.length, withActionable.length)} null)`);

  console.log('\n=== null broken down by zone ===');
  (['uptrend', 'sideways', 'downtrend'] as const).forEach((zone) => {
    const inZone = withActionable.filter((row) => row.result.zones!.zone === zone);
    if (!inZone.length) { console.log(`  ${zone.padEnd(10)} n=0`); return; }
    const withInvalidation = inZone.filter((row) => row.result.actionable!.invalidation !== null).length;
    const withTarget = inZone.filter((row) => row.result.actionable!.target !== null).length;
    console.log(`  ${zone.padEnd(10)} n=${String(inZone.length).padStart(3)}   invalidation ${String(withInvalidation).padStart(3)}   target ${String(withTarget).padStart(3)}`);
  });

  console.log('\n=== which refusal fired ===');
  const notes = new Map<string, number>();
  withActionable.forEach((row) => row.result.actionable!.notes
    .forEach((note) => notes.set(note, (notes.get(note) ?? 0) + 1)));
  [...notes.entries()].sort((left, right) => right[1] - left[1])
    .forEach(([note, count]) => console.log(`  ${note.padEnd(30)} ${String(count).padStart(3)}`));

  console.log('\n=== risk:reward where one exists ===');
  const ratios = rr.map((row) => row.result.actionable!.riskReward!).sort((left, right) => left - right);
  if (ratios.length) {
    const quantile = (fraction: number) => ratios[Math.min(ratios.length - 1, Math.floor(fraction * (ratios.length - 1)))];
    console.log(`  n ${ratios.length}  min ${ratios[0]}  p25 ${quantile(0.25)}  median ${quantile(0.5)}  p75 ${quantile(0.75)}  max ${ratios.at(-1)}`);
    console.log(`  below 1.0 (unfavorable_risk_reward): ${ratios.filter((value) => value < 1).length}`);
  }

  console.log('\n=== every instrument that got a full set ===');
  rr.forEach((row) => {
    const value = row.result.actionable!;
    console.log(`  ${row.symbol.padEnd(9)} ${row.result.zones!.zone.padEnd(9)} close ${String(row.result.zones!.referenceClose).padStart(10)}  inval ${String(value.invalidation).padStart(10)} (${value.invalidationAtr} ATR)  target ${String(value.target).padStart(10)}  R:R ${value.riskReward}`);
  });

  console.log('\n=== the golden ten ===');
  ['IREN', 'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD'].forEach((symbol) => {
    const row = rows.find((item) => item.symbol === symbol);
    if (!row?.result.actionable) return;
    const value = row.result.actionable;
    console.log(`  ${symbol.padEnd(9)} ${row.result.zones!.zone.padEnd(9)} inval ${String(value.invalidation).padStart(10)}  target ${String(value.target).padStart(10)}  R:R ${String(value.riskReward).padStart(6)}  [${value.notes.join(' ') || '-'}]`);
  });
}

main();
