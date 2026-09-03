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
 *   npm run trial:qa-cleanup -- --user=<uuid> --apply     # one account only
 *   npm run trial:qa-cleanup -- --orphan=<uuid> --apply   # one UNOWNED account
 *
 * THE SECOND KIND: QA ACCOUNTS. The browser QA runs sign in as real accounts,
 * so they create real users — `qa:phase1-ux` alone makes two per run, one Elite
 * and one Pro, and it has never deleted them. They are labelled at creation
 * with `user_metadata.qa_owner`, and that label is what this sweeps.
 *
 * IT IS DELIBERATELY NOT A PREDICATE OVER TIME OR SHAPE. An account must carry
 * one of the tags in the shared owner registry AND hold a `@example.com` address — a reserved
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
import { QA_EMAIL_DOMAIN, QA_OWNER_TAGS } from './qa/qa-accounts.mjs';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const apply = process.argv.includes('--apply');

/**
 * `--user=<uuid>`: act on ONE account and refuse the rest.
 *
 * The account sweep is the only part of this command that touches somebody's
 * rows, and recovering a stuck deletion is a per-account decision — the plan in
 * PLAN.md §7 requires it, and `account:reconcile` already spells the flag this
 * way. Without it the only options were "all of them" or "edit the source",
 * which is not a choice anybody should have to make against production.
 *
 * The narrowing is applied AFTER the owner and mailbox rules, never instead of
 * them: naming an id that is not a QA account selects nothing.
 */
const onlyUser = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--user='));
  if (!flag) return null;
  const value = flag.slice('--user='.length).trim();
  if (!UUID_PATTERN.test(value)) {
    console.error(`--user must be a uuid; got ${JSON.stringify(value)}`);
    process.exit(1);
  }
  return value.toLowerCase();
})();
/**
 * `--orphan=<uuid>[,<uuid>]`: collect residue the OWNER RULE CANNOT REACH.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN PRODUCTION THAT THE SWEEP ABOVE WILL NEVER TOUCH
 * ---------------------------------------------------------------------------
 * Four accounts, all on the reserved domain, none of them collectable by tag:
 *
 *     codex-portfolio-1785446418580@example.com   qa_owner absent
 *     codex-phase3-1785714976201@example.com      qa_owner absent
 *     hydration.locate.1786076018112@example.com  qa_owner "hydration-locate"
 *     sim.probe.1786893723382@example.com         qa_owner "sim-probe"
 *
 * The first two were made by something that never stamped an owner. The last
 * two were stamped by scripts that are NOT IN THIS REPOSITORY — no file writes
 * either tag, at this commit or any other — so they are throwaways whose maker
 * is gone.
 *
 * Registering those two tags would be the obvious fix and it is the wrong one:
 * `qa-accounts.test.ts` requires a script behind every registered tag, because
 * a tag with no creator is a sweep hunting accounts nothing makes, and the next
 * reader would have no way to learn that the entry is dead. The residue is
 * historical; the mechanism must not be widened to fit history.
 *
 * ---------------------------------------------------------------------------
 * WHY IDS, AND ONLY IDS
 * ---------------------------------------------------------------------------
 * This is the same standard `--mark` holds for claims: name the rows, never a
 * predicate. "Every unowned @example.com account" is a predicate, and a
 * predicate is a guess about which rows are somebody's — so what this flag
 * takes is uuids an operator has read out of the `unowned_preview` line below
 * and typed on purpose, one run at a time.
 *
 * Three further refusals, all in `main`:
 *
 *   * the account must hold a `@example.com` address — the reserved domain,
 *     which nobody receives mail at, so it cannot be a reader;
 *   * it must NOT carry a registered owner. An account the ordinary sweep can
 *     already collect goes through the ordinary sweep, where the proof is
 *     stronger, rather than through the flag that skips the tag rule;
 *   * an id that matches no account at all stops the run rather than being
 *     counted as done.
 *
 * And it is EXCLUSIVE: a run with `--orphan` acts on the named ids and does
 * nothing else — no owner sweep, no claim delete. Collecting residue by hand is
 * a deliberate act, and it must not quietly carry a bulk delete alongside it.
 *
 * Deletion goes through `removeQaAccount` like everything else here, so these
 * accounts get the dependency-ordered purge and the residual-count check rather
 * than a bare auth delete.
 */
const orphanIds = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--orphan='));
  if (!flag) return [] as string[];
  const values = flag.slice('--orphan='.length).split(',').map((value) => value.trim()).filter(Boolean);
  const malformed = values.filter((value) => !UUID_PATTERN.test(value));
  if (values.length === 0 || malformed.length > 0) {
    console.error(`--orphan takes account uuids; could not read ${JSON.stringify(malformed.join(',') || '')}`);
    process.exit(1);
  }
  return values.map((value) => value.toLowerCase());
})();

const markIds = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--mark='));
  if (!flag) return [] as string[];
  return flag
    .slice('--mark='.length)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => UUID_PATTERN.test(value));
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
 * The QA runs whose accounts this command owns — IMPORTED, never restated.
 *
 * This list used to be written here, `['phase1-ux-qa']`, one entry against the
 * nine tags the QA scripts actually stamp. The sweep was therefore correct and
 * useless at the same time: it reported "0 deletable" while twelve QA accounts
 * from eight other runs sat in production, because a tag it has never been told
 * about is indistinguishable from no account at all.
 *
 * The two lists could drift because they WERE two lists. There is now one, in
 * `scripts/qa/qa-accounts.mjs` beside the teardown that makes the accounts, and
 * `qa-accounts.test.ts` fails if any script stamps a tag that is not in it.
 * Adding a QA script still means adding its tag on purpose, in a diff somebody
 * reviewed — it just cannot be done in a way that leaves this sweep behind.
 *
 * The mailbox domain comes from the same module for the same reason: the rule
 * below is tag AND domain, so a script stamping a registered tag onto an
 * address outside the reserved domain would make an account nothing collects.
 */

