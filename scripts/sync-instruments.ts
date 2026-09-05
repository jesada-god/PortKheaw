import { createClient } from '@supabase/supabase-js';
import type { InstrumentSyncCounts, MarketInstrumentInput } from '../src/lib/instruments/types.ts';
import { planInstrumentSync, redactInstrumentSyncError } from '../src/lib/instruments/sync-plan.ts';
import { loadInstrumentSnapshot, toProviderFailure } from '../src/lib/instruments/providers.ts';
import { executeInstrumentSync } from '../src/lib/instruments/sync-runner.ts';

const BATCH_SIZE = 500;

interface StructuredFailure { code: string; message: string; retryable: boolean; status?: number }

function failure(code: string, message: string, retryable: boolean, status?: number): Error & StructuredFailure {
  return Object.assign(new Error(message), { code, retryable, status });
}

function safeFailure(error: unknown): StructuredFailure {
  const value = toProviderFailure(error);
  return {
    code: value.code || 'instrument-sync-failed',
    message: redactInstrumentSyncError(value.message || 'Unknown instrument sync failure'),
    retryable: value.retryable,
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
  };
}

/**
 * THE PROVIDER A ROW IS STAMPED WITH IS THE ONE THAT SERVED IT.
 *
 * ===========================================================================
 * WHAT THIS FIXES
 * ===========================================================================
 * Both stages below used to pass `PRIMARY_INSTRUMENT_PROVIDER` — the constant
 * `'alpha-vantage'` — to the database, whichever provider had actually
 * answered. A run that fell back to Nasdaq Trader wrote 12,636 rows every one
 * of which claimed to come from Alpha Vantage, and the sync's own log said
 * `providerUsed: nasdaq-trader` on the line above. The log told the truth and
 * the table did not.
 *
 * That is worse than a missing field. A missing provider is visibly unknown; a
 * wrong one is confidently misleading, and it makes "which rows came from the
 * fallback" unanswerable — which is exactly the question somebody asks when
 * they find a column the fallback does not populate.
 *
 * ===========================================================================
 * NULL IS NOT AN ATTRIBUTION
 * ===========================================================================
 * `providerUsed` is null when BOTH providers failed. The snapshot is then
 * empty and incomplete, and there is no honest name to write on a run — so
 * this refuses rather than falling back to the primary's name, which is the
 * habit that produced the defect in the first place.
 */
function syncProvider(providerUsed: string | null): string {
  if (!providerUsed) {
    throw failure(
      'sync-provider-unknown',
      'No instrument provider answered, so there is nothing to attribute a sync run to',
      false,
    );
  }
  return providerUsed;
}

async function dryRunCounts(rows: MarketInstrumentInput[], failed: number): Promise<InstrumentSyncCounts> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return { inserted: rows.length, updated: 0, skipped: 0, failed };
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const existing: MarketInstrumentInput[] = [];
  for (let from = 0; ; from += 1000) {
    /*
      EVERY ROW, NOT THE ONES ONE PROVIDER OWNS.

      This used to filter `.eq('provider', PRIMARY_INSTRUMENT_PROVIDER)`, which
      was only ever right because every row carried that one value — including
      the ones that did not come from it. Now that a row records who actually
      served it the table can hold a mix, and a preview that looked at one
      provider's rows would report the other provider's rows as new inserts.

      The sync replaces the whole instrument universe on every run, so the
      honest diff target is the whole table. Nothing else writes to it: the
      logo backfill updates metadata on existing rows and never inserts.
    */
    const { data, error } = await client.from('market_instruments')
      .select('provider_symbol,symbol,name,exchange,asset_type,currency,country,status,ipo_date,delisting_date')
      .range(from, from + 999);
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') return { inserted: rows.length, updated: 0, skipped: 0, failed };
      throw failure('database-read-failed', error.message, false);
    }
    existing.push(...((data ?? []) as MarketInstrumentInput[]));
    if (!data || data.length < 1000) break;
  }
  return planInstrumentSync(existing, rows, failed);
}

async function persist(
  rows: MarketInstrumentInput[],
  failed: number,
  idempotencyKey: string,
  providerUsed: string | null,
): Promise<InstrumentSyncCounts> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw failure('sync-not-configured', 'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for a real sync', false);
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: runId, error: beginError } = await client.rpc('begin_market_instrument_sync', { input_provider: syncProvider(providerUsed), input_idempotency_key: idempotencyKey });
  if (beginError || !runId) throw failure('sync-run-create-failed', beginError?.message ?? 'Could not create sync run', false);
  try {
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const { error } = await client.rpc('stage_market_instruments', { input_run_id: runId, input_rows: rows.slice(offset, offset + BATCH_SIZE) });
      if (error) throw failure('sync-stage-failed', error.message, false);
    }
    const { data, error } = await client.rpc('finalize_market_instrument_sync', { input_run_id: runId, input_failed_count: failed });
    const result = data?.[0];
    if (error || !result) throw failure('sync-finalize-failed', error?.message ?? 'Could not finalize sync run', false);
    return result as InstrumentSyncCounts;
  } catch (error) {
    await client.rpc('fail_market_instrument_sync', { input_run_id: runId, input_error: safeFailure(error) });
    throw error;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const snapshot = await loadInstrumentSnapshot({ apiKey: process.env.ALPHA_VANTAGE_API_KEY ?? '' });
  for (const [index, providerError] of snapshot.failures.entries()) {
    process.stderr.write(`${JSON.stringify({
      event: 'instrument_sync_warning',
      provider: index === 0 ? snapshot.primaryProvider : 'nasdaq-trader',
      ...safeFailure(providerError),
    })}\n`);
  }
  const idempotencyKey = new Date().toISOString().slice(0, 10);
  const execution = await executeInstrumentSync(snapshot, dryRun, {
    preview: dryRunCounts,
    persist: (rows, failed) => persist(rows, failed, idempotencyKey, snapshot.providerUsed),
  });
  process.stdout.write(`${JSON.stringify({
    event: 'instrument_sync_complete',
    dryRun,
    incomplete: snapshot.incomplete,
    primaryProvider: snapshot.primaryProvider,
    providerUsed: snapshot.providerUsed,
    fallbackReason: snapshot.fallbackReason,
    discovered: snapshot.instruments.length,
    ...execution.counts,
  })}\n`);
  if (snapshot.incomplete) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'instrument_sync_error', ...safeFailure(error) })}\n`);
  process.exitCode = 1;
});
