/**
 * Remove the claims our own Production QA left behind — and provably nothing else.
 *
 * Every QA run that proves the trial ledger works has to spend a real trial on a
 * real mailbox, which leaves a real claim. Those claims must keep blocking while
 * the test runs, and they must not sit in the table for three years pretending to
 * be somebody. So they are labelled `production_qa` when they are created, and
 * this is the only thing that deletes them.
 *
 *   npm run trial:qa-cleanup                # preview, the default
 *   npm run trial:qa-cleanup -- --apply
 *   npm run trial:qa-cleanup -- --mark=<claim-id>,<claim-id> --apply
 *
 * Three constraints, enforced in the database rather than here:
 *
 *   * only rows whose origin is `production_qa`;
 *   * never a row under a live legal hold;
 *   * never a row a live account still holds — that row belongs to an account
 *     that exists and goes when the account does.
 *
 * `--mark` relabels claims whose origin has been **proved** from operation
 * metadata — a QA run's own recorded claim ids. It takes ids and never a predicate
 * like "everything since Tuesday", because a guess about which rows are ours is a
 * guess about which rows are somebody's. Rows whose origin cannot be proved stay
 * `user`, which is the reading with the longest protection and the one this
 * command will not touch.
 *
 * It prints counts and claim ids. It never prints a digest — and the routines it
 * calls never return one.
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const markIds = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--mark='));
  if (!flag) return [] as string[];
  return flag
    .slice('--mark='.length)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
})();

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface QaCleanupResult {
  matched: number;
  deleted: number;
  skipped_legal_hold: number;
  skipped_active_holder: number;
}

async function main() {
  if (markIds.length > 0) {
    if (!apply) {
      console.info(JSON.stringify({
        event: 'trial_qa_cleanup',
        stage: 'mark_preview',
        claimIds: markIds,
        note: 'add --apply to relabel these as production_qa',
      }));
    } else {
      const { data, error } = await admin.rpc('mark_trial_identity_claim_origin', {
        input_claim_ids: markIds,
        input_origin: 'production_qa',
      });
      if (error) {
        console.error('Could not relabel the claims:', error.message);
        process.exit(1);
      }
      console.info(JSON.stringify({
        event: 'trial_qa_cleanup',
        stage: 'marked',
        claimIds: markIds,
        relabelled: typeof data === 'number' ? data : 0,
      }));
    }
  }

  // The preview always runs, including before an apply, so the counts an operator
  // is about to act on are printed rather than assumed.
  const preview = await admin.rpc('delete_qa_trial_identity_claims', { input_apply: false });
  if (preview.error) {
    console.error('Could not read the QA claims:', preview.error.message);
    process.exit(1);
  }
  const previewRow = (Array.isArray(preview.data) ? preview.data[0] : preview.data) as QaCleanupResult | null;
  console.info(JSON.stringify({
    event: 'trial_qa_cleanup',
    stage: 'preview',
    deletable: previewRow?.matched ?? 0,
    skippedLegalHold: previewRow?.skipped_legal_hold ?? 0,
    skippedActiveHolder: previewRow?.skipped_active_holder ?? 0,
  }));

  if (!apply) {
    console.info('\npreview only. Re-run with --apply to delete the QA-owned claims above.');
    return;
  }

  const applied = await admin.rpc('delete_qa_trial_identity_claims', { input_apply: true });
  if (applied.error) {
    console.error('Could not delete the QA claims:', applied.error.message);
    process.exit(1);
  }
  const appliedRow = (Array.isArray(applied.data) ? applied.data[0] : applied.data) as QaCleanupResult | null;
  console.info(JSON.stringify({
    event: 'trial_qa_cleanup',
    stage: 'applied',
    deleted: appliedRow?.deleted ?? 0,
    skippedLegalHold: appliedRow?.skipped_legal_hold ?? 0,
    skippedActiveHolder: appliedRow?.skipped_active_holder ?? 0,
  }));
}

main().catch((error: unknown) => {
  console.error('QA cleanup failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