interface AdminUser {
  id: string;
  email?: string | null;
  user_metadata?: { qa_owner?: unknown } | null;
}

/** Every account carrying one of our tags AND a reserved address. Paged. */
async function findQaAccounts(): Promise<AdminUser[]> {
  const owners = new Set<string>(QA_OWNER_TAGS);
  const found: AdminUser[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list accounts: ${error.message}`);
    const users = (data?.users ?? []) as AdminUser[];
    for (const user of users) {
      const owner = user.user_metadata?.qa_owner;
      if (typeof owner !== 'string' || !owners.has(owner)) continue;
      if (!user.email?.endsWith(QA_EMAIL_DOMAIN)) continue;
      // The narrowing goes here, past both proofs, never in place of them.
      if (onlyUser && user.id.toLowerCase() !== onlyUser) continue;
      found.push(user);
    }
    if (users.length < 200) break;
  }
  return found;
}

/**
 * Every account on the reserved domain that the OWNER RULE CANNOT REACH.
 *
 * A `@example.com` address whose `qa_owner` is missing, or is a tag no script
 * in this repository writes. These are reported and never deleted by `--apply`:
 * the point is that residue the sweep cannot collect stops being invisible.
 * `"deletable": 0` was a true sentence about the owner list and a false one
 * about the database, and this is the line that would have said so.
 */
async function findUnownedQaAccounts(): Promise<{ account: AdminUser; owner: string | null }[]> {
  const owners = new Set<string>(QA_OWNER_TAGS);
  const found: { account: AdminUser; owner: string | null }[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list accounts: ${error.message}`);
    const users = (data?.users ?? []) as AdminUser[];
    for (const user of users) {
      if (!user.email?.endsWith(QA_EMAIL_DOMAIN)) continue;
      const owner = user.user_metadata?.qa_owner;
      if (typeof owner === 'string' && owners.has(owner)) continue;
      found.push({ account: user, owner: typeof owner === 'string' ? owner : null });
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
  /*
   * The orphan path runs FIRST and returns, because it is exclusive: naming ids
   * by hand must not also fire the bulk sweep further down.
   */
  if (orphanIds.length > 0) {
    const unowned = await findUnownedQaAccounts();
    const byId = new Map(unowned.map((entry) => [entry.account.id.toLowerCase(), entry]));
    /*
     * ALL the ids are resolved before ANY of them is deleted, and a single
     * unresolvable one stops the whole run. Deleting the first two of three and
     * then refusing the third would leave an operator having to work out which
     * half happened.
     *
     * `process.exitCode` rather than `process.exit()`, because the accounts have
     * just been listed over HTTP and exiting on top of an undici handle that is
     * still closing aborts the process with a libuv assertion instead of a
     * refusal anybody can read.
     */
    const selected = orphanIds.map((id) => byId.get(id)).filter((entry) => entry !== undefined);
    if (selected.length !== orphanIds.length) {
      for (const id of orphanIds.filter((candidate) => !byId.has(candidate))) {
        console.error(
          `--orphan ${id} is not an unowned QA account: it is either not on ${QA_EMAIL_DOMAIN}, `
          + `carries a registered qa_owner (use the ordinary sweep for those), or does not exist.`,
        );
      }
      console.error('Nothing was deleted.');
      process.exitCode = 1;
      return;
    }
    console.info(JSON.stringify({
      event: 'trial_qa_cleanup',
      stage: 'orphan_preview',
      accounts: selected.map((entry) => ({
        id: entry.account.id, email: entry.account.email, qaOwner: entry.owner,
      })),
    }));
    if (!apply) {
      console.info('\npreview only. Re-run with --apply to delete the account(s) above.');
      return;
    }
    let deleted = 0;
    const failed: string[] = [];
    for (const entry of selected) {
      const failure = await removeQaAccount(entry.account);
      if (failure) failed.push(failure);
      else deleted += 1;
    }
    console.info(JSON.stringify({
      event: 'trial_qa_cleanup', stage: 'orphan_applied', deleted, failed,
    }));
    if (failed.length > 0) process.exitCode = 1;
    return;
  }

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
    owners: QA_OWNER_TAGS,
    scopedToUser: onlyUser,
    deletable: accounts.length,
    emails: accounts.map((account) => account.email),
  }));

  /*
   * The residue the owner rule cannot reach, printed on EVERY run and deleted
   * by none of them. `--apply` does not touch these; `--orphan=<uuid>` does,
   * one named id at a time, and this line is where the operator reads the ids.
   */
  const unowned = await findUnownedQaAccounts();
  console.info(JSON.stringify({
    event: 'trial_qa_cleanup',
    stage: 'unowned_preview',
    note: 'not deleted by --apply; collect one at a time with --orphan=<uuid> --apply',
    count: unowned.length,
    accounts: unowned.map((entry) => ({
      id: entry.account.id, email: entry.account.email, qaOwner: entry.owner,
    })),
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
