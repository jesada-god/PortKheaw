import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The Phase 6 migration, run against a real Postgres.
 *
 * These are the rules somebody loses access, money or privacy over if they are
 * wrong:
 *
 *   * introducing the beta takes nothing away from an account that already
 *     exists or already pays — the whole non-regression argument;
 *   * the stage never reaches `public` on its own, and a redeploy cannot reset a
 *     running stage back to its default;
 *   * the cohort cap is enforced inside the database, not in a form;
 *   * a non-operator cannot read an aggregate, change a stage, add an invite or
 *     write an audit row, whatever they send;
 *   * a funnel event lands once, carries no free text, and cannot be backdated
 *     or attributed to somebody else;
 *   * the admin audit cannot be edited or deleted, by anyone;
 *   * the rate limiter actually refuses past its bound.
 */

const MIGRATION_FILE = '202608050007_admin_beta_and_production_safety.sql';

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
  MIGRATION_FILE,
];

/** The owner UUID the Phase 3.1 migration seeds; its account must exist first. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
/** Signed up before the beta existed — must never be gated. */
const VETERAN = '11111111-1111-4111-8111-111111111111';
/** Signed up after, invited. */
const INVITED = '22222222-2222-4222-8222-222222222222';
/** Signed up after, not invited. */
const OUTSIDER = '33333333-3333-4333-8333-333333333333';
/** Signed up after, not invited, but already paying. */
const SUBSCRIBER = '44444444-4444-4444-8444-444444444444';

let db: PGlite;

/** Run as one signed-in reader. `null` is the trusted server (no JWT claim). */
async function as(userId: string | null): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ''}', false)`);
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
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
        insert into auth.users (id, email, email_confirmed_at, created_at) values
          ('${OWNER}', 'owner@example.com', now(), now() - interval '90 days'),
          ('${VETERAN}', 'veteran@example.com', now(), now() - interval '60 days'),
          ('${INVITED}', 'invited@example.com', now(), now()),
          ('${OUTSIDER}', 'outsider@example.com', now(), now()),
          ('${SUBSCRIBER}', 'subscriber@example.com', now(), now());
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec('grant usage on schema public, auth to anon, authenticated');

  for (const user of [VETERAN, INVITED, OUTSIDER, SUBSCRIBER]) {
    await db.exec(`
      insert into public.profiles (id, full_name) values ('${user}', 'Reader')
        on conflict (id) do update set full_name = excluded.full_name;
      insert into public.user_settings (user_id) values ('${user}') on conflict (user_id) do nothing;
      insert into public.user_roles (user_id) values ('${user}') on conflict (user_id) do nothing;
      insert into public.user_subscriptions (user_id) values ('${user}') on conflict (user_id) do nothing;
    `);
  }

  // The three accounts created "after" the program row must genuinely postdate
  // `enforced_from`, which was stamped when this migration ran.
  await db.exec(`
    update auth.users set created_at = now() + interval '1 minute'
    where id in ('${INVITED}', '${OUTSIDER}', '${SUBSCRIBER}');
  `);

  await db.exec(`
    update public.user_subscriptions set
      tier = 'pro', status = 'active',
      current_period_start = now() - interval '5 days',
      current_period_end = now() + interval '25 days',
      billing_plan_key = 'pro_monthly',
      billing_provider_mode = 'test',
      billing_collection_method = 'charge_automatically'
    where user_id = '${SUBSCRIBER}';
  `);
});

