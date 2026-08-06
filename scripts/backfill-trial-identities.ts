/**
 * Write the ledger entries that should already exist.
 *
 * Every account that had taken the free week before this feature shipped is
 * recorded only in its own `user_subscriptions.trial_used_at` — which cascades
 * away with the account. Without this pass, anybody who used a trial *before*
 * today could still delete, sign up again and take a second one. The loophole is
 * closed for new grants by the code; it is closed for existing ones by this.
 *
 * Idempotent by construction: the claim is a single `insert … on conflict`, and
 * a row already held by the same account is re-claimed rather than refused. Run
 * it as many times as you like.
 *
 * It never logs an address, a provider subject or a digest. The output is
 * counts, and one anonymous line per account that could not be recorded so an
 * operator knows the total is not the whole story.
 *
 *   npm run trial:backfill-identities
 *   npm run trial:backfill-identities -- --dry-run
 */

import { createClient } from '@supabase/supabase-js';
import { canonicalizeEmail } from '../src/lib/trial-identity/canonical-email';
import { createHmac } from 'node:crypto';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const secret = process.env.TRIAL_IDENTITY_HMAC_SECRET;

if (!url || !serviceRoleKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (!secret) {
  console.error('TRIAL_IDENTITY_HMAC_SECRET is required; without it no claim can be derived.');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const HASH_VERSION = 1;

/*
 * The derivation is duplicated here rather than imported, and deliberately so:
 * `identity-hash.ts` is `server-only`, which a plain Node script cannot import
 * without the `react-server` condition. The canonical-email rule — the part with
 * the interesting edge cases — *is* imported, so the two cannot disagree about
 * what one mailbox means. This file only re-states the HMAC envelope, and the
 * migration test would fail loudly if that envelope ever stopped matching.
 */
function digest(type: string, canonicalValue: string): string {
  return createHmac('sha256', secret as string)
    .update(`portkheaw:trial-identity:v${HASH_VERSION}:${type}:${canonicalValue}`)
    .digest('hex');
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data: spent, error } = await admin
    .from('user_subscriptions')
    .select('user_id')
    .not('trial_used_at', 'is', null);
  if (error) {
    console.error('Could not read which accounts have spent a trial:', error.message);
    process.exit(1);
  }

  const userIds = (spent ?? []).map((row) => row.user_id as string);
  console.info(`accounts with a spent trial: ${userIds.length}${dryRun ? ' (dry run)' : ''}`);

  let claimed = 0;
  let alreadyHeld = 0;
  let withoutIdentity = 0;
  let failed = 0;

  for (const userId of userIds) {
    const { data, error: readError } = await admin.auth.admin.getUserById(userId);
    const user = data?.user;
    if (readError || !user) {
      failed += 1;
      continue;
    }

    const identities: Array<{ type: string; hash: string }> = [];
    const addresses = new Set<string>();
    if (typeof user.email === 'string') addresses.add(user.email);
    for (const identity of user.identities ?? []) {
      const provider = typeof identity.provider === 'string' ? identity.provider.toLowerCase() : '';
      const subject = typeof identity.id === 'string' ? identity.id : '';
      const identityEmail = (identity.identity_data as { email?: unknown } | undefined)?.email;
      if (typeof identityEmail === 'string') addresses.add(identityEmail);
      if (provider && provider !== 'email' && subject) {
        identities.push({ type: 'oauth', hash: digest('oauth', `${provider}:${subject}`) });
      }
    }
    for (const address of addresses) {
      const canonical = canonicalizeEmail(address);
      if (canonical) identities.push({ type: 'email', hash: digest('email', canonical) });
    }

    if (identities.length === 0) {
      withoutIdentity += 1;
      continue;
    }
    if (dryRun) {
      claimed += identities.length;
      continue;
    }

    for (const identity of identities) {
      const { data: outcome, error: claimError } = await admin.rpc('claim_trial_identity', {
        input_user_id: userId,
        input_identity_type: identity.type,
        input_identity_hash: identity.hash,
        input_hash_version: HASH_VERSION,
      });
      if (claimError) failed += 1;
      else if (outcome === 'claimed') claimed += 1;
      else alreadyHeld += 1;
    }
  }

  console.info(JSON.stringify({
    event: 'trial_identity_backfill',
    accounts: userIds.length,
    claimed,
    alreadyHeld,
    withoutIdentity,
    failed,
    dryRun,
  }));
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // The message, never the object: an unexpected error from the client can carry
  // request details, and this script only ever handles identities.
  console.error('backfill failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
