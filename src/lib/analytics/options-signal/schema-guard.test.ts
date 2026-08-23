/**
 * The guard's three answers, and the reason there are three rather than two.
 *
 * "Behind" stops a boot. "Unknown" must not, or every cold database and every
 * preview environment without a service key becomes a total outage — a louder
 * failure than the silent one the guard exists to prevent, which is not a trade
 * worth making.
 */

import { describe, expect, it } from 'vitest';
import { OPTIONS_SIGNAL_CONFIG } from './config';
import {
  OPTIONS_SIGNAL_LABELS_NEEDING_MIGRATION,
  OPTIONS_SIGNAL_REQUIRED_MIGRATION,
  checkOptionsSignalSchema,
  schemaBehindMessage,
} from './schema-guard';
import type { HistoryStoreFailure, OptionsSignalHistoryRecord, OptionsSignalHistoryStore } from './signal-history';

function storeThat(
  outcome: { written: boolean; failure?: HistoryStoreFailure | null; throws?: boolean },
): OptionsSignalHistoryStore & { seen: OptionsSignalHistoryRecord[] } {
  const seen: OptionsSignalHistoryRecord[] = [];
  return {
    seen,
    async read() { return []; },
    async write(record) {
      seen.push(record);
      if (outcome.throws) throw new Error('socket hang up');
      return outcome.written;
    },
    lastFailure: () => outcome.failure ?? null,
  };
}

const checkViolation: HistoryStoreFailure = {
  operation: 'write',
  code: '23514',
  message: 'new row for relation "options_signal_history" violates check constraint '
    + '"options_signal_history_signal_type_check"',
  hint: null,
  details: 'Failing row contains (ZZ-CANARY, …, CONFLICTED, …).',
};

describe('options signal schema guard', () => {
  it('passes when the database accepts every label this build can publish', async () => {
    const store = storeThat({ written: true });
    await expect(checkOptionsSignalSchema(store)).resolves.toEqual({ state: 'ok', detail: null });
  });

  it('probes with the label itself, on the reserved canary key', async () => {
    // The row IS the assertion. A probe that wrote `null` here would pass on
    // exactly the schema this guard exists to catch.
    const store = storeThat({ written: true });
    await checkOptionsSignalSchema(store);
    expect(store.seen.map((record) => record.signalType))
      .toEqual([...OPTIONS_SIGNAL_LABELS_NEEDING_MIGRATION]);
    expect(store.seen[0].symbol).toBe(OPTIONS_SIGNAL_CONFIG.history.canarySymbol);
    // `inputs` is `jsonb not null`; an explicit null is rejected by the column
    // rather than falling back to its default, which once read as an outage.
    expect(store.seen[0].input).toEqual({});
  });

  it('calls a CHECK violation what it is, and names the migration to run', async () => {
    const store = storeThat({ written: false, failure: checkViolation });
    const verdict = await checkOptionsSignalSchema(store);
    expect(verdict.state).toBe('behind');
    if (verdict.state !== 'behind') return;
    expect(verdict.label).toBe('CONFLICTED');
    expect(verdict.migration).toBe(OPTIONS_SIGNAL_REQUIRED_MIGRATION);

    const message = schemaBehindMessage(verdict);
    expect(message).toContain(OPTIONS_SIGNAL_REQUIRED_MIGRATION);
    expect(message).toContain('CONFLICTED');
    // The operator has to be told the stop was deliberate, or the first instinct
    // is to look for the bug that broke the boot.
    expect(message).toContain('ON PURPOSE');
  });

  it('does NOT call a missing service key a missing migration', async () => {
    const store = storeThat({
      written: false,
      failure: {
        operation: 'write',
        code: null,
        message: 'no-admin-client:SUPABASE_SERVICE_ROLE_KEY is missing from the server environment',
        hint: null,
        details: null,
      },
    });
    const verdict = await checkOptionsSignalSchema(store);
    expect(verdict.state).toBe('unknown');
  });

  it('does NOT call a different constraint violation a missing migration', async () => {
    // 23502 is the NOT NULL on `inputs` that once read as "store unreachable".
    // It is a real bug and it is not this one.
    const store = storeThat({
      written: false,
      failure: { operation: 'write', code: '23502', message: 'null value in column "inputs"', hint: null, details: null },
    });
    await expect(checkOptionsSignalSchema(store)).resolves.toMatchObject({ state: 'unknown' });
  });

  it('treats a thrown network error as unanswered, never as a verdict', async () => {
    const store = storeThat({ written: false, throws: true });
    const verdict = await checkOptionsSignalSchema(store);
    expect(verdict.state).toBe('unknown');
    expect(verdict.detail).toContain('schema-probe-threw');
  });

  it('covers every label the split introduced', () => {
    /*
     * The guard is only as good as this list. CONFLICTED is what `2026.08.23`
     * added to the CHECK, so if a later release adds another label without
     * adding it here, this is the line that has to be edited deliberately.
     */
    expect(OPTIONS_SIGNAL_LABELS_NEEDING_MIGRATION).toEqual(['CONFLICTED']);
  });
});
