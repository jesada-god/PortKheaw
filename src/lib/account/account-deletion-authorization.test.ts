import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The database's own gate in front of account deletion, run against a real
 * Postgres.
 *
 * Deletion is the one reader-initiated write that runs on the service-role
 * client: not bounded by row-level security, and not bounded by the lockdown
 * triggers, which sit on the tables where privilege lives and not on the tables
 * a deletion empties. Until this routine existed the only thing in front of it
 * was an application check that fails *open* on a database error.
 *
 * These tests are written from the attacker's side. They do not click the
 * confirmation dialog or post the form; they call the routine directly, the way
 * anything that had gotten past the application would, and assert the answers:
 *
 *   * a caller with no session authorizes nothing;
 *   * a caller cannot name an account — there is no argument to name one with;
 *   * a caller with a session gets their own id back and never another's;
 *   * while the incident switch is on, nobody starts a deletion;
 *   * releasing the switch restores ordinary deletion;
 *   * a token that outlived its user authorizes nothing;
 *   * authorizing destroys nothing by itself.
 */

const MIGRATION_FILE = '202608140002_account_deletion_authorization.sql';

const MIGRATION_CHAIN = [
  '202607180001_phase_1_auth.sql',
  '202607180003_phase_3_watchlist.sql',
  '202607180004_phase_4_portfolio_core.sql',
  '202607180005_phase_4_portfolio_options.sql',
  '202607180006_portfolio_currency_summary.sql',
  '202607180009_phase_7_alerts_notifications.sql',
  '202607180010_phase_9_background_alerts_push.sql',
  '202607300001_portfolio_ledger_source_of_truth.sql',
  '202607310001_portfolio_option_symbol_resolution.sql',
  '202607310002_multi_portfolios.sql',
  '202607310003_portfolio_bangkok_transaction_date.sql',
  '202608020001_notification_preferences.sql',
  '202608020002_transfer_cash_lint.sql',
  '202608020008_subscription_entitlements.sql',
  '202608030001_elite_trial_and_read_only.sql',
  '202608030002_admin_role_and_access_preview.sql',
  '202608030003_billing_subscriptions.sql',
  '202608040001_effective_access_tier.sql',
  '202608040002_live_billing_readiness.sql',
  '202608040003_prevent_billing_mode_downgrade.sql',
  '202608050001_promptpay_invoice_subscriptions.sql',
  '202608050003_operations_support_and_trust.sql',
  '202608050004_audit_allows_parent_cascade.sql',
  '202608050005_admin_thread_audit.sql',
  '202608050006_admin_search_email_cast.sql',
  '202608050007_admin_beta_and_production_safety.sql',
  '202608060001_purchase_consent_and_refund_window.sql',
  '202608060002_account_deletion_and_trial_identity.sql',
  '202608070003_maintenance_and_release_notes.sql',
  '202608140001_security_lockdown_and_audit.sql',
  MIGRATION_FILE,
];

/** The owner UUID the admin migration seeds; its account must exist first. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
/** A subject that never existed in `auth.users`. */
const GHOST = '44444444-4444-4444-8444-444444444444';

let db: PGlite;

async function as(userId: string | null): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ''}', false)`);
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

