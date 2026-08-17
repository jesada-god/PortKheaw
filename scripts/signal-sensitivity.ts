/**
 * Market Signal calibration measurements over a wide instrument corpus.
 *
 * Ten golden symbols are enough to prove a rule fires; they are nowhere near
 * enough to say a threshold is safe or that a confidence formula is balanced.
 * This script builds a ~110-instrument corpus of real daily bars and answers
 * the two questions that decide whether P1's numbers can stand:
 *
 *   --sensitivity  How many labels move as the conflict magnitude threshold
 *                  sweeps 0.10 -> 0.30. A threshold sitting on a cliff is not a
 *                  threshold, it is a coin toss.
 *   --confidence   What the multiplicative confidence formula does to the whole
 *                  distribution, split by whether the label changed, plus the
 *                  median of every individual multiplier so the term doing the
 *                  most damage is named rather than guessed at.
 *
 * The corpus is cached under `__golden__/corpus/` and is NOT a gate: it is
 * measurement input, refreshed with `--refresh` whenever it needs to move.
 * Nothing here is compared byte-for-byte and nothing here feeds a test.
 *
 * Run: npm run signal:sensitivity -- --sensitivity --confidence
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { MARKET_SIGNAL_GATE } from '@/src/config/signal';
import { calculateMarketSignal } from '@/src/lib/analytics/market-signal/calculations';
import type { MarketSignalCandle, MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import type { DataFreshness } from '@/src/lib/market-data/types';

/** Liquid US instruments across every asset class the product actually serves. */
const CORPUS = [
  // Mega/large-cap equities
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'LLY', 'JPM',
  'V', 'UNH', 'XOM', 'MA', 'JNJ', 'PG', 'COST', 'HD', 'ABBV', 'MRK',
  'WMT', 'PEP', 'KO', 'ORCL', 'CVX', 'BAC', 'ADBE', 'CRM', 'AMD', 'NFLX',
  'TMO', 'ACN', 'MCD', 'LIN', 'CSCO', 'ABT', 'DHR', 'WFC', 'TXN', 'VZ',
  'PM', 'NEE', 'DIS', 'INTU', 'CAT', 'AMGN', 'IBM', 'GE', 'UNP', 'CMCSA',
  'COP', 'PFE', 'NOW', 'SPGI', 'RTX', 'HON', 'UPS', 'BA', 'SBUX', 'GS',
  // Higher-beta and speculative names — where a shaky threshold shows itself
  'ISRG', 'PLTR', 'MU', 'LRCX', 'ADI', 'PANW', 'SNOW', 'SHOP', 'UBER', 'ABNB',
  'COIN', 'RIVN', 'F', 'GM', 'DAL', 'AAL', 'CCL', 'NCLH', 'RKLB', 'IONQ',
  'SOFI', 'IREN', 'MARA', 'RIOT', 'AFRM',
  // ETFs, including the thin one
  'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'XLF', 'XLE', 'XLK', 'XLV', 'XLI',
  'SMH', 'ARKK', 'EEM', 'TLT', 'GLD', 'SLV', 'USO',
  // Commodity contracts sold at Pro
  'GC-F', 'SI-F', 'CL-F', 'NG-F', 'HG-F', 'ZC-F',
  // 24-hour crypto
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD',
];

const THRESHOLDS = [0.1, 0.15, 0.2, 0.25, 0.3];
const PINNED_CALCULATED_AT = '2026-01-01T00:00:00.000Z';
const CORPUS_DIR = join(process.cwd(), '__golden__', 'corpus');

interface Frozen {
  symbol: string;
  source: string | null;
  freshness: DataFreshness;
  nextReportDate?: string | null;
  candles: MarketSignalCandle[];
}

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);

