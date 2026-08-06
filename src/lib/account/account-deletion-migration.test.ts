import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

/**
 * The account-deletion and trial-identity migration, run against a real Postgres.
 *
 * These are the rules somebody takes a second free week, or loses data they were
 * never told they would lose, if they are wrong:
 *
 *   * a spent trial is remembered in a table that does not cascade from
 *     `auth.users`, so deleting the account does not delete the evidence;
 *   * an identity is claimed in one statement, so two simultaneous attempts
 *     produce one trial and not two;
 *   * a browser can neither read the ledger nor grant itself a trial that
 *     skipped it — including through the routine that used to allow exactly
 *     that;
 *   * a payment fingerprint is never on its own a reason to refuse;
 *   * an account that is closing writes nothing, whatever its JWT still says;
 *   * the pipeline resumes rather than restarting, never goes backwards, and
 *     only ever returns an account to service while nothing has been destroyed;
 *   * the auth user is the last thing to go, and the data is already gone when
 *     it does.
 */

const MIGRATION_FILE = '202608060002_account_deletion_and_trial_identity.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8');
const statements = rawSql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();

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
  '202608060001_purchase_consent_and_refund_window.sql',
  MIGRATION_FILE,
];

/** The owner UUID the Phase 3.1 migration seeds; its account must exist first. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
/** The account Alice creates after deleting hers, on the same mailbox. */
const ALICE_AGAIN = '33333333-3333-4333-8333-333333333333';

/** A digest of the right shape. The derivation itself is tested in TypeScript. */
const hashOf = (seed: string) => seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a');
const EMAIL_HASH = hashOf('a1b2c3');
const OAUTH_HASH = hashOf('d4e5f6');
const OTHER_HASH = hashOf('9f8e7d');

const emailIdentity = (hash = EMAIL_HASH) => JSON.stringify([{ type: 'email', hash, version: 1 }]);

let db: PGlite;

async function as(userId: string | null): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ''}', false)`);
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

/** Restore an account and the given identities to a never-used state. */
async function resetTrial(userId: string, hashes: string[] = []): Promise<void> {
  await as(null);
  await query(
    `update public.user_subscriptions
        set tier = 'basic', status = 'basic', trial_started_at = null,
            trial_ends_at = null, trial_used_at = null
      where user_id = $1`,
    [userId],
  );
  await query('delete from public.trial_identity_claims where claimed_by_user_id = $1', [userId]);
  if (hashes.length > 0) {
    await query('delete from public.trial_identity_claims where identity_hash = any($1::text[])', [hashes]);
  }
}

