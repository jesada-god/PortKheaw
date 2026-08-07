import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';

/**
 * Reading the maintenance switch from middleware.
 *
 * Middleware runs on every request, so the cost of this read is the cost of the
 * feature. Two properties matter and they pull against each other:
 *
 *   * **Cheap while the product is up.** The overwhelmingly common answer is
 *     "not in maintenance", and paying a database round trip per request to
 *     learn that would be a permanent latency tax for a switch thrown a few
 *     times a year. So a negative answer is cached in module scope — shared by
 *     every request the same instance serves — for {@link OFF_TTL_MS}.
 *   * **Fresh enough to be usable.** Ten seconds is the ceiling on how long an
 *     instance keeps serving readers after the switch goes on, which is short
 *     enough that an operator does not sit wondering whether it worked. It is
 *     never longer: a *positive* answer is not cached at all, because the second
 *     half of the answer — whether this particular caller is an operator — is
 *     per-reader and must not be shared between them.
 *
 * The failure mode is deliberate. If the read fails, the product stays up. A
 * database blip must not be able to take the whole site down by looking like a
 * maintenance window; the switch is an operator's decision, and an unreadable
 * switch is not one. Authorization fails the other way — `isAdmin` is false
 * unless the database says otherwise — so a failed read can never let anyone
 * through a gate, only decline to raise it.
 */

const OFF_TTL_MS = 10_000;
/** Short, so a transient error is retried soon without becoming a hot loop. */
const ERROR_TTL_MS = 5_000;

let assumeOffUntil = 0;

export interface EdgeMaintenanceState {
  maintenanceEnabled: boolean;
  isAdmin: boolean;
}

/** Test seam. Nothing in the application calls this. */
export function resetMaintenanceEdgeCache(): void {
  assumeOffUntil = 0;
}

export async function readMaintenanceForEdge(
  client: SupabaseClient<Database>,
  now: number = Date.now(),
): Promise<EdgeMaintenanceState> {
  if (now < assumeOffUntil) return { maintenanceEnabled: false, isAdmin: false };

  try {
    const { data, error } = await client.rpc('resolve_maintenance_state');
    if (error) throw error;
    const row = data?.[0];
    if (!row) {
      assumeOffUntil = now + OFF_TTL_MS;
      return { maintenanceEnabled: false, isAdmin: false };
    }
    if (!row.maintenance_enabled) {
      assumeOffUntil = now + OFF_TTL_MS;
      return { maintenanceEnabled: false, isAdmin: false };
    }
    assumeOffUntil = 0;
    return { maintenanceEnabled: true, isAdmin: row.is_admin === true };
  } catch {
    assumeOffUntil = now + ERROR_TTL_MS;
    return { maintenanceEnabled: false, isAdmin: false };
  }
}
