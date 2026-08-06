import 'server-only';

import { getBillingConfig } from '@/src/lib/billing/billing-server';
import { cancelStripeSubscriptionForDeletion } from '@/src/lib/billing/providers/stripe/stripe-provider';
import { createAdminClient } from '@/src/lib/supabase/admin';
import { SUPPORT_ATTACHMENT_BUCKET } from '@/src/lib/support/attachments';
import { deriveAccountIdentities, retainTrialIdentityOnDeletion } from '@/src/lib/trial-identity/trial-identity-store';

/**
 * Deleting an account, as a staged pipeline rather than one statement.
 *
 * The order is the whole design, and it is fixed:
 *
 *   1. **mark the account closing**, so nothing it owns accepts another write
 *      while the rest of this runs — the reader's token is still valid and will
 *      stay valid for the rest of its hour, so waiting for it to expire is not
 *      a plan;
 *   2. **write the trial ledger**, because after step 6 nothing in the system
 *      knows this account ever took the free week;
 *   3. **settle the payment provider**, so nobody is billed for a product they
 *      no longer have an account for. Never a refund — see the note on the
 *      provider call;
 *   4. **empty the storage bucket** of the files this account uploaded, which
 *      no database cascade would ever reach;
 *   5. **remove the account's data**, explicitly, so that it is gone even if the
 *      last step never succeeds;
 *   6. **delete the auth user**, last, and only last.
 *
 * Every step is safe to repeat, so a failure anywhere is retried from the top
 * rather than resumed from a position somebody has to reconstruct. The one thing
 * that never happens is deleting the auth user before the rest: that is the
 * defect the old one-statement path had, and it is why a spent trial used to
 * vanish with the account that spent it.
 *
 * A failure *before* anything is destroyed puts the account back into service. A
 * failure after it does not — an account whose data is half gone must not be
 * handed back to its owner as though it were intact, so it stays closed and the
 * pipeline is run again.
 */

export type AccountDeletionFailure =
  /** No service-role client, so none of this can run. Retryable. */
  | 'unavailable'
  /** The provider refused or could not be reached. Retryable; nothing was lost. */
  | 'provider-failed'
  /** The ledger could not be written. Refused, because the trial must be kept. */
  | 'ledger-failed'
  /** The data could not be removed. Retryable; the account stays closed. */
  | 'purge-failed'
  /** Everything else succeeded but the auth user remains. Retryable. */
  | 'auth-delete-failed';

export type AccountDeletionResult =
  | { ok: true; operationId: string; trialRetained: number }
  | { ok: false; reason: AccountDeletionFailure; operationId: string | null };

/**
 * The operator's record of a run.
 *
 * Deliberately carries no address, token, digest or provider identifier — an
 * operation id, a stage, and a reason drawn from a fixed list. That is enough to
 * find a stuck deletion in the logs and nothing more.
 */
function record(stage: string, operationId: string | null, detail?: string) {
  const payload = JSON.stringify({
    event: 'account_deletion',
    stage,
    ...(operationId ? { operationId } : {}),
    ...(detail ? { detail } : {}),
  });
  if (stage.endsWith('_failed')) console.warn(payload);
  else console.info(payload);
}

/** Everything about the account the pipeline needs, read before anything is removed. */
async function readAccountSubject(userId: string) {
  const admin = createAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user) return null;
  return data.user;
}

/**
 * Remove the files this account put in the private support bucket.
 *
 * The attachment *rows* are removed by the cascade from their ticket, but the
 * objects behind them are not — they would sit in the bucket forever, holding a
 * screenshot somebody asked us to delete.
 */