/** A write an ordinary session is allowed to make, on a row that always exists. */
async function writeAsOwner(userId: string): Promise<unknown[]> {
  await as(userId);
  return query(
    `update public.user_settings set language = 'en' where user_id = $1 returning user_id`, [userId],
  );
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

describe('the ledger outlives the account', () => {
  /*
   * The defect in one assertion. Every other user-owned table cascades from
   * `auth.users`, which is exactly why the trial record could not live in one.
   */
  it('holds no foreign key to auth.users, so deleting an account cannot delete the claim', async () => {
    const rows = await query<{ constraint_name: string }>(
      `select constraint_name
         from information_schema.table_constraints
        where table_schema = 'public'
          and table_name = 'trial_identity_claims'
          and constraint_type = 'FOREIGN KEY'`,
    );
    expect(rows).toEqual([]);
    expect(statements).not.toContain('claimed_by_user_id uuid references');
  });

  it('survives the deletion of the account that claimed it', async () => {
    await as(null);
    await query(`select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [ALICE, EMAIL_HASH]);
    await query(`select public.retain_trial_identity_on_deletion($1, $2::jsonb, true)`, [ALICE, emailIdentity()]);
    await query('delete from auth.users where id = $1', [ALICE]);

    const rows = await query<{ identity_hash: string; claimed_by_user_id: string | null; last_account_deleted_at: string | null }>(
      'select identity_hash, claimed_by_user_id, last_account_deleted_at from public.trial_identity_claims where identity_hash = $1',
      [EMAIL_HASH],
    );
    expect(rows).toHaveLength(1);
    // Released from the account, kept as a claim in its own right.
    expect(rows[0].claimed_by_user_id).toBeNull();
    expect(rows[0].last_account_deleted_at).not.toBeNull();

    // Restore the fixture for the tests below.
    await query(
      `insert into auth.users (id, email, email_confirmed_at) values ($1, 'alice@example.com', now())`,
      [ALICE],
    );
  });

  it('stores a digest and refuses anything that is not one', async () => {
    await as(null);
    await expect(
      query(`select public.claim_trial_identity($1, 'email', 'alice@example.com', 1::smallint)`, [BOB]),
    ).rejects.toThrow(/trial_identity_claims_hash_check/i);
  });

  it('keys the claim on the hash version, so rotating the secret does not collide old rows', async () => {
    expect(statements).toContain('unique (identity_type, hash_version, identity_hash)');
  });
});

describe('claiming an identity', () => {
  it('accepts the first claim and refuses a different account for the same identity', async () => {
    await as(null);
    const first = await query<{ claim_trial_identity: string }>(
      `select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [BOB, OTHER_HASH],
    );
    expect(first[0].claim_trial_identity).toBe('claimed');

    const second = await query<{ claim_trial_identity: string }>(
      `select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [ALICE_AGAIN, OTHER_HASH],
    );
    expect(second[0].claim_trial_identity).toBe('already_claimed');
  });

  it('lets the same account claim again, so a retry is not refused by its own attempt', async () => {
    await as(null);
    const again = await query<{ claim_trial_identity: string }>(
      `select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [BOB, OTHER_HASH],
    );
    expect(again[0].claim_trial_identity).toBe('claimed');
    const rows = await query('select 1 from public.trial_identity_claims where identity_hash = $1', [OTHER_HASH]);
    expect(rows).toHaveLength(1);
  });

  /*
   * The race a `select` then `insert` loses. Both transactions are started
   * before either commits, so the second genuinely reaches the unique index
   * rather than reading the first one's committed row.
   */
  it('lets exactly one of two simultaneous claims through', async () => {
    const raced = hashOf('c0ffee');
    const left = await db.transaction(async (tx) => {
      const result = await tx.query<{ claim_trial_identity: string }>(
        `select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [ALICE as never, raced as never],
      );
      return result.rows[0].claim_trial_identity;
    });
    const right = await db.transaction(async (tx) => {
      const result = await tx.query<{ claim_trial_identity: string }>(
        `select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [BOB as never, raced as never],
      );
      return result.rows[0].claim_trial_identity;
    });
    expect([left, right].filter((outcome) => outcome === 'claimed')).toHaveLength(1);
    expect([left, right].filter((outcome) => outcome === 'already_claimed')).toHaveLength(1);

    const rows = await query('select 1 from public.trial_identity_claims where identity_hash = $1', [raced]);
    expect(rows).toHaveLength(1);
    await query('delete from public.trial_identity_claims where identity_hash = $1', [raced]);
  });

  it('is not reachable by a browser at all', async () => {
    const rows = await query<{ authenticated: boolean; anon: boolean }>(
      `select has_function_privilege('authenticated', 'public.claim_trial_identity(uuid,text,text,smallint)', 'execute') as authenticated,
              has_function_privilege('anon', 'public.claim_trial_identity(uuid,text,text,smallint)', 'execute') as anon`,
    );
    expect(rows[0]).toEqual({ authenticated: false, anon: false });
  });

  it('denies every session on the ledger table, because it has no policy', async () => {
    const rows = await query<{ relrowsecurity: boolean; policies: number }>(
      `select c.relrowsecurity,
              (select count(*)::int from pg_policies p
                where p.schemaname = 'public' and p.tablename = 'trial_identity_claims') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'trial_identity_claims'`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].policies).toBe(0);
  });
});

