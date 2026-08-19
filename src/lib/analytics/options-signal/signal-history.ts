import { OPTIONS_SIGNAL_CONFIG, OPTIONS_SIGNAL_CONFIG_VERSION } from './config';
import type { OptionsSignalOwnHistory } from './assemble';
import type { OptionsSignalInput, OptionsSignalResult } from './types';

/**
 * Every signal this product has computed, with the inputs that produced it.
 *
 * STORAGE ONLY. Nothing here scores, back-tests or ranks anything, and nothing
 * reads a record to change a current answer except the two percentile series
 * below, which are the same numbers this symbol has already published.
 *
 * The record keeps the WHOLE input, not a summary, because the point of a
 * history is to be able to ask a question of it that nobody had thought of when
 * the row was written — and a summary can only answer the questions its author
 * already had. `configVersion` rides along on every row, so a reading taken
 * under one set of thresholds can never be silently compared with one taken
 * under another.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STORE IS ASYNC AND WHY THERE ARE TWO OF THEM
 * ---------------------------------------------------------------------------
 * The durable store is the point of the feature: the IV and Put/Call percentiles
 * need sixty of a symbol's own readings, and an in-process buffer resets on
 * every deploy, so that window could never close and both bases were unreachable
 * code. The buffer survives as the FALLBACK — when the database cannot answer,
 * a page still gets whatever this instance has seen rather than nothing.
 *
 * The distinction that makes the fallback correct is `read` returning `null` for
 * "could not answer" and `[]` for "answered: nothing recorded". A new symbol has
 * no history and must not be treated as an outage.
 */

/** The light per-day row the percentiles are drawn from. */
export interface OptionsSignalHistoryPoint {
  /** Finalized-candle date, `YYYY-MM-DD`. */
  capturedAt: string;
  configVersion: string;
  iv: number | null;
  putCallOi: number | null;
  putCallVolume: number | null;
}

export interface OptionsSignalHistoryRecord extends OptionsSignalHistoryPoint {
  /** When the row was written. Distinct from the signal's own `asOf`. */
  recordedAt: string;
  symbol: string;
  /** The signal's published (oldest-source) timestamp. */
  asOf: string | null;
  latestCandleAt: string | null;
  calculatedAt: string;
  status: OptionsSignalResult['status'];
  signalType: OptionsSignalResult['signalType'];
  underlyingBias: OptionsSignalResult['underlyingBias'];
  /** The one published 0-100 direction score. */
  score: number | null;
  confidenceScore: number;
  coverage: number;
  agreement: number;
  evidenceStrength: number;
  staleMix: boolean;
  liquidityGrade: OptionsSignalResult['liquidityGrade'];
  /** The complete engine input, verbatim. */
  input: OptionsSignalInput;
}

export interface OptionsSignalHistoryStore {
  /**
   * Readings for one symbol, oldest first, at most one per captured date.
   *
   * `null` means the store could not answer — that is what makes the fallback
   * fire. An empty array means it answered, and the answer is "nothing yet".
   */
  read(symbol: string, lookbackDays: number): Promise<OptionsSignalHistoryPoint[] | null>;
  /** `false` when the write did not land, so a caller can fall back. */
  write(record: OptionsSignalHistoryRecord): Promise<boolean>;
}

const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Finalized-candle date for a record, which is the day a reading belongs to. */
export function capturedDateOf(result: OptionsSignalResult): string {
  return (result.latestCandleAt ?? result.asOf ?? result.calculatedAt).slice(0, 10);
}

/**
 * Reduce one computation to the row that would be written for it.
 *
 * Pure: the caller supplies `recordedAt` so a test can assert a whole record
 * without stubbing a clock.
 */
