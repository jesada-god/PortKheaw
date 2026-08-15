import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

/**
 * Saved plans and account deletion, run against a real Postgres.
 *
 * `202608150001` created `stock_plans` and left it out of the account-deletion
 * pair on purpose, saying the change belonged to a migration of its own. This is
 * that migration, and these are the claims it has to make good on — none of
 * which can be read off the repository, because every one of them is a fact
 * about two function bodies that must agree:
 *
 *   * the purge removes a reader's plans, while their auth user still exists —
 *     the state a failed `deleteUser` leaves behind;
 *   * the reconciler COUNTS plans, so a plan the purge missed is a plan it
 *     refuses to delete the auth user over, rather than one it never looked for;
 *   * the two lists stay matched: in one and not the other is either a silent
 *     under-count or a deletion that stalls forever;
 *   * nobody else's plans move;
 *   * every other table the purge already handled behaves exactly as before, and
 *     the accounting record is still kept;
 *   * the `on delete cascade` the plans migration relies on is still the only
 *     foreign key on the table, and is not duplicated by any of this.
 */

const MIGRATION_FILE = '202608160001_stock_plans_account_deletion.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8');
/* Comments stripped: the prose explains what is deliberately NOT done here, and
   an assertion about the DDL must not be able to trip over it. */
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
  '202608060003_trial_retention_and_deletion_recovery.sql',
  '202608150001_stock_plans.sql',
  MIGRATION_FILE,
];

/** The owner UUID the Phase 3.1 migration seeds; its account must exist first. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
/** The account being closed. */
const LEAVER = '11111111-1111-4111-8111-111111111111';
/** The account that must be untouched by any of it. */
const BYSTANDER = '22222222-2222-4222-8222-222222222222';

let db: PGlite;

/** Service context: no session, which is what the pipeline runs as. */
async function asServer(): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

async function residualFor(userId: string): Promise<number> {
  const rows = await query<{ account_residual_data_count: number }>(
    'select public.account_residual_data_count($1)', [userId],
  );
  return rows[0].account_residual_data_count;
}

async function seedPlan(userId: string, symbol: string): Promise<void> {
  await query(
    `insert into public.stock_plans (user_id, symbol, baseline_price, target_price, invalidation_price, horizon_date)
     values ($1, $2, 100, 120, 90, date '2026-12-31')`,
    [userId, symbol],
  );
}

async function planCount(userId: string): Promise<number> {
  const rows = await query<{ count: number }>(
    'select count(*)::int as count from public.stock_plans where user_id = $1', [userId],
  );
  return rows[0].count;
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
          ('${LEAVER}', 'leaver@example.com', now()),
          ('${BYSTANDER}', 'bystander@example.com', now());
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await asServer();
});

