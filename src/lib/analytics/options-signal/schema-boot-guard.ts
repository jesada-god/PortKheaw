import 'server-only';

import { createSupabaseSignalHistoryStore } from './signal-history-repository';
import {
  checkOptionsSignalSchema,
  schemaBehindMessage,
  type OptionsSignalSchemaVerdict,
} from './schema-guard';

/**
 * The boot half of {@link checkOptionsSignalSchema}: run it once at start-up and
 * refuse to serve if the answer is a definite "the migration has not run".
 *
 * Separate from the check itself because this module throws and imports the
 * server-only store. The check is pure enough to unit-test against a fake store;
 * this is the two lines of policy on top of it.
 */

let verdict: Promise<OptionsSignalSchemaVerdict> | undefined;

export async function assertOptionsSignalSchemaReady(): Promise<OptionsSignalSchemaVerdict> {
  verdict ??= checkOptionsSignalSchema(createSupabaseSignalHistoryStore());
  const result = await verdict;

  if (result.state === 'behind') {
    // Both, deliberately. The structured line is what a log search finds; the
    // human sentence is what the operator staring at a crashed boot reads.
    console.error(JSON.stringify({
      event: 'options_signal_schema_behind',
      label: result.label,
      migration: result.migration,
      detail: result.detail,
    }));
    throw new Error(schemaBehindMessage(result));
  }

  if (result.state === 'unknown') {
    /*
     * Could not tell, so the boot continues. A missing service key in a preview
     * environment, a database still waking up, a network blip: none of those are
     * evidence that the migration is missing, and refusing to start on "no
     * answer" would turn every transient into a total outage.
     *
     * warn, not info: this is also the state a genuinely broken deploy sits in
     * for its first seconds, and it should be visible in a log search.
     */
    console.warn(JSON.stringify({
      event: 'options_signal_schema_unverified',
      detail: result.detail,
      impact: 'conflicted-label-writes-unverified',
    }));
  }

  return result;
}

/** Test seam: forget the memoized verdict. */
export function resetOptionsSignalSchemaGuard(): void {
  verdict = undefined;
}