describe('granting the trial', () => {
  it('records the identity in the same transaction that grants the week', async () => {
    await resetTrial(ALICE, [EMAIL_HASH]);
    await as(null);
    const granted = await query<{ trial_used_at: string | null; status: string }>(
      `select trial_used_at, status from public.start_elite_trial_with_identity($1, $2::jsonb)`,
      [ALICE, emailIdentity()],
    );
    expect(granted[0].status).toBe('trialing');
    expect(granted[0].trial_used_at).not.toBeNull();

    const claims = await query('select 1 from public.trial_identity_claims where identity_hash = $1', [EMAIL_HASH]);
    expect(claims).toHaveLength(1);
  });

  /* Delete, sign up again on the same mailbox, ask for the week again. */
  it('refuses a new account whose identity is already in the ledger', async () => {
    await as(null);
    await query(`select public.retain_trial_identity_on_deletion($1, $2::jsonb, true)`, [ALICE, emailIdentity()]);
    await query('delete from auth.users where id = $1', [ALICE]);
    await query(
      `insert into auth.users (id, email, email_confirmed_at) values ($1, 'alice@example.com', now())`,
      [ALICE_AGAIN],
    );

    await expect(
      query(`select * from public.start_elite_trial_with_identity($1, $2::jsonb)`, [ALICE_AGAIN, emailIdentity()]),
    ).rejects.toThrow(/TRIAL_IDENTITY_ALREADY_USED/);

    // The refusal must not have half-granted anything.
    const rows = await query<{ status: string; trial_used_at: string | null }>(
      'select status, trial_used_at from public.user_subscriptions where user_id = $1', [ALICE_AGAIN],
    );
    expect(rows[0].status).toBe('basic');
    expect(rows[0].trial_used_at).toBeNull();
  });

  it('treats an email identity and a Google identity on one mailbox as one claim', async () => {
    await as(null);
    // The same person returns a third time, this time signing in with Google.
    // The email digest is derived from the canonical address either way, so it
    // is the same value and it is already spent.
    const both = JSON.stringify([
      { type: 'email', hash: EMAIL_HASH, version: 1 },
      { type: 'oauth', hash: OAUTH_HASH, version: 1 },
    ]);
    await expect(
      query(`select * from public.start_elite_trial_with_identity($1, $2::jsonb)`, [ALICE_AGAIN, both]),
    ).rejects.toThrow(/TRIAL_IDENTITY_ALREADY_USED/);
    // And the unspent Google digest was not quietly consumed by the refusal.
    const rows = await query('select 1 from public.trial_identity_claims where identity_hash = $1', [OAUTH_HASH]);
    expect(rows).toEqual([]);
  });

  it('never lets a payment fingerprint be the thing that blocks somebody', async () => {
    await as(null);
    const card = JSON.stringify([{ type: 'payment', hash: hashOf('cafe01'), version: 1 }]);
    await expect(
      query(`select * from public.start_elite_trial_with_identity($1, $2::jsonb)`, [BOB, card]),
    ).rejects.toThrow(/TRIAL_IDENTITY_NOT_BINDING/);
  });

  it('refuses to grant a trial it cannot remember', async () => {
    await as(null);
    await expect(
      query(`select * from public.start_elite_trial_with_identity($1, '[]'::jsonb)`, [BOB]),
    ).rejects.toThrow(/TRIAL_IDENTITY_UNAVAILABLE/);
  });

  it('keeps every refusal the trial rule already made', async () => {
    await as(null);
    await query(
      `insert into auth.users (id, email, email_confirmed_at) values ($1, 'unverified@example.com', null)
       on conflict (id) do nothing`,
      ['44444444-4444-4444-8444-444444444444'],
    );
    await expect(
      query(`select * from public.start_elite_trial_with_identity($1, $2::jsonb)`, [
        '44444444-4444-4444-8444-444444444444', emailIdentity(hashOf('bbb111')),
      ]),
    ).rejects.toThrow(/EMAIL_NOT_VERIFIED/);
  });

  /*
   * The bypass. `start_elite_trial()` takes no arguments and decides everything
   * from `auth.uid()` — which is exactly why a browser could call it directly
   * over PostgREST and take a week the ledger never saw.
   */
  it('closes the argument-free grant a browser could call directly', async () => {
    const rows = await query<{ granted: boolean }>(
      `select has_function_privilege('authenticated', 'public.start_elite_trial()', 'execute') as granted`,
    );
    expect(rows[0].granted).toBe(false);
  });
});

