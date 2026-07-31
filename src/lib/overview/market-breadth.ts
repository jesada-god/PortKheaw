import 'server-only';

import { z } from 'zod';
import { serverEnv } from '@/src/config/env/server';
import { canonicalRegularTradingDateAt } from '@/src/lib/market-data/current-session';
import { exchangeSessionDate, US_EQUITY_TIMEZONE } from '@/src/lib/market-data/session';
import { getMarketBreadthInstrumentUniverse } from '@/src/lib/instruments/master';
import type { InstrumentMetadata, MarketBreadth } from './types';
import { LastGoodSnapshotCoordinator } from './industry-snapshot';
import { MARKET_BREADTH_UNIVERSE_DESCRIPTION } from './market-breadth-universe';

const ALPACA_SNAPSHOTS_URL = 'https://data.alpaca.markets/v2/stocks/snapshots';
const BATCH_SIZE = 200;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 12_000;
const DEADLINE_MS = 25_000;
const MIN_USABLE_BREADTH = 800;

const barSchema = z.object({
  c: z.number().finite().positive(),
  t: z.string().datetime({ offset: true }),
}).passthrough();

const snapshotSchema = z.object({
  dailyBar: barSchema.nullish(),
  prevDailyBar: barSchema.nullish(),
}).passthrough();

const responseSchema = z.record(z.string(), snapshotSchema);

export type AlpacaStockSnapshot = z.infer<typeof snapshotSchema>;

export interface AlpacaBreadthBatchResult {
  snapshots: Map<string, AlpacaStockSnapshot>;
  failedSymbols: Set<string>;
  requestCount: number;
  durationMs: number;
}

