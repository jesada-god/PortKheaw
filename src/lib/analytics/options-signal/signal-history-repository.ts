import 'server-only';

import { createAdminClient } from '@/src/lib/supabase/admin';
import { OPTIONS_SIGNAL_CONFIG } from './config';
import {
  checkHistoryAccess,
  createResilientHistoryStore,
  describeHistoryFailure,
  optionsSignalHistoryFallback,
  type HistoryAccessHealth,
  type HistoryStoreFailure,
  type OptionsSignalHistoryPoint,
  type OptionsSignalHistoryRecord,
  type OptionsSignalHistoryStore,
} from './signal-history';

/**
 * Durable storage for the Options Signal history. Service-role only, and soft
 * about every failure — soft, but no longer silent.
 *
 * Every failure is also KEPT, in the database's own words, and read back by the
 * health canary. The version of this file that only returned `false` reported a
 * `not null` violation on `inputs` as the same "store unreachable" a missing
 * service key produces, and the card said "อ่านประวัติไม่สำเร็จ" for a store
 * that was answering reads perfectly well.
 *
 * `public.options_signal_history` has RLS on with no policy, so nothing reaches
 * a browser from here: the entitlement that decides who may see any of this
 * lives in the route, one layer up, where it is tested.
 *
 * EVERY function here fails soft, and the two failure shapes are deliberately
 * different:
 *
 *   * `read` returns `null` when it could not answer — a missing service key, a
 *     network blip, a table that has not been migrated yet — and an ARRAY when
 *     it did, even an empty one. Only `null` triggers the in-memory fallback,
 *     because a symbol nobody has opened before genuinely has no history and
 *     substituting this instance's own recent views would build a "sixty-day
 *     percentile" out of one afternoon.
 *   * `write` returns `false` rather than throwing. A history that failed to
 *     record is not a reason to fail a page.
 */

const TABLE = 'options_signal_history';

/** `YYYY-MM-DD`, `lookbackDays` before now. */
function cutoffDate(lookbackDays: number): string {
  return new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Rows come back as loose SQL types, which the type system cannot narrow on its
 * own. A row whose captured date or config version is missing is DROPPED rather
 * than defaulted: an undated reading cannot take its place in a series, and a
 * reading that cannot say which model wrote it is one nothing may compare.
 */
function toPoint(row: {
  captured_at: string | null;
  config_version: string | null;
  iv: number | null;
  put_call_oi: number | null;
  put_call_volume: number | null;
}): OptionsSignalHistoryPoint | null {
  if (!row.captured_at || !row.config_version) return null;
  const usable = (value: number | null) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    capturedAt: row.captured_at.slice(0, 10),
    configVersion: row.config_version,
    iv: usable(row.iv),
    putCallOi: usable(row.put_call_oi),
    putCallVolume: usable(row.put_call_volume),
  };
}

/**
 * The `inputs` column, as a value PostgREST may send.
 *
 * `inputs` is `jsonb not null` with a default, and a default only applies to a
 * column that is OMITTED — sending an explicit null violates the constraint
 * instead. The health canary writes a record with no engine input at all, so
 * the null it would otherwise send is turned into an empty object here, at the
 * one place that knows the column's shape.
 */
function inputsColumn(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  const serialized: unknown = JSON.parse(JSON.stringify(input));
  return serialized !== null && typeof serialized === 'object' && !Array.isArray(serialized)
    ? serialized as Record<string, unknown>
    : { value: serialized };
}

/** A PostgREST error reduced to the four fields worth keeping. */
function toFailure(
  operation: HistoryStoreFailure['operation'],
  error: { code?: string | null; message?: string | null; hint?: string | null; details?: string | null } | null,
): HistoryStoreFailure {
  return {
    operation,
    code: error?.code ?? null,
    message: error?.message ?? 'unknown',
    hint: error?.hint ?? null,
    details: error?.details ?? null,
  };
}

