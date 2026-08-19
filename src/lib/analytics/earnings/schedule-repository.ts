import 'server-only';

import { createAdminClient } from '@/src/lib/supabase/admin';
import {
  createInMemoryEarningsScheduleStore,
  createResilientEarningsScheduleStore,
  type EarningsScheduleEntry,
  type EarningsScheduleStore,
} from './schedule-cache';
import type { EarningsProviderId, EarningsTimeOfDay } from './types';

/**
 * Durable storage for the last known earnings date per symbol. Service-role
 * only, and soft about every failure: a calendar cache that could fail a page
 * would be worse than the outage it exists to survive.
 *
 * `public.analytics_earnings_calendar_lkg` has RLS on with no policy, so nothing
 * reaches a browser from here. The date itself is not secret — it is on the
 * company's own investor-relations page — but the table is written by the
 * server and read by the server, and a client-facing policy would be a
 * capability nothing asked for.
 */

const TABLE = 'analytics_earnings_calendar_lkg';

const PROVIDERS: readonly EarningsProviderId[] = ['alpha-vantage', 'financial-modeling-prep'];
const TIMES: readonly EarningsTimeOfDay[] = ['pre-market', 'post-market', 'unknown'];

/**
 * Rows come back as loose SQL types. A row whose provider or time-of-day is not
 * one this code knows is DROPPED rather than coerced: the fallback it would feed
 * decides whether a confidence penalty applies, and a silently-defaulted field
 * is not a basis for that.
 */
function toEntry(row: {
  symbol: string | null;
  report_date: string | null;
  time_of_day: string | null;
  eps_estimate: number | null;
  provider: string | null;
  fetched_at: string | null;
}): EarningsScheduleEntry | null {
  if (!row.symbol || !row.report_date || !row.fetched_at) return null;
  const provider = PROVIDERS.find((id) => id === row.provider);
  if (!provider) return null;
  const timeOfDay = TIMES.find((value) => value === row.time_of_day) ?? 'unknown';
  return {
    symbol: row.symbol,
    reportDate: row.report_date.slice(0, 10),
    timeOfDay,
    epsEstimate: typeof row.eps_estimate === 'number' && Number.isFinite(row.eps_estimate)
      ? row.eps_estimate
      : null,
    provider,
    fetchedAt: row.fetched_at,
  };
}

export function createSupabaseEarningsScheduleStore(): EarningsScheduleStore {
  return {
    async read(symbol) {
      const client = createAdminClient();
      if (!client) return null;
      try {
        const { data, error } = await client
          .from(TABLE)
          .select('symbol, report_date, time_of_day, eps_estimate, provider, fetched_at')
          .eq('symbol', symbol)
          .maybeSingle();
        if (error || !data) return null;
        return toEntry(data);
      } catch {
        return null;
      }
    },

    async write(entry) {
      const client = createAdminClient();
      if (!client) return false;
      try {
        /*
         * Upsert on the symbol, so a symbol opened all afternoon holds one row
         * whose `fetched_at` is the last time a provider actually answered —
         * which is what the TTL is measured against.
         */
        const { error } = await client.from(TABLE).upsert({
          symbol: entry.symbol,
          report_date: entry.reportDate,
          time_of_day: entry.timeOfDay,
          eps_estimate: entry.epsEstimate,
          provider: entry.provider,
          fetched_at: entry.fetchedAt,
        }, { onConflict: 'symbol' });
        return !error;
      } catch {
        return false;
      }
    },
  };
}

let store: EarningsScheduleStore | undefined;

/**
 * The store the server uses: durable first, process-local buffer behind it.
 *
 * Memoized so the in-memory half accumulates across requests in one instance —
 * that buffer is the whole benefit on a deployment with no service-role key, and
 * a fresh one per request would remember nothing.
 */
export function getEarningsScheduleStore(): EarningsScheduleStore {
  store ??= createResilientEarningsScheduleStore(
    createSupabaseEarningsScheduleStore(),
    createInMemoryEarningsScheduleStore(),
  );
  return store;
}

/** Test seam: forget the memoized store. */
export function resetEarningsScheduleStore(): void {
  store = undefined;
}