describe('the migration is additive and preserves a running rollout', () => {
  it('seeds exactly one program row, closed, with nothing capped', async () => {
    const rows = await query<{ stage: string; participant_cap: number | null; count: string }>(
      'select stage, participant_cap, (select count(*) from public.beta_program_state)::text as count from public.beta_program_state',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe('closed');
    expect(rows[0].count).toBe('1');
  });

  it('does not reset a running stage when the migration is replayed', async () => {
    await as(OWNER);
    await query("select public.admin_set_beta_stage('beta_20_50', 30, 'req-replay')");

    // Exactly what a redeploy of the schema does.
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8'));

    const rows = await query<{ stage: string; participant_cap: number }>(
      'select stage, participant_cap from public.beta_program_state',
    );
    expect(rows[0].stage).toBe('beta_20_50');
    expect(rows[0].participant_cap).toBe(30);

    await query("select public.admin_set_beta_stage('closed', null, 'req-reset')");
  });

  it('refuses to be moved to public by anything but an explicit operator call', async () => {
    // There is no trigger, no scheduler and no default that writes `public`.
    const migration = readFileSync(
      resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE),
      'utf8',
    );
    const automaticWrites = migration.match(/update\s+public\.beta_program_state\s+set/gi) ?? [];
    // Exactly one writer: `admin_set_beta_stage`, which checks the operator role.
    expect(automaticWrites).toHaveLength(1);
    expect(migration).toContain("if not public.is_platform_admin(requesting_user) then");
  });
});

describe('who may buy while the rollout is running', () => {
  async function access(userId: string | null) {
    await as(userId);
    const rows = await query<{ stage: string; admitted: boolean; reason: string }>(
      'select stage, admitted, reason from public.resolve_my_beta_access()',
    );
    return rows[0];
  }

  it('admits an operator in every stage, so the console cannot lock itself out', async () => {
    await as(OWNER);
    for (const stage of ['closed', 'beta_5_10', 'beta_20_50', 'public']) {
      await query('select public.admin_set_beta_stage($1, null, $2)', [stage, 'req-stage']);
      const result = await access(OWNER);
      expect(result.admitted).toBe(true);
      expect(result.reason).toBe('admin');
      await as(OWNER);
    }
    await query("select public.admin_set_beta_stage('closed', null, 'req-stage')");
  });

  it('never gates an account that existed before the program did', async () => {
    // The non-regression rule. `closed` is the harshest stage there is.
    const result = await access(VETERAN);
    expect(result.stage).toBe('closed');
    expect(result.admitted).toBe(true);
    expect(result.reason).toBe('pre_existing_account');
  });

  it('never gates an account that already pays', async () => {
    const result = await access(SUBSCRIBER);
    expect(result.admitted).toBe(true);
    expect(result.reason).toBe('existing_subscriber');
  });

  it('closes the door on a new account while the stage is closed', async () => {
    const result = await access(OUTSIDER);
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('closed_stage');
  });

  it('admits an invited account once a cohort stage is running', async () => {
    await as(OWNER);
    await query("select public.admin_set_beta_stage('beta_5_10', 10, 'req-open')");
    await query("select * from public.admin_add_beta_invite('Invited@Example.com', 'req-invite')");

    const invited = await access(INVITED);
    expect(invited.admitted).toBe(true);
    expect(invited.reason).toBe('invited');

    const outsider = await access(OUTSIDER);
    expect(outsider.admitted).toBe(false);
    expect(outsider.reason).toBe('not_invited');
  });

  it('withdraws admission when the invitation is revoked', async () => {
    await as(OWNER);
    const [invite] = await query<{ invite_id: string }>(
      "select invite_id from public.admin_beta_invites('invited@example.com', 10, 0)",
    );
    await query('select public.admin_revoke_beta_invite($1, $2)', [invite.invite_id, 'req-revoke']);

    const result = await access(INVITED);
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('not_invited');

    await as(OWNER);
    await query("select * from public.admin_add_beta_invite('invited@example.com', 'req-reinvite')");
  });

  it('admits everyone once the stage is public', async () => {
    await as(OWNER);
    await query("select public.admin_set_beta_stage('public', null, 'req-public')");
    const result = await access(OUTSIDER);
    expect(result.admitted).toBe(true);
    expect(result.reason).toBe('public_stage');

    await as(OWNER);
    await query("select public.admin_set_beta_stage('beta_5_10', 5, 'req-back')");
  });
});

