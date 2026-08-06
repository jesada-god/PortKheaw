/**
 * Carry a stuck account deletion forward, safely.
 *
 * The pipeline in `src/lib/account/account-deletion.ts` is resumable and every
 * step is idempotent, which is worth nothing until something notices that a run
 * stopped. An account whose data is purged but whose auth user survived a failed
 * `deleteUser` looks like an ordinary account to every ordinary query. This finds
 * those and finishes them.
 *
 *   npm run account:reconcile                      # preview, the default
 *   npm run account:reconcile -- --apply
 *   npm run account:reconcile -- --stuck-after=15min --apply
 *   npm run account:reconcile -- --user=<uuid> --apply
 *
 * What it will not do, and why each one matters:
 *
 *   * **It never returns an account to service.** Reverting is the database's
 *     decision and only at the stage where nothing has been destroyed. An account
 *     whose portfolios are half deleted must not be handed back to its owner as
 *     though it were intact.
 *   * **It never settles a payment provider.** That step needs the application's
 *     billing client, and doing it twice is a second outward-facing action against
 *     somebody's subscription. A deletion still at `requested` is reported with
 *     the instruction to re-run the in-app deletion, which is safe from the top.
 *   * **It never writes the trial ledger.** The ledger is written before the
 *     provider is settled, so anything this script can reach already has it.
 *   * **It never deletes an auth user on a stage name alone.** `data_purged` is a
 *     claim about the past; `account_residual_data_count` is a measurement of the
 *     present, and it must read zero first.
 *
 * The log is a state and an account id. Never an address, never a digest.
 */

import { createClient } from '@supabase/supabase-js';
import {
  decideAccountDeletionRecovery,
  parseAccountDeletionReportRow,
  summarizeAccountDeletionReport,
  type AccountDeletionReportRow,
} from '../src/lib/account/deletion-recovery';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const stuckAfter = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--stuck-after='));
  return flag ? flag.slice('--stuck-after='.length) : '1 hour';
})();
const onlyUser = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--user='));
  return flag ? flag.slice('--user='.length) : null;
})();

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function record(stage: string, detail: Record<string, unknown>) {
  console.info(JSON.stringify({ event: 'account_deletion_reconcile', stage, ...detail }));
}

/**
 * Remove the support-bucket objects this account uploaded.
 *
 * The same step the pipeline runs, for the same reason: the attachment rows go
 * with their ticket but the objects behind them do not, and they would sit in the
 * bucket holding a screenshot somebody asked us to delete.
 */
