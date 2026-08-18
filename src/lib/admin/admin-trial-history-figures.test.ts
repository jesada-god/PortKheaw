import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The trial's history, beside its present — run against a real Postgres.
 *
 * `202608160003` settled what "กำลังทดลองใช้" means: a trial running at read
 * time, counted in one card and nowhere else. What it could not settle is how to
 * read a zero, because the same zero is returned by a product nobody has ever
 * trialled and by one whose trials have all ended — and the second is the
 * ordinary state of a young product, not a defect.
 *
 * So two figures are asserted here, and the thing being asserted about both is
 * that they do *not* move anybody:
 *
 *   * `trial_starts_total` counts every account that has ever started a week,
 *     including the ones that ended and the ones that turned into a purchase. It
 *     is zero only when the grant path has never run.
 *   * `expired_trial_members` counts the lapsed trials where they now are, which
 *     is inside `basic_members` — so it is asserted to be a strict subset of that
 *     card, never a sixth one, and the four current-state cards still sum to
 *     `total_users`.
 *
 * The same predicate now answers the question for one account in
 * `admin_search_accounts`, so a console reading a person and a card counting them
 * cannot disagree. The stored `status` is asserted to still say `trialing` after
 * the week is over: the row is not rewritten, and the operator is told that by
 * the dates rather than by a mutation.
 */

const MIGRATION_FILE = '202608170001_admin_trial_history_figures.sql';

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
  '202608060003_trial_retention_and_deletion_recovery.sql',
  '202608080002_admin_total_users.sql',
  '202608160003_admin_overview_trial_semantics.sql',
  MIGRATION_FILE,
];

/** The owner UUID the Phase 3.1 migration seeds as the platform administrator. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';

const TRIALIST = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const ELITE = '33333333-3333-4333-8333-333333333333';
const FREE = '44444444-4444-4444-8444-444444444444';

interface Overview {
  basic_members: number;
  pro_members: number;
  elite_members: number;
  trial_members: number;
  total_users: number;
  trial_starts_7d: number;
  trial_starts_total: number;
  expired_trial_members: number;
}

interface AccountRow {
  user_id: string;
  status: string;
  tier: string;
  effective_tier: string;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_active: boolean;
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
async function overview(): Promise<Overview> {
  await as(OWNER);
  const [row] = await query<Overview>(
    'select * from public.admin_dashboard_overview($1::date, $2::date)',
    [null, null],
  );
  await as(null);
  return row;
}

/** One account, read the way the billing console reads it. */
async function search(needle: string): Promise<AccountRow[]> {
  await as(OWNER);
  const rows = await query<AccountRow>(
    'select * from public.admin_search_accounts($1::text, 20)',
    [needle],
  );
  await as(null);
  return rows;
}

/** Put one account into a subscription state, as the trusted server. */
async function subscription(userId: string, columns: Record<string, string>): Promise<void> {
  const assignments = Object.entries(columns)
    .map(([column, value]) => `${column} = ${value}`)
    .join(', ');
  await as(null);
  await db.exec(`update public.user_subscriptions set ${assignments} where user_id = '${userId}'`);
}

/** A trial that has begun and has not ended. */
const RUNNING = {
  tier: "'elite'",
  status: "'trialing'",
  trial_started_at: "now() - interval '2 days'",
  trial_ends_at: "now() + interval '5 days'",
  trial_used_at: "now() - interval '2 days'",
};

/** The same trial, a fortnight later. Nothing about the row was rewritten. */
const LAPSED = {
  tier: "'elite'",
  status: "'trialing'",
  trial_started_at: "now() - interval '20 days'",
  trial_ends_at: "now() - interval '13 days'",
  trial_used_at: "now() - interval '20 days'",
};

/** Reset every account to the state a fresh signup leaves behind. */
async function resetSubscriptions(): Promise<void> {
  await as(null);
  await db.exec(`
    update public.user_subscriptions set
      tier = 'basic', status = 'basic',
      trial_started_at = null, trial_ends_at = null, trial_used_at = null,
      current_period_start = null, current_period_end = null,
      billing_provider_mode = null;
    delete from public.billing_invoices;
    delete from public.trial_identity_claims;
  `);
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
          ('${TRIALIST}', 'trialist@example.com', now(), now() - interval '3 days'),
          ('${PRO}', 'pro@example.com', now(), now() - interval '60 days'),
          ('${ELITE}', 'elite@example.com', now(), now() - interval '60 days'),
          ('${FREE}', 'free@example.com', now(), now() - interval '60 days');
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec('grant usage on schema public, auth to anon, authenticated');
});

beforeEach(async () => {
  await resetSubscriptions();
});

