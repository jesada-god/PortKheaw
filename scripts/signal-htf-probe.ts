/**
 * P3.3 falsification probe — does a weekly zone add information to the daily one?
 *
 * The brief has asked for a higher-timeframe filter since the first round
 * without ever establishing that 1W says anything 1D does not. This measures
 * that before any filter is written: resample each corpus instrument to weekly
 * bars, run the SAME zone engine on both timeframes, and count how often they
 * disagree.
 *
 * Two disagreement definitions are reported, because "conflict" is ambiguous and
 * the decision rule is worthless without saying which one it applies to:
 *
 *   strict  uptrend vs downtrend — the timeframes point opposite ways.
 *   loose   any difference at all, including uptrend vs sideways, which is
 *           mostly the weekly frame having a quarter of the bars rather than a
 *           genuine contradiction.
 *
 * Run: node --conditions=react-server --import=tsx scripts/signal-htf-probe.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { calculateTrendZones } from '@/src/lib/analytics/market-signal/calculations';
import { ema } from '@/src/lib/analytics/technical/calculations';
import type { MarketSignalCandle, MarketSignalZoneName } from '@/src/lib/analytics/market-signal/types';

const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');

interface Frozen { symbol: string; candles: MarketSignalCandle[] }
type Bar = Omit<MarketSignalCandle, 'finalized'>;

/** Monday-anchored ISO week key, so a resample is reproducible across runs. */
function weekKey(date: string): string {
  const time = new Date(`${date}T00:00:00.000Z`);
  const day = (time.getUTCDay() + 6) % 7;
  time.setUTCDate(time.getUTCDate() - day);
  return time.toISOString().slice(0, 10);
}

/**
 * Daily bars into weekly ones. The final week is DROPPED unless it carries five
 * sessions: a weekly bar built from a Tuesday is not a finalized weekly bar, and
 * including it is the same look-ahead mistake as reading a partial daily candle.
 */
function toWeekly(daily: readonly Bar[]): Bar[] {
  const groups = new Map<string, Bar[]>();
  daily.forEach((bar) => {
    const key = weekKey(bar.date);
    const bucket = groups.get(key);
    if (bucket) bucket.push(bar); else groups.set(key, [bar]);
  });
  const keys = [...groups.keys()].sort();
  const weekly: Bar[] = [];
  keys.forEach((key, index) => {
    const bars = groups.get(key)!;
    if (index === keys.length - 1 && bars.length < 5) return;
    weekly.push({
      date: key,
      open: bars[0].open,
      high: Math.max(...bars.map((bar) => bar.high)),
      low: Math.min(...bars.map((bar) => bar.low)),
      close: bars.at(-1)!.close,
      volume: bars.every((bar) => bar.volume !== null)
        ? bars.reduce((sum, bar) => sum + (bar.volume ?? 0), 0) : null,
    });
  });
  return weekly;
}

const zoneOf = (bars: readonly Bar[]): MarketSignalZoneName | null => {
  const ema20 = ema(bars.map((bar) => bar.close), 20).at(-1) ?? null;
  return calculateTrendZones({ candles: bars, ema20 })?.zone ?? null;
};

/*
 * Sampled across HISTORY, not just at the latest bar.
 *
 * One reading per instrument is 108 observations taken on a single date, and
 * that date happens to sit in a market where only two of the 108 are in a
 * downtrend at all. A "0% conflict" measured there says more about August 2026
 * than about the two timeframes. Sampling every `STRIDE` bars over the last
 * `SAMPLE_BARS` gives the pair a chance to disagree in conditions the corpus
 * does not currently contain.
 *
 * Each sample slices BOTH series to the as-of bar and recomputes EMA20 on the
 * slice, so nothing after the sample date is visible to it.
 */
const SAMPLE_BARS = 750;
const STRIDE = 10;

function main(): void {
  const files = readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.json'));
  const rows: Array<{ symbol: string; date: string; daily: MarketSignalZoneName; weekly: MarketSignalZoneName }> = [];
  let dropped = 0;

  for (const file of files) {
    const frozen = JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')) as Frozen;
    const daily = frozen.candles.filter((candle) => candle.finalized)
      .map(({ finalized: _f, ...candle }) => candle);
    // The zone walk needs ATR(20), a pivot window and 120 bars of walkback.
    if (daily.length < 400) { dropped += 1; continue; }
    const first = Math.max(400, daily.length - SAMPLE_BARS);
    for (let index = first; index < daily.length; index += STRIDE) {
      const dailySlice = daily.slice(0, index + 1);
      // Only weeks that had CLOSED by the as-of bar may take part.
      const weeklySlice = toWeekly(dailySlice).filter((bar) => bar.date < weekKey(daily[index].date));
      if (weeklySlice.length < 160) continue;
      const dailyZone = zoneOf(dailySlice);
      const weeklyZone = zoneOf(weeklySlice);
      if (!dailyZone || !weeklyZone) continue;
      rows.push({ symbol: frozen.symbol, date: daily[index].date, daily: dailyZone, weekly: weeklyZone });
    }
  }

  const strict = rows.filter((row) =>
    (row.daily === 'uptrend' && row.weekly === 'downtrend')
    || (row.daily === 'downtrend' && row.weekly === 'uptrend'));
  const loose = rows.filter((row) => row.daily !== row.weekly);
  const pct = (count: number) => `${((count / rows.length) * 100).toFixed(1)}%`;

  const symbols = new Set(rows.map((row) => row.symbol));
  const dates = new Set(rows.map((row) => row.date));
  console.log(`observations: ${rows.length}  (${symbols.size} instruments x ${dates.size} distinct as-of dates)${dropped ? `  dropped ${dropped} for short history` : ''}`);
  console.log('\n=== 1D zone vs 1W zone ===');
  console.log(`strict conflict (opposite directions): ${strict.length} / ${rows.length}  ${pct(strict.length)}`);
  console.log(`loose  disagreement (any difference)  : ${loose.length} / ${rows.length}  ${pct(loose.length)}`);
  if (strict.length) console.log(`  strict: ${strict.map((row) => `${row.symbol} ${row.daily}/${row.weekly}`).join(', ')}`);

  console.log('\n=== joint distribution (rows = 1D, cols = 1W) ===');
  const zones = ['uptrend', 'sideways', 'downtrend'] as const;
  console.log(`${''.padEnd(11)}${zones.map((zone) => zone.padStart(11)).join('')}`);
  zones.forEach((daily) => {
    const cells = zones.map((weekly) =>
      String(rows.filter((row) => row.daily === daily && row.weekly === weekly).length).padStart(11));
    console.log(`${daily.padEnd(11)}${cells.join('')}`);
  });

  console.log('\n=== marginals ===');
  zones.forEach((zone) => {
    console.log(`  ${zone.padEnd(10)} 1D ${String(rows.filter((row) => row.daily === zone).length).padStart(3)}   1W ${String(rows.filter((row) => row.weekly === zone).length).padStart(3)}`);
  });
}

main();