interface BatchOptions {
  keyId: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  concurrency?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  maxAttempts?: number;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

async function fetchChunk(
  symbols: readonly string[],
  options: Required<Pick<BatchOptions, 'keyId' | 'secretKey' | 'fetchImpl' | 'timeoutMs' | 'maxAttempts'>>,
  deadlineAt: number,
): Promise<Record<string, AlpacaStockSnapshot>> {
  const url = new URL(ALPACA_SNAPSHOTS_URL);
  url.searchParams.set('feed', 'delayed_sip');
  url.searchParams.set('symbols', symbols.join(','));

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error('market breadth deadline reached');
    try {
      const response = await options.fetchImpl(url, {
        headers: {
          'APCA-API-KEY-ID': options.keyId,
          'APCA-API-SECRET-KEY': options.secretKey,
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(options.timeoutMs, remainingMs)),
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === options.maxAttempts) {
          throw new Error(`Alpaca breadth snapshot returned HTTP ${response.status}`);
        }
      } else {
        return responseSchema.parse(await response.json());
      }
    } catch (error) {
      if (attempt === options.maxAttempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw new Error('Alpaca breadth snapshot exhausted retries');
}

/**
 * One bounded multi-symbol collection. At 4,285 catalogue symbols this produces
 * 22 requests, never 4,285 individual requests.
 */
export async function loadAlpacaBreadthSnapshots(
  symbols: readonly string[],
  options: BatchOptions,
): Promise<AlpacaBreadthBatchResult> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + (options.deadlineMs ?? DEADLINE_MS);
  const batches = chunks([...new Set(symbols.map((symbol) => symbol.toUpperCase()))], options.batchSize ?? BATCH_SIZE);
  const snapshots = new Map<string, AlpacaStockSnapshot>();
  const failedSymbols = new Set<string>();
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = Math.min(Math.max(1, options.concurrency ?? CONCURRENCY), Math.max(1, batches.length));
  const requestOptions = {
    keyId: options.keyId,
    secretKey: options.secretKey,
    fetchImpl,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? 2,
  };
  let cursor = 0;
  let requestCount = 0;

  const worker = async () => {
    while (cursor < batches.length && Date.now() < deadlineAt) {
      const batch = batches[cursor++]!;
      requestCount += 1;
      try {
        const values = await fetchChunk(batch, requestOptions, deadlineAt);
        for (const [symbol, snapshot] of Object.entries(values)) {
          snapshots.set(symbol.toUpperCase(), snapshot);
        }
        for (const symbol of batch) {
          if (!snapshots.has(symbol)) failedSymbols.add(symbol);
        }
      } catch {
        batch.forEach((symbol) => failedSymbols.add(symbol));
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  while (cursor < batches.length) {
    batches[cursor++]!.forEach((symbol) => failedSymbols.add(symbol));
  }
  return {
    snapshots,
    failedSymbols,
    requestCount,
    durationMs: Date.now() - startedAt,
  };
}

export function calculateBatchMarketBreadth(input: {
  universe: readonly InstrumentMetadata[];
  snapshots: ReadonlyMap<string, AlpacaStockSnapshot>;
  failedSymbols?: ReadonlySet<string>;
  expectedTradingDate: string;
  evaluatedAt: string;
  durationMs: number;
}): MarketBreadth {
  let advancing = 0;
  let declining = 0;
  let unchanged = 0;
  let staleCount = 0;
  let failedCount = 0;
  const usableTimestamps: string[] = [];

  for (const instrument of input.universe) {
    const snapshot = input.snapshots.get(instrument.symbol);
    const daily = snapshot?.dailyBar;
    const previous = snapshot?.prevDailyBar;
    if (!daily || !previous || input.failedSymbols?.has(instrument.symbol)) {
      failedCount += 1;
      continue;
    }
    const tradingDate = exchangeSessionDate(daily.t, US_EQUITY_TIMEZONE);
    const previousDate = exchangeSessionDate(previous.t, US_EQUITY_TIMEZONE);
    if (tradingDate !== input.expectedTradingDate) {
      staleCount += 1;
      continue;
    }
    if (!previousDate || previousDate >= tradingDate) {
      failedCount += 1;
      continue;
    }
    if (daily.c > previous.c) advancing += 1;
    else if (daily.c < previous.c) declining += 1;
    else unchanged += 1;
    usableTimestamps.push(daily.t);
  }

  const validCount = advancing + declining + unchanged;
  return {
    advancing,
    declining,
    unchanged,
    validCount,
    universeCount: input.universe.length,
    returnedCount: input.snapshots.size,
    failedCount,
    staleCount,
    upDownRatio: declining > 0 ? advancing / declining : null,
    breadthPercent: validCount ? advancing / validCount * 100 : 0,
    coveragePercent: input.universe.length ? validCount / input.universe.length * 100 : 0,
    aboveEma20Percent: null,
    updatedAt: usableTimestamps.sort().at(-1) ?? null,
    evaluatedAt: input.evaluatedAt,
    durationMs: input.durationMs,
    tradingDate: input.expectedTradingDate,
    session: 'regular',
    source: 'alpaca-multi-snapshot',
    feed: 'delayed_sip',
    status: validCount >= MIN_USABLE_BREADTH ? 'ready' : 'partial',
    universeDescription: MARKET_BREADTH_UNIVERSE_DESCRIPTION,
  };
}

const breadthSnapshots = new LastGoodSnapshotCoordinator<MarketBreadth>({
  freshMs: 2 * 60_000,
  staleMs: 15 * 60_000,
});

function snapshotKey(now: Date): string {
  return `regular:${canonicalRegularTradingDateAt(now)
    ?? exchangeSessionDate(now.toISOString(), US_EQUITY_TIMEZONE)
    ?? 'unknown'}`;
}

async function calculateMarketBreadthSnapshot(now: Date): Promise<MarketBreadth> {
  if (!serverEnv.ALPACA_API_KEY_ID || !serverEnv.ALPACA_API_SECRET_KEY) {
    throw new Error('Alpaca batch snapshot credentials are not configured');
  }
  const expectedTradingDate = canonicalRegularTradingDateAt(now);
  if (!expectedTradingDate) throw new Error('No canonical regular trading date');
  const universe = await getMarketBreadthInstrumentUniverse();
  const result = await loadAlpacaBreadthSnapshots(
    universe.map((instrument) => instrument.symbol),
    {
      keyId: serverEnv.ALPACA_API_KEY_ID,
      secretKey: serverEnv.ALPACA_API_SECRET_KEY,
    },
  );
  const breadth = calculateBatchMarketBreadth({
    universe,
    snapshots: result.snapshots,
    failedSymbols: result.failedSymbols,
    expectedTradingDate,
    evaluatedAt: new Date().toISOString(),
    durationMs: result.durationMs,
  });
  if (breadth.validCount === 0) throw new Error('Market breadth batch contained no usable regular-session prices');
  console.info('[overview-breadth]', JSON.stringify({
    durationMs: breadth.durationMs,
    universeCount: breadth.universeCount,
    usableCount: breadth.validCount,
    failedCount: breadth.failedCount,
    staleCount: breadth.staleCount,
    requestCount: result.requestCount,
  }));
  return breadth;
}

export function loadMarketBreadthSnapshot(now = new Date()): MarketBreadth | null {
  const current = breadthSnapshots.read(snapshotKey(now));
  if (!current.value) return null;
  return current.state === 'refreshing'
    ? { ...current.value, status: 'stale' }
    : current.value;
}

export function warmMarketBreadth(now = new Date()): Promise<MarketBreadth | null> {
  return breadthSnapshots.refresh(
    snapshotKey(now),
    () => calculateMarketBreadthSnapshot(now),
    (value) => value.validCount > 0,
  );
}

export async function loadMarketBreadth(now = new Date(), force = false): Promise<MarketBreadth | null> {
  const current = loadMarketBreadthSnapshot(now);
  if (!force && current?.status === 'ready') return current;
  await warmMarketBreadth(now);
  return loadMarketBreadthSnapshot(now);
}
