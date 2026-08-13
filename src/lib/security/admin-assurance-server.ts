import 'server-only';

import { cache } from 'react';
import { createClient } from '@/src/lib/supabase/server';
import {
  requireAdmin,
  resolveRequestAccountAccess,
  type RequestAccountAccess,
} from '@/src/lib/subscription/account-access';
import {
  assuranceLevelFromToken,
  decideAssurance,
  hasVerifiedFactor,
  type AssuranceState,
  type MfaFactorLike,
} from './admin-assurance';
import type { LockdownClass } from './lockdown';
import { assertMutationAllowed } from './lockdown-server';

/**
 * The operator assurance gate, resolved on the server.
 *
 * The order of the three reads below is the security property, not an
 * implementation detail:
 *
 *   1. `resolveRequestAccountAccess()` resolves the *stored* role through the
 *      database's own projection. Nothing about the caller's privilege comes
 *      from the request.
 *   2. `auth.getUser()` proves the access token authentic against the auth
 *      server — and, in the same round trip, returns the factors the auth server
 *      says this account holds. Neither fact is taken from the cookie.
 *   3. Only then is the token decoded for its `aal` claim. Decoding is safe
 *      exactly because step 2 already proved the token is the one Supabase
 *      issued; doing it first would be asking the caller what their own
 *      assurance level is.
 *
 * Every failure resolves to "not satisfied". An unreachable auth server, an
 * unreadable session, a Supabase that is not configured — none of them is
 * evidence that a second factor was presented, so none of them opens the console.
 */

const UNSATISFIED: AssuranceState = {
  isAdmin: false,
  currentLevel: null,
  hasVerifiedFactor: false,
  requirement: 'not-admin',
  satisfied: false,
};

async function resolveUncached(): Promise<AssuranceState> {
  const access = await resolveRequestAccountAccess();
  if (!access.isAdmin) return UNSATISFIED;

  const client = await createClient();
  if (!client) return { ...UNSATISFIED, isAdmin: true, requirement: 'enroll' };

  try {
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) return { ...UNSATISFIED, isAdmin: true, requirement: 'enroll' };

    const { data: { session } } = await client.auth.getSession();
    const factors = (user as { factors?: MfaFactorLike[] | null }).factors ?? null;

    return decideAssurance({
      isAdmin: true,
      currentLevel: assuranceLevelFromToken(session?.access_token),
      hasVerifiedFactor: hasVerifiedFactor(factors),
    });
  } catch {
    // An operator whose assurance could not be read is an operator who has not
    // proved a second factor. `enroll` rather than `verify` because the safe
    // wrong answer is the one that sends them to a page where they can fix it.
    return { ...UNSATISFIED, isAdmin: true, requirement: 'enroll' };
  }
}

/**
 * Memoised per request. A page, its layout and the action it posts to may all
 * ask; they must observe one answer and cost one round trip.
 */
export const resolveAdminAssurance = cache(resolveUncached);

export class AssuranceRequiredError extends Error {
  constructor(readonly requirement: 'enroll' | 'verify') {
    super('AAL2_REQUIRED');
    this.name = 'AssuranceRequiredError';
  }
}

export function isAssuranceRequiredError(error: unknown): error is AssuranceRequiredError {
  if (error instanceof AssuranceRequiredError) return true;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes('AAL2_REQUIRED');
}

/**
 * The gate a sensitive operator action opens with.
 *
 * This is the boundary, not the middleware redirect. Middleware refuses a URL
 * before a renderer runs, which is a filter; a server action is reachable by a
 * POST that never passed through a page, so the action has to ask for itself.
 * The two are independent on purpose — neither is trusted to be the only one.
 */
export async function requireAdminAssurance(): Promise<AssuranceState> {
  const state = await resolveAdminAssurance();
  if (state.satisfied) return state;
  throw new AssuranceRequiredError(state.requirement === 'verify' ? 'verify' : 'enroll');
}

/**
 * The gate every operator **mutation** opens with: authorized, assured, and not
 * locked down.
 *
 * It exists as one function rather than three calls at each site for a reason
 * that has nothing to do with brevity. Six actions across five files change
 * roles, plans, refunds, ticket state and the maintenance switch, and three of
 * them do not live under `/admin` at all — they are posted from `/settings` and
 * `/support` pages, where the middleware assurance gate never sees them. A rule
 * spelled out six times is a rule the seventh action forgets; a rule that is the
 * gate itself is one it cannot. That property is what makes this the right place
 * to enforce the lockdown too: every operator mutation in the product passes
 * through this function, so one check here is a check on all of them, including
 * the one somebody adds next month.
 *
 * The ordering is deliberate, and all three steps are load-bearing:
 *
 *   1. **Authorization**, so a non-operator is refused as a non-operator and
 *      never learns that a second factor is a thing this product asks for.
 *   2. **Assurance**, and only for people who really are operators.
 *   3. **Lockdown**, last, because it is the only one of the three that a
 *      legitimate, fully-assured operator can hit — and refusing them for it
 *      before checking they are an operator at all would tell an anonymous
 *      caller that an incident is in progress.
 *
 * `admin-console.contract.test.ts` asserts that every action calling
 * `requireAdmin()` calls this instead, so the coverage is checked by the build
 * rather than remembered.
 */
export interface AdminMutationOptions {
  /**
   * Which lockdown class this mutation belongs to. Defaults to
   * `'admin-mutation'`, so a console action added tomorrow is refused during an
   * incident without anybody remembering to classify it.
   *
   * The two classes that are never blocked — `'security-toggle'` and
   * `'maintenance-toggle'` — must be named explicitly at their call site, which
   * is the point: an exemption from the incident control should be something a
   * reader of that action can see, not a default it inherited.
   */
  lockdownClass?: LockdownClass;
}

export async function requireAdminMutation(
  options: AdminMutationOptions = {},
): Promise<RequestAccountAccess> {
  const access = await requireAdmin();
  await requireAdminAssurance();
  await assertMutationAllowed(options.lockdownClass ?? 'admin-mutation');
  return access;
}

export { ASSURANCE_DENIAL_MESSAGE } from './admin-assurance';