export function buildSignalHistoryRecord(
  input: OptionsSignalInput,
  result: OptionsSignalResult,
  recordedAt: string,
  configVersion: string = OPTIONS_SIGNAL_CONFIG_VERSION,
): OptionsSignalHistoryRecord {
  const pricing = input.pricing.status === 'available' ? input.pricing.value : null;
  const sentiment = input.sentiment.status === 'available' ? input.sentiment.value : null;
  return {
    configVersion,
    recordedAt,
    symbol: result.symbol,
    capturedAt: capturedDateOf(result),
    asOf: result.asOf,
    latestCandleAt: result.latestCandleAt,
    calculatedAt: result.calculatedAt,
    status: result.status,
    signalType: result.signalType,
    underlyingBias: result.underlyingBias,
    score: result.status === 'available' ? result.directionScore0to100 : null,
    confidenceScore: result.confidenceScore,
    coverage: result.diagnostics.coverage,
    agreement: result.diagnostics.agreement,
    evidenceStrength: result.diagnostics.evidenceStrength,
    staleMix: result.staleMix,
    liquidityGrade: result.liquidityGrade,
    iv: finite(pricing?.impliedVolatility),
    putCallOi: sentiment ? finite(sentiment.putCallRatio) : null,
    putCallVolume: sentiment ? finite(sentiment.volumeRatio) : null,
    input,
  };
}

/**
 * A bounded in-memory store.
 *
 * Bounded because an unbounded one in a long-lived server process is a leak;
 * `maximumRecords` is in the config with every other constant. Last write for a
 * captured date wins, on the same reasoning the durable store upserts: a reading
 * taken after the close is a more complete statement about that day than one
 * taken at lunchtime, and both are honest records of what the card said.
 */
export function createSignalHistoryLog(
  maximumRecords: number = OPTIONS_SIGNAL_CONFIG.history.maximumRecords,
): OptionsSignalHistoryStore & {
  all(): OptionsSignalHistoryRecord[];
  clear(): void;
} {
  const records: OptionsSignalHistoryRecord[] = [];
  return {
    async write(entry) {
      records.push(entry);
      if (records.length > maximumRecords) records.splice(0, records.length - maximumRecords);
      return true;
    },
    async read(symbol, lookbackDays) {
      const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
      const byDate = new Map<string, OptionsSignalHistoryRecord>();
      for (const entry of records) {
        if (entry.symbol !== symbol || entry.capturedAt < cutoff) continue;
        byDate.set(entry.capturedAt, entry);
      }
      return [...byDate.values()]
        .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
        .map(({ capturedAt, configVersion, iv, putCallOi, putCallVolume }) => ({
          capturedAt, configVersion, iv, putCallOi, putCallVolume,
        }));
    },
    all() {
      return [...records];
    },
    clear() {
      records.length = 0;
    },
  };
}

/** The process-wide fallback store. Injectable everywhere it is read, for tests. */
export const optionsSignalHistoryFallback = createSignalHistoryLog();

/**
 * Try the durable store, and fall back to the buffer only when it fails.
 *
 * Reads prefer the durable answer even when it is empty — a symbol with no rows
 * genuinely has no history, and quietly substituting this instance's own recent
 * views would make a percentile out of one afternoon. The fallback fires on
 * `null` (could not answer), never on `[]`.
 *
 * Writes go to BOTH when the durable one lands, so an instance that later loses
 * the database still has the readings it took itself.
 */
export function createResilientHistoryStore(
  durable: OptionsSignalHistoryStore,
  fallback: OptionsSignalHistoryStore = optionsSignalHistoryFallback,
): OptionsSignalHistoryStore {
  return {
    async read(symbol, lookbackDays) {
      const durableRows = await durable.read(symbol, lookbackDays).catch(() => null);
      if (durableRows !== null) return durableRows;
      return fallback.read(symbol, lookbackDays);
    },
    async write(record) {
      const landed = await durable.write(record).catch(() => false);
      await fallback.write(record).catch(() => false);
      return landed;
    },
  };
}

/**
 * One reading per captured date, newest last, as the two percentile series.
 *
 * Drops rows written under a different `configVersion` when asked to: a
 * percentile is a comparison, and comparing today's IV against readings the
 * previous model produced is a comparison of two different measurements wearing
 * the same name. The default keeps them, because the IV and Put/Call figures are
 * provider measurements rather than engine output and no threshold change moves
 * them — but the switch is here so a future change that does move them has one
 * line to flip rather than a migration to write.
 */