describe('one predicate decides what a running trial is', () => {
  it('answers the whole truth table from the row and the clock alone', async () => {
    const [row] = await query<Record<string, boolean>>(`
      select
        public.subscription_trial_is_active(
          'trialing', now() - interval '1 day', now() + interval '6 days', now()) as running,
        public.subscription_trial_is_active(
          'trialing', now() - interval '8 days', now() - interval '1 second', now()) as just_ended,
        public.subscription_trial_is_active(
          'trialing', now() + interval '2 days', now() + interval '9 days', now()) as not_begun,
        public.subscription_trial_is_active(
          'trialing', now() - interval '1 day', null, now()) as no_end,
        public.subscription_trial_is_active(
          'active', now() - interval '1 day', now() + interval '6 days', now()) as bought_mid_trial
    `);

    expect(row.running).toBe(true);
    // A boundary is a boundary: the instant the end is reached the trial is over.
    expect(row.just_ended).toBe(false);
    // No grant path stamps a future start; a repair script could.
    expect(row.not_begun).toBe(false);
    expect(row.no_end).toBe(false);
    // Somebody who paid during their week is a customer, not a trialist.
    expect(row.bought_mid_trial).toBe(false);
  });
});

describe('“เคยเริ่มทดลองใช้ทั้งหมด” separates a quiet week from a broken one', () => {
  it('is zero when no account has ever been granted a trial', async () => {
    const stats = await overview();
    expect(stats.trial_members).toBe(0);
    expect(stats.trial_starts_total).toBe(0);
  });

  it('counts every account that ever started one, whatever became of it', async () => {
    await subscription(TRIALIST, RUNNING);
    await subscription(FREE, LAPSED);
    // Trialled, then bought Pro. Still somebody who started a free week.
    await subscription(PRO, {
      tier: "'pro'",
      status: "'active'",
      billing_provider_mode: "'test'",
      trial_started_at: "now() - interval '40 days'",
      trial_ends_at: "now() - interval '33 days'",
      trial_used_at: "now() - interval '40 days'",
      current_period_start: "now() - interval '10 days'",
      current_period_end: "now() + interval '20 days'",
    });

    const stats = await overview();
    expect(stats.trial_starts_total).toBe(3);
    // …and only one of the three is on a trial right now.
    expect(stats.trial_members).toBe(1);
  });

  it('is not bounded by the seven-day window the movement figure uses', async () => {
    await subscription(FREE, LAPSED);

    const stats = await overview();
    expect(stats.trial_starts_7d).toBe(0);
    expect(stats.trial_starts_total).toBe(1);
  });
});

describe('“ทดลองใช้หมดอายุแล้ว” says where the lapsed trials went', () => {
  it('counts a trial that has ended, inside Basic rather than beside it', async () => {
    await subscription(TRIALIST, LAPSED);

    const stats = await overview();
    expect(stats.expired_trial_members).toBe(1);
    expect(stats.trial_members).toBe(0);
    // Basic is what that account can open, and it is where it is reported.
    expect(stats.basic_members).toBe(5);
    expect(stats.elite_members).toBe(0);
  });

  it('does not count a trial that is still running', async () => {
    await subscription(TRIALIST, RUNNING);

    const stats = await overview();
    expect(stats.expired_trial_members).toBe(0);
    expect(stats.trial_members).toBe(1);
  });

  it('does not count somebody who bought a plan after their week', async () => {
    await subscription(ELITE, {
      tier: "'elite'",
      status: "'active'",
      billing_provider_mode: "'live'",
      trial_started_at: "now() - interval '40 days'",
      trial_ends_at: "now() - interval '33 days'",
      trial_used_at: "now() - interval '40 days'",
      current_period_start: "now() - interval '10 days'",
      current_period_end: "now() + interval '20 days'",
    });

    const stats = await overview();
    // The trial did lapse, and the account is not in Basic — it is in the tier
    // it pays for, which is the card that should carry it.
    expect(stats.expired_trial_members).toBe(0);
    expect(stats.elite_members).toBe(1);
    expect(stats.trial_starts_total).toBe(1);
  });

  it('stays a subset of Basic, and leaves the row of cards adding up', async () => {
    await subscription(TRIALIST, RUNNING);
    await subscription(FREE, LAPSED);
    await subscription(PRO, {
      tier: "'pro'",
      status: "'active'",
      billing_provider_mode: "'test'",
      current_period_start: "now() - interval '10 days'",
      current_period_end: "now() + interval '20 days'",
    });

    const stats = await overview();
    expect(stats.expired_trial_members).toBeLessThanOrEqual(stats.basic_members);
    expect(
      stats.basic_members + stats.pro_members + stats.elite_members + stats.trial_members,
    ).toBe(stats.total_users);
  });

  it('moves an account from the trial card to the expired figure with nothing deleted', async () => {
    await subscription(TRIALIST, RUNNING);
    expect((await overview()).trial_members).toBe(1);

    // Only the clock changes — the same three columns the grant wrote, one of
    // them now in the past.
    await subscription(TRIALIST, { trial_ends_at: "now() - interval '1 second'" });

    const stats = await overview();
    expect(stats.trial_members).toBe(0);
    expect(stats.expired_trial_members).toBe(1);
    expect(stats.trial_starts_total).toBe(1);

    await as(null);
    const [row] = await query<{ used: string | null; started: string | null }>(
      `select trial_used_at as used, trial_started_at as started
       from public.user_subscriptions where user_id = '${TRIALIST}'`,
    );
    expect(row.used).not.toBeNull();
    expect(row.started).not.toBeNull();
  });
});

