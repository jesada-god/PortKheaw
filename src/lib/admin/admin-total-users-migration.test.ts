import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * "ผู้ใช้งานทั้งหมด" on the operator dashboard, run against a real Postgres.
 *
 * The number is trivial to compute and easy to get subtly wrong, and every way
 * of getting it wrong prints a confident figure nobody can tell is false. So the
 * rules are asserted rather than assumed:
 *
 *   * a successful signup raises it by exactly one, and deleting that account
 *     lowers it by exactly one — because it is a `count(*)` of the account table
 *     at read time and not a stored total that could drift away from it;
 *   * an account GoTrue soft-deleted is not a user of the product any more;
 *   * the selected date range cannot move it;
 *   * it cannot be derived from the tier cards, so it has to be its own count;
 *   * the recreated routine still refuses a non-operator inside the database,
 *     and still returns every column the console already reads.
 */

const MIGRATION_FILE = '202608080002_admin_total_users.sql';

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
  MIGRATION_FILE,
];

/** The owner UUID the Phase 3.1 migration seeds as the platform administrator. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const READER = '11111111-1111-4111-8111-111111111111';
const OTHER_READER = '22222222-2222-4222-8222-222222222222';

/** The one that signs up and is deleted again inside the tests. */
const NEWCOMER = '33333333-3333-4333-8333-333333333333';

interface Overview {
  basic_members: number;
  pro_members: number;
  elite_members: number;
  new_members_today: number;
  /** PGlite returns a `date` column as a `Date`, not as the ISO string PostgREST sends. */
  period_from: string | Date;
  period_to: string | Date;
  total_users: number;
}

let db: PGlite;

/** Run as one signed-in reader. `null` is the trusted server (no JWT claim). */
async function as(userId: string | null): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ''}', false)`);
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

/** The dashboard read, exactly as the console makes it. */
async function overview(period: { from: string | null; to: string | null } = { from: null, to: null }) {
  await as(OWNER);
  const [row] = await query<Overview>(
    'select * from public.admin_dashboard_overview($1::date, $2::date)',
    [period.from, period.to],
  );
  return row;
}