describe('the matched pair', () => {
  /*
   * The failure this migration exists to prevent, asserted on the routines as
   * the database actually holds them rather than on the file that created them:
   * a table in the purge but not the count under-reports forever, and a table in
   * the count but not the purge stalls every deletion at `awaiting_auth_delete`.
   */
  it('names stock_plans in both routines, so neither can be changed alone', async () => {
    const rows = await query<{ purge: string; count: string }>(
      `select pg_get_functiondef('public.purge_account_data(uuid)'::regprocedure) as purge,
              pg_get_functiondef('public.account_residual_data_count(uuid)'::regprocedure) as count`,
    );
    expect(rows[0].purge).toContain("'stock_plans', 'user_id'");
    expect(rows[0].count).toContain("'stock_plans', 'user_id'");
  });

  it('is still reachable only by the trusted server', async () => {
    for (const routine of ['purge_account_data(uuid)', 'account_residual_data_count(uuid)']) {
      const rows = await query<{ anon: boolean; authenticated: boolean; service: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service`,
        [`public.${routine}`],
      );
      expect(`${routine}: ${JSON.stringify(rows[0])}`)
        .toBe(`${routine}: ${JSON.stringify({ anon: false, authenticated: false, service: true })}`);
    }
  });

  it('re-applies cleanly, because a migration that cannot be re-run cannot be resumed', async () => {
    await db.exec(rawSql);
    await asServer();
    expect(await residualFor(BYSTANDER)).toBeGreaterThanOrEqual(0);
  });
});

describe('closing an account that saved plans', () => {
  it('counts the plans before the purge and none after, and removes them', async () => {
    await asServer();
    await seedPlan(LEAVER, 'AAPL');
    await seedPlan(LEAVER, 'MSFT');
    await seedPlan(BYSTANDER, 'AAPL');
    expect(await planCount(LEAVER)).toBe(2);

    // The reconciler sees the plans: removing them alone drops the count by two,
    // which is the proof that the rows are inside the total rather than beside it.
    const withPlans = await residualFor(LEAVER);
    await query(`delete from public.stock_plans where user_id = $1 and symbol = 'MSFT'`, [LEAVER]);
    expect(await residualFor(LEAVER)).toBe(withPlans - 1);
    await seedPlan(LEAVER, 'MSFT');
    expect(await residualFor(LEAVER)).toBe(withPlans);

    // The real pipeline, in the order it runs.
    await query('select * from public.begin_account_deletion($1)', [LEAVER]);
    await query(`select public.advance_account_deletion($1, 'provider_settled')`, [LEAVER]);
    await query('select public.purge_account_data($1)', [LEAVER]);

    expect(await planCount(LEAVER)).toBe(0);
    expect(await residualFor(LEAVER)).toBe(0);
    // The auth user is still there — the state a failed `deleteUser` leaves, and
    // the one in which nothing of the person may remain.
    expect(await query('select 1 from auth.users where id = $1', [LEAVER])).toHaveLength(1);
  });

  it('leaves every other account s plans exactly where they were', async () => {
    expect(await planCount(BYSTANDER)).toBe(1);
    expect(await residualFor(BYSTANDER)).toBeGreaterThan(0);
  });

  it('reports the deletion as complete rather than stuck on a residual row', async () => {
    await asServer();
    await query(`select public.advance_account_deletion($1, 'data_purged')`, [LEAVER]);
    const report = await query<{ user_id: string; state: string; residual_rows: number }>(
      `select * from public.account_deletion_report(interval '1 hour')`,
    );
    expect(report.find((row) => row.user_id === LEAVER)).toMatchObject({
      state: 'awaiting_auth_delete', residual_rows: 0,
    });
  });
});

describe('everything else the purge already did', () => {
  const SUBJECT = '66666666-6666-4666-8666-666666666666';

  it('still removes the account s other tables and still keeps the accounting record', async () => {
    await asServer();
    await query(
      `insert into auth.users (id, email, email_confirmed_at) values ($1, 'dave@example.com', now())`, [SUBJECT],
    );
    await seedPlan(SUBJECT, 'NVDA');
    await query(
      `insert into public.price_alerts (user_id, symbol, condition, target_value)
       values ($1, 'AAPL', 'above', 100)`, [SUBJECT],
    );
    await query(
      `insert into public.billing_webhook_events (provider, provider_mode, provider_event_id, event_type, user_id)
       values ('stripe', 'live', 'evt_dave', 'invoice.paid', $1)`, [SUBJECT],
    );

    await query('select * from public.begin_account_deletion($1)', [SUBJECT]);
    await query('select public.purge_account_data($1)', [SUBJECT]);

    expect(await query('select 1 from public.stock_plans where user_id = $1', [SUBJECT])).toEqual([]);
    expect(await query('select 1 from public.price_alerts where user_id = $1', [SUBJECT])).toEqual([]);
    expect(await query('select 1 from public.watchlists where user_id = $1', [SUBJECT])).toEqual([]);
    expect(await query('select 1 from public.user_settings where user_id = $1', [SUBJECT])).toEqual([]);
    expect(await query('select 1 from public.profiles where id = $1', [SUBJECT])).toEqual([]);
    expect(await query('select 1 from public.billing_webhook_events where user_id = $1', [SUBJECT])).toHaveLength(1);
    expect(await residualFor(SUBJECT)).toBe(0);
  });

  it('deletes the auth user last, and the ledger outlives it', async () => {
    await query('delete from auth.users where id = $1', [SUBJECT]);
    expect(await query('select 1 from public.billing_webhook_events where user_id = $1', [SUBJECT])).toHaveLength(1);
  });
});

describe('the cascade the plans migration relies on', () => {
  it('is still the table s one foreign key, and still cascades', async () => {
    const rows = await query<{ constraint_name: string; delete_rule: string; column_name: string }>(
      `select tc.constraint_name, rc.delete_rule, kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.referential_constraints rc
           on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.table_schema
        where tc.table_schema = 'public' and tc.table_name = 'stock_plans'
          and tc.constraint_type = 'FOREIGN KEY'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delete_rule: 'CASCADE', column_name: 'user_id' });
    // Nothing here redefines it: the migration issues no table DDL at all, so
    // the cascade cannot have been duplicated or quietly replaced by this file.
    for (const ddl of ['alter table', 'create table', 'add constraint', 'create policy',
      'drop policy', 'create trigger', 'drop function']) {
      expect(`${ddl}: ${statements.includes(ddl)}`).toBe(`${ddl}: false`);
    }
  });

  it('still takes the plans with it when the auth user goes without a purge', async () => {
    const stray = '77777777-7777-4777-8777-777777777777';
    await asServer();
    await query(
      `insert into auth.users (id, email, email_confirmed_at) values ($1, 'erin@example.com', now())`, [stray],
    );
    await seedPlan(stray, 'TSLA');
    expect(await planCount(stray)).toBe(1);

    await query('delete from auth.users where id = $1', [stray]);
    expect(await planCount(stray)).toBe(0);
  });

  it('keeps owner-only row level security on the table', async () => {
    const rows = await query<{ relrowsecurity: boolean; policies: number }>(
      `select c.relrowsecurity,
              (select count(*)::int from pg_policies p
                where p.schemaname = 'public' and p.tablename = 'stock_plans') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'stock_plans'`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].policies).toBe(4);
  });
});