describe('an account that is closing', () => {
  it('is refused every write, even though its session is still valid', async () => {
    await as(null);
    await query('select * from public.begin_account_deletion($1)', [BOB]);
    await as(BOB);
    await expect(
      query(`update public.user_settings set language = 'en' where user_id = $1`, [BOB]),
    ).rejects.toThrow(/ACCOUNT_DELETING/);
    await expect(
      query(`update public.profiles set full_name = 'blocked' where id = $1`, [BOB]),
    ).rejects.toThrow(/ACCOUNT_DELETING/);
    await expect(
      query(`insert into public.price_alerts (user_id, symbol, condition, target_value)
             values ($1, 'AAPL', 'above', 100)`, [BOB]),
    ).rejects.toThrow(/ACCOUNT_DELETING/);
  });

  it('still lets the trusted server remove those very rows', async () => {
    await as(null);
    const rows = await query('select public.purge_account_data($1)', [BOB]);
    expect(rows).toHaveLength(1);
  });

  it('says so in the account access projection, so a page can refuse before a write is tried', async () => {
    await as(BOB);
    const rows = await query<{ account_status: string }>('select account_status from public.get_my_account_access()');
    expect(rows[0].account_status).toBe('deleting');
    await as(ALICE_AGAIN);
    const active = await query<{ account_status: string }>('select account_status from public.get_my_account_access()');
    expect(active[0].account_status).toBe('active');
  });

  it('leaves an untouched account writing exactly as before', async () => {
    expect(await writeAsOwner(ALICE_AGAIN)).toHaveLength(1);
  });
});