describe('the cohort cap is enforced by the database', () => {
  it('refuses a cap outside the stage’s own band', async () => {
    await as(OWNER);
    const [tooBig] = await query<{ admin_set_beta_stage: string }>(
      "select public.admin_set_beta_stage('beta_5_10', 50, 'req-cap')",
    );
    expect(tooBig.admin_set_beta_stage).toBe('cap_out_of_band');

    const [tooSmall] = await query<{ admin_set_beta_stage: string }>(
      "select public.admin_set_beta_stage('beta_20_50', 3, 'req-cap')",
    );
    expect(tooSmall.admin_set_beta_stage).toBe('cap_out_of_band');
  });

  it('stops inviting once the cohort is full', async () => {
    await as(OWNER);
    // The stage is beta_5_10 capped at 5, and one invite already exists.
    for (const address of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
      const [row] = await query<{ outcome: string }>(
        'select outcome from public.admin_add_beta_invite($1, $2)',
        [address, 'req-fill'],
      );
      expect(row.outcome).toBe('invited');
    }

    const [refused] = await query<{ outcome: string; active_invites: number; participant_cap: number }>(
      "select outcome, active_invites, participant_cap from public.admin_add_beta_invite('e@example.com', 'req-over')",
    );
    expect(refused.outcome).toBe('cap_reached');
    expect(refused.active_invites).toBe(5);
    expect(refused.participant_cap).toBe(5);
  });

  it('refuses a malformed mailbox before it reaches the cap check', async () => {
    await as(OWNER);
    for (const bad of ['', 'nope', 'a@b', '@example.com']) {
      const [row] = await query<{ outcome: string }>(
        'select outcome from public.admin_add_beta_invite($1, $2)',
        [bad, 'req-bad'],
      );
      expect(row.outcome).toBe('invalid_email');
    }
  });

  it('never counts the same mailbox twice, whatever its casing', async () => {
    await as(OWNER);
    const [again] = await query<{ outcome: string }>(
      "select outcome from public.admin_add_beta_invite('A@Example.COM', 'req-dupe')",
    );
    expect(again.outcome).toBe('already_invited');
  });
});

