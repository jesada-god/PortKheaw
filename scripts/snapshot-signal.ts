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
import type { MarketSignalCandle, MarketSignalFeatures } from '@/src/lib/analytics/market-signal/types';
import { SIGNAL_FLAG_KEYS, signalFlagState, type SignalFlagKey } from '@/src/config/signal-flags';
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

/**
 * WHICH FLAGS REACH THE ENGINE, in one place, because two things read it.
 *
 * `calculateMarketSignal` takes a `MarketSignalFeatures`, and this maps each of
 * its three members onto the environment variable that turns it on. The call
 * below builds its `features` from this table and the directory name is built
 * from the same table, so the two cannot disagree: wiring a fourth phase into
 * the engine means adding one line here, and the snapshot directory starts
 * naming it in the same commit.
 *
 * WHAT IS DELIBERATELY ABSENT. `SIGNAL_HISTORY` and `SIGNAL_CONTEXT` are real
 * rollout switches and neither one is a member of `MarketSignalFeatures` — no
 * value of either changes a single byte this harness writes. P6 in particular
 * cannot: `history` is not engine output at all, it is attached afterwards in
 * `src/lib/analytics/market-signal/service.ts` from a Supabase read, and this
 * harness reaches no network by design. A directory named for those flags was
 * therefore a byte-identical copy of the one next to it, wearing a name that
 * announced coverage it did not have. See `__golden__/README.md`.
 */
const ENGINE_FEATURE_OF = {
  SIGNAL_GATE: 'gate',
  SIGNAL_ZONES: 'zones',
  SIGNAL_ACTIONABLE: 'actionable',
} as const satisfies Record<string, keyof MarketSignalFeatures>;

type EngineFlagKey = keyof typeof ENGINE_FEATURE_OF;
const ENGINE_FLAG_KEYS = Object.keys(ENGINE_FEATURE_OF) as readonly EngineFlagKey[];

function engineFeatures(flags: Record<SignalFlagKey, boolean>): MarketSignalFeatures {
  return Object.fromEntries(
    ENGINE_FLAG_KEYS.map((key) => [ENGINE_FEATURE_OF[key], flags[key]]),
  ) as unknown as MarketSignalFeatures;
}

/**
 * One directory per flag COMBINATION, not one directory for "some flag is on".
 *
 * The rollout turns these on one at a time, so production passes through states
 * nobody has a reference for - GATE alone, then GATE+ZONES - before it reaches
 * the combination the preview was captured at. A single flat `preview/` cannot
 * hold those: the second combination's run overwrites the first one's files, and
 * the overwrite is silent because both are legitimate flag-ON output. What looked
 * like a preview of the rollout was only ever a preview of its last step.
 *
 * `gate-only` rather than `gate` because the name has to say what is OFF as well
 * as what is on; a directory called `gate` read six months from now is a question
 * rather than an answer.
 *
 * It is fed the ENGINE flags only, so the name lists exactly the switches that
 * moved the bytes inside. `engine-flags-off` is the degenerate case — every
 * engine flag off while some other switch is on. WRITING that run resolves here,
 * to a directory of its own rather than to the baseline's, because a write that
 * resolved to `signal/` would let one stray variable redefine the pre-deploy
 * baseline, which is the exact accident `preview/` exists to prevent. CHECKING
 * it does not need this name at all: see `main`, which compares it against
 * `signal/` — the bytes it reproduces — rather than against a copy of them.
 */
function previewSlug(flagsOn: readonly string[]): string {
  const parts = flagsOn.map((key) => key.replace(/^SIGNAL_/, '').toLowerCase());
  if (parts.length === 0) return 'engine-flags-off';
  return parts.length === 1 ? `${parts[0]}-only` : parts.join('-');
}

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
  const engineFlagsOn = ENGINE_FLAG_KEYS.filter((key) => flags[key]);
  const slug = previewSlug(engineFlagsOn);
  console.log(`mode: ${MODE}`);
  console.log(`signal flags: ${flagsOn.length ? flagsOn.join(', ') : 'all OFF'}`);
  /*
   * Said out loud, because a reader who set a variable and saw no directory
   * named after it deserves the reason rather than a search through this file.
   */
  const inertFlags = flagsOn.filter((key) => !(ENGINE_FLAG_KEYS as readonly string[]).includes(key));
  if (inertFlags.length) {
    console.log(`${inertFlags.join(', ')}: never reaches the engine, changes no byte here — left out of the snapshot name`);
  }
  /*
   * A flag-ON run writes somewhere else entirely. Being able to look at what a
   * phase does is necessary; being able to overwrite the flags-OFF baseline with
   * it, one careless environment variable at a time, is not.
   *
   * A flag-ON --check is allowed, and compares against that combination's own
   * directory. It is NOT the pre-deploy gate and does not claim to be: the gate
   * is the flags-OFF run, because flags-OFF is what production is. This is the
   * check that answers a different question - "did turning this one flag on do
   * what it did last time?" - which is the only question worth asking at each
   * step of a rollout that moves one flag at a time.
   */
  /*
   * ANY flag decides whether this is a preview; only the ENGINE flags decide
   * what the directory is called. The two were being answered by one expression:
   * a run with `SIGNAL_HISTORY` alone must still be kept away from `signal/` —
   * it is not a flags-OFF run and must not be able to rewrite the baseline —
   * while the bytes it produces ARE the baseline's, so naming its directory
   * after P6 claimed a difference that is not in there.
   *
   * WHICH LEAVES ONE CASE WITH NOWHERE TO LOOK: an inert flag on, every engine
   * flag off. Writing must still be diverted, but a CHECK has a perfectly good
   * reference already — `signal/`, which is what this run reproduces byte for
   * byte. Comparing against it is the honest answer and it is a stronger check
   * than a third copy of the same ten files would be: it asserts that the inert
   * flag really is inert. Only the label has to stay careful, because passing
   * here is not the pre-deploy gate passing.
   */
  const previewing = flagsOn.length > 0;
  const engineOff = engineFlagsOn.length === 0;
  const checkingAgainstBaseline = previewing && engineOff && MODE === 'check';
  const outputDir = previewing && !checkingAgainstBaseline ? join(PREVIEW_DIR, slug) : SIGNAL_DIR;
  if (checkingAgainstBaseline) {
    console.log('no engine flag is on, so this run reproduces the baseline — comparing against __golden__/signal/');
    console.log('NOT the pre-deploy gate; the gate is the run with every SIGNAL_* flag unset');
  } else if (previewing) {
    mkdirSync(outputDir, { recursive: true });
    console.log(`${MODE === 'check' ? 'comparing against' : 'writing to'} __golden__/preview/${slug}/`);
    if (MODE === 'check') console.log('PREVIEW check, not the pre-deploy gate; the gate is the flags-OFF run');
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
      features: engineFeatures(flags),
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
    const label = previewing ? `PREVIEW ${slug}` : 'GATE';
    console.log(`\n${failures ? `${label} FAILED · ${failures} symbol(s) differ` : `${label} PASSED · ${SYMBOLS.length} symbol(s) byte-identical`}`);
    process.exitCode = failures ? 1 : 0;
    return;
  }
  console.log(`\n${changed} snapshot(s) changed${failures ? ` · ${failures} failure(s)` : ''}`);
  process.exitCode = failures ? 1 : 0;
}

void main();
