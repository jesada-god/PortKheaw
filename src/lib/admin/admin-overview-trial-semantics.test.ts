import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The operator overview's user figures, run against a real Postgres.
 *
 * What is being asserted is a *vocabulary*, not an arithmetic: every card on the
 * page has to mean one thing, and one person has to appear in exactly one of
 * them. The defect these tests pin down is the one an operator could see and not
 * explain — an account on a live Elite trial counted by both "กำลังทดลองใช้" and
 * "Elite", and by "Basic" the day after it lapsed.
 *
 * The other half is time. "Active trial" is a question about now, so it is
 * decided against the database clock on every read: nothing is stored, no job has
 * to run, and — the property the whole trial defence rests on — nothing is
 * deleted when a trial ends. The identity ledger that stops a second free week
 * survives the trial it recorded, and is asserted to.
 */

const MIGRATION_FILE = '202608160003_admin_overview_trial_semantics.sql';

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
  // The ledger that outlives the trial, and the retention deadline on it. Here
  // because "the history survives" is one of the properties under test.
  '202608060002_account_deletion_and_trial_identity.sql',
  '202608060003_trial_retention_and_deletion_recovery.sql',
  '202608080002_admin_total_users.sql',
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
  past_due_members: number;
  new_members_today: number;
  new_members_7d: number;
  new_members_30d: number;
  total_users: number;
  trial_starts_7d: number;
  paid_conversions_7d: number;
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
async function overview(
  period: { from: string | null; to: string | null } = { from: null, to: null },
): Promise<Overview> {
  await as(OWNER);
  const [row] = await query<Overview>(
    'select * from public.admin_dashboard_overview($1::date, $2::date)',
    [period.from, period.to],
  );
  await as(null);
  return row;
}

/** Everything the five current-state cards report, added up. */
function currentStateTotal(stats: Overview): number {
  return stats.basic_members + stats.pro_members + stats.elite_members + stats.trial_members;
}

/** Put one account into a subscription state, as the trusted server. */
async function subscription(userId: string, columns: Record<string, string>): Promise<void> {
  const assignments = Object.entries(columns)
    .map(([column, value]) => `${column} = ${value}`)
    .join(', ');
  await as(null);
  await db.exec(`update public.user_subscriptions set ${assignments} where user_id = '${userId}'`);
}

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