async function purgeStorageObjects(userId: string): Promise<void> {
  const admin = createAdminClient();
  if (!admin) throw new Error('ACCOUNT_DELETION_UNAVAILABLE');
  const { data, error } = await admin
    .from('support_attachments')
    .select('storage_path')
    .eq('uploaded_by', userId);
  if (error) throw error;

  const paths = (data ?? [])
    .map((row) => row.storage_path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (paths.length === 0) return;

  const { error: removeError } = await admin.storage.from(SUPPORT_ATTACHMENT_BUCKET).remove(paths);
  // A path that is already gone is the expected outcome of a retry, and the
  // remove call reports it per-object rather than throwing.
  if (removeError) throw removeError;
}

/**
 * Cancel the account's live subscription, if it has one.
 *
 * Returns quietly when the deployment sells nothing, when the account never
 * bought anything, or when the subscription is already cancelled — all three are
 * "the provider has nothing left to settle", which is the state this step is
 * trying to reach.
 */
async function settleProvider(userId: string): Promise<void> {
  const admin = createAdminClient();
  if (!admin) throw new Error('ACCOUNT_DELETION_UNAVAILABLE');
  const config = getBillingConfig();
  if (!config) return;

  const { data, error } = await admin
    .from('user_subscriptions')
    .select('billing_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;

  const subscriptionId = data?.billing_subscription_id;
  if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) return;
  await cancelStripeSubscriptionForDeletion(config, subscriptionId);
}

/**
 * Run the pipeline.
 *
 * The caller has already proved, freshly, that the session belongs to this
 * account — this function does not re-derive authorization, and it must never be
 * reachable from anything that has not.
 */
export async function deleteAccount(userId: string): Promise<AccountDeletionResult> {
  const admin = createAdminClient();
  if (!admin) {
    record('unavailable_failed', null);
    return { ok: false, reason: 'unavailable', operationId: null };
  }

  const subject = await readAccountSubject(userId);
  if (!subject) {
    record('unavailable_failed', null, 'subject-unreadable');
    return { ok: false, reason: 'unavailable', operationId: null };
  }

  // 1. Close the account to new writes.
  const begun = await admin.rpc('begin_account_deletion', { input_user_id: userId });
  const state = Array.isArray(begun.data) ? begun.data[0] : null;
  if (begun.error || !state) {
    record('begin_failed', null);
    return { ok: false, reason: 'unavailable', operationId: null };
  }
  const operationId = state.operation_id ?? null;
  record(state.resumed ? 'resumed' : 'begun', operationId, state.stage ?? undefined);

  // 2. Remember the spent trial, while the subscription row still exists to
  //    prove there was one.
  let trialRetained = 0;
  try {
    const { binding } = deriveAccountIdentities(subject);
    trialRetained = await retainTrialIdentityOnDeletion({
      userId,
      identities: binding,
      trialUsed: state.trial_used === true,
    });
    record('ledger_written', operationId);
  } catch {
    record('ledger_failed', operationId);
    // Nothing has been destroyed yet, so the account goes back into service
    // rather than being left closed over a ledger we can retry.
    await Promise.resolve(admin.rpc('cancel_account_deletion', { input_user_id: userId })).catch(() => undefined);
    return { ok: false, reason: 'ledger-failed', operationId };
  }

  // 3. Settle the provider. Still nothing destroyed, so this is the last point
  //    at which the account can be handed back intact.
  try {
    await settleProvider(userId);
    await admin.rpc('advance_account_deletion', { input_user_id: userId, input_stage: 'provider_settled' });
    record('provider_settled', operationId);
  } catch {
    record('provider_failed', operationId);
    await Promise.resolve(admin.rpc('cancel_account_deletion', { input_user_id: userId })).catch(() => undefined);
    return { ok: false, reason: 'provider-failed', operationId };
  }

  // 4 & 5. From here the account is closed for good, and a failure is retried.
  try {
    await purgeStorageObjects(userId);
    const purged = await admin.rpc('purge_account_data', { input_user_id: userId });
    if (purged.error) throw purged.error;
    await admin.rpc('advance_account_deletion', { input_user_id: userId, input_stage: 'data_purged' });
    record('data_purged', operationId);
  } catch {
    record('purge_failed', operationId);
    return { ok: false, reason: 'purge-failed', operationId };
  }

  // 6. The auth user, last.
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    record('auth_delete_failed', operationId);
    return { ok: false, reason: 'auth-delete-failed', operationId };
  }

  record('completed', operationId, `identities:${trialRetained}`);
  return { ok: true, operationId: operationId ?? '', trialRetained };
}
