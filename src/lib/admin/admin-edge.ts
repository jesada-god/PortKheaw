import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { normalizeRole } from '@/src/lib/subscription/admin-access';

/**
 * "Is the caller of this request an operator?", answered in middleware.
 *
 * It reads the same projection the server components read —
 * `get_my_account_access`, which resolves the caller from `auth.uid()` inside the
 * database and returns the *stored* role. No user id, role or preview is
 * accepted from the request; there is nothing here a client can send.
 *
 * Two deliberate differences from {@link readMaintenanceForEdge}, which reads a
 * switch a few paths away:
 *
 *   * **Nothing is cached, in either direction.** That module caches "the
 *     product is up" because it is the same answer for everybody. This answer is
 *     per-reader, and module scope is shared by every request an instance
 *     serves — a cached positive would be one reader's operator role handed to
 *     the next caller. The cost is one round trip on `/admin` URLs only, which
 *     is a page a handful of people open a handful of times a day.
 *   * **It fails closed.** An unreadable switch leaves the product up, because a
 *     database blip must not look like a maintenance window. An unreadable role
 *     is the opposite: it is not evidence of an operator, so it answers false and
 *     the console stays shut.
 *
 * This is a filter, not the boundary. It refuses the URL early so no renderer
 * ever runs for a non-operator; `requireAdminPage()` refuses the render and the
 * database refuses the data.
 */
export async function isPlatformAdminForEdge(
  client: SupabaseClient<Database>,
): Promise<boolean> {
  try {
    const { data, error } = await client.rpc('get_my_account_access');
    if (error) return false;
    return normalizeRole(data?.[0]?.role) === 'admin';
  } catch {
    return false;
  }
}
