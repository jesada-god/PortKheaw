/**
 * Market Signal golden snapshot harness.
 *
 * This is the ONE check that guards the Market Signal v2 build. Every phase ends
 * by regenerating snapshots and reading the diff; nothing is verified by eye.
 *
 * The problem it has to solve is that a live signal is not reproducible: candles
 * arrive daily, `calculatedAt` is a clock read, and provider freshness moves on
 * its own. A golden file built straight from the network would differ from
 * itself an hour later, which makes "byte-identical" meaningless as a gate.
 *
 * So the snapshot is split in two, and only one half touches the network:
 *
 *   __golden__/candles/<SYMBOL>.json   FROZEN INPUT. The real OHLCV the real
 *                                      provider served, plus the source and
 *                                      freshness that came with it. Written only
 *                                      by `--refresh`, which is a deliberate,
 *                                      reviewable act.
 *   __golden__/signal/<SYMBOL>.json    OUTPUT. `calculateMarketSignal` replayed
 *                                      over that frozen input with a pinned
 *                                      `calculatedAt`. A pure function of the
 *                                      repo, so it is reproducible offline, in
 *                                      CI, and next month.
 *
 * Modes:
 *   (default)   replay the frozen candles and REWRITE the signal snapshots.
 *   --check     replay and compare; exit non-zero and print the diff on any
 *               mismatch. This is the pre-deploy gate.
 *   --refresh   re-fetch candles from the real providers and rewrite the frozen
 *               input, then replay. Changes the baseline on purpose.
 *   --symbols=A,B  narrow the run.
 *
 * Run: npm run snapshot:signal              (rewrite output snapshots)
 *      npm run snapshot:signal -- --check   (gate)
 *      npm run snapshot:signal -- --refresh (new frozen input from providers)
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { calendarDaysUntil } from '@/src/lib/analytics/earnings/normalize';
import { calculateMarketSignal } from '@/src/lib/analytics/market-signal/calculations';
import type { MarketSignalCandle } from '@/src/lib/analytics/market-signal/types';
import { SIGNAL_FLAG_KEYS, signalFlagState } from '@/src/config/signal-flags';
import type { DataFreshness } from '@/src/lib/market-data/types';

/** The instrument mix the brief pins: equity, index ETFs, a thin ETF, three futures, crypto. */
const DEFAULT_SYMBOLS = [
  'IREN', 'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD',
] as const;

/**
 * A fixed instant, not `new Date()`. `calculatedAt` is echoed into the result and
 * would otherwise make every snapshot differ from every other snapshot.
 */
const PINNED_CALCULATED_AT = '2026-01-01T00:00:00.000Z';

const ROOT = process.cwd();
const GOLDEN_DIR = join(ROOT, '__golden__');
const CANDLES_DIR = join(GOLDEN_DIR, 'candles');
const SIGNAL_DIR = join(GOLDEN_DIR, 'signal');
/** Where a flag-ON run writes, so it can never overwrite the flags-OFF baseline. */
const PREVIEW_DIR = join(GOLDEN_DIR, 'preview');

