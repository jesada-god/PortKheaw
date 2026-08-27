import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SUPPORT_ATTACHMENT_BUCKET } from '@/src/lib/support/attachments';
import { resolveTrialIdentityKeyring } from '@/src/lib/trial-identity/keyring';

/**
 * The properties of the operator tooling that cannot be expressed as a function
 * call.
 *
 * These three scripts run as `service_role` against production with no UI in
 * front of them, so what they *cannot* do is the whole of their safety, and every
 * one of those refusals lives in control flow rather than in a value some test
 * could pass in. What is checkable is the source: that the dangerous call is not
 * present, that the default is a preview, that nothing logs an address, and that
 * the two values re-stated outside their `server-only` homes still match them.
 */

const source = (path: string) => readFileSync(resolve(path), 'utf8');

const RECONCILE = source('scripts/reconcile-account-deletions.ts');
const QA_CLEANUP = source('scripts/trial-qa-cleanup.ts');
const RETENTION_PROBE = source('scripts/probe-trial-retention.ts');
const BACKFILL = source('scripts/backfill-trial-identities.ts');

describe('the reconciler', () => {
  /*
   * The refusal that matters most. An account whose data is half gone must not be
   * handed back to its owner as though it were intact, so the routine that would
   * do it is not called from here at all — there is no flag, and no branch.
   */
  it('cannot return an account to service, because it never calls the routine that would', () => {
    expect(RECONCILE).not.toContain('cancel_account_deletion');
    expect(RECONCILE).not.toMatch(/status:\s*'active'/);
  });

  /*
   * Settling a provider twice is a second outward-facing action against somebody's
   * subscription, and re-writing the ledger would be a claim written by a script
   * that never derived it.
   */
  it('never settles a payment provider or writes the trial ledger', () => {
    for (const forbidden of [
      'cancelStripeSubscriptionForDeletion',
      'stripe',
      'retain_trial_identity_on_deletion',
      'claim_trial_identity',
      'begin_account_deletion',
    ]) {
      expect(`reconciler: ${forbidden}`)
        .toBe(RECONCILE.toLowerCase().includes(forbidden.toLowerCase())
          ? `reconciler CALLS ${forbidden}`
          : `reconciler: ${forbidden}`);
    }
  });

  /*
   * The count is re-read immediately before the irreversible step rather than
   * trusted from a report that may be seconds old.
   */
  it('re-measures the purge before it deletes an auth user', () => {
    const body = RECONCILE.slice(RECONCILE.indexOf('async function deleteAuthUser'));
    const guard = body.slice(0, body.indexOf('auth.admin.deleteUser'));
    expect(guard).toContain('account_residual_data_count');
    expect(guard).toContain('residual !== 0');
    // …and confirms the account is still the one the report described.
    expect(guard).toContain("eq('user_id', row.userId)");
    expect(guard).toContain("lifecycle?.stage !== 'data_purged'");
  });

  it('previews by default and needs an explicit flag to act', () => {
    expect(RECONCILE).toContain("const apply = process.argv.includes('--apply')");
    expect(RECONCILE).toContain('if (!apply) continue;');
  });

  it('logs a state and an account, never an address or a digest', () => {
    const logged = [...RECONCILE.matchAll(/console\.(?:info|warn|error)\(([\s\S]*?)\);/g)]
      .map((match) => match[1]);
    expect(logged.length).toBeGreaterThan(3);
    for (const line of logged) {
      expect(line).not.toMatch(/\bemail\b/i);
      expect(line).not.toMatch(/\bhash\b/i);
      expect(line).not.toMatch(/identity_hash/);
    }
  });

  /*
   * The bucket name is re-stated because its module is `server-only` and a plain
   * Node script cannot import it. A drift would surface as a remove that silently
   * deletes nothing, so it is pinned here.
   */
  it('empties the same storage bucket the application uploads to', () => {
    expect(RECONCILE).toContain(`from('${SUPPORT_ATTACHMENT_BUCKET}')`);
  });
});