describe('the account search says which trial the operator is looking at', () => {
  it('reports a running trial as running, with its end', async () => {
    await subscription(TRIALIST, RUNNING);

    const [account] = await search('trialist@example.com');
    expect(account.trial_active).toBe(true);
    expect(account.trial_ends_at).not.toBeNull();
    expect(account.effective_tier).toBe('elite');
  });

  it('reports a lapsed trial without rewriting the row that records it', async () => {
    await subscription(TRIALIST, LAPSED);

    const [account] = await search('trialist@example.com');
    // The stored fact, unchanged: this is what stops a second free week.
    expect(account.status).toBe('trialing');
    expect(account.tier).toBe('elite');
    // …and the two columns that say it is over, so the console never has to
    // reconcile the status against the entitlement chip by hand.
    expect(account.trial_active).toBe(false);
    expect(account.effective_tier).toBe('basic');
    expect(Date.parse(account.trial_ends_at ?? '')).toBeLessThan(Date.now());
  });

  it('reports an account that never trialled as never having trialled', async () => {
    const [account] = await search('free@example.com');
    expect(account.trial_active).toBe(false);
    expect(account.trial_started_at).toBeNull();
    expect(account.trial_ends_at).toBeNull();
  });
});

describe('both recreated routines keep every boundary they had', () => {
  it('refuses a reader, and a session with no account at all', async () => {
    await as(TRIALIST);
    await expect(
      query('select * from public.admin_dashboard_overview(null, null)'),
    ).rejects.toThrow(/ADMIN_REQUIRED/);
    await expect(
      query("select * from public.admin_search_accounts('trialist', 20)"),
    ).rejects.toThrow(/ADMIN_REQUIRED/);

    await as(null);
    await expect(
      query('select * from public.admin_dashboard_overview(null, null)'),
    ).rejects.toThrow(/Authentication required/);
    await expect(
      query("select * from public.admin_search_accounts('trialist', 20)"),
    ).rejects.toThrow(/Authentication required/);
  });

  it('returns every column the console already read, with the new ones appended', async () => {
    const columnsOf = async (routine: string): Promise<string[]> => {
      const [row] = await query<{ result: string }>(`
        select pg_get_function_result(p.oid) as result
        from pg_proc as p
        join pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = '${routine}'
      `);
      return row.result
        .replace(/^TABLE\(/, '')
        .replace(/\)$/, '')
        .split(', ')
        .map((entry) => entry.split(' ')[0]);
    };

    expect(await columnsOf('admin_dashboard_overview')).toEqual([
      'basic_members', 'pro_members', 'elite_members', 'trial_members',
      'promptpay_pending', 'past_due_members', 'new_members_today', 'new_members_7d',
      'new_members_30d', 'revenue_today_minor', 'revenue_month_minor',
      'revenue_period_minor', 'refunds_period_minor', 'failed_webhooks',
      'dead_letter_webhooks', 'open_reconciliation_issues',
      'critical_reconciliation_issues', 'open_tickets', 'open_refund_requests',
      'period_from', 'period_to', 'database_now', 'total_users',
      'trial_starts_7d', 'paid_conversions_7d',
      'trial_starts_total', 'expired_trial_members',
    ]);

    expect(await columnsOf('admin_search_accounts')).toEqual([
      'user_id', 'email', 'full_name', 'role', 'tier', 'status', 'effective_tier',
      'billing_plan_key', 'billing_interval', 'billing_provider_mode',
      'billing_collection_method', 'current_period_end', 'cancel_at_period_end',
      'access_revoked_at', 'access_revoked_reason', 'open_ticket_count',
      'open_refund_count', 'database_now',
      'trial_started_at', 'trial_ends_at', 'trial_active',
    ]);
  });

  it('stays unreachable by an anonymous role directly', async () => {
    for (const signature of [
      'public.admin_dashboard_overview(date, date)',
      'public.admin_search_accounts(text, integer)',
    ]) {
      const [granted] = await query<{ has: boolean }>(
        `select has_function_privilege('authenticated', '${signature}', 'execute') as has`,
      );
      expect(granted.has).toBe(true);

      const [anonymous] = await query<{ has: boolean }>(
        `select has_function_privilege('anon', '${signature}', 'execute') as has`,
      );
      expect(anonymous.has).toBe(false);
    }
  });

  it('keeps the email cast that made searching work at all', async () => {
    // `auth.users.email` is varchar(255) upstream and the routine declares text.
    // Without the cast every search fails with 42804 — see `202608050006`.
    const rows = await search('owner@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(OWNER);
  });
});
