import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TRIAL_IDENTITY_QA_RETENTION_DAYS,
  TRIAL_IDENTITY_RETENTION_DAYS,
} from './retention';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

/**
 * Retention, legal hold, the purge and the recovery reports, run against a real
 * Postgres.
 *
 * These are the rules somebody either loses a record they were promised, or takes
 * a second free week, if they are wrong:
 *
 *   * a claim's deadline is stamped once and never recomputed, so editing the
 *     policy cannot reach back and shorten a promise already made;
 *   * a dry run deletes nothing, and neither does an apply while enforcement is
 *     off — which is the state production ships in;
 *   * a legal hold outranks the deadline, and a claim a live account still holds
 *     is never swept out from under it;
 *   * a run is idempotent under its own id, so a retry cannot delete twice;
 *   * the audit trail holds counts and never a digest;
 *   * a browser can reach none of it — not the flag, not the hold, not the sweep,
 *     not the audit;
 *   * a stored key version we cannot compute is reported rather than missed;
 *   * a stuck deletion is visible, and the last destructive step is refused until
 *     the purge is measured complete.
 */

const MIGRATION_FILE = '202608060003_trial_retention_and_deletion_recovery.sql';
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
  '202608060002_account_deletion_and_trial_identity.sql',
  MIGRATION_FILE,
];

/** The owner UUID the Phase 3.1 migration seeds; its account must exist first. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** Digests of the right shape. The derivation itself is tested in TypeScript. */
const hashOf = (seed: string) => seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a');

let db: PGlite;

async function as(userId: string | null): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ''}', false)`);
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

/**
 * Insert a claim directly, as the trusted server would, with control over its age.
 *
 * `first_claimed_at` is supplied so a row can be old enough to be due without the
 * test having to wait three years; `retain_until` is left to the trigger, which is
 * the behaviour under test.
 */
async function seedClaim(input: {
  hash: string;
  claimedAgoDays?: number;
  origin?: 'user' | 'backfill' | 'production_qa';
  holder?: string | null;
  version?: number;
  retainUntil?: string | null;
}): Promise<string> {
  const rows = await query<{ id: string }>(
    `insert into public.trial_identity_claims
       (identity_type, identity_hash, hash_version, claimed_by_user_id, claim_origin,
        first_claimed_at, retain_until)
     values ('email', $1, $2::smallint, $3, $4, now() - ($5 || ' days')::interval, $6)
     returning id`,
    [
      input.hash,
      input.version ?? 1,
      input.holder ?? null,
      input.origin ?? 'user',
      String(input.claimedAgoDays ?? 0),
      input.retainUntil ?? null,
    ],
  );
  return rows[0].id;
}

async function claimCount(): Promise<number> {
  const rows = await query<{ count: number }>('select count(*)::integer as count from public.trial_identity_claims');
  return rows[0].count;
}

async function clearClaims(): Promise<void> {
  await as(null);
  await query('delete from public.trial_identity_claims');
  await query('delete from public.trial_retention_runs');
  await query('update public.trial_retention_config set enforcement_enabled = false where singleton');
}

interface PurgeResult {
  run_id: string;
  mode: string;
  enforcement_enabled: boolean;
  scanned: number;
  deleted: number;
  skipped_legal_hold: number;
  skipped_active_holder: number;
  already_recorded: boolean;
  error: string | null;
}

async function purge(runId: string, apply: boolean, batch: number | null = null): Promise<PurgeResult> {
  const rows = await query<PurgeResult>(
    'select * from public.purge_expired_trial_identity_claims($1, $2, $3)',
    [runId, apply, batch],
  );
  return rows[0];
}

const runId = (seed: number) => `aaaaaaaa-0000-4000-8000-${String(seed).padStart(12, '0')}`;

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