async function setLockdown(enabled: boolean): Promise<void> {
  await as(null);
  await query('update public.app_runtime_settings set security_lockdown_enabled = $1 where singleton', [enabled]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email varchar(255),
      email_confirmed_at timestamptz,
      created_at timestamptz not null default now(),
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);

  for (const file of MIGRATION_CHAIN) {
    if (file === '202608030002_admin_role_and_access_preview.sql') {
      await db.exec(`
        insert into auth.users (id, email, email_confirmed_at) values
          ('${OWNER}', 'owner@example.com', now()),
          ('${ALICE}', 'alice@example.com', now()),
          ('${BOB}', 'bob@example.com', now());
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await as(null);
});

beforeEach(async () => {
  await setLockdown(false);
});

describe('the subject cannot be chosen by the caller', () => {
  /*
   * The IDOR and the mass-assignment shape, closed by construction: a routine
   * with no arguments has no parameter to smuggle another account's id through.
   * Asserted against the catalog rather than by trying one bad id, because the
   * property is "there is no argument", not "this argument is validated".
   */
  it('accepts no arguments at all', async () => {
    const [row] = await query<{ pronargs: number }>(
      `select pronargs from pg_proc where proname = 'authorize_account_deletion'`,
    );
    expect(row.pronargs).toBe(0);
  });

  it('refuses a caller supplying an account id, because no such signature exists', async () => {
    await as(ALICE);
    await expect(query(`select public.authorize_account_deletion($1::uuid)`, [BOB])).rejects.toThrow();
  });

  it('returns the calling session and never the account named beside it', async () => {
    await as(ALICE);
    const [alice] = await query<{ authorize_account_deletion: string }>(
      'select public.authorize_account_deletion()',
    );
    expect(alice.authorize_account_deletion).toBe(ALICE);

    await as(BOB);
    const [bob] = await query<{ authorize_account_deletion: string }>(
      'select public.authorize_account_deletion()',
    );
    expect(bob.authorize_account_deletion).toBe(BOB);
  });
});

describe('a session is required, and it must still have a subject', () => {
  it('refuses a caller with no session', async () => {
    await as(null);
    await expect(query('select public.authorize_account_deletion()')).rejects.toThrow(
      /ACCOUNT_DELETION_UNAUTHENTICATED/,
    );
  });

  /*
   * A token that outlived the account it was minted for. This is the replay
   * case: the signature is still whatever it was, and the subject is gone.
   */
  it('refuses a token whose user no longer exists', async () => {
    await as(GHOST);
    await expect(query('select public.authorize_account_deletion()')).rejects.toThrow(/ACCOUNT_NOT_FOUND/);
  });
});

describe('the incident switch binds the one irreversible path', () => {
  it('refuses to start a deletion while the platform is locked down', async () => {
    await setLockdown(true);
    await as(ALICE);
    await expect(query('select public.authorize_account_deletion()')).rejects.toThrow(/SECURITY_LOCKDOWN/);
  });

  it('refuses every caller during lockdown, operator or not', async () => {
    await as(null);
    await query(
      `insert into public.user_roles (user_id, role) values ($1, 'admin')
         on conflict (user_id) do update set role = 'admin'`,
      [BOB],
    );
    await setLockdown(true);
    await as(BOB);
    await expect(query('select public.authorize_account_deletion()')).rejects.toThrow(/SECURITY_LOCKDOWN/);

    // Releasing first is not tidiness: while the switch is on, the trigger on
    // `user_roles` refuses to move a role at all — which is the enforcement from
    // the previous migration doing its job on the way out of this test.
    await setLockdown(false);
    await as(null);
    await query(`update public.user_roles set role = 'user' where user_id = $1`, [BOB]);
  });

  it('authorizes ordinary deletion again once the switch is released', async () => {
    await setLockdown(true);
    await as(ALICE);
    await expect(query('select public.authorize_account_deletion()')).rejects.toThrow(/SECURITY_LOCKDOWN/);

    await setLockdown(false);
    await as(ALICE);
    const [row] = await query<{ authorize_account_deletion: string }>(
      'select public.authorize_account_deletion()',
    );
    expect(row.authorize_account_deletion).toBe(ALICE);
  });
});

describe('authorizing is not acting', () => {
  /*
   * The routine must grant no ability a browser did not already have. If it ever
   * started the pipeline itself, it would be a client-callable service-role
   * operation — the thing this design exists to avoid.
   */
  it('writes nothing: no lifecycle row appears from authorizing alone', async () => {
    await as(null);
    await query('delete from public.account_lifecycle where user_id = $1', [ALICE]);

    await as(ALICE);
    await query('select public.authorize_account_deletion()');

    await as(null);
    const rows = await query('select user_id from public.account_lifecycle where user_id = $1', [ALICE]);
    expect(rows).toHaveLength(0);
  });
});

describe('the routine is reachable only the way it was designed to be', () => {
  it('is executable by authenticated and by nobody anonymous', async () => {
    const [row] = await query<{ acl: string | null }>(
      `select array_to_string(proacl, ',') as acl from pg_proc where proname = 'authorize_account_deletion'`,
    );
    expect(row.acl ?? '').toContain('authenticated=X');
    expect(row.acl ?? '').not.toContain('anon=X');
  });

  /*
   * It reads `auth.users` and calls a predicate revoked from every client role,
   * so it must be `security definer` — and a `security definer` without a pinned
   * `search_path` is a privilege-escalation primitive, not a gate.
   */
  it('is security definer with an empty, fixed search_path', async () => {
    const [row] = await query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `select prosecdef, proconfig from pg_proc where proname = 'authorize_account_deletion'`,
    );
    expect(row.prosecdef).toBe(true);
    expect(row.proconfig ?? []).toContain('search_path=""');
  });
});
