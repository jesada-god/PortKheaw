/**
 * DOES THE DATABASE ACCEPT THE LABELS THIS BUILD WRITES?
 *
 * `2026.08.23` splits CONFLICTED out of SIDEWAYS, and the `signal_type` CHECK on
 * `public.options_signal_history` only admits it after migration
 * `202608230001`. Deploy the app first and the failure is the worst shape a
 * failure comes in:
 *
 *   * every write of a conflicted signal is rejected with SQLSTATE 23514;
 *   * `recordOptionsSignal` swallows that, because a history is never a reason
 *     to fail a page — which is correct, and here it is also the problem;
 *   * so the reading history stops accumulating for EXACTLY the symbols whose
 *     evidence disagrees, and for no others.
 *
 * The IV and Put/Call percentiles are drawn from that history. A baseline still
 * 19 and 59 days short would then fill in from a population with the conflicted
 * symbols deleted out of it, and produce percentiles that are wrong in a
 * consistent direction while looking completely healthy. Nothing about the card
 * would say so. That is much harder to find than an outage, so the response to
 * this specific condition is to refuse to boot rather than to serve.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is fail on "could not tell". A missing
 * service key, a network blip or a cold database is `unknown`, not `behind`, and
 * `unknown` never stops a boot — turning every transient into a total outage
 * would trade a subtle bug for a loud one nobody asked for.
 */

import { OPTIONS_SIGNAL_CONFIG, OPTIONS_SIGNAL_CONFIG_VERSION } from './config';
import {
  describeHistoryFailure,
  type OptionsSignalHistoryRecord,
  type OptionsSignalHistoryStore,
} from './signal-history';
import type { OptionsSignalInput, OptionsSignalType } from './types';

/** The file that has to have run. Named in full so the message is actionable. */
export const OPTIONS_SIGNAL_REQUIRED_MIGRATION =
  '202608230001_options_signal_history_conflicted_label.sql';

/**
 * Labels this build can publish that an older `signal_type` CHECK rejects.
 *
 * A list rather than a constant, because the next label split should be added
 * here and get this guard for free instead of rediscovering the failure mode.
 */
export const OPTIONS_SIGNAL_LABELS_NEEDING_MIGRATION: readonly OptionsSignalType[] = ['CONFLICTED'];

/** SQLSTATE for a CHECK constraint violation — the schema-is-behind fingerprint. */
const CHECK_VIOLATION = '23514';

export type OptionsSignalSchemaVerdict =
  | { state: 'ok'; detail: null }
  | { state: 'behind'; label: OptionsSignalType; migration: string; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * The probe row. Same reserved symbol and same daily primary key as the access
 * canary, so it upserts over that row rather than adding a second one and it is
 * cleaned up by the canary retention that already exists.
 */
function probeRecord(label: OptionsSignalType, now: Date): OptionsSignalHistoryRecord {
  const checkedAt = now.toISOString();
  return {
    configVersion: OPTIONS_SIGNAL_CONFIG_VERSION,
    recordedAt: checkedAt,
    symbol: OPTIONS_SIGNAL_CONFIG.history.canarySymbol,
    capturedAt: checkedAt.slice(0, 10),
    asOf: checkedAt,
    latestCandleAt: checkedAt.slice(0, 10),
    calculatedAt: checkedAt,
    status: 'insufficient-data',
    /*
     * THE POINT OF THE ROW. Everything else here is the canary's own shape; this
     * one field is the assertion, and it is the field the old CHECK rejects.
     */
    signalType: label,
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
    // An empty object, never null: `inputs` is `jsonb not null` and an explicit
    // null violates that instead of taking the column default.
    input: {} as unknown as OptionsSignalInput,
  };
}

/**
 * Ask the database, by writing the label and seeing whether it is refused.
 *
 * Asking the catalogue for the constraint's text would need a new RPC, which is
 * itself a migration — a guard against un-run migrations that needs an un-run
 * migration to work. Writing the row tests the exact thing at risk, through the
 * exact code path that would fail.
 */
export async function checkOptionsSignalSchema(
  store: OptionsSignalHistoryStore,
  options: { now?: () => Date } = {},
): Promise<OptionsSignalSchemaVerdict> {
  const now = (options.now ?? (() => new Date()))();

  for (const label of OPTIONS_SIGNAL_LABELS_NEEDING_MIGRATION) {
    let written: boolean;
    try {
      written = await store.write(probeRecord(label, now));
    } catch (error) {
      return { state: 'unknown', detail: `schema-probe-threw:${String(error).slice(0, 80)}` };
    }
    if (written) continue;

    const failure = store.lastFailure?.() ?? null;
    const detail = describeHistoryFailure(failure) ?? 'write-rejected-without-detail';
    if (failure?.code === CHECK_VIOLATION) {
      return { state: 'behind', label, migration: OPTIONS_SIGNAL_REQUIRED_MIGRATION, detail };
    }
    /*
     * Rejected for some other reason — no service key, RLS, a network error. The
     * schema question is unanswered, and an unanswered question is not a verdict.
     */
    return { state: 'unknown', detail };
  }

  return { state: 'ok', detail: null };
}

/**
 * The operator-facing sentence. Kept next to the check so the message and the
 * condition cannot drift apart, and exported so a test can assert the migration
 * filename is in it rather than trusting that somebody wrote it down.
 */
export function schemaBehindMessage(verdict: Extract<OptionsSignalSchemaVerdict, { state: 'behind' }>): string {
  return [
    `FATAL: the options_signal_history schema is behind this build (${OPTIONS_SIGNAL_CONFIG_VERSION}).`,
    `The database refuses signal_type "${verdict.label}": ${verdict.detail}`,
    `Run the migration ${verdict.migration} and start the app again.`,
    'The app is refusing to start ON PURPOSE. Serving in this state would keep every',
    'other symbol writing history while conflicted symbols silently stopped, and the',
    'IV and Put/Call percentiles would rebuild from a biased population that looks fine.',
  ].join('\n');
}
