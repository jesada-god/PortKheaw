/**
 * Remove what our own Production QA left behind — and provably nothing else.
 *
 * TWO KINDS OF RESIDUE, one command, the same rule for both.
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
 * THE SECOND KIND: QA ACCOUNTS. The browser QA runs sign in as real accounts,
 * so they create real users — `qa:phase1-ux` alone makes two per run, one Elite
 * and one Pro, and it has never deleted them. They are labelled at creation
 * with `user_metadata.qa_owner`, and that label is what this sweeps.
 *
 * IT IS DELIBERATELY NOT A PREDICATE OVER TIME OR SHAPE. An account must carry
 * one of the tags in `QA_OWNERS` AND hold a `@example.com` address — a reserved
 * domain nobody receives mail at. Both, never either: a tag can be typed into
 * metadata by hand, and an address could in principle belong to something else,
 * but nothing that is not ours carries both. That is the same standard `--mark`
 * holds for claims — prove it is ours, or leave it alone.
 *
 * Deleting the account is what removes its portfolios, watchlists and alerts;
 * they go by foreign key, so this command issues no delete against a data table.
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

/*
 * The two settings again, past the guard above, so the direct admin-API call in
 * `removeQaAccount` has them as plain strings. The guard exits, but a `const`
 * read out of `process.env` is still `string | undefined` inside a function
 * declared after it.
 */
const SUPABASE_URL: string = url;
const SERVICE_ROLE_KEY: string = serviceRoleKey;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * The QA runs whose accounts this command owns.
 *
 * One entry per script that creates users, using the exact string that script
 * writes into `user_metadata.qa_owner`. A run whose tag is not listed is not
 * swept: adding a browser QA means adding its tag on purpose, in a diff
 * somebody reviewed, rather than a sweep quietly widening to fit.
 */
const QA_OWNERS = ['phase1-ux-qa'] as const;

/** Reserved domain, so a candidate cannot be an address anybody receives mail at. */
const QA_EMAIL_DOMAIN = '@example.com';

interface AdminUser {
  id: string;
  email?: string | null;
  user_metadata?: { qa_owner?: unknown } | null;
}

/** Every account carrying one of our tags AND a reserved address. Paged. */
async function findQaAccounts(): Promise<AdminUser[]> {
  const owners = new Set<string>(QA_OWNERS);
  const found: AdminUser[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list accounts: ${error.message}`);
    const users = (data?.users ?? []) as AdminUser[];
    for (const user of users) {
      const owner = user.user_metadata?.qa_owner;
      if (typeof owner !== 'string' || !owners.has(owner)) continue;
      if (!user.email?.endsWith(QA_EMAIL_DOMAIN)) continue;
      found.push(user);
    }
    if (users.length < 200) break;
  }
  return found;
}

/**
 * Delete one QA account, in the order the account-deletion pipeline uses.
 *
 * THE DATA FIRST, THE AUTH USER LAST. Deleting the auth user on its own cannot
 * work and never could: GoTrue cascades into `public.portfolios`, and
 * `portfolio_transactions_portfolio_id_fkey` is `on delete restrict`, so the
 * cascade stops on the ledger and the whole delete fails with 23503. The first
 * version of this sweep did exactly that against four accounts and reported
 * four failures.
 *
 * `purge_account_data` is the routine that knows the order — it is the same one
 * `deleteAccount` calls at step 4, it is `security definer`, and it is the
 * reason nothing here issues a delete against a data table by hand.
 *
 * `account_residual_data_count` is then asked whether the purge actually
 * emptied the account, and a non-zero answer stops the sweep for that account.
 * That is the rule the deletion reconciler already follows: an auth user is not
 * removed over rows that are still there, because once it is gone those rows
 * belong to nobody and nothing will come back for them.
 */
async function removeQaAccount(account: AdminUser): Promise<string | null> {
  const label = account.email ?? account.id;

  const purged = await admin.rpc('purge_account_data', { input_user_id: account.id });
  if (purged.error) {
    return `${label}: purge failed [${purged.error.code ?? 'no-code'}] ${purged.error.message}`;
  }

  const residual = await admin.rpc('account_residual_data_count', { input_user_id: account.id });
  if (residual.error) {
    return `${label}: residual count failed [${residual.error.code ?? 'no-code'}] ${residual.error.message}`;
  }
  if (typeof residual.data === 'number' && residual.data > 0) {
    return `${label}: ${residual.data} row(s) still present after the purge — auth user left in place`;
  }

  /*
   * The raw admin endpoint rather than `auth.admin.deleteUser`, because the
   * supabase-js error is not readable: a 500 from GoTrue arrives as
   * `AuthRetryableFetchError` whose `message` is the string "{}", which is what
   * put "{}" in this command's own failure report and hid a plain foreign-key
   * violation for a full run. The status line and the body are the diagnosis.
   */
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${account.id}`, {
    method: 'DELETE',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    const body = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 400);
    return `${label}: HTTP ${response.status} ${response.statusText} ${body || '(empty body)'}`;
  }
  return null;
}

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

  /*
   * The accounts are previewed in the same breath as the claims, so an operator
   * sees both before either is touched, and `--apply` covers both or neither.
   */
  const accounts = await findQaAccounts();
  console.info(JSON.stringify({
    event: 'trial_qa_cleanup',
    stage: 'accounts_preview',
    owners: QA_OWNERS,
    deletable: accounts.length,
    emails: accounts.map((account) => account.email),
  }));

  if (!apply) {
    console.info('\npreview only. Re-run with --apply to delete the QA-owned claims and accounts above.');
    return;
  }

  let deletedAccounts = 0;
  const failedAccounts: string[] = [];
  for (const account of accounts) {
    const failure = await removeQaAccount(account);
    if (failure) failedAccounts.push(failure);
    else deletedAccounts += 1;
  }
  console.info(JSON.stringify({
    event: 'trial_qa_cleanup',
    stage: 'accounts_applied',
    deleted: deletedAccounts,
    failed: failedAccounts,
  }));

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
