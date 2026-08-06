import 'server-only';

import { createAdminClient } from '@/src/lib/supabase/admin';
import {
  emailTrialIdentity,
  isTrialIdentityConfigured,
  oauthTrialIdentity,
  paymentTrialIdentity,
  type TrialIdentity,
} from './identity-hash';

/**
 * The only way in or out of the persistent trial ledger.
 *
 * Every routine it calls is granted to `service_role` and to nothing else, so
 * this module is the boundary in both directions: a browser cannot read the
 * ledger to discover whether an address has an account, and a browser cannot
 * write to it to release a claim against itself.
 *
 * Nothing here ever logs an address, a subject, a fingerprint or a digest. The
 * caller gets a decision; the operator's log gets a stage name.
 */

/** The shape the database routines take. Digests only. */
type IdentityPayload = Array<{ type: string; hash: string; version: number }>;

function payload(identities: readonly TrialIdentity[]): IdentityPayload {
  return identities.map(({ type, hash, version }) => ({ type, hash, version }));
}

/**
 * A user as the trusted server read it — never as a browser described it.
 *
 * `identities` is the provider list Supabase attaches to the account, and
 * `email` is the address on the account record. Both are read from the verified
 * session or from the admin API, and this module has no way to accept anything
 * else.
 */
export interface AccountIdentitySource {
  email?: string | null;
  identities?: Array<{ provider?: unknown; id?: unknown; identity_data?: unknown }> | null;
}

/**
 * Every identity an account can be recognised by later.
 *
 * The address is derived from the account record *and* from each provider
 * identity's own verified email, because a Google account and a password account
 * on one mailbox must produce one digest — that is what makes "delete, then sign
 * up with Google instead" a dead end rather than a second free week.
 *
 * `binding` is what may refuse a trial. `signals` is recorded and never enforced:
 * a payment fingerprint belongs to a card, and a card is shared between family
 * members, reissued to strangers and used by one person to pay for another's
 * account. Refusing on one would refuse people who have never had a trial.
 */
export interface DerivedIdentities {
  binding: TrialIdentity[];
  signals: TrialIdentity[];
}

export function deriveAccountIdentities(
  user: AccountIdentitySource | null | undefined,
  paymentFingerprints: readonly string[] = [],
): DerivedIdentities {
  const binding = new Map<string, TrialIdentity>();
  const signals = new Map<string, TrialIdentity>();
  if (!user) return { binding: [], signals: [] };

  const addresses = new Set<string>();
  if (typeof user.email === 'string') addresses.add(user.email);

  for (const identity of user.identities ?? []) {
    const provider = typeof identity?.provider === 'string' ? identity.provider : null;
    const subject = typeof identity?.id === 'string' ? identity.id : null;
    const data = identity?.identity_data as { email?: unknown; email_verified?: unknown } | undefined;
    if (typeof data?.email === 'string') addresses.add(data.email);

    /*
     * The provider subject, for the one provider that gives us a stable one.
     * `email` is Supabase's own password identity and its "subject" is the user
     * id, which is regenerated on every sign-up and would therefore never match
     * anything — recording it would be recording noise.
     */
    if (provider && provider !== 'email' && subject) {
      const derived = oauthTrialIdentity(provider, subject);
      if (derived) binding.set(`${derived.type}:${derived.version}:${derived.hash}`, derived);
    }
  }

  for (const address of addresses) {
    const derived = emailTrialIdentity(address);
    if (derived) binding.set(`${derived.type}:${derived.version}:${derived.hash}`, derived);
  }

  for (const fingerprint of paymentFingerprints) {
    const derived = paymentTrialIdentity(fingerprint);
    if (derived) signals.set(`${derived.type}:${derived.version}:${derived.hash}`, derived);
  }

  return { binding: [...binding.values()], signals: [...signals.values()] };
}

export type TrialIdentityLookup = 'unclaimed' | 'claimed' | 'unavailable';

/**
 * Whether any of these identities has already spent its trial.
 *
 * `unavailable` is a third answer on purpose, and it is never treated as
 * `unclaimed` by the caller: an unreadable ledger must not hand out a week it
 * cannot record, for the same reason an unreadable rollout does not admit
 * anybody. It is retryable.
 */
export async function lookupTrialIdentityClaim(
  identities: readonly TrialIdentity[],
): Promise<TrialIdentityLookup> {
  if (identities.length === 0) return 'unavailable';
  const admin = createAdminClient();
  if (!admin) return 'unavailable';
  const { data, error } = await admin.rpc('trial_identity_is_claimed', {
    input_identities: payload(identities),
  });
  if (error || typeof data !== 'boolean') return 'unavailable';
  return data ? 'claimed' : 'unclaimed';
}

export interface TrialGrant {
  trialEndsAt: string | null;
  trialUsedAt: string | null;
  databaseNow: string | null;
}

/**
 * Claim the identities and grant the week, in one database transaction.
 *
 * Two statements would leave one of two wrecks behind: a claim burned by a grant
 * that failed, so the account can never have the week it never got, or a grant
 * nobody recorded, which is the defect this whole feature exists to close.
 * Neither is reachable — the routine does both or neither.
 */
export async function claimAndStartEliteTrial(
  userId: string,
  identities: readonly TrialIdentity[],
): Promise<TrialGrant> {
  const admin = createAdminClient();
  if (!admin) throw new Error('TRIAL_IDENTITY_UNAVAILABLE');
  const { data, error } = await admin.rpc('start_elite_trial_with_identity', {
    input_user_id: userId,
    input_identities: payload(identities),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error('TRIAL_IDENTITY_UNAVAILABLE');
  return {
    trialEndsAt: row.trial_ends_at ?? null,
    trialUsedAt: row.trial_used_at ?? null,
    databaseNow: row.database_now ?? null,
  };
}

/**
 * Write the account's spent trial into the ledger before it is deleted.
 *
 * Called with `trialUsed` read from the subscription row *before* that row is
 * removed, because afterwards nothing knows. Returns how many identities were
 * retained so the operator can see that a deletion which should have left a
 * claim behind actually did.
 */
export async function retainTrialIdentityOnDeletion(input: {
  userId: string;
  identities: readonly TrialIdentity[];
  trialUsed: boolean;
}): Promise<number> {
  const admin = createAdminClient();
  if (!admin) throw new Error('TRIAL_IDENTITY_UNAVAILABLE');
  const { data, error } = await admin.rpc('retain_trial_identity_on_deletion', {
    input_user_id: input.userId,
    input_identities: payload(input.identities),
    input_trial_used: input.trialUsed,
  });
  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}

/** Whether this deployment can record a trial at all. */
export function trialIdentityAvailable(): boolean {
  return isTrialIdentityConfigured() && createAdminClient() !== null;
}