describe('the QA cleanup', () => {
  it('previews by default', () => {
    expect(QA_CLEANUP).toContain("const apply = process.argv.includes('--apply')");
    expect(QA_CLEANUP).toContain('preview only.');
  });

  /*
   * It deletes through one routine whose predicate is `claim_origin =
   * 'production_qa'`, so "QA-owned only" is enforced in SQL rather than in
   * argument-building here — which is what makes it provable.
   */
  /*
   * It reaches the table only through routines whose own predicate is
   * `claim_origin = 'production_qa'`. It builds no query of its own — no
   * `from(…)`, no `delete()` — so "QA-owned only" is enforced in SQL, where it can
   * be proved, rather than in argument-building here, where it could be mistyped.
   */
  it('deletes only through the origin-constrained routine, never with its own query', () => {
    expect(QA_CLEANUP).toContain('delete_qa_trial_identity_claims');
    expect(QA_CLEANUP).not.toMatch(/admin\.from\(/);
    expect(QA_CLEANUP).not.toMatch(/\.delete\(\)/);

    /*
     * THE LIST GREW BY TWO, and the property it protects is unchanged: every
     * name here is a routine whose own body decides what it may touch, and the
     * command still builds no query of its own.
     *
     * The command now also sweeps the ACCOUNTS the browser QA leaves behind, and
     * an auth user cannot be deleted before its data is — `portfolios` cascades
     * from `auth.users` while `portfolio_transactions` is `on delete restrict`,
     * so a bare `deleteUser` raises 23503 and fails. `purge_account_data` is the
     * routine that knows the order (the same one `deleteAccount` calls), and
     * `account_residual_data_count` is asked afterwards whether it worked: a
     * non-zero answer leaves the auth user in place, because once it is gone the
     * rows it left behind belong to nobody.
     *
     * Both are `security definer` and both take only a user id. Neither is a
     * query this file assembled, which is the distinction the test exists for.
     */
    const calls = [...QA_CLEANUP.matchAll(/admin\.rpc\('([a-z_]+)'/g)].map((match) => match[1]);
    expect([...new Set(calls)].sort()).toEqual([
      'account_residual_data_count',
      'delete_qa_trial_identity_claims',
      'mark_trial_identity_claim_origin',
      'purge_account_data',
    ]);
  });

  /*
   * The auth user goes LAST, and only over a proved-empty account. Asserted on
   * the source because the ordering is the whole fix: the previous version
   * deleted the user first and reported four failures whose message was "{}".
   */
  it('purges the data before it deletes the auth user, and proves it emptied', () => {
    const purgeAt = QA_CLEANUP.indexOf("admin.rpc('purge_account_data'");
    const countAt = QA_CLEANUP.indexOf("admin.rpc('account_residual_data_count'");
    const deleteAt = QA_CLEANUP.indexOf('/auth/v1/admin/users/');
    expect(purgeAt).toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(purgeAt);
    expect(deleteAt).toBeGreaterThan(countAt);
    expect(QA_CLEANUP).toMatch(/row\(s\) still present after the purge/);
  });

  /*
   * A failure has to be readable. `auth.admin.deleteUser` reports a GoTrue 500
   * as an `AuthRetryableFetchError` whose `message` is the string "{}" — which
   * is what this command printed for four accounts while the real answer was a
   * plain foreign-key violation. The status line and the body are the diagnosis,
   * so the delete goes through the raw endpoint.
   */
  it('reports a failed delete with its status and body, never a stringified error', () => {
    expect(QA_CLEANUP).toMatch(/response\.status/);
    expect(QA_CLEANUP).toMatch(/await response\.text\(\)/);
    expect(QA_CLEANUP).not.toMatch(/JSON\.stringify\((error|cause|failure)\b/);
    /*
     * Comments stripped: the block above the fetch names `auth.admin.deleteUser`
     * to explain why it is NOT used, and a source-reading test that could not
     * tell the note from the call would forbid recording the reason.
     */
    const code = QA_CLEANUP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/auth\.admin\.deleteUser/);
  });

  /*
   * Relabelling takes ids and validates their shape. A predicate — "everything
   * claimed since Tuesday" — would be a guess about which rows are ours, and a
   * wrong guess deletes a person's record three years early.
   */
  it('relabels only explicitly named claim ids, validated as UUIDs', () => {
    expect(QA_CLEANUP).toContain('mark_trial_identity_claim_origin');
    expect(QA_CLEANUP).toMatch(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
    // The ids come from the flag and from nowhere else — never from a query the
    // script ran to decide for itself which rows look like ours.
    expect(QA_CLEANUP).toContain("input_claim_ids: markIds");
    expect(QA_CLEANUP).toContain("--mark=");
  });
});

describe('the retention probe', () => {
  it('reads and never writes', () => {
    for (const forbidden of [
      'purge_expired_trial_identity_claims',
      'set_trial_identity_legal_hold',
      'mark_trial_identity_claim_origin',
      'delete_qa_trial_identity_claims',
      'deleteUser',
    ]) {
      expect(RETENTION_PROBE).not.toContain(forbidden);
    }
    // The only routines it calls are the two `stable` reports.
    expect(RETENTION_PROBE).toContain('trial_retention_status');
    expect(RETENTION_PROBE).toContain('account_deletion_report');
  });

  /*
   * Version numbers are what an operator needs; a key, or even its length, is
   * neither needed nor safe to print into a terminal somebody may paste.
   */
  it('reports key versions and never a key or its length', () => {
    expect(RETENTION_PROBE).toContain('keyring.supportedVersions');
    expect(RETENTION_PROBE).not.toContain('secretFor');
    expect(RETENTION_PROBE).not.toContain('process.env.TRIAL_IDENTITY_HMAC_SECRET');
  });

  it('checks that a browser key still cannot read any of the three tables', () => {
    for (const table of ['trial_identity_claims', 'trial_retention_config', 'trial_retention_runs']) {
      expect(RETENTION_PROBE).toContain(table);
    }
    expect(RETENTION_PROBE).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  });
});

describe('the backfill', () => {
  /*
   * The HMAC envelope is re-stated in the script because `identity-hash.ts` is
   * `server-only`. This derives the same identity both ways and requires the two
   * digests to be equal — which is the only thing that keeps a backfilled claim
   * findable by the application that has to refuse a trial because of it.
   */
  it('derives the same digest the application does', async () => {
    const secret = 'a-backfill-contract-key-long-enough';
    const keyring = resolveTrialIdentityKeyring({ TRIAL_IDENTITY_HMAC_SECRET_V1: secret });
    expect(keyring.ok).toBe(true);
    if (!keyring.ok) return;

    const envelope = [...BACKFILL.matchAll(/\.update\(`([^`]+)`\)/g)].map((match) => match[1]);
    expect(envelope).toEqual(['portkheaw:trial-identity:v${HASH_VERSION}:${type}:${canonicalValue}']);

    const fromScript = createHmac('sha256', secret)
      .update(`portkheaw:trial-identity:v${keyring.activeVersion}:email:reader@example.com`)
      .digest('hex');

    vi.resetModules();
    vi.stubEnv('TRIAL_IDENTITY_HMAC_SECRET', '');
    vi.stubEnv('TRIAL_IDENTITY_HMAC_SECRET_V1', secret);
    const { emailTrialIdentity } = await import('@/src/lib/trial-identity/identity-hash');
    expect(emailTrialIdentity('reader@example.com')!.hash).toBe(fromScript);
    vi.unstubAllEnvs();
  });

  it('writes the active version and labels its own claims', () => {
    expect(BACKFILL).toContain('const HASH_VERSION = keyring.activeVersion');
    expect(BACKFILL).toContain("input_origin: 'backfill'");
  });

  it('refuses to run at all on an unusable keyring', () => {
    expect(BACKFILL).toContain('if (!keyring.ok)');
    expect(BACKFILL).toContain('process.exit(1)');
  });
});