describe('the pipeline', () => {
  it('resumes rather than restarting, and reports the stage it reached', async () => {
    await as(null);
    const first = await query<{ operation_id: string; stage: string; resumed: boolean }>(
      'select * from public.begin_account_deletion($1)', [ALICE_AGAIN],
    );
    expect(first[0].stage).toBe('requested');
    expect(first[0].resumed).toBe(false);

    await query(`select public.advance_account_deletion($1, 'provider_settled')`, [ALICE_AGAIN]);
    const second = await query<{ operation_id: string; stage: string; resumed: boolean }>(
      'select * from public.begin_account_deletion($1)', [ALICE_AGAIN],
    );
    expect(second[0].resumed).toBe(true);
    expect(second[0].stage).toBe('provider_settled');
    expect(second[0].operation_id).toBe(first[0].operation_id);
  });

  it('never moves a stage backwards, so a retried step cannot un-record itself', async () => {
    await as(null);
    const rows = await query<{ advance_account_deletion: string }>(
      `select public.advance_account_deletion($1, 'requested')`, [ALICE_AGAIN],
    );
    expect(rows[0].advance_account_deletion).toBe('provider_settled');
  });

  it('refuses to return a half-emptied account to service', async () => {
    await as(null);
    await expect(
      query('select public.cancel_account_deletion($1)', [ALICE_AGAIN]),
    ).rejects.toThrow(/ACCOUNT_DELETION_IRREVERSIBLE/);
  });

  it('does return an account to service while nothing has been destroyed', async () => {
    await as(null);
    await query(
      `insert into auth.users (id, email, email_confirmed_at) values ($1, 'carol@example.com', now())`,
      ['55555555-5555-4555-8555-555555555555'],
    );
    await query('select * from public.begin_account_deletion($1)', ['55555555-5555-4555-8555-555555555555']);
    const rows = await query<{ cancel_account_deletion: string }>(
      'select public.cancel_account_deletion($1)', ['55555555-5555-4555-8555-555555555555'],
    );
    expect(rows[0].cancel_account_deletion).toBe('active');
    expect(await writeAsOwner('55555555-5555-4555-8555-555555555555')).toHaveLength(1);
  });

  it('removes the account data before the auth user, and keeps the accounting record', async () => {
    await as(null);
    const subject = '66666666-6666-4666-8666-666666666666';
    await query(
      `insert into auth.users (id, email, email_confirmed_at) values ($1, 'dave@example.com', now())`, [subject],
    );
    await query(
      `insert into public.price_alerts (user_id, symbol, condition, target_value)
       values ($1, 'AAPL', 'above', 100)`, [subject],
    );
    await query(
      `insert into public.billing_webhook_events (provider, provider_mode, provider_event_id, event_type, user_id)
       values ('stripe', 'live', 'evt_dave', 'invoice.paid', $1)`,
      [subject],
    );

    await query('select * from public.begin_account_deletion($1)', [subject]);
    await query('select public.purge_account_data($1)', [subject]);

    // Everything the person made is gone while the auth user still exists,
    // which is what makes a failure at the last step safe.
    expect(await query('select 1 from public.price_alerts where user_id = $1', [subject])).toEqual([]);
    expect(await query('select 1 from public.watchlists where user_id = $1', [subject])).toEqual([]);
    expect(await query('select 1 from public.user_settings where user_id = $1', [subject])).toEqual([]);
    expect(await query('select 1 from public.profiles where id = $1', [subject])).toEqual([]);
    expect(await query('select 1 from auth.users where id = $1', [subject])).toHaveLength(1);
    // The billing ledger is retained. Its user_id has no foreign key, so once
    // the auth user is deleted the value resolves to nobody.
    expect(await query('select 1 from public.billing_webhook_events where user_id = $1', [subject])).toHaveLength(1);

    await query('delete from auth.users where id = $1', [subject]);
    expect(await query('select 1 from public.billing_webhook_events where user_id = $1', [subject])).toHaveLength(1);
  });

  it('releases an unused claim held by an account that never got the trial', async () => {
    await as(null);
    const subject = '77777777-7777-4777-8777-777777777777';
    const orphan = hashOf('feed01');
    await query(
      `insert into auth.users (id, email, email_confirmed_at) values ($1, 'erin@example.com', now())`, [subject],
    );
    await query(`select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [subject, orphan]);
    await query(`select public.retain_trial_identity_on_deletion($1, $2::jsonb, false)`, [subject, emailIdentity(orphan)]);
    expect(await query('select 1 from public.trial_identity_claims where identity_hash = $1', [orphan])).toEqual([]);
  });

  it('will not let one account start another account s deletion', async () => {
    const rows = await query<{ granted: boolean }>(
      `select has_function_privilege('authenticated', 'public.begin_account_deletion(uuid)', 'execute') as granted`,
    );
    expect(rows[0].granted).toBe(false);
  });

  it('closes the one-statement delete that used to run from an ordinary session', async () => {
    await as(BOB);
    await expect(query('select public.delete_own_account()')).rejects.toThrow(/permission denied|ACCOUNT_DELETION_REQUIRES_PIPELINE/i);
    const rows = await query<{ granted: boolean }>(
      `select has_function_privilege('authenticated', 'public.delete_own_account()', 'execute') as granted`,
    );
    expect(rows[0].granted).toBe(false);
  });
});
