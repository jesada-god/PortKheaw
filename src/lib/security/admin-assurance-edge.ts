import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import {
  assuranceLevelFromToken,
  decideAssurance,
  hasVerifiedFactor,
  type AssuranceState,
  type MfaFactorLike,
} from './admin-assurance';

/**
 * "Has this operator presented a second factor in this session?", answered in
 * middleware.
 *
 * The same decision as {@link resolveAdminAssurance}, made from facts middleware
 * already has: the operator role has been resolved through the database, and
 * `auth.getUser()` has already run to establish the session — so the factors the
 * auth server reported are in hand and the access token is already proven
 * authentic. Only the `aal` claim still has to be read out of it.
 *
 * This is a filter, not the boundary. It refuses the URL so no console renderer
 * runs at `aal1`; the pages and the mutations ask again for themselves, because
 * a POST to a server action can arrive without passing a page.
 *
 * It fails closed, like every other operator check on this path: an unreadable
 * session is not evidence of a factor.
 */
export async function resolveAdminAssuranceForEdge(
  client: SupabaseClient<Database>,
  user: User | null,
): Promise<AssuranceState> {
  const base = { isAdmin: true, currentLevel: null, hasVerifiedFactor: false } as const;
  if (!user) return decideAssurance({ ...base, currentLevel: 'aal1' });

  try {
    const { data: { session } } = await client.auth.getSession();
    const factors = (user as { factors?: MfaFactorLike[] | null }).factors ?? null;
    return decideAssurance({
      isAdmin: true,
      currentLevel: assuranceLevelFromToken(session?.access_token),
      hasVerifiedFactor: hasVerifiedFactor(factors),
    });
  } catch {
    return decideAssurance({ ...base, currentLevel: 'aal1' });
  }
}
