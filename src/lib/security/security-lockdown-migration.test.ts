import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The lockdown migration, run against a real Postgres.
 *
 * The source-reading contracts next door prove the SQL *says* the right things.
 * This proves it *does* them — that the triggers fire, that the routines refuse
 * the callers they are supposed to refuse, and that the audit row lands in the
 * same transaction as the flag. A migration is the one artefact where reading it
 * is genuinely not enough: a trigger attached to the wrong event, a `security
 * definer` that resolves a name it should not, or a check written against `old`
 * where it meant `new` all read perfectly and fail in production.
 *
 * The rules somebody loses control of the platform over if they are wrong:
 *
 *   * a non-operator cannot move the switch, read the posture, or read the log;
 *   * the audit row and the flag move together or not at all;
 *   * while the switch is on, nobody grants themselves `admin` — including
 *     through a path that never touches the application;
 *   * a brand-new signup still gets its ordinary role row during a lockdown;
 *   * the operator can always release the switch.
 */

const MIGRATION_FILE = '202608140001_security_lockdown_and_audit.sql';

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
  '202608070003_maintenance_and_release_notes.sql',
  MIGRATION_FILE,
];

/** The owner UUID the Phase 3.1 migration seeds; its account must exist first. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const READER = '22222222-2222-4222-8222-222222222222';
const NEWCOMER = '33333333-3333-4333-8333-333333333333';

let db: PGlite;

/** Run as one signed-in reader. `null` is the trusted server (no JWT claim). */
async function as(userId: string | null): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ''}', false)`);
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

/** Throw the database's own error message, or return null when it succeeded. */
async function refusalFrom(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await query(sql, params);
    return null;
  } catch (error) {
    return (error as { message?: string }).message ?? 'unknown';
  }
}

