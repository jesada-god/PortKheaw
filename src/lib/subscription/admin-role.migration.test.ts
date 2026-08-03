import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

/**
 * The role, the preview and every refusal around them are decided inside
 * PostgreSQL, so they are tested inside PostgreSQL. Each case runs the real
 * migration chain against an in-process database rather than asserting on SQL
 * text — the two text assertions below are the exceptions, and they check
 * absences (no destructive statement, no duplicate auth trigger) that a
 * behavioural test cannot observe.
 */
const migrationFile = '202608030002_admin_role_and_access_preview.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationFile), 'utf8');
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();

const MIGRATION_CHAIN = [
  '202607180001_phase_1_auth.sql',
  '202607180003_phase_3_watchlist.sql',
  '202607180004_phase_4_portfolio_core.sql',
  '202607180005_phase_4_portfolio_options.sql',
  '202607180006_portfolio_currency_summary.sql',
  '202607180009_phase_7_alerts_notifications.sql',
  '202607300001_portfolio_ledger_source_of_truth.sql',
  '202607310001_portfolio_option_symbol_resolution.sql',
  '202607310002_multi_portfolios.sql',
  '202607310003_portfolio_bangkok_transaction_date.sql',
  '202608020002_transfer_cash_lint.sql',
  '202608020008_subscription_entitlements.sql',
  '202608030001_elite_trial_and_read_only.sql',
  migrationFile,
];

/** The literal the migration seeds. If this and the SQL ever disagree, say so. */
const OWNER_ID = '52e7b434-1dca-4636-88ab-ea9bdf063761';

const USERS = {
  owner: OWNER_ID,
  /**
   * Same display name, near-identical mailbox, different account. It exists to
   * prove that neither is consulted: this row must resolve to `user`.
   */
  lookalike: '11111111-1111-4111-8111-111111111111',
  ordinary: '22222222-2222-4222-8222-222222222222',
  trialing: '33333333-3333-4333-8333-333333333333',
} as const;