async function purgeStorageObjects(userId: string): Promise<number> {
  const { data, error } = await admin
    .from('support_attachments')
    .select('storage_path')
    .eq('uploaded_by', userId);
  if (error) throw error;

  const paths = (data ?? [])
    .map((row) => row.storage_path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (paths.length === 0) return 0;

  /*
   * The bucket name is re-stated rather than imported, for the same reason the
   * backfill script re-states the HMAC envelope: `src/lib/support/attachments.ts`
   * is `server-only`, which a plain Node script cannot import. A mismatch would
   * surface as a remove that deletes nothing, so it is asserted against the
   * constant in `deletion-recovery.contract.test.ts`.
   */
  const { error: removeError } = await admin.storage.from('support-attachments').remove(paths);
  if (removeError) throw removeError;
  return paths.length;
}

async function resumePurge(row: AccountDeletionReportRow): Promise<boolean> {
  try {
    const objects = await purgeStorageObjects(row.userId);
    const { error } = await admin.rpc('purge_account_data', { input_user_id: row.userId });
    if (error) throw error;
    await admin.rpc('advance_account_deletion', {
      input_user_id: row.userId, input_stage: 'data_purged',
    });
    record('purge_resumed', { userId: row.userId, storageObjects: objects });
    return true;
  } catch (error: unknown) {
    // The message only. An error object from the client can carry request detail,
    // and this script handles accounts.
    record('purge_failed', {
      userId: row.userId,
      detail: error instanceof Error ? error.message.slice(0, 120) : 'unknown error',
    });
    return false;
  }
}

/**
 * The last step, and the only destructive one taken here.
 *
 * The count is re-read immediately before the deletion rather than trusted from
 * the report: the report may be seconds old, and this is the one action that
 * cannot be undone.
 */
async function deleteAuthUser(row: AccountDeletionReportRow): Promise<boolean> {
  const { data: residual, error: countError } = await admin.rpc('account_residual_data_count', {
    input_user_id: row.userId,
  });
  if (countError || typeof residual !== 'number') {
    record('auth_delete_refused', { userId: row.userId, detail: 'residual count unreadable' });
    return false;
  }
  if (residual !== 0) {
    record('auth_delete_refused', { userId: row.userId, detail: `residual rows ${residual}` });
    return false;
  }

  // Ownership, proved from the database rather than assumed from the report: the
  // account must still exist and must still be marked as deleting.
  const { data: lifecycle, error: lifecycleError } = await admin
    .from('account_lifecycle')
    .select('status, stage')
    .eq('user_id', row.userId)
    .maybeSingle();
  if (lifecycleError || lifecycle?.status !== 'deleting' || lifecycle?.stage !== 'data_purged') {
    record('auth_delete_refused', { userId: row.userId, detail: 'lifecycle no longer says data_purged' });
    return false;
  }

  const { error } = await admin.auth.admin.deleteUser(row.userId);
  if (error) {
    record('auth_delete_failed', { userId: row.userId, detail: error.message.slice(0, 120) });
    return false;
  }
  record('auth_deleted', { userId: row.userId });
  return true;
}

async function main() {
  const { data, error } = await admin.rpc('account_deletion_report', {
    input_stuck_after: stuckAfter,
  });
  if (error) {
    console.error('Could not read the deletion report:', error.message);
    process.exit(1);
  }

  const rows = (Array.isArray(data) ? data : [])
    .map((raw) => parseAccountDeletionReportRow(raw))
    .filter((row): row is AccountDeletionReportRow => row !== null)
    .filter((row) => onlyUser === null || row.userId === onlyUser);

  const summary = summarizeAccountDeletionReport(rows);
  console.info(JSON.stringify({
    event: 'account_deletion_reconcile',
    stage: 'report',
    apply,
    stuckAfter,
    ...summary,
  }));

  if (rows.length === 0) {
    console.info('\nnothing in flight.');
    return;
  }

  let resumed = 0;
  let completed = 0;
  let refused = 0;

  for (const row of rows) {
    const decision = decideAccountDeletionRecovery(row);
    record('decision', {
      userId: row.userId,
      state: row.state,
      stuck: row.stuck,
      action: decision.action,
      reason: decision.reason,
    });

    if (decision.action === 'report-only' || decision.action === 'none') {
      refused += 1;
      continue;
    }
    if (!apply) continue;

    if (decision.action === 'resume-purge') {
      if (await resumePurge(row)) {
        resumed += 1;
        /*
         * Straight on to the last step, from a freshly measured state rather than
         * from the report we started with — the purge we just ran changed it.
         */
        const advanced: AccountDeletionReportRow = {
          ...row, state: 'awaiting_auth_delete', stage: 'data_purged', residualRows: 0,
        };
        if (await deleteAuthUser(advanced)) completed += 1;
      }
      continue;
    }

    if (decision.action === 'delete-auth-user' && await deleteAuthUser(row)) completed += 1;
  }

  console.info(JSON.stringify({
    event: 'account_deletion_reconcile',
    stage: 'done',
    apply,
    inFlight: rows.length,
    resumed,
    completed,
    refused,
  }));
  if (!apply) {
    console.info('\npreview only. Re-run with --apply to carry these forward.');
  }
}

main().catch((error: unknown) => {
  console.error('reconcile failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