describe('the deadline on a claim', () => {
  it('is stamped on the way in, from the row\'s own claim date and origin', async () => {
    await clearClaims();
    await seedClaim({ hash: hashOf('a1'), claimedAgoDays: 0 });
    await seedClaim({ hash: hashOf('a2'), claimedAgoDays: 0, origin: 'production_qa' });

    const rows = await query<{ identity_hash: string; days: number }>(
      `select identity_hash,
              round(extract(epoch from (retain_until - first_claimed_at)) / 86400)::integer as days
         from public.trial_identity_claims order by identity_hash`,
    );
    expect(rows.map((row) => row.days)).toEqual([
      TRIAL_IDENTITY_RETENTION_DAYS,
      TRIAL_IDENTITY_QA_RETENTION_DAYS,
    ]);
  });

  it('agrees with the policy the privacy page publishes', async () => {
    const rows = await query<{ user_days: number; qa_days: number }>(
      `select
         (extract(epoch from public.trial_identity_retention_interval('user')) / 86400)::integer as user_days,
         (extract(epoch from public.trial_identity_retention_interval('production_qa')) / 86400)::integer as qa_days`,
    );
    expect(rows[0].user_days).toBe(TRIAL_IDENTITY_RETENTION_DAYS);
    expect(rows[0].qa_days).toBe(TRIAL_IDENTITY_QA_RETENTION_DAYS);
  });

  /*
   * The defect a stored deadline exists to prevent: a purge that computed
   * `first_claimed_at + <today's policy>` would let a future edit to the policy
   * shorten a window that started years ago. Re-running the backfill statement
   * must therefore leave an existing deadline exactly as it was.
   */
  it('is never recomputed, so a policy change cannot rewrite an existing promise', async () => {
    await clearClaims();
    const id = await seedClaim({ hash: hashOf('b1'), claimedAgoDays: 400 });
    const before = await query<{ retain_until: Date }>(
      'select retain_until from public.trial_identity_claims where id = $1', [id],
    );

    // The migration's own backfill, re-run, and a re-claim of the same identity.
    await query(
      `update public.trial_identity_claims
          set retain_until = first_claimed_at + public.trial_identity_retention_interval(claim_origin)
        where retain_until is null`,
    );
    await query(
      `select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [ALICE, hashOf('b1')],
    );

    const after = await query<{ retain_until: Date }>(
      'select retain_until from public.trial_identity_claims where id = $1', [id],
    );
    expect(new Date(after[0].retain_until).getTime())
      .toBe(new Date(before[0].retain_until).getTime());
  });

  it('backfills a row that predates the column, deterministically', async () => {
    await clearClaims();
    const id = await seedClaim({ hash: hashOf('c1'), claimedAgoDays: 30 });
    // The state the migration found: a claim with no deadline at all.
    await query('update public.trial_identity_claims set retain_until = null where id = $1', [id]);
    await query(
      `update public.trial_identity_claims
          set retain_until = first_claimed_at + public.trial_identity_retention_interval(claim_origin)
        where retain_until is null`,
    );

    const rows = await query<{ days: number; claim_origin: string }>(
      `select round(extract(epoch from (retain_until - first_claimed_at)) / 86400)::integer as days,
              claim_origin
         from public.trial_identity_claims where id = $1`, [id],
    );
    expect(rows[0].days).toBe(TRIAL_IDENTITY_RETENTION_DAYS);
    // Existing rows keep the origin with the longest protection, never a guess.
    expect(rows[0].claim_origin).toBe('user');
  });

  it('defaults a claim made through the ordinary routine to the user origin', async () => {
    await clearClaims();
    await query(`select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [ALICE, hashOf('d1')]);
    const rows = await query<{ claim_origin: string; retain_until: Date | null }>(
      'select claim_origin, retain_until from public.trial_identity_claims',
    );
    expect(rows[0].claim_origin).toBe('user');
    expect(rows[0].retain_until).not.toBeNull();
  });
});