async function setLockdown(enabled: boolean): Promise<void> {
  await db.exec(`
    update public.app_runtime_settings
       set security_lockdown_enabled = ${enabled ? 'true' : 'false'}
     where singleton;
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
          ('${OPERATOR}', 'operator@example.com', now(), now() - interval '60 days'),
          ('${READER}', 'reader@example.com', now(), now() - interval '30 days');
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec('grant usage on schema public, auth to anon, authenticated');

  for (const user of [OPERATOR, READER]) {
    await db.exec(`
      insert into public.profiles (id, full_name) values ('${user}', 'Reader')
        on conflict (id) do update set full_name = excluded.full_name;
      insert into public.user_settings (user_id) values ('${user}') on conflict (user_id) do nothing;
      insert into public.user_roles (user_id) values ('${user}') on conflict (user_id) do nothing;
      insert into public.user_subscriptions (user_id) values ('${user}') on conflict (user_id) do nothing;
    `);
  }

  // One operator, promoted before any lockdown exists.
  await db.exec(`update public.user_roles set role = 'admin' where user_id = '${OPERATOR}'`);
});

beforeEach(async () => {
  await setLockdown(false);
  await as(null);
});

describe('the migration applies and defaults to open', () => {
  it('adds the lockdown columns to the existing settings singleton', async () => {
    const [row] = await query<{
      security_lockdown_enabled: boolean;
      security_lockdown_reason: string | null;
      security_lockdown_started_at: string | null;
    }>('select * from public.app_runtime_settings where singleton');
    expect(row.security_lockdown_enabled).toBe(false);
    expect(row.security_lockdown_reason).toBeNull();
    expect(row.security_lockdown_started_at).toBeNull();
  });

  it('is replayable — applying it twice changes nothing', async () => {
    await setLockdown(true);
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8'));
    const [row] = await query<{ security_lockdown_enabled: boolean }>(
      'select security_lockdown_enabled from public.app_runtime_settings where singleton',
    );
    // A schema redeploy must not release a lockdown behind the operator who set
    // it — nor engage one behind an operator who did not.
    expect(row.security_lockdown_enabled).toBe(true);
  });

  it('leaves the maintenance switch untouched', async () => {
    const [row] = await query<{ maintenance_enabled: boolean }>(
      'select maintenance_enabled from public.app_runtime_settings where singleton',
    );
    expect(row.maintenance_enabled).toBe(false);
  });
});

describe('only an operator may touch the switch', () => {
  it('refuses a signed-out caller', async () => {
    await as(null);
    expect(await refusalFrom(
      `select public.admin_set_security_lockdown(true, 'test', 'req-1')`,
    )).toContain('Authentication required');
  });

  it('refuses an ordinary reader, whatever they send', async () => {
    await as(READER);
    expect(await refusalFrom(
      `select public.admin_set_security_lockdown(true, 'let me in', 'req-2')`,
    )).toContain('ADMIN_REQUIRED');
  });

  it('refuses an ordinary reader the operator posture view', async () => {
    await as(READER);
    expect(await refusalFrom('select * from public.admin_security_posture()'))
      .toContain('ADMIN_REQUIRED');
  });

  it('refuses an ordinary reader the security audit', async () => {
    await as(READER);
    expect(await refusalFrom('select * from public.admin_security_audit(10, 0)'))
      .toContain('ADMIN_REQUIRED');
  });

  it('lets an operator engage and release it', async () => {
    await as(OPERATOR);
    const [engaged] = await query<{ admin_set_security_lockdown: string }>(
      `select public.admin_set_security_lockdown(true, 'suspicious console access', 'req-3')`,
    );
    expect(engaged.admin_set_security_lockdown).toBe('enabled');

    const [released] = await query<{ admin_set_security_lockdown: string }>(
      `select public.admin_set_security_lockdown(false, null, 'req-4')`,
    );
    expect(released.admin_set_security_lockdown).toBe('disabled');
  });

  it('reports `unchanged` rather than rewriting an identical state', async () => {
    await as(OPERATOR);
    await query(`select public.admin_set_security_lockdown(true, 'same reason', 'req-5')`);
    const [again] = await query<{ admin_set_security_lockdown: string }>(
      `select public.admin_set_security_lockdown(true, 'same reason', 'req-6')`,
    );
    expect(again.admin_set_security_lockdown).toBe('unchanged');
  });

  it('does not re-stamp the start instant when the reason is edited mid-incident', async () => {
    await as(OPERATOR);
    await query(`select public.admin_set_security_lockdown(true, 'first note', 'req-7')`);
    const [before] = await query<{ security_lockdown_started_at: string }>(
      'select security_lockdown_started_at from public.app_runtime_settings where singleton',
    );
    await query(`select public.admin_set_security_lockdown(true, 'clarified note', 'req-8')`);
    const [after] = await query<{ security_lockdown_started_at: string }>(
      'select security_lockdown_started_at from public.app_runtime_settings where singleton',
    );
    // The duration of an incident must not reset because somebody fixed a typo.
    // Compared as instants: the driver hands back `Date` objects, so identity
    // would be asserting something about the driver rather than about the row.
    expect(new Date(after.security_lockdown_started_at).toISOString())
      .toBe(new Date(before.security_lockdown_started_at).toISOString());
  });

  it('clears the reason and the stamps on release', async () => {
    await as(OPERATOR);
    await query(`select public.admin_set_security_lockdown(true, 'a reason', 'req-9')`);
    await query(`select public.admin_set_security_lockdown(false, null, 'req-10')`);
    const [row] = await query<{
      security_lockdown_reason: string | null;
      security_lockdown_started_at: string | null;
      security_lockdown_started_by: string | null;
    }>('select * from public.app_runtime_settings where singleton');
    expect(row.security_lockdown_reason).toBeNull();
    expect(row.security_lockdown_started_at).toBeNull();
    expect(row.security_lockdown_started_by).toBeNull();
  });
});

describe('the switch and its audit row move together', () => {
  it('writes an audit row in the same transaction as the flag', async () => {
    await as(OPERATOR);
    await query(`select public.admin_set_security_lockdown(true, 'incident 42', 'req-11')`);

    await as(null);
    const rows = await query<{ action: string; actor_user_id: string; after_summary: Record<string, unknown> }>(
      `select action, actor_user_id, after_summary from public.admin_audit_events
        where target_ref = 'security_lockdown' order by id desc limit 1`,
    );
    expect(rows[0].action).toBe('security.lockdown.enabled');
    expect(rows[0].actor_user_id).toBe(OPERATOR);
    expect(rows[0].after_summary).toMatchObject({ lockdown_enabled: true, reason: 'incident 42' });
  });

  it('records the release as its own event', async () => {
    await as(OPERATOR);
    await query(`select public.admin_set_security_lockdown(true, 'x', 'req-12')`);
    await query(`select public.admin_set_security_lockdown(false, null, 'req-13')`);

    await as(null);
    const [row] = await query<{ action: string }>(
      `select action from public.admin_audit_events
        where target_ref = 'security_lockdown' order by id desc limit 1`,
    );
    expect(row.action).toBe('security.lockdown.disabled');
  });

  it('cannot be edited or deleted afterwards, by anyone', async () => {
    await as(OPERATOR);
    await query(`select public.admin_set_security_lockdown(true, 'evidence', 'req-14')`);
    await as(null);
    // Even the trusted server connection is refused: the record of an incident
    // must outlive any decision to tidy it up.
    expect(await refusalFrom(
      `update public.admin_audit_events set action = 'nothing.happened' where target_ref = 'security_lockdown'`,
    )).toContain('AUDIT_APPEND_ONLY');
    expect(await refusalFrom(
      `delete from public.admin_audit_events where target_ref = 'security_lockdown'`,
    )).toContain('AUDIT_APPEND_ONLY');
  });
});

describe('while the switch is on, nobody grants themselves privilege', () => {
  it('refuses a promotion to admin, even from the trusted server connection', async () => {
    await setLockdown(true);
    await as(null);
    // The trigger is on the table, so it holds for a path that never touches the
    // application — a `service_role` script, or a routine written next month.
    expect(await refusalFrom(
      `update public.user_roles set role = 'admin' where user_id = '${READER}'`,
    )).toContain('SECURITY_LOCKDOWN');
  });

  it('refuses a direct insert of an admin row', async () => {
    await setLockdown(true);
    await as(null);
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at) values
        ('${NEWCOMER}', 'newcomer@example.com', now())
      on conflict (id) do nothing;
    `);
    expect(await refusalFrom(
      `insert into public.user_roles (user_id, role) values ('${NEWCOMER}', 'admin')`,
    )).toContain('SECURITY_LOCKDOWN');
  });

  it('refuses a demotion too, so evidence cannot be removed mid-incident', async () => {
    await setLockdown(true);
    await as(null);
    expect(await refusalFrom(
      `update public.user_roles set role = 'user' where user_id = '${OPERATOR}'`,
    )).toContain('SECURITY_LOCKDOWN');
  });

  it('refuses deleting the row that records an operator', async () => {
    await setLockdown(true);
    await as(null);
    expect(await refusalFrom(
      `delete from public.user_roles where user_id = '${OPERATOR}'`,
    )).toContain('SECURITY_LOCKDOWN');
  });

  it('still lets a brand-new signup get its ordinary role row', async () => {
    /*
     * The blast radius this scoping exists to avoid. A lockdown that refused
     * every write to `user_roles` would take account creation down as a side
     * effect of an unrelated control — `handle_new_user` inserts the default
     * row for every signup.
     */
    await setLockdown(true);
    await as(null);
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at) values
        ('${NEWCOMER}', 'newcomer@example.com', now())
      on conflict (id) do nothing;
    `);
    expect(await refusalFrom(
      `insert into public.user_roles (user_id) values ('${NEWCOMER}') on conflict (user_id) do nothing`,
    )).toBeNull();
  });

  it('refuses an access preview outright', async () => {
    await setLockdown(true);
    await as(OPERATOR);
    expect(await refusalFrom(`select * from public.set_my_admin_access_preview('elite')`))
      .toContain('SECURITY_LOCKDOWN');
  });

  it('lets the operator release the switch while it is engaged', async () => {
    // The lockout case. A control that cannot be released while engaged is not
    // a control, and `app_runtime_settings` deliberately carries no trigger.
    await setLockdown(true);
    await as(OPERATOR);
    const [released] = await query<{ admin_set_security_lockdown: string }>(
      `select public.admin_set_security_lockdown(false, null, 'req-15')`,
    );
    expect(released.admin_set_security_lockdown).toBe('disabled');
  });

  it('leaves role changes working again the moment it is released', async () => {
    await setLockdown(true);
    await setLockdown(false);
    await as(null);
    expect(await refusalFrom(
      `update public.user_roles set role = 'user' where user_id = '${READER}'`,
    )).toBeNull();
  });
});

describe('the posture read', () => {
  it('answers both switches and the caller´s role in one row', async () => {
    await as(OPERATOR);
    const [row] = await query<{
      maintenance_enabled: boolean; security_lockdown_enabled: boolean; is_admin: boolean;
    }>('select * from public.resolve_runtime_posture()');
    expect(row.maintenance_enabled).toBe(false);
    expect(row.security_lockdown_enabled).toBe(false);
    expect(row.is_admin).toBe(true);
  });

  it('tells an ordinary reader the posture but never calls them an operator', async () => {
    await setLockdown(true);
    await as(READER);
    const [row] = await query<{ security_lockdown_enabled: boolean; is_admin: boolean }>(
      'select * from public.resolve_runtime_posture()',
    );
    expect(row.security_lockdown_enabled).toBe(true);
    expect(row.is_admin).toBe(false);
  });

  it('answers a signed-out visitor without calling them an operator', async () => {
    await as(null);
    const [row] = await query<{ is_admin: boolean }>('select * from public.resolve_runtime_posture()');
    expect(row.is_admin).toBe(false);
  });
});

describe('the security event writer', () => {
  it('records an event attributed to the caller, never to an argument', async () => {
    await as(READER);
    const [result] = await query<{ record_security_event: string }>(
      `select public.record_security_event('admin.authorization.denied', 'admin-console', 3, 'denied', 'req-16')`,
    );
    expect(result.record_security_event).toBe('recorded');

    await as(null);
    const [row] = await query<{ actor_user_id: string; actor_role: string; after_summary: Record<string, unknown> }>(
      `select actor_user_id, actor_role, after_summary from public.admin_audit_events
        where target_type = 'security' order by id desc limit 1`,
    );
    // The actor is `auth.uid()`. There is no parameter that could name anybody else.
    expect(row.actor_user_id).toBe(READER);
    // An observation, not an operator action — recording a non-operator's denied
    // attempt as an *operator* action would corrupt the feed an incident is read from.
    expect(row.actor_role).toBe('system');
    expect(row.after_summary).toMatchObject({ outcome: 'denied', observedCount: 3 });
  });

  it('refuses an event key outside the allowlist', async () => {
    await as(READER);
    const [result] = await query<{ record_security_event: string }>(
      `select public.record_security_event('anything.i.like', 'wherever', 1, 'denied', 'req-17')`,
    );
    expect(result.record_security_event).toBe('invalid_event');
  });

  it('refuses a signed-out caller', async () => {
    await as(null);
    expect(await refusalFrom(
      `select public.record_security_event('admin.access.granted', 'x', 1, 'allowed', 'req-18')`,
    )).toContain('Authentication required');
  });

  it('normalises an outcome it does not recognise rather than losing the row', async () => {
    await as(READER);
    await query(
      `select public.record_security_event('admin.access.granted', 'admin-console', 1, 'whatever', 'req-19')`,
    );
    await as(null);
    const [row] = await query<{ after_summary: Record<string, unknown> }>(
      `select after_summary from public.admin_audit_events
        where target_type = 'security' order by id desc limit 1`,
    );
    expect(row.after_summary).toMatchObject({ outcome: 'unknown' });
  });

  it('clamps a hostile count instead of storing it', async () => {
    await as(READER);
    await query(
      `select public.record_security_event('admin.access.granted', 'admin-console', 999999999, 'observed', 'req-20')`,
    );
    await as(null);
    const [row] = await query<{ after_summary: { observedCount: number } }>(
      `select after_summary from public.admin_audit_events
        where target_type = 'security' order by id desc limit 1`,
    );
    expect(row.after_summary.observedCount).toBe(1000000);
  });

  it('truncates an over-long reference rather than refusing the evidence', async () => {
    await as(READER);
    await query(
      `select public.record_security_event('admin.access.granted', $1, 1, 'observed', 'req-21')`,
      ['x'.repeat(500)],
    );
    await as(null);
    const [row] = await query<{ target_ref: string }>(
      `select target_ref from public.admin_audit_events
        where target_type = 'security' order by id desc limit 1`,
    );
    expect(row.target_ref.length).toBe(160);
  });

  it('shows an operator the security feed and an ordinary reader nothing', async () => {
    await as(READER);
    await query(
      `select public.record_security_event('admin.authorization.denied', 'admin-console', 1, 'denied', 'req-22')`,
    );

    await as(OPERATOR);
    const rows = await query('select * from public.admin_security_audit(50, 0)');
    expect(rows.length).toBeGreaterThan(0);

    await as(READER);
    expect(await refusalFrom('select * from public.admin_security_audit(50, 0)'))
      .toContain('ADMIN_REQUIRED');
  });
});
