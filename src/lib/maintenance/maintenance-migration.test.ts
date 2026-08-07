import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The maintenance switch and the release notes, run against a real Postgres.
 *
 * These are the rules somebody loses access, privacy or trust over if they are
 * wrong:
 *
 *   * only an operator may switch the product off, or back on;
 *   * a redeploy cannot reset a running maintenance window;
 *   * every toggle leaves an audit row naming the account that did it, taken
 *     from the session and never from an argument;
 *   * a draft is invisible to readers, and a non-operator cannot publish or edit
 *     one;
 *   * a reader sees the newest unseen release and only that one, and once they
 *     acknowledge it they never see it again — on any device;
 *   * no reader can write, or read, another reader's acknowledgement.
 */

const MIGRATION_FILE = '202608070003_maintenance_and_release_notes.sql';

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
          ('${READER}', 'reader@example.com', now(), now() - interval '60 days'),
          ('${OTHER_READER}', 'other@example.com', now(), now() - interval '60 days');
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec('grant usage on schema public, auth to anon, authenticated');

  for (const user of [READER, OTHER_READER]) {
    await db.exec(`
      insert into public.profiles (id, full_name) values ('${user}', 'Reader')
        on conflict (id) do update set full_name = excluded.full_name;
      insert into public.user_settings (user_id) values ('${user}') on conflict (user_id) do nothing;
      insert into public.user_roles (user_id) values ('${user}') on conflict (user_id) do nothing;
      insert into public.user_subscriptions (user_id) values ('${user}') on conflict (user_id) do nothing;
    `);
  }
});

describe('the maintenance switch', () => {
  it('seeds exactly one row, switched on for readers', async () => {
    const rows = await query<{ maintenance_enabled: boolean; count: string }>(
      `select maintenance_enabled,
              (select count(*) from public.app_runtime_settings)::text as count
       from public.app_runtime_settings`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].maintenance_enabled).toBe(false);
    expect(rows[0].count).toBe('1');
  });

  it('an operator can switch it off and the row records who and when', async () => {
    await as(OWNER);
    const [{ admin_set_maintenance: outcome }] = await query<{ admin_set_maintenance: string }>(
      `select public.admin_set_maintenance(true, 'อัปเดตระบบพอร์ต', null, 'req-1')`,
    );
    expect(outcome).toBe('enabled');

    const [state] = await query<{
      maintenance_enabled: boolean;
      maintenance_message: string;
      maintenance_started_at: string | null;
      maintenance_started_by: string | null;
    }>('select * from public.app_runtime_settings');
    expect(state.maintenance_enabled).toBe(true);
    expect(state.maintenance_message).toBe('อัปเดตระบบพอร์ต');
    expect(state.maintenance_started_at).not.toBeNull();
    expect(state.maintenance_started_by).toBe(OWNER);
  });

  it('editing the notice mid-window does not restart the outage clock', async () => {
    await as(OWNER);
    const [before] = await query<{ maintenance_started_at: string }>(
      'select maintenance_started_at::text as maintenance_started_at from public.app_runtime_settings',
    );
    await query(`select public.admin_set_maintenance(true, 'ปรับข้อความใหม่', null, 'req-2')`);
    const [after] = await query<{ maintenance_started_at: string }>(
      'select maintenance_started_at::text as maintenance_started_at from public.app_runtime_settings',
    );
    expect(after.maintenance_started_at).toBe(before.maintenance_started_at);
  });

  it('a reader can read the public notice but is never reported as an operator', async () => {
    await as(READER);
    const [row] = await query<{
      maintenance_enabled: boolean; maintenance_message: string; is_admin: boolean;
    }>('select * from public.resolve_maintenance_state()');
    expect(row.maintenance_enabled).toBe(true);
    expect(row.maintenance_message).toBe('ปรับข้อความใหม่');
    expect(row.is_admin).toBe(false);
  });

  it('reports the operator as an operator, in the same read', async () => {
    await as(OWNER);
    const [row] = await query<{ is_admin: boolean }>('select * from public.resolve_maintenance_state()');
    expect(row.is_admin).toBe(true);
  });

  it('a reader cannot switch the product off, or on', async () => {
    await as(READER);
    await expect(query(`select public.admin_set_maintenance(false, null, null, null)`))
      .rejects.toThrow(/ADMIN_REQUIRED/);
    await expect(query('select * from public.admin_maintenance_state()'))
      .rejects.toThrow(/ADMIN_REQUIRED/);
    await expect(query('select * from public.admin_maintenance_audit(10)'))
      .rejects.toThrow(/ADMIN_REQUIRED/);
  });

  it('a reader cannot write the settings row directly either', async () => {
    await as(READER);
    await db.exec('set role authenticated');
    await expect(query('update public.app_runtime_settings set maintenance_enabled = false'))
      .rejects.toThrow(/permission denied|denied for table/i);
    await db.exec('reset role');
  });

  it('every toggle left an audit row naming the operator', async () => {
    await as(OWNER);
    const rows = await query<{ action: string; actor_user_id: string }>(
      'select action, actor_user_id from public.admin_maintenance_audit(10)',
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => row.actor_user_id === OWNER)).toBe(true);
    expect(rows.some((row) => row.action === 'maintenance.enabled')).toBe(true);
  });

  it('switching back on clears the notice and the outage clock', async () => {
    await as(OWNER);
    const [{ admin_set_maintenance: outcome }] = await query<{ admin_set_maintenance: string }>(
      `select public.admin_set_maintenance(false, null, null, 'req-3')`,
    );
    expect(outcome).toBe('disabled');

    const [state] = await query<{
      maintenance_enabled: boolean;
      maintenance_message: string | null;
      maintenance_started_at: string | null;
    }>('select * from public.app_runtime_settings');
    expect(state.maintenance_enabled).toBe(false);
    expect(state.maintenance_message).toBeNull();
    expect(state.maintenance_started_at).toBeNull();
  });

  it('replaying the migration cannot reset a running window', async () => {
    await as(OWNER);
    await query(`select public.admin_set_maintenance(true, 'กำลังปรับปรุง', null, 'req-4')`);
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8'));
    const [state] = await query<{ maintenance_enabled: boolean }>(
      'select maintenance_enabled from public.app_runtime_settings',
    );
    expect(state.maintenance_enabled).toBe(true);
    await as(OWNER);
    await query(`select public.admin_set_maintenance(false, null, null, 'req-5')`);
  });
});