describe('the sweep', () => {
  it('deletes nothing on a dry run, however many rows are due', async () => {
    await clearClaims();
    await query('update public.trial_retention_config set enforcement_enabled = true where singleton');
    await seedClaim({ hash: hashOf('e1'), claimedAgoDays: 2000 });
    await seedClaim({ hash: hashOf('e2'), claimedAgoDays: 2000 });

    const result = await purge(runId(1), false);
    expect(result.mode).toBe('dry_run');
    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(0);
    expect(await claimCount()).toBe(2);
  });

  /*
   * The state production ships in. The job runs, the audit row is written, the
   * count is real — and nothing is removed until counsel has signed off.
   */
  it('reports without deleting while enforcement is off, and says which it was', async () => {
    await clearClaims();
    await seedClaim({ hash: hashOf('f1'), claimedAgoDays: 2000 });

    const result = await purge(runId(2), true);
    expect(result.mode).toBe('reporting_only');
    expect(result.enforcement_enabled).toBe(false);
    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(0);
    expect(await claimCount()).toBe(1);

    const audit = await query<{ mode: string; scanned: number; deleted: number }>(
      'select mode, scanned, deleted from public.trial_retention_runs where run_id = $1', [runId(2)],
    );
    // Recorded under a mode that cannot be confused with a preview.
    expect(audit[0]).toMatchObject({ mode: 'reporting_only', scanned: 1, deleted: 0 });
  });

  it('deletes only expired, unheld rows that no live account holds', async () => {
    await clearClaims();
    await query('update public.trial_retention_config set enforcement_enabled = true where singleton');

    const expired = await seedClaim({ hash: hashOf('11'), claimedAgoDays: 2000 });
    const notYet = await seedClaim({ hash: hashOf('12'), claimedAgoDays: 10 });
    const held = await seedClaim({ hash: hashOf('13'), claimedAgoDays: 2000 });
    const stillOwned = await seedClaim({ hash: hashOf('14'), claimedAgoDays: 2000, holder: ALICE });
    await query('select public.set_trial_identity_legal_hold($1, now() + interval \'30 days\', $2)', [held, OWNER]);

    const result = await purge(runId(3), true);
    expect(result.mode).toBe('apply');
    expect(result.deleted).toBe(1);
    expect(result.skipped_legal_hold).toBe(1);
    expect(result.skipped_active_holder).toBe(1);

    const survivors = await query<{ id: string }>('select id from public.trial_identity_claims order by identity_hash');
    expect(survivors.map((row) => row.id).sort()).toEqual([notYet, held, stillOwned].sort());
    expect(survivors.map((row) => row.id)).not.toContain(expired);
  });

  /*
   * A hold that has lapsed stops protecting the row — otherwise placing one would
   * be an accidental permanent exemption nobody would notice.
   */
  it('sweeps a row whose legal hold has lapsed', async () => {
    await clearClaims();
    await query('update public.trial_retention_config set enforcement_enabled = true where singleton');
    const lapsed = await seedClaim({ hash: hashOf('15'), claimedAgoDays: 2000 });
    await query(
      'select public.set_trial_identity_legal_hold($1, now() - interval \'1 day\', $2)', [lapsed, OWNER],
    );

    const result = await purge(runId(4), true);
    expect(result.deleted).toBe(1);
    expect(await claimCount()).toBe(0);
  });

  it('lifts a hold when it is set back to null, and forgets who set it', async () => {
    await clearClaims();
    const id = await seedClaim({ hash: hashOf('16'), claimedAgoDays: 2000 });
    await query('select public.set_trial_identity_legal_hold($1, now() + interval \'1 year\', $2)', [id, OWNER]);
    await query('select public.set_trial_identity_legal_hold($1, null, null)', [id]);

    const rows = await query<{ legal_hold_until: Date | null; legal_hold_set_at: Date | null; legal_hold_set_by: string | null }>(
      'select legal_hold_until, legal_hold_set_at, legal_hold_set_by from public.trial_identity_claims where id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ legal_hold_until: null, legal_hold_set_at: null, legal_hold_set_by: null });
  });

  it('bounds one run to a batch and finishes the rest on the next', async () => {
    await clearClaims();
    await query('update public.trial_retention_config set enforcement_enabled = true where singleton');
    for (let index = 0; index < 5; index += 1) {
      await seedClaim({ hash: hashOf(`2${index}`), claimedAgoDays: 2000 });
    }

    const first = await purge(runId(5), true, 2);
    expect(first.scanned).toBe(5);
    expect(first.deleted).toBe(2);
    expect(await claimCount()).toBe(3);

    const second = await purge(runId(6), true, 2);
    expect(second.deleted).toBe(2);
    const third = await purge(runId(7), true, 2);
    expect(third.deleted).toBe(1);
    expect(await claimCount()).toBe(0);
  });

  it('honours the configured batch when the caller names none, and a hard ceiling above it', async () => {
    expect(statements).toContain('least( greatest(coalesce(input_batch_limit, config.batch_limit), 1), 5000 )'
      .replace(/\s+/g, ' '));
    const rows = await query<{ batch_limit: number }>(
      'select batch_limit from public.trial_retention_config where singleton',
    );
    expect(rows[0].batch_limit).toBe(500);
  });

  /*
   * Idempotency, which is what makes a retry safe. A cron job that fires twice, or
   * an operator who re-runs a command, must not delete a second batch under the
   * same run id.
   */
  it('is idempotent under its own run id', async () => {
    await clearClaims();
    await query('update public.trial_retention_config set enforcement_enabled = true where singleton');
    await seedClaim({ hash: hashOf('31'), claimedAgoDays: 2000 });
    await seedClaim({ hash: hashOf('32'), claimedAgoDays: 2000 });

    const first = await purge(runId(8), true, 1);
    expect(first.deleted).toBe(1);
    expect(first.already_recorded).toBe(false);

    const repeat = await purge(runId(8), true, 1);
    expect(repeat.already_recorded).toBe(true);
    expect(repeat.deleted).toBe(1); // the first run's count, not a second deletion
    expect(await claimCount()).toBe(1);

    const runs = await query<{ count: number }>(
      'select count(*)::integer as count from public.trial_retention_runs where run_id = $1', [runId(8)],
    );
    expect(runs[0].count).toBe(1);
  });

  it('records counts and a run id, and has nowhere to put a digest', async () => {
    const columns = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'trial_retention_runs'
        order by column_name`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).toEqual([
      'deleted', 'enforcement_enabled', 'error', 'finished_at', 'mode', 'run_id',
      'scanned', 'skipped_active_holder', 'skipped_legal_hold', 'started_at',
    ]);
    // Not merely absent today: there is no column any future writer could use.
    expect(names.some((name) => /hash|identity|email|user/.test(name))).toBe(false);
  });

  it('constrains its error column to a fixed vocabulary', async () => {
    await expect(
      query(
        `insert into public.trial_retention_runs (run_id, mode, enforcement_enabled, error)
         values (gen_random_uuid(), 'dry_run', false, 'connection to 10.0.0.1 failed for user alice')`,
      ),
    ).rejects.toThrow(/trial_retention_runs_error_check/i);
  });
});

describe('reading across key versions', () => {
  it('finds a claim written under a version that is no longer active', async () => {
    await clearClaims();
    await seedClaim({ hash: hashOf('41'), version: 1, claimedAgoDays: 10 });

    const rows = await query<{ claimed: boolean; unsupported_versions: number[] }>(
      'select * from public.trial_identity_claim_status($1::jsonb, $2::smallint[])',
      [JSON.stringify([{ type: 'email', hash: hashOf('41'), version: 1 }]), [1, 2]],
    );
    expect(rows[0].claimed).toBe(true);
    expect(rows[0].unsupported_versions).toEqual([]);
  });

  /*
   * The bypass this reports: a claim stamped with a version whose key we no
   * longer hold cannot be derived, so a lookup would miss and the miss would read
   * as "never had a trial".
   */
  it('reports a stored version the caller cannot compute', async () => {
    await clearClaims();
    await seedClaim({ hash: hashOf('42'), version: 3, claimedAgoDays: 10 });

    const rows = await query<{ claimed: boolean; unsupported_versions: number[] }>(
      'select * from public.trial_identity_claim_status($1::jsonb, $2::smallint[])',
      [JSON.stringify([{ type: 'email', hash: hashOf('99'), version: 1 }]), [1, 2]],
    );
    expect(rows[0].claimed).toBe(false);
    expect(rows[0].unsupported_versions).toEqual([3]);
  });

  /*
   * The whole point of the release, end to end on the database side.
   *
   * A person spends their trial under V1, deletes the account, the key is rotated,
   * and they sign up again. The V1 claim is the only evidence that survives — so
   * the lookup that now carries both a V1 and a V2 digest must find it, and the
   * grant must refuse. If this passes and the derivation test passes, rotating the
   * key cannot hand out a second free week.
   */
  it('refuses a re-registered account whose only claim is under the retired version', async () => {
    await clearClaims();
    const v1Digest = hashOf('43');
    const v2Digest = hashOf('44');

    // Their first account: trial spent, claim written under V1, account deleted.
    await query(`select public.claim_trial_identity($1, 'email', $2, 1::smallint)`, [ALICE, v1Digest]);
    await query(
      `select public.retain_trial_identity_on_deletion($1, $2::jsonb, true)`,
      [ALICE, JSON.stringify([{ type: 'email', hash: v1Digest, version: 1 }])],
    );

    // Their new account, on the same mailbox, under a deployment whose active
    // version is now 2 — so it derives both digests and asks about both.
    const status = await query<{ claimed: boolean; unsupported_versions: number[] }>(
      'select * from public.trial_identity_claim_status($1::jsonb, $2::smallint[])',
      [
        JSON.stringify([
          { type: 'email', hash: v1Digest, version: 1 },
          { type: 'email', hash: v2Digest, version: 2 },
        ]),
        [1, 2],
      ],
    );
    expect(status[0].claimed).toBe(true);
    expect(status[0].unsupported_versions).toEqual([]);

    // And the grant itself refuses, not merely the check in front of it.
    await expect(
      query(
        `select * from public.start_elite_trial_with_identity($1, $2::jsonb)`,
        [BOB, JSON.stringify([{ type: 'email', hash: v1Digest, version: 1 }])],
      ),
    ).rejects.toThrow(/TRIAL_IDENTITY_ALREADY_USED|already/i);

    /*
     * What is *not* refused is a purchase. The checkout deliberately never consults
     * the ledger — that property lives with the checkout, and is asserted in
     * `app/settings/subscription/trial-beta-gate.test.ts`.
     */
  });

  it('answers both questions from one snapshot', async () => {
    expect(statements).toContain('create or replace function public.trial_identity_claim_status');
    // One statement, so a match and a version list cannot describe two moments.
    expect(statements).toContain('returns table (claimed boolean, unsupported_versions smallint[])');
  });
});

describe('where a claim came from', () => {
  it('gives the ordinary routine no way to name an origin', async () => {
    const signature = await query<{ arguments: string }>(
      `select pg_get_function_arguments(oid) as arguments from pg_proc
        where proname = 'claim_trial_identity' and pronamespace = 'public'::regnamespace`,
    );
    expect(signature[0].arguments).not.toContain('origin');
  });

  it('lets a trusted path label a QA claim, and refuses an origin it does not know', async () => {
    await clearClaims();
    const outcome = await query<{ claim_trial_identity_with_origin: string }>(
      `select public.claim_trial_identity_with_origin($1, 'email', $2, 1::smallint, 'production_qa')`,
      [ALICE, hashOf('51')],
    );
    expect(outcome[0].claim_trial_identity_with_origin).toBe('claimed');

    const rows = await query<{ claim_origin: string; days: number }>(
      `select claim_origin,
              round(extract(epoch from (retain_until - first_claimed_at)) / 86400)::integer as days
         from public.trial_identity_claims`,
    );
    expect(rows[0].claim_origin).toBe('production_qa');
    expect(rows[0].days).toBe(TRIAL_IDENTITY_QA_RETENTION_DAYS);

    await expect(
      query(
        `select public.claim_trial_identity_with_origin($1, 'email', $2, 1::smallint, 'whatever')`,
        [BOB, hashOf('52')],
      ),
    ).rejects.toThrow(/TRIAL_IDENTITY_ORIGIN_UNKNOWN/);
  });

  /*
   * A QA claim still has to block a second trial while the test is running —
   * otherwise the test would be proving the ledger works using a row that does not
   * behave like the rows it is meant to model.
   */
  it('keeps a QA claim blocking exactly like any other', async () => {
    await clearClaims();
    await query(
      `select public.claim_trial_identity_with_origin($1, 'email', $2, 1::smallint, 'production_qa')`,
      [ALICE, hashOf('53')],
    );
    const rows = await query<{ claimed: boolean }>(
      'select claimed from public.trial_identity_claim_status($1::jsonb, null)',
      [JSON.stringify([{ type: 'email', hash: hashOf('53'), version: 1 }])],
    );
    expect(rows[0].claimed).toBe(true);
  });

  it('relabels only the exact rows it is given, and moves their deadline', async () => {
    await clearClaims();
    const proven = await seedClaim({ hash: hashOf('54'), claimedAgoDays: 100 });
    const other = await seedClaim({ hash: hashOf('55'), claimedAgoDays: 100 });

    const affected = await query<{ mark_trial_identity_claim_origin: number }>(
      `select public.mark_trial_identity_claim_origin($1::uuid[], 'production_qa')`, [[proven]],
    );
    expect(affected[0].mark_trial_identity_claim_origin).toBe(1);

    const rows = await query<{ id: string; claim_origin: string; days: number }>(
      `select id, claim_origin,
              round(extract(epoch from (retain_until - first_claimed_at)) / 86400)::integer as days
         from public.trial_identity_claims order by identity_hash`,
    );
    expect(rows.find((row) => row.id === proven)).toMatchObject({
      claim_origin: 'production_qa', days: TRIAL_IDENTITY_QA_RETENTION_DAYS,
    });
    expect(rows.find((row) => row.id === other)).toMatchObject({
      claim_origin: 'user', days: TRIAL_IDENTITY_RETENTION_DAYS,
    });
  });

  it('relabels nothing when handed nothing', async () => {
    const affected = await query<{ mark_trial_identity_claim_origin: number }>(
      `select public.mark_trial_identity_claim_origin(null, 'production_qa')`,
    );
    expect(affected[0].mark_trial_identity_claim_origin).toBe(0);
  });

  it('deletes QA claims and provably nothing else', async () => {
    await clearClaims();
    const qa = await seedClaim({ hash: hashOf('61'), origin: 'production_qa', claimedAgoDays: 1 });
    const qaHeld = await seedClaim({ hash: hashOf('62'), origin: 'production_qa', claimedAgoDays: 1 });
    const qaOwned = await seedClaim({ hash: hashOf('63'), origin: 'production_qa', claimedAgoDays: 1, holder: BOB });
    const person = await seedClaim({ hash: hashOf('64'), claimedAgoDays: 2000 });
    await query('select public.set_trial_identity_legal_hold($1, now() + interval \'1 year\', $2)', [qaHeld, OWNER]);

    const preview = await query<{ matched: number; deleted: number }>(
      'select * from public.delete_qa_trial_identity_claims(false)',
    );
    expect(preview[0]).toMatchObject({ matched: 1, deleted: 0 });
    expect(await claimCount()).toBe(4);

    const applied = await query<{ deleted: number; skipped_legal_hold: number; skipped_active_holder: number }>(
      'select * from public.delete_qa_trial_identity_claims(true)',
    );
    expect(applied[0]).toMatchObject({ deleted: 1, skipped_legal_hold: 1, skipped_active_holder: 1 });

    const survivors = await query<{ id: string }>('select id from public.trial_identity_claims');
    expect(survivors.map((row) => row.id).sort()).toEqual([qaHeld, qaOwned, person].sort());
    expect(survivors.map((row) => row.id)).not.toContain(qa);
  });
});

describe('what a browser can reach', () => {
  /*
   * The whole of this feature is operator surface. A reader must not be able to
   * discover that an address has an account, when a record of theirs expires,
   * whether a hold exists, or that a sweep runs at all.
   */
  it('gives no session any access to the flag, the ledger or the audit', async () => {
    for (const table of ['trial_retention_config', 'trial_retention_runs', 'trial_identity_claims']) {
      const grants = await query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = $1
            and grantee in ('anon', 'authenticated', 'public')`,
        [table],
      );
      expect(`${table}: ${JSON.stringify(grants)}`).toBe(`${table}: []`);

      const policies = await query<{ policyname: string }>(
        `select policyname from pg_policies where schemaname = 'public' and tablename = $1`, [table],
      );
      expect(`${table} policies: ${policies.map((row) => row.policyname).join(',')}`)
        .toBe(`${table} policies: `);

      const rls = await query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where oid = ('public.' || $1)::regclass`, [table],
      );
      expect(rls[0].relrowsecurity).toBe(true);
    }
  });

  it('grants every new routine to service_role and to nobody else', async () => {
    const routines = [
      'purge_expired_trial_identity_claims',
      'set_trial_identity_legal_hold',
      'trial_identity_claim_status',
      'claim_trial_identity_with_origin',
      'mark_trial_identity_claim_origin',
      'delete_qa_trial_identity_claims',
      'account_residual_data_count',
      'account_deletion_report',
      'trial_retention_status',
    ];
    for (const routine of routines) {
      const grants = await query<{ grantee: string }>(
        `select distinct grantee from information_schema.role_routine_grants
          where routine_schema = 'public' and routine_name = $1
            and grantee in ('anon', 'authenticated', 'public')`,
        [routine],
      );
      expect(`${routine}: ${grants.map((row) => row.grantee).join(',')}`).toBe(`${routine}: `);
      expect(statements).toContain(`grant execute on function public.${routine}`);
    }
  });

  /*
   * A reader whose own account is being deleted may see *that*, and nothing about
   * the ledger. This is the one policy in the area, and it must stay a select.
   */
  it('leaves the lifecycle table readable to its owner and no more', async () => {
    const policies = await query<{ cmd: string; roles: string }>(
      `select cmd, roles::text from pg_policies
        where schemaname = 'public' and tablename = 'account_lifecycle'`,
    );
    expect(policies).toEqual([{ cmd: 'SELECT', roles: '{authenticated}' }]);
  });
});

describe('seeing a stuck deletion', () => {
  it('counts what an account still owns, so a purge can be proved rather than claimed', async () => {
    await as(null);
    const before = await query<{ account_residual_data_count: number }>(
      'select public.account_residual_data_count($1)', [BOB],
    );
    expect(before[0].account_residual_data_count).toBeGreaterThan(0);

    await query('select public.purge_account_data($1)', [BOB]);
    const after = await query<{ account_residual_data_count: number }>(
      'select public.account_residual_data_count($1)', [BOB],
    );
    expect(after[0].account_residual_data_count).toBe(0);
  });

  it('names the state of every deletion in flight, including the one nothing else could see', async () => {
    await as(null);
    await query('select public.begin_account_deletion($1)', [ALICE]);

    let report = await query<{ user_id: string; state: string; stuck: boolean; auth_user_exists: boolean }>(
      `select * from public.account_deletion_report(interval '1 hour')`,
    );
    expect(report.find((row) => row.user_id === ALICE)).toMatchObject({
      state: 'closing', stuck: false, auth_user_exists: true,
    });

    await query(`select public.advance_account_deletion($1, 'provider_settled')`, [ALICE]);
    report = await query(`select * from public.account_deletion_report(interval '1 hour')`);
    expect(report.find((row) => row.user_id === ALICE)?.state).toBe('purge_pending');

    await query('select public.purge_account_data($1)', [ALICE]);
    await query(`select public.advance_account_deletion($1, 'data_purged')`, [ALICE]);
    report = await query(`select * from public.account_deletion_report(interval '1 hour')`);

    // The state a failed `deleteUser` leaves behind: data gone, account present.
    const alice = report.find((row) => row.user_id === ALICE) as unknown as {
      state: string; residual_rows: number; auth_user_exists: boolean;
    };
    expect(alice).toMatchObject({
      state: 'awaiting_auth_delete', residual_rows: 0, auth_user_exists: true,
    });
  });

  it('flags a deletion that has sat still longer than the threshold', async () => {
    await as(null);
    await query(
      `update public.account_lifecycle set updated_at = now() - interval '3 hours' where user_id = $1`,
      [ALICE],
    );
    const report = await query<{ user_id: string; stuck: boolean }>(
      `select * from public.account_deletion_report(interval '1 hour')`,
    );
    expect(report.find((row) => row.user_id === ALICE)?.stuck).toBe(true);

    const lenient = await query<{ user_id: string; stuck: boolean }>(
      `select * from public.account_deletion_report(interval '1 day')`,
    );
    expect(lenient.find((row) => row.user_id === ALICE)?.stuck).toBe(false);
  });

  it('reports the retention flag, the schedule and the counts without a digest', async () => {
    await clearClaims();
    await seedClaim({ hash: hashOf('71'), claimedAgoDays: 2000 });
    await seedClaim({ hash: hashOf('72'), claimedAgoDays: 1, origin: 'production_qa' });

    const rows = await query<Record<string, unknown>>('select * from public.trial_retention_status()');
    expect(rows[0]).toMatchObject({
      enforcement_enabled: false,
      batch_limit: 500,
      total_claims: 2,
      due_now: 1,
      held_now: 0,
      qa_claims: 1,
      // pg_cron is not installed in this harness, and it says so rather than
      // asserting a schedule nobody has.
      scheduled: false,
    });
    expect(Object.keys(rows[0]).some((name) => /hash|email/.test(name))).toBe(false);
  });
});

describe('the schedule', () => {
  it('is installed on the database scheduler, applying by default so the flag decides', () => {
    expect(statements).toContain("'portkheaw-trial-retention'");
    expect(statements).toContain('purge_expired_trial_identity_claims(gen_random_uuid(), true, null)');
    // Guarded, so a deployment without pg_cron still applies the migration.
    expect(statements).toContain("to_regproc('cron.schedule') is null");
    // Unscheduled before scheduling, so re-running the migration leaves one job.
    expect(statements).toContain('cron.unschedule');
  });

  it('needs no new HTTP surface and therefore no new secret', () => {
    expect(statements).not.toContain('cron_secret');
    expect(statements).not.toContain('net.http');
  });
});
