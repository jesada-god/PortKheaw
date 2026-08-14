import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The boundaries that cannot be expressed as a function call.
 *
 * A mocked Supabase cannot prove that the service role is unreachable from the
 * browser, that the deletion action takes no account argument, or that the trial
 * ledger is never handed a raw address. These read the real source and the real
 * migration, which is the only way those claims stay true after the next edit.
 */

const source = (path: string) => readFileSync(resolve(path), 'utf8');
const isImplementation = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);

const MIGRATION = source('supabase/migrations/202608060002_account_deletion_and_trial_identity.sql');
const ACTIONS = source('app/auth/actions.ts');

describe('the service role stays on the server', () => {
  it('is never reachable from anything the browser loads', () => {
    const clientSurfaces = [
      ...readdirSync(resolve('src/components/auth')).filter(isImplementation)
        .map((name) => `src/components/auth/${name}`),
      'src/lib/account/deletion-copy.ts',
    ];
    for (const path of clientSurfaces) {
      const text = source(path);
      expect(`${path}: service role`).not.toContain('SERVICE_ROLE');
      expect(text).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(text).not.toContain('createAdminClient');
      expect(text).not.toContain('auth.admin');
    }
  });

  /*
   * Every module that can reach the admin client or derive an identity digest
   * must be `server-only`, which turns a browser import into a build failure
   * rather than a shipped secret.
   */
  it('marks every privileged module server-only', () => {
    for (const path of [
      'src/lib/account/account-deletion.ts',
      'src/lib/account/reauthentication.ts',
      'src/lib/trial-identity/identity-hash.ts',
      'src/lib/trial-identity/trial-identity-store.ts',
      'src/lib/trial-identity/trial-eligibility.ts',
    ]) {
      expect(`${path}: server-only`).toContain('server-only');
      expect(source(path).startsWith(`import 'server-only';`)).toBe(true);
    }
  });

  it('grants every ledger and pipeline routine to the service role and to nobody else', () => {
    const routines = [
      'public.claim_trial_identity(uuid, text, text, smallint)',
      'public.trial_identity_is_claimed(jsonb)',
      'public.start_elite_trial_with_identity(uuid, jsonb)',
      'public.begin_account_deletion(uuid)',
      'public.advance_account_deletion(uuid, text)',
      'public.cancel_account_deletion(uuid)',
      'public.retain_trial_identity_on_deletion(uuid, jsonb, boolean)',
      'public.purge_account_data(uuid)',
    ];
    // Line breaks inside a statement are formatting, so the comparison is made
    // against a whitespace-normalized copy rather than against the layout.
    const sql = MIGRATION.replace(/\s+/g, ' ');
    for (const routine of routines) {
      expect(`${routine}: revoked`)
        .toBe(sql.includes(`revoke all on function ${routine} from public, anon, authenticated;`)
          ? `${routine}: revoked` : `${routine}: NOT revoked`);
      expect(`${routine}: granted`)
        .toBe(sql.includes(`grant execute on function ${routine} to service_role;`)
          ? `${routine}: granted` : `${routine}: NOT granted`);
    }
  });
});

describe('the deletion action', () => {
  it('takes no account identifier, so nobody can name somebody else', () => {
    const body = ACTIONS.slice(ACTIONS.indexOf('export async function deleteAccountAction'));
    expect(body).toContain('formData: FormData');
    // The subject is read from the verified session and from nothing else.
    expect(body).toContain('await supabase.auth.getUser()');
    /*
     * And then re-derived by the database, on the reader's own client, through a
     * routine that takes no account id at all. The pipeline runs on the subject
     * the *database* returned, and only after it has been checked against the
     * session — so naming somebody else would require both to agree on the lie.
     */
    expect(body).toContain("rpc('authorize_account_deletion')");
    // On the reader's own client, never the service-role one — that is what makes
    // `auth.uid()` the subject rather than an argument.
    expect(body).toMatch(/supabase\s*\n?\s*\.rpc\('authorize_account_deletion'\)/);
    expect(body).toContain('authorizedUserId !== user.id');
    expect(body).toContain('deleteAccount(authorizedUserId)');
    expect(body).not.toMatch(/formData\.get\(['"](userId|user_id|id|email)['"]\)/);
  });

  it('requires the confirmation phrase and a fresh proof of identity before it calls anything', () => {
    const body = ACTIONS.slice(
      ACTIONS.indexOf('export async function deleteAccountAction'),
      ACTIONS.indexOf('deleteAccount(authorizedUserId)'),
    );
    expect(body).toContain('DELETE_ACCOUNT_CONFIRMATION');
    expect(body).toContain('verifyPassword');
    expect(body).toContain('signInIsFresh');
  });

  it('logs nothing at all from the file that handles passwords', () => {
    expect(ACTIONS).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it('no longer reaches for the one-statement delete it used to call', () => {
    expect(ACTIONS).not.toContain('delete_own_account');
  });
});

describe('the ledger never holds a raw identity', () => {
  it('constrains the stored value to a hex digest', () => {
    expect(MIGRATION).toContain(`identity_hash ~ '^[0-9a-f]{64}$'`);
  });

  /*
   * The address is canonicalized, hashed and discarded inside one expression.
   * Nothing on the way to the database keeps it, and nothing logs it.
   */
  it('sends only digests to the database, and logs neither address nor digest', () => {
    const store = source('src/lib/trial-identity/trial-identity-store.ts');
    expect(store).toContain('identities.map(({ type, hash, version }) => ({ type, hash, version }))');
    expect(store).not.toMatch(/console\./);
    expect(source('src/lib/trial-identity/identity-hash.ts')).not.toMatch(/console\./);

    const pipeline = source('src/lib/account/account-deletion.ts');
    // The pipeline logs a stage and an operation id. Never a subject's details.
    expect(pipeline).not.toMatch(/console\.(info|warn)\([^)]*email/i);
    expect(pipeline).not.toMatch(/console\.(info|warn)\([^)]*hash/i);
  });

  it('keys the digest with a secret that only the server environment holds', () => {
    expect(source('src/config/env/server.ts')).toContain('TRIAL_IDENTITY_HMAC_SECRET');
    // A `NEXT_PUBLIC_` twin would inline the key into the browser bundle.
    expect(source('src/config/env/client.ts')).not.toContain('TRIAL_IDENTITY');
  });
});

describe('the trial can no longer be granted around the ledger', () => {
  it('closes the argument-free grant a browser could call directly', () => {
    expect(MIGRATION).toContain('revoke execute on function public.start_elite_trial() from authenticated;');
  });

  it('routes the only remaining grant through the one eligibility service', () => {
    const action = source('app/settings/subscription/actions.ts');
    expect(action).toContain('resolveTrialEligibility()');
    expect(action).toContain('claimAndStartEliteTrial(eligibility.userId, eligibility.identities)');
    // The old direct path is gone, so there is no second way to spend a trial.
    expect(action).not.toContain('startEliteTrial()');
  });

  it('offers the trial from the same answer the action refuses with', () => {
    const page = source('app/settings/subscription/page.tsx');
    expect(page).toContain('resolveTrialEligibility()');
    expect(page).toContain('trialBlockedReason={trialBlockedReason}');
  });
});