describe('a non-operator reaches none of it', () => {
  const routines: readonly [string, string][] = [
    ['admin_set_beta_stage', "select public.admin_set_beta_stage('public', null, 'x')"],
    ['admin_add_beta_invite', "select * from public.admin_add_beta_invite('x@example.com', 'x')"],
    ['admin_revoke_beta_invite', `select public.admin_revoke_beta_invite('${OWNER}'::uuid, 'x')`],
    ['admin_dashboard_overview', 'select * from public.admin_dashboard_overview(null, null)'],
    ['admin_recent_billing_activity', "select * from public.admin_recent_billing_activity('all', null, 10, 0)"],
    ['admin_beta_report', 'select * from public.admin_beta_report()'],
    ['admin_beta_feature_report', 'select * from public.admin_beta_feature_report(10)'],
    ['admin_beta_invites', 'select * from public.admin_beta_invites(null, 10, 0)'],
    ['admin_beta_program_state', 'select * from public.admin_beta_program_state()'],
    ['admin_audit_feed', 'select * from public.admin_audit_feed(10, 0)'],
  ];

  it.each(routines)('refuses %s for an ordinary reader', async (_name, sql) => {
    await as(OUTSIDER);
    await expect(query(sql)).rejects.toThrow(/ADMIN_REQUIRED/);
  });

  it.each(routines)('refuses %s for a signed-out caller', async (_name, sql) => {
    await as(null);
    await expect(query(sql)).rejects.toThrow(/Authentication required/);
  });

  it('grants no client role a seat at any new table', async () => {
    const rows = await query<{ table_name: string; privilege_type: string; grantee: string }>(`
      select table_name, privilege_type, grantee
      from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee in ('anon', 'authenticated')
        and table_name in (
          'admin_audit_events', 'beta_program_state', 'beta_invites',
          'beta_funnel_events', 'rate_limit_counters'
        )
    `);
    expect(rows).toEqual([]);
  });

  it('keeps row-level security on every new table', async () => {
    const rows = await query<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in (
          'admin_audit_events', 'beta_program_state', 'beta_invites',
          'beta_funnel_events', 'rate_limit_counters'
        )
    `);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.relrowsecurity)).toBe(true);
  });
});

describe('the operator audit is evidence', () => {
  it('recorded every stage and invitation change with a before and an after', async () => {
    await as(OWNER);
    const rows = await query<{
      action: string; target_type: string; before_summary: unknown; after_summary: unknown; request_id: string | null;
    }>('select action, target_type, before_summary, after_summary, request_id from public.admin_audit_feed(100, 0)');

    const actions = rows.map((row) => row.action);
    expect(actions).toContain('beta_stage_changed');
    expect(actions).toContain('beta_invite_added');
    expect(actions).toContain('beta_invite_revoked');

    const stageChange = rows.find((row) => row.action === 'beta_stage_changed');
    expect(stageChange?.target_type).toBe('beta_program');
    expect(stageChange?.before_summary).toHaveProperty('stage');
    expect(stageChange?.after_summary).toHaveProperty('stage');
    expect(stageChange?.request_id).toBeTruthy();
  });

  it('masks the invited mailbox even inside the audit row', async () => {
    await as(OWNER);
    const rows = await query<{ after_summary: { emailMask?: string } }>(
      "select after_summary from public.admin_audit_events where action = 'beta_invite_added'",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.after_summary.emailMask).toMatch(/^.\*\*\*@/);
      expect(JSON.stringify(row.after_summary)).not.toContain('invited@example.com');
    }
  });

  it('cannot be edited or deleted, by anyone', async () => {
    await as(null);
    await expect(
      query("update public.admin_audit_events set action = 'rewritten'"),
    ).rejects.toThrow(/AUDIT_APPEND_ONLY/);
    await expect(
      query('delete from public.admin_audit_events'),
    ).rejects.toThrow(/AUDIT_APPEND_ONLY/);
  });

  it('does not stand in the way of deleting an account', async () => {
    // Phase 5.1 had to loosen the *support* audit trigger because it blocked a
    // cascade and broke account deletion. This table carries no foreign key to
    // an account, so nothing cascades into it and the unconditional refusal is
    // safe — but that is a claim worth exercising rather than asserting.
    const doomed = '55555555-5555-4555-8555-555555555555';
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at) values ('${doomed}', 'doomed@example.com', now());
      insert into public.user_roles (user_id, role) values ('${doomed}', 'admin')
        on conflict (user_id) do update set role = 'admin';
    `);
    await as(doomed);
    await query("select public.admin_set_beta_stage('beta_20_50', 20, 'req-doomed')");

    await db.exec(`delete from auth.users where id = '${doomed}'`);
    const remaining = await query<{ count: string }>(
      `select count(*)::text as count from public.admin_audit_events where actor_user_id = '${doomed}'`,
    );
    // The account is gone; the evidence of what it did is not.
    expect(remaining[0].count).toBe('1');

    await as(OWNER);
    await query("select public.admin_set_beta_stage('beta_5_10', 5, 'req-restore')");
  });

  it('reads operator ticket and refund decisions in the same feed', async () => {
    await as(OUTSIDER);
    const [ticket] = await query<{ ticket_id: string }>(
      "select ticket_id from public.create_support_ticket('billing', 'A subject', 'A description long enough to pass')",
    );
    await as(OWNER);
    await query("select public.admin_set_support_ticket_status($1, 'in_progress')", [ticket.ticket_id]);

    const rows = await query<{ source: string; action: string }>(
      'select source, action from public.admin_audit_feed(100, 0)',
    );
    expect(rows.some((row) => row.source === 'support' && row.action === 'ticket_status_changed')).toBe(true);
    // A reader's own reply is not an administrative action.
    expect(rows.some((row) => row.action === 'ticket_created')).toBe(false);
  });
});

