import 'server-only';

import { cache } from 'react';
import { resolveBetaAccessForRequest } from '@/src/lib/beta/beta-server';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';
import { resolveTrialState } from '@/src/lib/subscription/trial';
import {
  ADMIN_TRIAL_BLOCKED_MESSAGE,
  trialFailureMessage,
  type TrialFailureCode,
} from '@/src/lib/subscription/trial';
import { createClient } from '@/src/lib/supabase/server';
import type { TrialIdentity } from './identity-hash';
import {
  deriveAccountIdentities,
  lookupTrialIdentityClaim,
  trialIdentityAvailable,
} from './trial-identity-store';

/**
 * The one place that answers "may this reader start the free week?".
 *
 * Every entry point asks it — the hero that decides whether to offer the button,
 * and the server action that actually grants — so the control a reader sees and
 * the answer they get on pressing it can never disagree. The checkout
 * deliberately does *not* consult it: somebody whose trial is spent may still
 * buy a plan, and that is the whole point of the sentence they are shown.
 *
 * Nothing it reads comes from the browser. The session is verified, the
 * subscription comes from the database's own projection, the mailbox proof comes
 * from the verified user record, and the identities are derived here from what
 * the provider told us — never from a form field.
 */

export type TrialEligibility =
  | { ok: true; userId: string; identities: TrialIdentity[] }
  | { ok: false; code: TrialFailureCode; message: string };

function refuse(code: TrialFailureCode, message?: string): TrialEligibility {
  return { ok: false, code, message: message ?? trialFailureMessage(code) };
}

async function resolveUncached(): Promise<TrialEligibility> {
  const client = await createClient();
  if (!client) return refuse('UNAVAILABLE');

  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return refuse('UNAUTHENTICATED');

  const access = await resolveRequestAccountAccess();
  if (access.accountStatus !== 'active') return refuse('ACCOUNT_DELETING');

  /*
   * An administrator already holds the whole product and can simulate a trial
   * without spending one, so their single real grant is not burned here.
   */
  if (access.isAdmin) return refuse('UNAVAILABLE', ADMIN_TRIAL_BLOCKED_MESSAGE);

  /*
   * The account's own row first. It is cheaper than the ledger lookup, it is the
   * answer for every account that has simply already had its week, and it keeps
   * the familiar wording for that case instead of the "you have used this
   * before" sentence meant for a returning reader.
   */
  const emailVerified = Boolean(user.email_confirmed_at);
  const state = resolveTrialState(
    {
      tier: access.storedTier,
      status: access.status,
      trialEndsAt: access.trialEndsAt,
      trialUsedAt: access.trialUsedAt,
      currentPeriodEnd: access.currentPeriodEnd,
      databaseNow: access.databaseNow ?? new Date(0).toISOString(),
    },
    emailVerified,
  );
  if (state.kind === 'paid') return refuse('PAID_SUBSCRIPTION_ACTIVE');
  if (state.kind === 'trialing') return refuse('TRIAL_ALREADY_ACTIVE');
  if (state.kind === 'used') return refuse('TRIAL_ALREADY_USED');
  if (state.kind === 'email-unverified') return refuse('EMAIL_NOT_VERIFIED');

  /*
   * The controlled rollout, for the same reason the checkout consults it: a
   * trial is a grant of the top plan and therefore a way *in*. An unreadable
   * rollout refuses rather than admitting, and the refusal is retryable.
   */
  const beta = await resolveBetaAccessForRequest();
  if (beta.resolution === 'unavailable') return refuse('BETA_ACCESS_UNAVAILABLE');
  if (!beta.admitted) return refuse('BETA_NOT_ADMITTED');

  if (!trialIdentityAvailable()) return refuse('TRIAL_IDENTITY_UNAVAILABLE');

  const { binding } = deriveAccountIdentities(user);
  // No identity means no way to remember the grant, and a grant nobody can
  // remember is the defect the ledger exists to close.
  if (binding.length === 0) return refuse('TRIAL_IDENTITY_UNAVAILABLE');

  const claim = await lookupTrialIdentityClaim(binding);
  if (claim === 'unavailable') return refuse('TRIAL_IDENTITY_UNAVAILABLE');
  if (claim === 'claimed') return refuse('TRIAL_IDENTITY_ALREADY_USED');

  return { ok: true, userId: user.id, identities: binding };
}

/**
 * One answer per request. The hero and the action both ask during a single
 * render or submission, and they must observe the same ledger and the same
 * database clock rather than two round trips that could straddle a change.
 */
export const resolveTrialEligibility = cache(resolveUncached);