describe('release notes', () => {
  let firstId = '';
  let secondId = '';

  it('an operator can save a draft, and a reader is never shown it', async () => {
    await as(OWNER);
    const [row] = await query<{ release_id: string; outcome: string }>(
      `select * from public.admin_save_release_note(
         null, '1.0.0', 'ร่างแรก', '• ยังไม่เผยแพร่', 'normal', null, 'req-r1')`,
    );
    expect(row.outcome).toBe('created');
    firstId = row.release_id;

    await as(READER);
    expect(await query('select * from public.resolve_my_release_announcement()')).toHaveLength(0);
  });

  it('a reader cannot create, edit or publish anything', async () => {
    await as(READER);
    await expect(query(
      `select * from public.admin_save_release_note(null, null, 'ของผู้ใช้', 'เนื้อหา', 'normal', true, null)`,
    )).rejects.toThrow(/ADMIN_REQUIRED/);
    await expect(query(
      `select * from public.admin_save_release_note('${firstId}', null, 'แก้ไข', 'เนื้อหา', 'normal', true, null)`,
    )).rejects.toThrow(/ADMIN_REQUIRED/);
    await expect(query('select * from public.admin_release_notes(20, 0)'))
      .rejects.toThrow(/ADMIN_REQUIRED/);
  });

  it('the table itself grants a reader nothing', async () => {
    await as(READER);
    await db.exec('set role authenticated');
    await expect(query('select * from public.app_release_notes'))
      .rejects.toThrow(/permission denied|denied for table/i);
    await expect(query(`update public.app_release_notes set title = 'x'`))
      .rejects.toThrow(/permission denied|denied for table/i);
    await db.exec('reset role');
  });

  it('publishing the draft makes it visible to a reader who has not seen it', async () => {
    await as(OWNER);
    const [row] = await query<{ outcome: string }>(
      `select * from public.admin_save_release_note(
         '${firstId}', '1.0.0', 'PortKheaw 1.0', '• เพิ่มพอร์ตใหม่', 'normal', true, 'req-r2')`,
    );
    expect(row.outcome).toBe('published');

    await as(READER);
    const shown = await query<{ id: string; title: string }>(
      'select * from public.resolve_my_release_announcement()',
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].id).toBe(firstId);
    expect(shown[0].title).toBe('PortKheaw 1.0');
  });

  it('acknowledging it stops it coming back — on this device or any other', async () => {
    await as(READER);
    const [{ acknowledge_release_note: outcome }] = await query<{ acknowledge_release_note: string }>(
      `select public.acknowledge_release_note('${firstId}')`,
    );
    expect(outcome).toBe('acknowledged');
    expect(await query('select * from public.resolve_my_release_announcement()')).toHaveLength(0);

    // Idempotent: a second press, or a second device, is one row and one answer.
    await query(`select public.acknowledge_release_note('${firstId}')`);
    expect(await query('select * from public.resolve_my_release_announcement()')).toHaveLength(0);
    const [{ count }] = await query<{ count: string }>(
      'select count(*)::text as count from public.user_release_note_state',
    );
    expect(count).toBe('1');
  });

  it('another reader who never saw it still sees it', async () => {
    await as(OTHER_READER);
    expect(await query('select * from public.resolve_my_release_announcement()')).toHaveLength(1);
  });

  /*
   * The reason the acknowledgement stores an instant as well as an id: somebody
   * who was away for three releases must get one popup, not three stacked modals.
   */
  it('several missed releases collapse to the newest one, and one acknowledgement clears them all', async () => {
    await as(OWNER);
    for (const [version, title] of [['1.1.0', 'รุ่นที่สอง'], ['1.2.0', 'รุ่นที่สาม']]) {
      const [row] = await query<{ release_id: string }>(
        `select * from public.admin_save_release_note(
           null, '${version}', '${title}', '• อัปเดต', 'normal', true, null)`,
      );
      secondId = row.release_id;
      await db.exec(`update public.app_release_notes
                     set published_at = now() + interval '1 second'
                     where id = '${row.release_id}'`);
    }

    await as(READER);
    const shown = await query<{ id: string; title: string }>(
      'select * from public.resolve_my_release_announcement()',
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].id).toBe(secondId);

    await query(`select public.acknowledge_release_note('${secondId}')`);
    expect(await query('select * from public.resolve_my_release_announcement()')).toHaveLength(0);
  });

  it('acknowledging an older release cannot un-see a newer one', async () => {
    await as(READER);
    await query(`select public.acknowledge_release_note('${firstId}')`);
    expect(await query('select * from public.resolve_my_release_announcement()')).toHaveLength(0);
  });

  it('editing a published note does not re-announce it', async () => {
    await as(OWNER);
    await query(
      `select * from public.admin_save_release_note(
         '${secondId}', '1.2.0', 'รุ่นที่สาม (แก้คำผิด)', '• อัปเดต', 'normal', null, null)`,
    );
    await as(READER);
    expect(await query('select * from public.resolve_my_release_announcement()')).toHaveLength(0);
  });

  it('a reader cannot write, or read, anybody else\'s acknowledgement', async () => {
    await as(READER);
    await db.exec('set role authenticated');
    await expect(query(
      `insert into public.user_release_note_state (user_id, last_seen_release_id)
       values ('${OTHER_READER}', '${secondId}')`,
    )).rejects.toThrow(/permission denied|denied for table/i);
    await expect(query('select * from public.user_release_note_state'))
      .rejects.toThrow(/permission denied|denied for table/i);
    await db.exec('reset role');

    // The other reader's state is untouched: they still have the newest release.
    await as(OTHER_READER);
    expect(await query('select * from public.resolve_my_release_announcement()')).toHaveLength(1);
  });

  it('refuses markup in a release note at the database, not only in the form', async () => {
    await as(OWNER);
    const [row] = await query<{ outcome: string }>(
      `select * from public.admin_save_release_note(
         null, null, 'โจมตี', '<script>alert(1)</script>', 'normal', true, null)`,
    );
    expect(row.outcome).toBe('invalid_content');
  });

  it('refuses an empty title or body', async () => {
    await as(OWNER);
    const [noTitle] = await query<{ outcome: string }>(
      `select * from public.admin_save_release_note(null, null, '   ', 'เนื้อหา', 'normal', true, null)`,
    );
    expect(noTitle.outcome).toBe('invalid_title');
    const [noBody] = await query<{ outcome: string }>(
      `select * from public.admin_save_release_note(null, null, 'หัวข้อ', '  ', 'normal', true, null)`,
    );
    expect(noBody.outcome).toBe('invalid_content');
  });

  it('unpublishing hides a release again', async () => {
    await as(OWNER);
    const [row] = await query<{ outcome: string }>(
      `select * from public.admin_save_release_note(
         '${secondId}', '1.2.0', 'รุ่นที่สาม', '• อัปเดต', 'normal', false, null)`,
    );
    expect(row.outcome).toBe('unpublished');

    await as(OTHER_READER);
    const shown = await query<{ id: string }>('select * from public.resolve_my_release_announcement()');
    // Falls back to the newest still-published release, never to a draft.
    expect(shown.every((entry) => entry.id !== secondId)).toBe(true);
  });

  it('a signed-out visitor is offered nothing', async () => {
    await as(null);
    expect(await query('select * from public.resolve_my_release_announcement()')).toHaveLength(0);
  });
});