describe('the funnel is privacy-safe and lands once', () => {
  it('records an approved event and refuses an unapproved one', async () => {
    await as(OUTSIDER);
    const [recorded] = await query<{ record_beta_funnel_event: string }>(
      "select public.record_beta_funnel_event('checkout_started', 'pro_monthly', 'card', null, 'scope-1')",
    );
    expect(recorded.record_beta_funnel_event).toBe('recorded');

    const [refused] = await query<{ record_beta_funnel_event: string }>(
      "select public.record_beta_funnel_event('password_entered', null, null, null, 'scope-2')",
    );
    expect(refused.record_beta_funnel_event).toBe('invalid_event');
  });

  it('collapses a repeat of the same scope instead of inflating the funnel', async () => {
    await as(OUTSIDER);
    const [again] = await query<{ record_beta_funnel_event: string }>(
      "select public.record_beta_funnel_event('checkout_started', 'pro_monthly', 'card', null, 'scope-1')",
    );
    expect(again.record_beta_funnel_event).toBe('duplicate');

    const rows = await query<{ count: string }>(
      "select count(*)::text as count from public.beta_funnel_events where event_key = 'checkout_started'",
    );
    expect(rows[0].count).toBe('1');
  });

  it('keeps one reader’s scope from colliding with another’s', async () => {
    await as(INVITED);
    const [other] = await query<{ record_beta_funnel_event: string }>(
      "select public.record_beta_funnel_event('checkout_started', 'pro_monthly', 'card', null, 'scope-1')",
    );
    expect(other.record_beta_funnel_event).toBe('recorded');
  });

  it('stamps the account, the clock and the stage itself — a caller cannot', async () => {
    await as(INVITED);
    const rows = await query<{ user_id: string; beta_stage: string; occurred_at: string; local_date: string }>(
      "select user_id, beta_stage, occurred_at, local_date from public.beta_funnel_events where user_id = '" + INVITED + "'",
    );
    expect(rows[0].user_id).toBe(INVITED);
    expect(rows[0].beta_stage).toBe('beta_5_10');
    expect(Date.parse(rows[0].occurred_at)).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('stores no column that could carry free text or payment detail', async () => {
    const rows = await query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'beta_funnel_events'
      order by column_name
    `);
    expect(rows.map((row) => row.column_name)).toEqual([
      'beta_stage', 'dedupe_key', 'event_key', 'feature_key', 'id',
      'local_date', 'occurred_at', 'payment_rail', 'plan_key', 'user_id',
    ]);
  });

  it('refuses a rail the product does not sell', async () => {
    await as(OUTSIDER);
    const [row] = await query<{ record_beta_funnel_event: string }>(
      "select public.record_beta_funnel_event('checkout_started', 'pro_monthly', 'crypto', null, 'scope-rail')",
    );
    expect(row.record_beta_funnel_event).toBe('invalid_rail');
  });
});

describe('the dashboard counts the ledger, not an estimate', () => {
  beforeAll(async () => {
    await db.exec(`
      insert into public.billing_invoices (
        user_id, provider_mode, invoice_id, plan_key, status,
        amount_due_minor, amount_paid_minor, amount_refunded_minor, currency, paid_at, issued_at
      ) values
        ('${SUBSCRIBER}', 'test', 'in_paid_today', 'pro_monthly', 'paid', 39900, 39900, 0, 'thb', now(), now()),
        ('${VETERAN}', 'test', 'in_partly_refunded', 'pro_monthly', 'partially_refunded', 39900, 39900, 10000, 'thb', now(), now()),
        ('${VETERAN}', 'test', 'in_open', 'pro_monthly', 'open', 39900, 0, 0, 'thb', null, now());
    `);
  });

  it('recognizes confirmed money in, minus confirmed money back — and nothing open', async () => {
    await as(OWNER);
    const [row] = await query<{ revenue_today_minor: string; revenue_month_minor: string }>(
      'select revenue_today_minor::text, revenue_month_minor::text from public.admin_dashboard_overview(null, null)',
    );
    // 39900 paid + (39900 paid - 10000 refunded). The open invoice is not revenue.
    expect(row.revenue_today_minor).toBe('69800');
    expect(row.revenue_month_minor).toBe('69800');
  });

  it('counts membership by the effective tier the product already resolves', async () => {
    await as(OWNER);
    const [row] = await query<{
      basic_members: number; pro_members: number; elite_members: number; past_due_members: number;
    }>('select basic_members, pro_members, elite_members, past_due_members from public.admin_dashboard_overview(null, null)');
    expect(row.pro_members).toBe(1);
    expect(row.basic_members).toBeGreaterThanOrEqual(3);
    expect(row.elite_members).toBe(0);
    expect(row.past_due_members).toBe(0);
  });

  it('reports webhook and reconciliation health from their own tables', async () => {
    await db.exec(`
      insert into public.billing_webhook_retries (provider_mode, provider_event_id, event_type, status, attempt_count)
      values ('test', 'evt_dead', 'invoice.paid', 'dead_letter', 10),
             ('test', 'evt_retry', 'invoice.paid', 'retrying', 2);
      insert into public.billing_reconciliation_issues (dedupe_key, issue_type, severity)
      values ('k1', 'dead_letter_event', 'critical'), ('k2', 'tier_period_mismatch', 'warning');
    `);
    await as(OWNER);
    const [row] = await query<{
      failed_webhooks: number; dead_letter_webhooks: number;
      open_reconciliation_issues: number; critical_reconciliation_issues: number;
    }>(`select failed_webhooks, dead_letter_webhooks, open_reconciliation_issues,
        critical_reconciliation_issues from public.admin_dashboard_overview(null, null)`);
    expect(row.failed_webhooks).toBe(1);
    expect(row.dead_letter_webhooks).toBe(1);
    expect(row.open_reconciliation_issues).toBe(2);
    expect(row.critical_reconciliation_issues).toBe(1);
  });

  it('corrects a reversed date range rather than reporting nothing', async () => {
    await as(OWNER);
    const [row] = await query<{ period_from: string; period_to: string }>(
      "select period_from::text, period_to::text from public.admin_dashboard_overview('2026-08-05', '2026-08-01')",
    );
    expect(row.period_from).toBe('2026-08-01');
    expect(row.period_to).toBe('2026-08-05');
  });

  it('pages and filters the recent activity list', async () => {
    await as(OWNER);
    const all = await query<{ activity_kind: string; total_count: string }>(
      "select activity_kind, total_count::text from public.admin_recent_billing_activity('all', null, 50, 0)",
    );
    expect(all.length).toBeGreaterThan(0);

    const payments = await query<{ activity_kind: string }>(
      "select activity_kind from public.admin_recent_billing_activity('payment', null, 50, 0)",
    );
    expect(payments.every((row) => row.activity_kind === 'payment')).toBe(true);

    // Rows genuinely share a timestamp here — an invoice paid and a subscription
    // updated in the same statement — which is exactly the case where an
    // unstable sort repeats one row across pages and silently drops another.
    const pageSize = 2;
    const seen: string[] = [];
    for (let offset = 0; offset < Number(all[0].total_count); offset += pageSize) {
      const page = await query<{ activity_kind: string; user_id: string; occurred_at: string }>(
        "select activity_kind, user_id, occurred_at from public.admin_recent_billing_activity('all', null, $1, $2)",
        [pageSize, offset],
      );
      seen.push(...page.map((row) => `${row.activity_kind}:${row.user_id}:${row.occurred_at}`));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(all.length);
  });

  it('finds an account by mailbox without the caller supplying an internal id', async () => {
    await as(OWNER);
    const rows = await query<{ email: string }>(
      "select email from public.admin_recent_billing_activity('payment', 'subscriber@', 10, 0)",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.email === 'subscriber@example.com')).toBe(true);
  });
});

describe('the beta report', () => {
  it('counts distinct accounts per stage, and invitations against the running stage', async () => {
    await as(OWNER);
    const rows = await query<{
      stage: string; invited: number; signed_up: number; paid: number; checkout_started: number;
    }>('select stage, invited, signed_up, paid, checkout_started from public.admin_beta_report()');

    const running = rows.find((row) => row.stage === 'beta_5_10');
    expect(running).toBeDefined();
    expect(running!.invited).toBe(5);
    // Only `invited@example.com` has an account among the five invitations.
    expect(running!.signed_up).toBe(1);
    expect(running!.paid).toBe(0);
    // Two distinct accounts started checkout while this stage was running.
    expect(running!.checkout_started).toBe(2);

    const closed = rows.find((row) => row.stage === 'closed');
    expect(closed?.invited).toBe(0);
  });

  it('reports which feature keys people reach for, and never who they were', async () => {
    await as(OUTSIDER);
    await query(
      "select public.record_beta_funnel_event('paywall_blocked', null, null, 'chart.vpvr', 'pw-1')",
    );
    await as(INVITED);
    await query(
      "select public.record_beta_funnel_event('paywall_blocked', null, null, 'chart.vpvr', 'pw-2')",
    );

    await as(OWNER);
    const rows = await query<{ event_key: string; feature_key: string; accounts: number }>(
      'select event_key, feature_key, accounts from public.admin_beta_feature_report(10)',
    );
    const blocked = rows.find((row) => row.feature_key === 'chart.vpvr');
    expect(blocked?.event_key).toBe('paywall_blocked');
    expect(blocked?.accounts).toBe(2);
    expect(Object.keys(rows[0])).not.toContain('user_id');
  });
});

describe('the rate limiter', () => {
  const key = 'a'.repeat(64);

  it('allows up to the bound and refuses past it', async () => {
    await as(OUTSIDER);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const [row] = await query<{ allowed: boolean; remaining: number }>(
        'select allowed, remaining from public.consume_rate_limit($1, 3, 60)',
        [key],
      );
      expect(row.allowed).toBe(true);
      expect(row.remaining).toBe(3 - attempt);
    }

    const [refused] = await query<{ allowed: boolean; retry_after_seconds: number }>(
      'select allowed, retry_after_seconds from public.consume_rate_limit($1, 3, 60)',
      [key],
    );
    expect(refused.allowed).toBe(false);
    expect(refused.retry_after_seconds).toBeGreaterThan(0);
  });

  it('refuses a malformed key rather than letting it bypass the limit', async () => {
    await as(OUTSIDER);
    const [row] = await query<{ allowed: boolean }>(
      "select allowed from public.consume_rate_limit('short', 100, 60)",
    );
    expect(row.allowed).toBe(false);
  });

  it('counts each key separately', async () => {
    await as(OUTSIDER);
    const [row] = await query<{ allowed: boolean }>(
      'select allowed from public.consume_rate_limit($1, 3, 60)',
      ['b'.repeat(64)],
    );
    expect(row.allowed).toBe(true);
  });
});

describe('readiness tells an anonymous caller nothing it should not', () => {
  it('answers with a word, never a timestamp, a count or an error', async () => {
    await as(null);
    const [row] = await query<{ database_ready: boolean; scheduler_status: string }>(
      'select database_ready, scheduler_status from public.platform_readiness()',
    );
    expect(row.database_ready).toBe(true);
    expect(['ok', 'lagging', 'stale', 'unknown']).toContain(row.scheduler_status);
    expect(Object.keys(row)).toEqual(['database_ready', 'scheduler_status']);
  });

  it('reports a fresh scheduler run as ok', async () => {
    await db.exec(`
      insert into public.alert_evaluation_runs (schedule_window, status, completed_at)
      values (now(), 'completed', now());
    `);
    await as(null);
    const [row] = await query<{ scheduler_status: string }>(
      'select scheduler_status from public.platform_readiness()',
    );
    expect(row.scheduler_status).toBe('ok');
  });
});
