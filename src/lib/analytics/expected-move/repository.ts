import 'server-only';

import { createAdminClient } from '@/src/lib/supabase/admin';
import type { ExpectedMoveObservation } from './derive';

/**
 * Storage for the expected-move collection. Service-role only, write-mostly.
 *
 * There is no read path in the product, and that is not an omission: nothing
 * reads this table. When the collection is finally long enough to answer
 * something, the analysis will be a script against the database like every other
 * measurement in this programme — not a feature reading rows at request time.
 */

const TABLE = 'expected_move_observations';

/**
 * Write one day for one symbol, or leave the table exactly as it was.
 *
 * Upsert on `(symbol, as_of)`, so re-running the collector on the same day
 * overwrites rather than failing — a retry after a partial run is the normal
 * case, not the exceptional one.
 *
 * Returns whether the row landed, because the collector's whole output is a
 * count and a list of what it could not get; a silent failure here would make
 * that report a lie.
 */
export async function writeExpectedMove(observation: ExpectedMoveObservation): Promise<boolean> {
  const client = createAdminClient();
  if (!client) return false;
  const { error } = await client.from(TABLE).upsert({
    symbol: observation.symbol,
    as_of: observation.asOf,
    spot: observation.spot,
    expiration: observation.expiration,
    days_to_expiry: observation.daysToExpiry,
    atm_iv: observation.atmIv,
    atm_strike: observation.atmStrike,
    implied_move: observation.impliedMove,
    implied_move_pct: observation.impliedMovePct,
    provider: observation.provider,
    recorded_at: new Date().toISOString(),
  }, { onConflict: 'symbol,as_of' });
  return !error;
}

/**
 * How long the collection has been running, and how dense it is.
 *
 * The only read this module offers, and it exists for the collector's own log
 * line rather than for the product: a run that reports "day 41 of the wait" is
 * a run somebody can leave alone, which is the desired behaviour for at least a
 * year.
 */
export async function collectionProgress(): Promise<{ days: number; rows: number; since: string | null }> {
  const client = createAdminClient();
  if (!client) return { days: 0, rows: 0, since: null };
  const { data, error } = await client
    .from(TABLE)
    .select('as_of')
    .order('as_of', { ascending: true })
    .limit(1);
  if (error || !data || data.length === 0) return { days: 0, rows: 0, since: null };

  const since = data[0].as_of;
  const { count } = await client.from(TABLE).select('*', { count: 'exact', head: true });
  const days = Math.round((Date.now() - Date.parse(`${since}T00:00:00Z`)) / 86_400_000);
  return { days, rows: count ?? 0, since };
}