const PREVIEW_MODES = ['basic', 'pro', 'elite', 'elite_trial', 'expired_trial'] as const;

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      email_confirmed_at timestamptz,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  for (const file of MIGRATION_CHAIN.slice(0, -1)) {
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
      ('${USERS.owner}', 'jesadatwt@gmail.com', timestamptz '2026-01-01 00:00:00+00', '{"full_name":"Jesada Tawinteung"}'::jsonb),
      ('${USERS.lookalike}', 'jesadatwt+qa@gmail.com', timestamptz '2026-01-02 00:00:00+00', '{"full_name":"Jesada Tawinteung"}'::jsonb),
      ('${USERS.ordinary}', 'reader@example.com', timestamptz '2026-01-03 00:00:00+00', '{}'::jsonb),
      ('${USERS.trialing}', 'trialing@example.com', timestamptz '2026-01-04 00:00:00+00', '{}'::jsonb);
  `);
  await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationFile), 'utf8'));
  await db.exec(`grant usage on schema public, auth to anon, authenticated`);
  return db;
}

async function setUser(db: PGlite, userId: string | null) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
}

interface AccessRow {
  user_id: string;
  role: string;
  preview_mode: string;
  preview_expires_at: Date | null;
  tier: string;
  status: string;
  database_now: Date;
}

async function accountAccess(db: PGlite): Promise<AccessRow> {
  const result = await db.query<AccessRow>(`select * from public.get_my_account_access()`);
  return result.rows[0];
}

async function setPreview(db: PGlite, mode: string) {
  return db.query<{ mode: string; expires_at: Date | null }>(
    `select * from public.set_my_admin_access_preview($1)`,
    [mode],
  );
}

async function subscriptionRow(db: PGlite, userId: string) {
  const result = await db.query<Record<string, unknown>>(
    `select * from public.user_subscriptions where user_id = $1`,
    [userId],
  );
  return result.rows[0];
}

describe('admin role and access preview migration', () => {
  it('adds only, and extends the one existing signup hook rather than adding a trigger', () => {
    // Non-destructive: nothing that could remove a table, a column or a row.
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/drop column/);
    expect(sql).not.toMatch(/truncate/);
    expect(sql).not.toMatch(/alter table public\.user_subscriptions/);
    expect(sql).not.toMatch(/update public\.user_subscriptions/);
    expect(sql).not.toMatch(/delete from public\.user_subscriptions/);

    // The role tables are created, never re-created destructively.
    expect(sql).toContain('create table if not exists public.user_roles');
    expect(sql).toContain('create table if not exists public.admin_access_previews');
    expect(sql).toContain('alter table public.user_roles enable row level security');
    expect(sql).toContain('alter table public.admin_access_previews enable row level security');

    // One signup hook, extended — never a second auth trigger.
    expect(sql).toContain('create or replace function public.handle_new_user()');
    expect(sql).not.toContain('create trigger on_auth_user_created');

    /*
     * The owner is a UUID literal, and no authorization decision anywhere in the
     * file is made by comparing an email or a display name. (`handle_new_user`
     * still reads `raw_user_meta_data ->> 'full_name'` to seed a profile row —
     * that is a display value being copied, not an identity being checked, so
     * the assertions below look for comparisons and lookups rather than for the
     * words themselves.)
     */
    expect(rawSql).toContain(`values ('${OWNER_ID}', 'admin')`);
    expect(sql).not.toMatch(/users\.email/);
    expect(sql).not.toMatch(/email\s*(=|like|ilike)/);
    expect(sql).not.toMatch(/full_name\s*(=|like|ilike)/);
    expect(sql).not.toMatch(/from auth\.users\s+where/);
  });

  it('gives every existing account the user role and promotes only the owner UUID', async () => {
    const db = await database();
    try {
      const roles = await db.query<{ user_id: string; role: string }>(
        `select user_id, role from public.user_roles order by role, user_id`,
      );
      expect(roles.rows).toEqual([
        { user_id: USERS.owner, role: 'admin' },
        { user_id: USERS.lookalike, role: 'user' },
        { user_id: USERS.ordinary, role: 'user' },
        { user_id: USERS.trialing, role: 'user' },
      ].sort((a, b) => a.role.localeCompare(b.role) || a.user_id.localeCompare(b.user_id)));

      const admins = await db.query<{ count: number }>(
        `select count(*)::int as count from public.user_roles where role = 'admin'`,
      );
      expect(admins.rows[0].count).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('does not promote an account that merely shares the owner name and mailbox', async () => {
    const db = await database();
    try {
      const lookalike = await db.query<{ role: string; email: string }>(`
        select role.role, users.email
        from public.user_roles as role
        join auth.users as users on users.id = role.user_id
        where role.user_id = '${USERS.lookalike}'
      `);
      expect(lookalike.rows[0].email).toContain('jesadatwt');
      expect(lookalike.rows[0].role).toBe('user');

      await setUser(db, USERS.lookalike);
      const access = await accountAccess(db);
      expect(access.role).toBe('user');
      await expect(setPreview(db, 'elite')).rejects.toThrow(/ADMIN_REQUIRED/);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('replays without duplicating rows and gives a new signup the user role', async () => {
    const db = await database();
    try {
      await db.exec(rawSql);
      const replay = await db.query<{ roles: number; admins: number; duplicates: number }>(`
        select
          (select count(*)::int from public.user_roles) as roles,
          (select count(*)::int from public.user_roles where role = 'admin') as admins,
          (select count(*)::int from (
            select user_id from public.user_roles group by user_id having count(*) > 1
          ) as duplicate_rows) as duplicates
      `);
      expect(replay.rows[0]).toEqual({ roles: 4, admins: 1, duplicates: 0 });

      const signup = '44444444-4444-4444-8444-444444444444';
      await db.exec(`insert into auth.users (id, email) values ('${signup}', 'new@example.com')`);
      const created = await db.query<{ role: string }>(
        `select role from public.user_roles where user_id = '${signup}'`,
      );
      expect(created.rows).toEqual([{ role: 'user' }]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('keeps signup alive when the role insert fails', async () => {
    const db = await database();
    try {
      const blocked = '55555555-5555-4555-8555-555555555555';
      await db.exec(`
        create function public.reject_role() returns trigger language plpgsql as $$
        begin
          if new.user_id = '${blocked}' then raise exception 'simulated role failure'; end if;
          return new;
        end;
        $$;
        create trigger reject_role before insert on public.user_roles
          for each row execute function public.reject_role();
        insert into auth.users (id, email) values ('${blocked}', 'blocked@example.com');
      `);
      const rows = await db.query<{ users: number; profiles: number; roles: number }>(`
        select
          (select count(*)::int from auth.users where id = '${blocked}') as users,
          (select count(*)::int from public.profiles where id = '${blocked}') as profiles,
          (select count(*)::int from public.user_roles where user_id = '${blocked}') as roles
      `);
      expect(rows.rows[0]).toEqual({ users: 1, profiles: 1, roles: 0 });

      // And the resolver still answers, failing closed to `user`.
      await setUser(db, blocked);
      expect((await accountAccess(db)).role).toBe('user');
    } finally {
      await db.close();
    }
  }, 30_000);

  it('lets an account read only its own role and never write one', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.ordinary);
      await db.exec(`set role authenticated`);

      const visible = await db.query<{ user_id: string }>(`select user_id from public.user_roles`);
      expect(visible.rows).toEqual([{ user_id: USERS.ordinary }]);

      await expect(db.exec(`update public.user_roles set role = 'admin' where user_id = '${USERS.ordinary}'`))
        .rejects.toThrow(/permission denied/);
      await expect(db.exec(`insert into public.user_roles (user_id, role) values ('${USERS.ordinary}', 'admin')`))
        .rejects.toThrow(/permission denied/);
      await expect(db.exec(`delete from public.user_roles where user_id = '${USERS.ordinary}'`))
        .rejects.toThrow(/permission denied/);

      // The preview table is not readable or writable by any client at all.
      await expect(db.query(`select * from public.admin_access_previews`)).rejects.toThrow(/permission denied/);
      await expect(db.exec(`
        insert into public.admin_access_previews (user_id, mode, expires_at)
        values ('${USERS.ordinary}', 'elite', now() + interval '1 hour')
      `)).rejects.toThrow(/permission denied/);

      await db.exec(`reset role`);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('denies anon every role, preview and resolver path', async () => {
    const db = await database();
    try {
      await db.exec(`set role anon`);
      await expect(db.query(`select * from public.user_roles`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select * from public.admin_access_previews`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select * from public.get_my_account_access()`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select * from public.set_my_admin_access_preview('elite')`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select public.clear_my_admin_access_preview()`)).rejects.toThrow(/permission denied/);
      await db.exec(`reset role`);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('refuses a non-administrator both preview routines whatever they send', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.ordinary);
      for (const mode of [...PREVIEW_MODES, 'actual']) {
        await expect(setPreview(db, mode)).rejects.toThrow(/ADMIN_REQUIRED/);
      }
      await expect(db.query(`select public.clear_my_admin_access_preview()`)).rejects.toThrow(/ADMIN_REQUIRED/);

      // No row was created by any of those attempts.
      const rows = await db.query<{ count: number }>(
        `select count(*)::int as count from public.admin_access_previews`,
      );
      expect(rows.rows[0].count).toBe(0);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('rejects a mode outside the allowlist even for the administrator', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.owner);
      for (const mode of ['elite; drop table public.user_roles', 'ELITE', 'admin', '']) {
        await expect(setPreview(db, mode)).rejects.toThrow(/INVALID_PREVIEW_MODE/);
      }
      await expect(db.query(`select * from public.set_my_admin_access_preview(null)`))
        .rejects.toThrow(/INVALID_PREVIEW_MODE/);
      expect((await accountAccess(db)).preview_mode).toBe('actual');
    } finally {
      await db.close();
    }
  }, 30_000);

  it('runs each preview mode for exactly sixty minutes and returns to actual on demand', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.owner);
      expect((await accountAccess(db)).preview_mode).toBe('actual');

      for (const mode of PREVIEW_MODES) {
        const granted = await setPreview(db, mode);
        expect(granted.rows[0].mode).toBe(mode);

        const access = await accountAccess(db);
        expect(access.preview_mode).toBe(mode);
        expect(access.preview_expires_at).not.toBeNull();
        const minutes = (access.preview_expires_at!.getTime() - access.database_now.getTime()) / 60_000;
        expect(minutes).toBeGreaterThan(59);
        expect(minutes).toBeLessThanOrEqual(60);

        // Exactly one row, however many times a mode is switched.
        const rows = await db.query<{ count: number }>(
          `select count(*)::int as count from public.admin_access_previews`,
        );
        expect(rows.rows[0].count).toBe(1);
      }

      await setPreview(db, 'actual');
      const cleared = await accountAccess(db);
      expect(cleared.preview_mode).toBe('actual');
      expect(cleared.preview_expires_at).toBeNull();

      // Clearing twice is not an error.
      await db.query(`select public.clear_my_admin_access_preview()`);
      await db.query(`select public.clear_my_admin_access_preview()`);
      expect((await accountAccess(db)).preview_mode).toBe('actual');
    } finally {
      await db.close();
    }
  }, 30_000);

  it('returns to actual access on its own once the preview lapses', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.owner);
      await setPreview(db, 'basic');
      expect((await accountAccess(db)).preview_mode).toBe('basic');

      await db.exec(`
        update public.admin_access_previews
        set expires_at = statement_timestamp() - interval '1 second'
        where user_id = '${USERS.owner}'
      `);

      const lapsed = await accountAccess(db);
      expect(lapsed.preview_mode).toBe('actual');
      expect(lapsed.preview_expires_at).toBeNull();
      // The row is still there — expiry is decided on read, so nothing had to
      // run on a schedule for access to come back.
      expect(lapsed.role).toBe('admin');
    } finally {
      await db.close();
    }
  }, 30_000);

  it('ignores a preview belonging to an account that is no longer an administrator', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.owner);
      await setPreview(db, 'basic');
      await db.exec(`update public.user_roles set role = 'user' where user_id = '${USERS.owner}'`);

      const access = await accountAccess(db);
      expect(access.role).toBe('user');
      expect(access.preview_mode).toBe('actual');
      expect(access.preview_expires_at).toBeNull();
      await expect(setPreview(db, 'elite')).rejects.toThrow(/ADMIN_REQUIRED/);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('never touches a subscription, billing or trial field in any preview mode', async () => {
    const db = await database();
    try {
      // Give the owner a real trial first, so there is trial state to disturb.
      await setUser(db, USERS.owner);
      await db.query(`select * from public.start_elite_trial()`);
      const before = await subscriptionRow(db, USERS.owner);
      const everyoneBefore = await db.query<{ digest: string }>(
        `select md5(string_agg(subscription::text, '|' order by user_id))::text as digest
         from public.user_subscriptions as subscription`,
      );

      for (const mode of [...PREVIEW_MODES, 'actual']) {
        await setPreview(db, mode);
        expect(await subscriptionRow(db, USERS.owner)).toEqual(before);
      }
      await db.query(`select public.clear_my_admin_access_preview()`);

      expect(await subscriptionRow(db, USERS.owner)).toEqual(before);
      const everyoneAfter = await db.query<{ digest: string }>(
        `select md5(string_agg(subscription::text, '|' order by user_id))::text as digest
         from public.user_subscriptions as subscription`,
      );
      expect(everyoneAfter.rows[0].digest).toBe(everyoneBefore.rows[0].digest);
      // The one grant the account really holds is still spent exactly once.
      expect(before.trial_used_at).not.toBeNull();
    } finally {
      await db.close();
    }
  }, 30_000);

  it('reports the real subscription alongside the preview, never in place of it', async () => {
    const db = await database();
    try {
      await db.query(`
        update public.user_subscriptions
        set tier = 'pro', status = 'active',
            current_period_start = timestamptz '2026-01-01 00:00:00+00',
            current_period_end = timestamptz '2099-01-01 00:00:00+00'
        where user_id = $1
      `, [USERS.owner]);

      await setUser(db, USERS.owner);
      await setPreview(db, 'basic');
      const access = await accountAccess(db);
      expect(access.preview_mode).toBe('basic');
      // The stored plan is reported unchanged; only the preview says Basic.
      expect(access.tier).toBe('pro');
      expect(access.status).toBe('active');
    } finally {
      await db.close();
    }
  }, 30_000);

  it('resolves a missing role row to user rather than failing or escalating', async () => {
    const db = await database();
    try {
      await db.exec(`delete from public.user_roles where user_id = '${USERS.ordinary}'`);
      await setUser(db, USERS.ordinary);
      const access = await accountAccess(db);
      expect(access.role).toBe('user');
      expect(access.preview_mode).toBe('actual');
      expect(access.tier).toBe('basic');
    } finally {
      await db.close();
    }
  }, 30_000);
});
