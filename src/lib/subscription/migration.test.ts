import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationFile = '202608020008_subscription_entitlements.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationFile), 'utf8');
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();
const BEFORE_SUBSCRIPTIONS = [
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
];

const USERS = {
  basic: '11111111-1111-4111-8111-111111111111',
  pro: '22222222-2222-4222-8222-222222222222',
  elite: '33333333-3333-4333-8333-333333333333',
  concurrent: '44444444-4444-4444-8444-444444444444',
  resilient: '55555555-5555-4555-8555-555555555555',
} as const;

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  for (const file of BEFORE_SUBSCRIPTIONS) {
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec(`
    insert into auth.users (id) values
      ('${USERS.basic}'),
      ('${USERS.pro}'),
      ('${USERS.elite}'),
      ('${USERS.concurrent}');
  `);
  await db.exec(rawSql);
  await db.exec(`grant usage on schema public, auth to anon, authenticated`);
  return db;
}

async function setUser(db: PGlite, userId: string) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
}

async function createPortfolio(db: PGlite, name: string, type: 'STOCK' | 'OPTION') {
  const result = await db.query<{ create_portfolio: string }>(
    `select public.create_portfolio($1, $2)`,
    [name, type],
  );
  return result.rows[0].create_portfolio;
}

async function activate(db: PGlite, userId: string, tier: 'pro' | 'elite') {
  await db.query(`
    update public.user_subscriptions
    set tier = $2, status = 'active',
        current_period_start = timestamptz '2026-01-01 00:00:00+00',
        current_period_end = timestamptz '2099-01-01 00:00:00+00'
    where user_id = $1
  `, [userId, tier]);
}

describe('subscription entitlement migration', () => {
  it('declares the read-only RLS and trusted entitlement contract without a duplicate auth trigger', () => {
    expect(sql).toContain('create table if not exists public.user_subscriptions');
    expect(sql).toContain('alter table public.user_subscriptions enable row level security');
    expect(sql).toContain('for select to authenticated');
    expect(sql).toContain('revoke all on table public.user_subscriptions from anon, authenticated');
    expect(sql).toContain('grant select on table public.user_subscriptions to authenticated');
    expect(sql).toContain('create or replace function public.handle_new_user()');
    expect(sql).not.toContain('create trigger on_auth_user_created');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('statement_timestamp()');
    expect(sql).not.toContain('service_role_key');
    expect(sql).not.toContain('billing_price_id_key');
  });

  it('backfills once, replays safely and keeps signup alive if subscription initialization fails', async () => {
    const db = await database();
    try {
      await db.exec(rawSql);
      const backfill = await db.query<{ users: number; subscriptions: number; duplicates: number }>(`
        select
          (select count(*)::int from auth.users) as users,
          (select count(*)::int from public.user_subscriptions) as subscriptions,
          (select count(*)::int from (
            select user_id from public.user_subscriptions group by user_id having count(*) > 1
          ) as duplicate_rows) as duplicates
      `);
      expect(backfill.rows[0]).toEqual({ users: 4, subscriptions: 4, duplicates: 0 });

      await db.exec(`
        create function public.reject_resilient_subscription() returns trigger
        language plpgsql as $$
        begin
          if new.user_id = '${USERS.resilient}' then raise exception 'simulated subscription failure'; end if;
          return new;
        end;
        $$;
        create trigger reject_resilient_subscription
          before insert on public.user_subscriptions
          for each row execute function public.reject_resilient_subscription();
        insert into auth.users (id) values ('${USERS.resilient}');
      `);
      const resilient = await db.query<{ user_rows: number; profile_rows: number; subscription_rows: number }>(`
        select
          (select count(*)::int from auth.users where id = '${USERS.resilient}') as user_rows,
          (select count(*)::int from public.profiles where id = '${USERS.resilient}') as profile_rows,
          (select count(*)::int from public.user_subscriptions where user_id = '${USERS.resilient}') as subscription_rows
      `);
      expect(resilient.rows[0]).toEqual({ user_rows: 1, profile_rows: 1, subscription_rows: 0 });
    } finally {
      await db.close();
    }
  }, 30_000);

  it('enforces Basic and paid portfolio entitlements in the atomic database path', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.basic);
      await createPortfolio(db, 'Basic Stock', 'STOCK');
      await expect(createPortfolio(db, 'Basic Stock 2', 'STOCK')).rejects.toThrow(/LIMIT_REACHED:STOCK:1/);
      await expect(createPortfolio(db, 'Basic Options', 'OPTION')).rejects.toThrow(/UPGRADE_REQUIRED:portfolio.options.create/);

      for (const [userId, tier] of [[USERS.pro, 'pro'], [USERS.elite, 'elite']] as const) {
        await activate(db, userId, tier);
        await setUser(db, userId);
        for (const type of ['STOCK', 'OPTION'] as const) {
          for (let index = 1; index <= 10; index += 1) {
            await createPortfolio(db, `${tier}-${type}-${index}`, type);
          }
          await expect(createPortfolio(db, `${tier}-${type}-11`, type)).rejects.toThrow(/LIMIT_REACHED/);
        }
      }
    } finally {
      await db.close();
    }
  }, 30_000);

  it('keeps Basic creation bounded under concurrent requests', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.concurrent);
      const attempts = await Promise.allSettled([
        createPortfolio(db, 'Concurrent Basic 1', 'STOCK'),
        createPortfolio(db, 'Concurrent Basic 2', 'STOCK'),
      ]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
      const rows = await db.query<{ count: number }>(`
        select count(*)::int as count from public.portfolios
        where user_id = '${USERS.concurrent}' and portfolio_type = 'STOCK' and archived_at is null
      `);
      expect(rows.rows[0].count).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('allows authenticated users to read only their row and denies all client writes and anon reads', async () => {
    const db = await database();
    try {
      await setUser(db, USERS.basic);
      await db.exec(`set role authenticated`);
      const visible = await db.query<{ user_id: string }>(`select user_id from public.user_subscriptions`);
      expect(visible.rows).toEqual([{ user_id: USERS.basic }]);
      const snapshot = await db.query<{ user_id: string; database_now: string }>(
        `select user_id, database_now::text from public.get_my_subscription_snapshot()`,
      );
      expect(snapshot.rows).toHaveLength(1);
      expect(snapshot.rows[0].user_id).toBe(USERS.basic);
      expect(snapshot.rows[0].database_now).toBeTruthy();
      await expect(db.exec(`update public.user_subscriptions set tier = 'elite' where user_id = '${USERS.basic}'`))
        .rejects.toThrow(/permission denied/);
      await db.exec(`reset role`);

      await db.exec(`set role anon`);
      await expect(db.query(`select * from public.user_subscriptions`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select * from public.get_my_subscription_snapshot()`)).rejects.toThrow(/permission denied/);
      await db.exec(`reset role`);
    } finally {
      await db.close();
    }
  }, 30_000);
});