export async function readOwnHistory(
  symbol: string,
  store: OptionsSignalHistoryStore,
  options: { lookbackDays?: number; configVersion?: string } = {},
): Promise<OptionsSignalOwnHistory> {
  const lookbackDays = options.lookbackDays ?? OPTIONS_SIGNAL_CONFIG.history.readLookbackDays;
  const rows = (await store.read(symbol, lookbackDays).catch(() => null)) ?? [];
  const usable = options.configVersion === undefined
    ? rows
    : rows.filter((row) => row.configVersion === options.configVersion);
  return {
    atmIv: usable.flatMap((row) => (finite(row.iv) === null ? [] : [row.iv as number])),
    putCallRatio: usable.flatMap((row) => (finite(row.putCallOi) === null ? [] : [row.putCallOi as number])),
  };
}

/**
 * Whether the store can actually be read AND written, established by doing both.
 *
 * `ok: false` is the state the UI must show as an outage rather than as a
 * countdown; `reason` is what gets logged.
 */
export interface HistoryAccessHealth {
  ok: boolean;
  reason: string | null;
  checkedAt: string;
}

/**
 * Write one row and read it straight back.
 *
 * This exists because of a failure mode that looks exactly like success. The
 * table has RLS on with no policy, which is the entitlement boundary — but a
 * SELECT under a key that is not the service role does not error under
 * PostgREST, it returns an empty set. An empty set is ALSO the correct answer
 * for a symbol nobody has ever opened, so a read alone cannot tell a locked-out
 * store from a new symbol. Left undetected, a mistyped or rotated key would park
 * every symbol on "ต้องการข้อมูลอีก 60 วัน" permanently, counting down to
 * nothing, in perfect silence — the same broken outcome the durable store was
 * built to fix, from a different cause.
 *
 * A write followed by a read of the row just written has no such ambiguity.
 */
export async function checkHistoryAccess(
  store: OptionsSignalHistoryStore,
  options: { symbol?: string; now?: () => Date } = {},
): Promise<HistoryAccessHealth> {
  const now = (options.now ?? (() => new Date()))();
  const checkedAt = now.toISOString();
  const symbol = options.symbol ?? OPTIONS_SIGNAL_CONFIG.history.canarySymbol;
  const capturedAt = checkedAt.slice(0, 10);

  const probe: OptionsSignalHistoryRecord = {
    configVersion: OPTIONS_SIGNAL_CONFIG_VERSION,
    recordedAt: checkedAt,
    symbol,
    capturedAt,
    asOf: checkedAt,
    latestCandleAt: capturedAt,
    calculatedAt: checkedAt,
    status: 'insufficient-data',
    signalType: null,
    underlyingBias: null,
    score: null,
    confidenceScore: 0,
    coverage: 0,
    agreement: 0,
    evidenceStrength: 0,
    staleMix: false,
    liquidityGrade: null,
    iv: null,
    putCallOi: null,
    putCallVolume: null,
    input: null as unknown as OptionsSignalInput,
  };

  try {
    const written = await store.write(probe);
    if (!written) {
      return { ok: false, reason: 'history-write-rejected', checkedAt };
    }
    const rows = await store.read(symbol, 2);
    if (rows === null) {
      return { ok: false, reason: 'history-read-failed', checkedAt };
    }
    if (!rows.some((row) => row.capturedAt === capturedAt)) {
      // Wrote it, cannot see it. This is the RLS/wrong-key shape exactly.
      return { ok: false, reason: 'history-read-denied-silently', checkedAt };
    }
    return { ok: true, reason: null, checkedAt };
  } catch (error) {
    return { ok: false, reason: `history-probe-threw:${(error as Error).message.slice(0, 60)}`, checkedAt };
  }
}

/** Record one computation. Never throws: a history is never a reason to fail a page. */
export async function recordOptionsSignal(
  input: OptionsSignalInput,
  result: OptionsSignalResult,
  store: OptionsSignalHistoryStore,
  options: { now?: () => Date } = {},
): Promise<OptionsSignalHistoryRecord | null> {
  try {
    const entry = buildSignalHistoryRecord(
      input,
      result,
      (options.now ?? (() => new Date()))().toISOString(),
    );
    await store.write(entry);
    return entry;
  } catch {
    return null;
  }
}