interface FrozenInput {
  symbol: string;
  capturedAt: string;
  source: string | null;
  freshness: DataFreshness;
  /*
   * The next report DATE, not a number of days.
   *
   * Frozen alongside the bars because P1's earnings rules would otherwise make a
   * replay depend on a live calendar and stop being reproducible. Storing the
   * date rather than "days from now" is what keeps it reproducible *tomorrow* as
   * well: days are derived against the capture's own last bar, so the same file
   * yields the same signal forever. `null` is a real answer here — most of these
   * symbols are ETFs and futures that never report — and it exercises the same
   * skip-silently path production takes when the calendar is down.
   */
  nextReportDate?: string | null;
  candles: MarketSignalCandle[];
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => args.find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;

const MODE = flag('check') ? 'check'
  : flag('refresh') ? 'refresh'
    : flag('refresh-earnings') ? 'refresh-earnings' : 'write';
const SYMBOLS = (option('symbols')?.split(',').map((value) => value.trim()).filter(Boolean)
  ?? [...DEFAULT_SYMBOLS]).map((value) => value.toUpperCase());

/**
 * Key-sorted JSON. Field ORDER in a result object is an accident of the code that
 * built it; a reordering is not a behaviour change and must not fail the gate,
 * while a value change must. Sorting keys makes the file express exactly that.
 */
function stableStringify(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
        .map((key) => [key, normalize((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

const candlePath = (symbol: string) => join(CANDLES_DIR, `${symbol}.json`);

async function fetchFrozenInput(symbol: string): Promise<FrozenInput> {
  // Imported lazily: the replay and gate paths must run with no provider module
  // loaded and no network reachable.
  const { getCandleMarketDataService } = await import('@/src/lib/market-data/candles');
  const { loadEarningsSchedule } = await import('@/src/lib/analytics/earnings/service');
  const result = await getCandleMarketDataService().getCandles({
    symbol,
    interval: '1D',
    range: '5y',
    adjusted: true,
    session: 'regular',
  });
  const schedule = await loadEarningsSchedule(symbol).catch(() => null);
  return {
    symbol,
    capturedAt: new Date().toISOString(),
    source: result.provider ?? result.data.provider,
    freshness: result.freshness,
    nextReportDate: schedule?.status === 'available' ? schedule.reportDate : null,
    candles: result.data.candles.map((candle) => ({
      date: new Date(candle.timestamp * 1_000).toISOString().slice(0, 10),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: Math.round(candle.volume),
      finalized: candle.partial !== true,
    })),
  };
}

/**
 * Days from the capture's newest finalized bar to its frozen report date.
 *
 * Measured against the bar rather than the wall clock, so replaying a capture
 * next month produces the same signal it produced today.
 */
function daysToReport(frozen: FrozenInput): number | null {
  if (!frozen.nextReportDate) return null;
  const lastBar = frozen.candles.filter((candle) => candle.finalized).at(-1)?.date;
  return lastBar ? calendarDaysUntil(lastBar, frozen.nextReportDate) : null;
}

function readFrozenInput(symbol: string): FrozenInput | null {
  const path = candlePath(symbol);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as FrozenInput;
}

/** First differing line, with a little context — enough to say what moved. */
function firstDifference(expected: string, actual: string): string {
  const left = expected.split('\n');
  const right = actual.split('\n');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    const from = Math.max(0, index - 3);
    return [
      ...left.slice(from, index).map((line) => `   ${line}`),
      `  -${left[index] ?? '<missing>'}`,
      `  +${right[index] ?? '<missing>'}`,
    ].join('\n');
  }
  return '  (files differ only in length)';
}

async function main(): Promise<void> {
  mkdirSync(CANDLES_DIR, { recursive: true });
  mkdirSync(SIGNAL_DIR, { recursive: true });

  const flags = signalFlagState();
  const flagsOn = SIGNAL_FLAG_KEYS.filter((key) => flags[key]);
  console.log(`mode: ${MODE}`);
  console.log(`signal flags: ${flagsOn.length ? flagsOn.join(', ') : 'all OFF'}`);
  if (MODE === 'check' && flagsOn.length) {
    console.error('\nGATE REFUSED: the pre-deploy gate compares against the flags-OFF baseline.');
    console.error(`Unset ${flagsOn.join(', ')} and run again.`);
    process.exitCode = 2;
    return;
  }
  /*
   * A flag-ON run writes somewhere else entirely. Being able to look at what a
   * phase does is necessary; being able to overwrite the flags-OFF baseline with
   * it, one careless environment variable at a time, is not.
   */
  const previewing = flagsOn.length > 0;
  const outputDir = previewing ? PREVIEW_DIR : SIGNAL_DIR;
  if (previewing) {
    mkdirSync(PREVIEW_DIR, { recursive: true });
    console.log('writing to __golden__/preview/ — the flags-OFF baseline in signal/ is left alone');
  }

  let failures = 0;
  let changed = 0;

  for (const symbol of SYMBOLS) {
    let frozen = readFrozenInput(symbol);
    if (MODE === 'refresh-earnings' && frozen) {
      // Only the calendar, never the bars. Adding earnings coverage to an
      // existing capture must not silently move the price history the reference
      // fixtures are pinned to.
      const { loadEarningsSchedule } = await import('@/src/lib/analytics/earnings/service');
      const schedule = await loadEarningsSchedule(symbol).catch(() => null);
      frozen = { ...frozen, nextReportDate: schedule?.status === 'available' ? schedule.reportDate : null };
      writeFileSync(candlePath(symbol), stableStringify(frozen), 'utf8');
      console.log(`${symbol.padEnd(8)} earnings ${frozen.nextReportDate ?? 'none scheduled'}${frozen.nextReportDate ? ` · ${daysToReport(frozen)} วันจากแท่งล่าสุด` : ''}`);
    }
    if (MODE === 'refresh' || !frozen) {
      if (MODE === 'check') {
        console.error(`${symbol.padEnd(8)} MISSING frozen input — run --refresh first`);
        failures += 1;
        continue;
      }
      try {
        frozen = await fetchFrozenInput(symbol);
        writeFileSync(candlePath(symbol), stableStringify(frozen), 'utf8');
      } catch (cause) {
        console.error(`${symbol.padEnd(8)} FETCH FAILED · ${cause instanceof Error ? cause.message : String(cause)}`);
        failures += 1;
        continue;
      }
    }

    const result = calculateMarketSignal(frozen.candles, {
      symbol: frozen.symbol,
      source: frozen.source,
      freshness: frozen.freshness,
      calculatedAt: PINNED_CALCULATED_AT,
      features: { gate: flags.SIGNAL_GATE, zones: flags.SIGNAL_ZONES },
      earnings: { daysToNextReport: daysToReport(frozen) },
    });
    const serialized = stableStringify(result);
    const path = join(outputDir, `${symbol}.json`);
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;

    if (MODE === 'check') {
      if (previous === null) {
        console.error(`${symbol.padEnd(8)} MISSING golden signal snapshot`);
        failures += 1;
      } else if (previous !== serialized) {
        console.error(`${symbol.padEnd(8)} DIFF\n${firstDifference(previous, serialized)}`);
        failures += 1;
      } else {
        console.log(`${symbol.padEnd(8)} ok · ${result.status} · ${result.state ?? '—'} · score ${result.score ?? '—'} · conf ${result.confidence}`);
      }
      continue;
    }

    if (previous !== serialized) changed += 1;
    writeFileSync(path, serialized, 'utf8');
    console.log(`${symbol.padEnd(8)} ${previous === null ? 'new ' : previous === serialized ? 'same' : 'CHANGED'} · ${result.status} · ${result.state ?? '—'} · score ${result.score ?? '—'} · conf ${result.confidence} · bars ${result.dataPoints.finalized}/${result.dataPoints.received}`);
  }

  const stale = existsSync(SIGNAL_DIR)
    ? readdirSync(SIGNAL_DIR).map((name) => name.replace(/\.json$/, '')).filter((name) => !SYMBOLS.includes(name))
    : [];
  if (stale.length && !option('symbols')) console.log(`\nsnapshots not covered by this run: ${stale.join(', ')}`);

  if (MODE === 'check') {
    console.log(`\n${failures ? `GATE FAILED · ${failures} symbol(s) differ` : `GATE PASSED · ${SYMBOLS.length} symbol(s) byte-identical`}`);
    process.exitCode = failures ? 1 : 0;
    return;
  }
  console.log(`\n${changed} snapshot(s) changed${failures ? ` · ${failures} failure(s)` : ''}`);
  process.exitCode = failures ? 1 : 0;
}

void main();