async function payInvoice(userId: string, paidAt: string, amountMinor = 39900): Promise<void> {
  await as(null);
  await db.exec(`
    insert into public.billing_invoices (
      user_id, provider_mode, invoice_id, status, amount_due_minor, amount_paid_minor, paid_at
    ) values (
      '${userId}', 'test', 'in_${Math.random().toString(36).slice(2, 12)}',
      'paid', ${amountMinor}, ${amountMinor}, ${paidAt}
    );
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
      // Signup dates are spread on purpose: only one of these four is a member
      // of the trailing seven days, so "สมาชิกใหม่ 7 วัน" has something to be
      // wrong about.
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

describe('กำลังทดลองใช้ counts a trial that is running now', () => {
  it('counts an account whose trial has begun and has not ended', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '2 days'",
      trial_ends_at: "now() + interval '5 days'",
      trial_used_at: "now() - interval '2 days'",
    });

    const stats = await overview();
    expect(stats.trial_members).toBe(1);
  });

  it('does not count a trial whose end has just passed', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '7 days'",
      // One second on the far side of the boundary. The predicate is strict, so
      // the instant a trial's end is reached it stops being current.
      trial_ends_at: "now() - interval '1 second'",
      trial_used_at: "now() - interval '7 days'",
    });

    expect((await overview()).trial_members).toBe(0);
  });

  it('does not count a trial that expired days ago, and reports that account as Basic', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '20 days'",
      trial_ends_at: "now() - interval '13 days'",
      trial_used_at: "now() - interval '20 days'",
    });

    const stats = await overview();
    expect(stats.trial_members).toBe(0);
    // Basic is what the account can actually open once the week is over, which
    // is what `resolve_effective_subscription_tier` already answers.
    expect(stats.basic_members).toBe(5);
    expect(stats.elite_members).toBe(0);
  });

  it('does not count a trial stamped to begin in the future', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() + interval '2 days'",
      trial_ends_at: "now() + interval '9 days'",
      trial_used_at: 'now()',
    });

    // No grant path produces this, and a repair script could. A trial that has
    // not started is not a trial that is running.
    expect((await overview()).trial_members).toBe(0);
  });

  it('does not count a trial the reader never had', async () => {
    expect((await overview()).trial_members).toBe(0);
  });

  it('leaves the trial history and the identity ledger untouched when it stops counting', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '2 days'",
      trial_ends_at: "now() + interval '5 days'",
      trial_used_at: "now() - interval '2 days'",
    });
    await as(null);
    await db.exec(`
      insert into public.trial_identity_claims (identity_type, identity_hash, hash_version, claimed_by_user_id)
      values ('email', repeat('a', 64), 1, '${TRIALIST}');
    `);
    expect((await overview()).trial_members).toBe(1);

    // The only thing that changes is the clock.
    await subscription(TRIALIST, { trial_ends_at: "now() - interval '1 minute'" });
    expect((await overview()).trial_members).toBe(0);

    const [claims] = await query<{ count: number }>(
      'select count(*)::integer as count from public.trial_identity_claims',
    );
    expect(claims.count).toBe(1);

    const [history] = await query<{ used: string | null; started: string | null; ended: string | null }>(
      `select trial_used_at as used, trial_started_at as started, trial_ends_at as ended
       from public.user_subscriptions where user_id = '${TRIALIST}'`,
    );
    expect(history.used).not.toBeNull();
    expect(history.started).not.toBeNull();
    expect(history.ended).not.toBeNull();
  });
});

describe('one person, one card', () => {
  it('does not report a trial account as a paying Elite member', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '1 day'",
      trial_ends_at: "now() + interval '6 days'",
      trial_used_at: "now() - interval '1 day'",
    });

    const stats = await overview();
    expect(stats.trial_members).toBe(1);
    // The resolver still answers 'elite' for this account — a trial really does
    // grant the Elite product — and the card still does not claim they paid.
    expect(stats.elite_members).toBe(0);
    expect(stats.basic_members).toBe(4);
  });

  it('reports the current tier distribution, and adds up to the accounts that exist', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '1 day'",
      trial_ends_at: "now() + interval '6 days'",
      trial_used_at: "now() - interval '1 day'",
    });
    await subscription(PRO, {
      tier: "'pro'",
      status: "'active'",
      billing_provider_mode: "'test'",
      current_period_start: "now() - interval '10 days'",
      current_period_end: "now() + interval '20 days'",
    });
    await subscription(ELITE, {
      tier: "'elite'",
      status: "'active'",
      billing_provider_mode: "'test'",
      current_period_start: "now() - interval '10 days'",
      current_period_end: "now() + interval '20 days'",
    });

    const stats = await overview();
    expect(stats.trial_members).toBe(1);
    expect(stats.pro_members).toBe(1);
    expect(stats.elite_members).toBe(1);
    // The owner and the free account.
    expect(stats.basic_members).toBe(2);
    expect(currentStateTotal(stats)).toBe(stats.total_users);
    expect(stats.total_users).toBe(5);
  });

  it('counts an account holding no subscription row at all, as Basic', async () => {
    await as(null);
    await db.exec(`delete from public.user_subscriptions where user_id = '${FREE}'`);

    const stats = await overview();
    expect(stats.basic_members).toBe(5);
    expect(currentStateTotal(stats)).toBe(stats.total_users);

    // Put it back for the rest of the suite.
    await as(null);
    await db.exec(`insert into public.user_subscriptions (user_id) values ('${FREE}')`);
  });

  it('keeps a lapsed paid subscription in exactly one card', async () => {
    await subscription(ELITE, {
      tier: "'elite'",
      status: "'canceled'",
      billing_provider_mode: "'test'",
      current_period_start: "now() - interval '40 days'",
      current_period_end: "now() - interval '10 days'",
    });

    const stats = await overview();
    expect(stats.elite_members).toBe(0);
    expect(currentStateTotal(stats)).toBe(stats.total_users);
  });

  it('does not double count an account that is past due', async () => {
    await subscription(PRO, {
      tier: "'pro'",
      status: "'past_due'",
      billing_provider_mode: "'test'",
      current_period_start: "now() - interval '10 days'",
      current_period_end: "now() + interval '5 days'",
    });

    const stats = await overview();
    // Still holding what they paid for, and flagged for the operator once.
    expect(stats.pro_members).toBe(1);
    expect(stats.past_due_members).toBe(1);
    expect(currentStateTotal(stats)).toBe(stats.total_users);
  });

  it('stops counting an account GoTrue soft-deleted, in every user card', async () => {
    await subscription(PRO, {
      tier: "'pro'",
      status: "'active'",
      billing_provider_mode: "'test'",
      current_period_start: "now() - interval '10 days'",
      current_period_end: "now() + interval '20 days'",
    });
    expect((await overview()).pro_members).toBe(1);

    await as(null);
    await db.exec(`update auth.users set deleted_at = now() where id = '${PRO}'`);
    const stats = await overview();
    expect(stats.pro_members).toBe(0);
    expect(stats.total_users).toBe(4);
    expect(currentStateTotal(stats)).toBe(stats.total_users);

    await as(null);
    await db.exec(`update auth.users set deleted_at = null where id = '${PRO}'`);
  });
});

describe('the seven-day movement figures', () => {
  it('counts the accounts created in the window, and no others', async () => {
    const stats = await overview();
    expect(stats.new_members_7d).toBe(1);
    expect(stats.new_members_30d).toBe(1);
    expect(stats.new_members_today).toBe(0);
  });

  it('counts trials that began in the window, including ones that have since expired', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '3 days'",
      trial_ends_at: "now() + interval '4 days'",
      trial_used_at: "now() - interval '3 days'",
    });
    await subscription(FREE, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '6 days'",
      trial_ends_at: "now() - interval '1 hour'",
      trial_used_at: "now() - interval '6 days'",
    });

    const stats = await overview();
    // Two people started a trial this week; one of them is still on it. Those
    // are different questions and they now have different cards.
    expect(stats.trial_starts_7d).toBe(2);
    expect(stats.trial_members).toBe(1);
  });

  it('does not count a trial that began before the window', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '20 days'",
      trial_ends_at: "now() - interval '13 days'",
      trial_used_at: "now() - interval '20 days'",
    });

    expect((await overview()).trial_starts_7d).toBe(0);
  });

  it('counts the first settled invoice per account, never a renewal', async () => {
    // Converted this week.
    await payInvoice(TRIALIST, "now() - interval '2 days'");
    // Converted long ago and renewed inside the window: the same customer, not
    // a new one.
    await payInvoice(PRO, "now() - interval '80 days'");
    await payInvoice(PRO, "now() - interval '1 day'");

    const stats = await overview();
    expect(stats.paid_conversions_7d).toBe(1);
  });

  it('does not read a zero-value settled invoice as somebody starting to pay', async () => {
    await payInvoice(ELITE, "now() - interval '1 day'", 0);
    expect((await overview()).paid_conversions_7d).toBe(0);
  });
});

describe('the date range moves the revenue figures and nothing else', () => {
  it('leaves every current-state figure alone whatever range is asked for', async () => {
    await subscription(TRIALIST, {
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '1 day'",
      trial_ends_at: "now() + interval '6 days'",
      trial_used_at: "now() - interval '1 day'",
    });

    const wide = await overview({ from: '2000-01-01', to: '2100-01-01' });
    const narrow = await overview({ from: '2020-06-01', to: '2020-06-02' });
    const reversed = await overview({ from: '2100-01-01', to: '2000-01-01' });

    for (const stats of [wide, narrow, reversed]) {
      expect(stats.total_users).toBe(5);
      expect(stats.trial_members).toBe(1);
      expect(stats.basic_members).toBe(4);
      expect(stats.pro_members).toBe(0);
      expect(stats.elite_members).toBe(0);
      expect(stats.new_members_7d).toBe(1);
      expect(stats.trial_starts_7d).toBe(1);
      expect(currentStateTotal(stats)).toBe(stats.total_users);
    }
  });
});

describe('the recreated routine keeps every boundary it had', () => {
  it('refuses a reader, and a session with no account at all', async () => {
    await as(TRIALIST);
    await expect(
      query('select * from public.admin_dashboard_overview(null, null)'),
    ).rejects.toThrow(/ADMIN_REQUIRED/);

    await as(null);
    await expect(
      query('select * from public.admin_dashboard_overview(null, null)'),
    ).rejects.toThrow(/Authentication required/);
  });

  it('returns every column the console already read, with the two new ones appended', async () => {
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
      'trial_starts_7d', 'paid_conversions_7d',
    ]);
  });

  it('stays unreachable by a client role directly', async () => {
    const [granted] = await query<{ has: boolean }>(
      `select has_function_privilege('authenticated',
        'public.admin_dashboard_overview(date, date)', 'execute') as has`,
    );
    expect(granted.has).toBe(true);

    const [anonymous] = await query<{ has: boolean }>(
      `select has_function_privilege('anon',
        'public.admin_dashboard_overview(date, date)', 'execute') as has`,
    );
    expect(anonymous.has).toBe(false);
  });
});