export function createSupabaseSignalHistoryStore(): OptionsSignalHistoryStore {
  /*
   * The last thing that went wrong, kept so `checkHistoryAccess` can say WHY
   * rather than only THAT. One slot, overwritten: the useful error is the one
   * from the operation the caller just ran, and a growing list of them in a
   * long-lived server process is a leak wearing a diagnostic's clothes.
   */
  let failure: HistoryStoreFailure | null = null;

  return {
    lastFailure: () => failure,

    async read(symbol, lookbackDays) {
      const client = createAdminClient();
      if (!client) {
        failure = toFailure('read', { message: 'no-admin-client:NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from the server environment' });
        return null;
      }
      try {
        /*
         * Bounded by DATE, not by row count. `limit(60)` would return the newest
         * sixty recorded days however far back they reach, so a symbol nobody has
         * opened since March would build today's percentile out of March. Asking
         * for a date range makes an empty answer the correct answer.
         *
         * Only the light columns: `inputs` is a whole engine input per row and
         * nothing on this path reads it.
         */
        const { data, error } = await client
          .from(TABLE)
          .select('captured_at, config_version, iv, put_call_oi, put_call_volume')
          .eq('symbol', symbol)
          .gte('captured_at', cutoffDate(lookbackDays))
          .order('captured_at', { ascending: true });
        if (error || !data) {
          failure = toFailure('read', error);
          return null;
        }
        failure = null;
        return data
          .map(toPoint)
          .filter((point): point is OptionsSignalHistoryPoint => point !== null);
      } catch (thrown) {
        failure = toFailure('read', { message: String(thrown) });
        return null;
      }
    },

    async write(record) {
      const client = createAdminClient();
      if (!client) {
        failure = toFailure('write', { message: 'no-admin-client:NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from the server environment' });
        return false;
      }
      try {
        /*
         * Upsert on the primary key, so opening the same symbol six times in an
         * afternoon writes one row and the last read of a day is the one kept.
         * That ordering is deliberate: a reading taken after the close is a more
         * complete statement about that day than one taken at lunchtime, and
         * both are honest records of what the card said.
         */
        const { error } = await client.from(TABLE).upsert({
          symbol: record.symbol,
          captured_at: record.capturedAt,
          config_version: record.configVersion,
          signal_type: record.signalType,
          underlying_bias: record.underlyingBias,
          score: record.score,
          confidence: record.confidenceScore,
          iv: record.iv,
          put_call_oi: record.putCallOi,
          put_call_volume: record.putCallVolume,
          inputs: inputsColumn(record.input),
          recorded_at: record.recordedAt,
        }, { onConflict: 'symbol,captured_at' });
        failure = error ? toFailure('write', error) : null;
        return !error;
      } catch (thrown) {
        failure = toFailure('write', { message: String(thrown) });
        return false;
      }
    },
  };
}

let store: OptionsSignalHistoryStore | undefined;
let health: Promise<HistoryAccessHealth> | undefined;

/**
 * The store the server uses: durable first, in-process buffer behind it.
 *
 * Memoized because `createAdminClient` is called per operation inside it and the
 * wrapper itself is stateless — there is nothing to rebuild between requests.
 */
export function getOptionsSignalHistoryStore(): OptionsSignalHistoryStore {
  store ??= createResilientHistoryStore(createSupabaseSignalHistoryStore(), optionsSignalHistoryFallback);
  return store;
}

/**
 * The durable store's reachability, probed ONCE per process and remembered.
 *
 * Memoized on the promise, not on the result, so concurrent first requests share
 * one probe rather than each running their own. It is deliberately not retried:
 * a wrong key does not fix itself, and a probe on every request would turn a
 * configuration mistake into a load problem on top of a correctness one. A
 * deploy restarts the process and re-probes.
 */
export function getOptionsSignalHistoryHealth(
  options: { store?: OptionsSignalHistoryStore } = {},
): Promise<HistoryAccessHealth> {
  const probed = options.store ?? createSupabaseSignalHistoryStore();
  health ??= checkHistoryAccess(probed)
    .then((result) => {
      if (!result.ok) {
        /*
         * warn, not info: the percentile bases are silently off in this state
         * and the card is showing a fallback basis to every reader. It is the
         * kind of failure that otherwise only surfaces as "nobody ever gets a
         * percentile", months later.
         */
        console.warn(JSON.stringify({
          event: 'options_signal_history_unreachable',
          reason: result.reason,
          /*
           * The database's own words, separately from the reason, because the
           * reason is a slug a human has to look up and this is the sentence
           * that says which line to change. Both, not either.
           */
          failure: probed.lastFailure?.() ?? null,
          failureSummary: describeHistoryFailure(probed.lastFailure?.() ?? null),
          checkedAt: result.checkedAt,
          impact: 'iv-and-putcall-percentiles-disabled',
        }));
      }
      return result;
    })
    .catch((error: unknown) => ({
      ok: false,
      reason: `health-check-threw:${String(error).slice(0, 60)}`,
      checkedAt: new Date().toISOString(),
    }));
  return health;
}

/** Test seam: forget the memoized probe. */
export function resetOptionsSignalHistoryHealth(): void {
  health = undefined;
}

/**
 * Delete rows past the retention window.
 *
 * Reporting-only by default, mirroring the SQL function it calls: the first run
 * tells you the size of the delete before you authorise it.
 */
export async function sweepOptionsSignalHistory(
  options: { apply?: boolean; retentionDays?: number } = {},
): Promise<{ due: number; deleted: number } | null> {
  const client = createAdminClient();
  if (!client) return null;
  try {
    const { data, error } = await client.rpc('sweep_options_signal_history', {
      retention_days: options.retentionDays ?? OPTIONS_SIGNAL_CONFIG.history.retentionDays,
      apply: options.apply ?? false,
    });
    if (error || !data?.length) return null;
    return { due: Number(data[0].due), deleted: Number(data[0].deleted) };
  } catch {
    return null;
  }
}

export type { OptionsSignalHistoryRecord };