/** How many rows the account table actually holds — the figure the card must match. */
async function liveAccounts(): Promise<number> {
  const [row] = await query<{ count: number }>(
    'select count(*)::integer as count from auth.users where deleted_at is null',
  );
  return row.count;
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
      -- GoTrue's own soft-delete marker. Present in the hosted schema, and the
      -- reason the count filters rather than taking the whole table.
      deleted_at timestamptz,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);

  for (const file of MIGRATION_CHAIN) {
    if (file === '202608030002_admin_role_and_access_preview.sql') {
      await db.exec(`
        insert into auth.users (id, email, email_confirmed_at, created_at) values
          ('${OWNER}', 'owner@example.com', now(), now() - interval '90 days'),
          ('${READER}', 'reader@example.com', now(), now() - interval '60 days'),
          ('${OTHER_READER}', 'other@example.com', now(), now() - interval '60 days');
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec('grant usage on schema public, auth to anon, authenticated');
});

describe('how many accounts exist', () => {
  it('counts the account table, not the tier cards', async () => {
    const stats = await overview();
    expect(stats.total_users).toBe(await liveAccounts());
    expect(stats.total_users).toBe(3);
  });

  it('rises by one when an account is created, and falls by one when it is deleted', async () => {
    const before = (await overview()).total_users;

    // A signup is one row in the account table; the trigger fans it out into a
    // profile, settings, a watchlist, a portfolio, a role and a subscription.
    await as(null);
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at, created_at)
      values ('${NEWCOMER}', 'newcomer@example.com', now(), now());
    `);
    const afterSignup = await overview();
    expect(afterSignup.total_users).toBe(before + 1);
    expect(afterSignup.total_users).toBe(await liveAccounts());

    // The deletion pipeline's last act (`202608060002`) is removing this row.
    await as(null);
    await db.exec(`delete from auth.users where id = '${NEWCOMER}'`);
    const afterDeletion = await overview();
    expect(afterDeletion.total_users).toBe(before);
    expect(afterDeletion.total_users).toBe(await liveAccounts());
  });

  it('stops counting an account GoTrue soft-deleted', async () => {
    const before = (await overview()).total_users;

    await as(null);
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at, created_at)
      values ('${NEWCOMER}', 'soft@example.com', now(), now());
    `);
    expect((await overview()).total_users).toBe(before + 1);

    await as(null);
    await db.exec(`update auth.users set deleted_at = now() where id = '${NEWCOMER}'`);
    expect((await overview()).total_users).toBe(before);

    await as(null);
    await db.exec(`delete from auth.users where id = '${NEWCOMER}'`);
  });

  it('counts an account that holds no subscription row at all', async () => {
    await as(null);
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at, created_at)
      values ('${NEWCOMER}', 'tierless@example.com', now(), now());
      delete from public.user_subscriptions where user_id = '${NEWCOMER}';
    `);

    const stats = await overview();
    const tiers = stats.basic_members + stats.pro_members + stats.elite_members;
    expect(stats.total_users).toBe(await liveAccounts());
    // The whole reason this cannot be assembled from the cards beside it.
    expect(stats.total_users).toBeGreaterThan(tiers);

    await as(null);
    await db.exec(`delete from auth.users where id = '${NEWCOMER}'`);
  });

  it('is the same number whatever date range the page asks for', async () => {
    const accounts = await liveAccounts();
    const wide = await overview({ from: '2000-01-01', to: '2100-01-01' });
    const narrow = await overview({ from: '2020-06-01', to: '2020-06-02' });
    const reversed = await overview({ from: '2100-01-01', to: '2000-01-01' });

    for (const stats of [wide, narrow, reversed]) {
      expect(stats.total_users).toBe(accounts);
    }
    // The range really did change — the other figures move with it. (PGlite
    // hands a `date` back as a Date, so compare the calendar day it names.)
    const day = (value: Overview['period_from']): string =>
      new Date(value).toISOString().slice(0, 10);
    expect(day(narrow.period_from)).toBe('2020-06-01');
    expect(day(wide.period_from)).toBe('2000-01-01');
  });
});

describe('the recreated routine keeps every boundary it had', () => {
  it('refuses a reader, and a session with no account at all', async () => {
    await as(READER);
    await expect(
      query('select * from public.admin_dashboard_overview(null, null)'),
    ).rejects.toThrow(/ADMIN_REQUIRED/);

    await as(null);
    await expect(
      query('select * from public.admin_dashboard_overview(null, null)'),
    ).rejects.toThrow(/Authentication required/);
  });

  it('returns every column the console already read, with the new one appended', async () => {
    const [row] = await query<{ result: string }>(`
      select pg_get_function_result(p.oid) as result
      from pg_proc as p
      join pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_dashboard_overview'
    `);
    const columns = row.result
      .replace(/^TABLE\(/, '')
      .replace(/\)$/, '')
      .split(', ')
      .map((entry) => entry.split(' ')[0]);

    expect(columns).toEqual([
      'basic_members', 'pro_members', 'elite_members', 'trial_members',
      'promptpay_pending', 'past_due_members', 'new_members_today', 'new_members_7d',
      'new_members_30d', 'revenue_today_minor', 'revenue_month_minor',
      'revenue_period_minor', 'refunds_period_minor', 'failed_webhooks',
      'dead_letter_webhooks', 'open_reconciliation_issues',
      'critical_reconciliation_issues', 'open_tickets', 'open_refund_requests',
      'period_from', 'period_to', 'database_now', 'total_users',
    ]);
  });

  it('leaves the count unreachable by a client role directly', async () => {
    // The routine is the only door; no client role may read the account table.
    const [grant] = await query<{ has: boolean }>(
      `select has_function_privilege('authenticated',
        'public.admin_dashboard_overview(date, date)', 'execute') as has`,
    );
    expect(grant.has).toBe(true);

    const [anonymous] = await query<{ has: boolean }>(
      `select has_function_privilege('anon',
        'public.admin_dashboard_overview(date, date)', 'execute') as has`,
    );
    expect(anonymous.has).toBe(false);
  });
});