async function ensureCorpus(): Promise<Frozen[]> {
  mkdirSync(CORPUS_DIR, { recursive: true });
  const loaded: Frozen[] = [];
  let fetched = 0;
  for (const symbol of CORPUS) {
    const path = join(CORPUS_DIR, `${symbol}.json`);
    if (existsSync(path) && !has('refresh')) {
      loaded.push(JSON.parse(readFileSync(path, 'utf8')) as Frozen);
      continue;
    }
    try {
      const { getCandleMarketDataService } = await import('@/src/lib/market-data/candles');
      const result = await getCandleMarketDataService().getCandles({
        symbol, interval: '1D', range: '5y', adjusted: true, session: 'regular',
      });
      const frozen: Frozen = {
        symbol,
        source: result.provider ?? result.data.provider,
        freshness: result.freshness,
        candles: result.data.candles.map((candle) => ({
          date: new Date(candle.timestamp * 1_000).toISOString().slice(0, 10),
          open: candle.open, high: candle.high, low: candle.low, close: candle.close,
          volume: Math.round(candle.volume), finalized: candle.partial !== true,
        })),
      };
      writeFileSync(path, `${JSON.stringify(frozen, null, 2)}\n`, 'utf8');
      loaded.push(frozen);
      fetched += 1;
    } catch (cause) {
      console.error(`  skipped ${symbol}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  console.error(`corpus: ${loaded.length} instruments (${fetched} newly fetched)`);
  return loaded;
}

const run = (frozen: Frozen, gate: boolean): MarketSignalResult => calculateMarketSignal(frozen.candles, {
  symbol: frozen.symbol,
  source: frozen.source,
  freshness: frozen.freshness,
  calculatedAt: PINNED_CALCULATED_AT,
  features: { gate },
});

const quantile = (sorted: readonly number[], fraction: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];

function describe(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted.at(-1) ?? 0,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : 0,
  };
}

function histogram(values: readonly number[]): string {
  const buckets = Array<number>(10).fill(0);
  values.forEach((value) => { buckets[Math.min(9, Math.floor(value / 10))] += 1; });
  return buckets.map((count, index) => `${String(index * 10).padStart(3)}-${String(index * 10 + 9).padStart(3)} ${'#'.repeat(count).padEnd(40)} ${count}`).join('\n');
}

async function main(): Promise<void> {
  const corpus = (await ensureCorpus()).filter((frozen) => run(frozen, false).status === 'available');
  console.log(`\ninstruments with an available signal: ${corpus.length}`);

  const baseline = new Map(corpus.map((frozen) => [frozen.symbol, run(frozen, false)]));

  if (has('sensitivity')) {
    console.log('\n=== conflict magnitude sensitivity ===');
    console.log('threshold | labels changed vs flags-OFF | forced neutral by conflict | conflicts detected');
    console.log('----------|-----------------------------|----------------------------|-------------------');
    const perThreshold = new Map<number, Set<string>>();
    for (const threshold of THRESHOLDS) {
      /*
       * The engine reads this constant directly, and measuring anything other
       * than the real code path would measure a copy of the rule rather than the
       * rule. `as const` is a compile-time assertion, not a runtime freeze, so
       * the override is safe here and confined to this script.
       */
      (MARKET_SIGNAL_GATE as { conflictMinimumMagnitude: number }).conflictMinimumMagnitude = threshold;
      const changed = new Set<string>();
      let forcedNeutral = 0;
      let withConflicts = 0;
      corpus.forEach((frozen) => {
        const gated = run(frozen, true);
        if (gated.state !== baseline.get(frozen.symbol)!.state) changed.add(frozen.symbol);
        if (gated.gate?.forcedNeutral) forcedNeutral += 1;
        if (gated.gate?.conflicts.length) withConflicts += 1;
      });
      perThreshold.set(threshold, changed);
      console.log(`${threshold.toFixed(2).padStart(9)} | ${String(changed.size).padStart(27)} | ${String(forcedNeutral).padStart(26)} | ${String(withConflicts).padStart(18)}`);
    }
    console.log('\nstep-to-step movement (how many symbols flip label between adjacent thresholds):');
    for (let index = 1; index < THRESHOLDS.length; index += 1) {
      const previous = perThreshold.get(THRESHOLDS[index - 1])!;
      const current = perThreshold.get(THRESHOLDS[index])!;
      const moved = [...new Set([...previous, ...current])].filter((symbol) => previous.has(symbol) !== current.has(symbol));
      console.log(`  ${THRESHOLDS[index - 1].toFixed(2)} -> ${THRESHOLDS[index].toFixed(2)}: ${moved.length}${moved.length && moved.length <= 8 ? ` (${moved.join(', ')})` : ''}`);
    }
    (MARKET_SIGNAL_GATE as { conflictMinimumMagnitude: number }).conflictMinimumMagnitude = 0.2;
  }

  if (has('confidence')) {
    (MARKET_SIGNAL_GATE as { conflictMinimumMagnitude: number }).conflictMinimumMagnitude = 0.2;
    const rows = corpus.map((frozen) => {
      const off = baseline.get(frozen.symbol)!;
      const on = run(frozen, true);
      return { symbol: frozen.symbol, off, on, sameLabel: off.state === on.state };
    });

    const line = (label: string, stats: ReturnType<typeof describe>) =>
      `${label.padEnd(28)} n=${String(stats.n).padStart(3)}  min ${String(stats.min).padStart(3)}  p25 ${String(stats.p25).padStart(3)}  median ${String(stats.median).padStart(3)}  p75 ${String(stats.p75).padStart(3)}  max ${String(stats.max).padStart(3)}  mean ${stats.mean.toFixed(1)}`;

    console.log('\n=== confidence distribution ===');
    console.log(line('flags OFF (all)', describe(rows.map((row) => row.off.confidence))));
    console.log(line('SIGNAL_GATE ON (all)', describe(rows.map((row) => row.on.confidence))));
    const unchanged = rows.filter((row) => row.sameLabel);
    const changed = rows.filter((row) => !row.sameLabel);
    console.log(line('  label unchanged, OFF', describe(unchanged.map((row) => row.off.confidence))));
    console.log(line('  label unchanged, ON', describe(unchanged.map((row) => row.on.confidence))));
    console.log(line('  label changed, OFF', describe(changed.map((row) => row.off.confidence))));
    console.log(line('  label changed, ON', describe(changed.map((row) => row.on.confidence))));

    console.log('\nflags OFF histogram:');
    console.log(histogram(rows.map((row) => row.off.confidence)));
    console.log('\nSIGNAL_GATE ON histogram:');
    console.log(histogram(rows.map((row) => row.on.confidence)));

    console.log('\n=== which multiplier does the damage (median across the corpus) ===');
    const factorOf = (key: keyof NonNullable<MarketSignalResult['gate']>['confidenceFactors']) =>
      describe(rows.flatMap((row) => row.on.gate ? [row.on.gate.confidenceFactors[key]] : []));
    (['base', 'completeness', 'agreement', 'regimeClarity', 'conflict', 'earnings'] as const).forEach((key) => {
      const stats = factorOf(key);
      console.log(`${key.padEnd(16)} min ${stats.min.toFixed(3)}  p25 ${stats.p25.toFixed(3)}  median ${stats.median.toFixed(3)}  p75 ${stats.p75.toFixed(3)}  max ${stats.max.toFixed(3)}`);
    });

    console.log('\n=== the six symbols the P1 report named as label-unchanged ===');
    ['SPY', 'QQQ', 'DIA', 'IWM', 'GC-F', 'SI-F'].forEach((symbol) => {
      const row = rows.find((item) => item.symbol === symbol);
      if (!row) return;
      console.log(`${symbol.padEnd(8)} ${row.off.state} ${String(row.off.confidence).padStart(3)}% -> ${row.on.state} ${String(row.on.confidence).padStart(3)}%  (${row.sameLabel ? 'same label' : 'LABEL CHANGED'})`);
    });
  }
}

void main();
