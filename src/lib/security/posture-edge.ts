import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';

/**
 * Reading both runtime switches from middleware, in one round trip.
 *
 * Middleware runs on every request, so the cost of this read is the cost of the
 * feature — and adding a second switch must not mean adding a second round trip.
 * `resolve_runtime_posture()` answers maintenance, lockdown and the caller's
 * operator role together, which is why it exists as its own routine rather than
 * as a second call beside `resolve_maintenance_state()`.
 *
 * **The fallback is not defensive coding, it is deploy ordering.** A deployment
 * is not atomic: for a few minutes a new build answers requests against a
 * database that has not run the migration yet, and `resolve_runtime_posture`
 * does not exist there. Rather than fail that window open on *both* switches,
 * the read falls back to the older maintenance-only routine, which every
 * database in that window does have. The product keeps its maintenance gate
 * throughout; lockdown simply reads false until the migration lands, which is
 * the same state it would have been in anyway.
 *
 * Two caching properties, pulling against each other:
 *
 *   * **Cheap while everything is normal.** The overwhelmingly common answer is
 *     "both switches off", and paying a round trip per request to learn that
 *     would be a permanent latency tax on controls thrown a few times a year. A
 *     fully-clear answer is cached in module scope for {@link CLEAR_TTL_MS}.
 *   * **Never cached when it matters.** If *either* switch is on, nothing is
 *     cached — because the rest of the answer (whether this caller is an
 *     operator) is per-reader, and a shared positive would be one reader's role
 *     handed to everybody the same instance serves.
 *
 * Availability fails open, authorization fails closed. An unreadable switch
 * leaves the product up; `isAdmin` is false unless the database says otherwise,
 * so a failed read can never let anybody through a gate, only decline to raise
 * one.
 */

const CLEAR_TTL_MS = 10_000;
/** Short, so a transient error is retried soon without becoming a hot loop. */
const ERROR_TTL_MS = 5_000;

let assumeClearUntil = 0;

export interface EdgeRuntimePosture {
  maintenanceEnabled: boolean;
  lockdownEnabled: boolean;
  isAdmin: boolean;
}

const CLEAR: EdgeRuntimePosture = {
  maintenanceEnabled: false,
  lockdownEnabled: false,
  isAdmin: false,
};

/** Test seam. Nothing in the application calls this. */
export function resetRuntimePostureCache(): void {
  assumeClearUntil = 0;
}

export async function readRuntimePostureForEdge(
  client: SupabaseClient<Database>,
  now: number = Date.now(),
): Promise<EdgeRuntimePosture> {
  if (now < assumeClearUntil) return CLEAR;

  try {
    const posture = await readPosture(client);
    if (!posture) {
      assumeClearUntil = now + CLEAR_TTL_MS;
      return CLEAR;
    }
    if (!posture.maintenanceEnabled && !posture.lockdownEnabled) {
      assumeClearUntil = now + CLEAR_TTL_MS;
      return CLEAR;
    }
    assumeClearUntil = 0;
    return posture;
  } catch {
    assumeClearUntil = now + ERROR_TTL_MS;
    return CLEAR;
  }
}

/**
 * The posture routine, or the older maintenance-only one when the migration has
 * not reached this database yet. See the note above on deploy ordering.
 */
async function readPosture(
  client: SupabaseClient<Database>,
): Promise<EdgeRuntimePosture | null> {
  const { data, error } = await client.rpc('resolve_runtime_posture');
  if (!error) {
    const row = data?.[0];
    if (!row) return null;
    return {
      maintenanceEnabled: row.maintenance_enabled === true,
      lockdownEnabled: row.security_lockdown_enabled === true,
      isAdmin: row.is_admin === true,
    };
  }

  const legacy = await client.rpc('resolve_maintenance_state');
  if (legacy.error) throw legacy.error;
  const row = legacy.data?.[0];
  if (!row) return null;
  return {
    maintenanceEnabled: row.maintenance_enabled === true,
    lockdownEnabled: false,
    isAdmin: row.is_admin === true,
  };
}
