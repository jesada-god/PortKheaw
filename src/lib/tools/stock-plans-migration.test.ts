import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * Saved plans, run against a real Postgres.
 *
 * These are the rules somebody loses data, privacy or the meaning of their own
 * plan over if they are wrong, and none of them can be proved by reading the
 * repository — every one of them is enforced by the database:
 *
 *   * a plan is readable, editable and removable by its owner and by nobody else;
 *   * `baseline_price` cannot be moved by an update, by any caller, ever;
 *   * a plan cannot be handed to another account;
 *   * the long-only ordering (`invalidation < baseline < target`) holds for every
 *     row, not merely for every row today's code path wrote;
 *   * archiving keeps the row.
 */

const MIGRATION_FILE = '202608150001_stock_plans.sql';

const OWNER = '11111111-1111-4111-8111-111111111111';
const INTRUDER = '22222222-2222-4222-8222-222222222222';

let db: PGlite;

/** Run as one signed-in reader, under RLS. */
async function as(userId: string): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false)`);
  await db.exec('set role authenticated');
}

async function asServer(): Promise<void> {
  await db.exec('reset role');
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

/** The plan every test starts from: baseline 100, target 120, invalidation 90. */
async function seedPlan(owner = OWNER): Promise<string> {
  await as(owner);
  const rows = await query<{ id: string }>(
    `insert into public.stock_plans (user_id, symbol, baseline_price, target_price, invalidation_price, horizon_date)
     values ($1, 'AAPL', 100, 120, 90, date '2026-12-31') returning id`,
    [owner],
  );
  return rows[0].id;
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
      created_at timestamptz not null default now()
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    insert into auth.users (id, email) values
      ('${OWNER}', 'owner@example.com'),
      ('${INTRUDER}', 'intruder@example.com');
  `);
  await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8'));
  await db.exec('grant usage on schema public, auth to anon, authenticated');
  await db.exec('grant select, insert, update, delete on public.stock_plans to authenticated');
});

beforeEach(async () => {
  await asServer();
  await db.exec('delete from public.stock_plans');
});

describe('a saved plan belongs to one account', () => {
  it('is invisible to anybody else', async () => {
    await seedPlan();

    await as(INTRUDER);
    expect(await query('select id from public.stock_plans')).toHaveLength(0);
  });

  it('cannot be edited by anybody else', async () => {
    const id = await seedPlan();

    await as(INTRUDER);
    await query('update public.stock_plans set target_price = 999 where id = $1', [id]);

    // Not an error — RLS simply matched no row. What matters is the plan is intact.
    await as(OWNER);
    const [plan] = await query<{ target_price: string }>(
      'select target_price from public.stock_plans where id = $1', [id],
    );
    expect(Number(plan.target_price)).toBe(120);
  });

  it('cannot be deleted by anybody else', async () => {
    const id = await seedPlan();

    await as(INTRUDER);
    await query('delete from public.stock_plans where id = $1', [id]);

    await as(OWNER);
    expect(await query('select id from public.stock_plans where id = $1', [id])).toHaveLength(1);
  });

  it('cannot be inserted on somebody else\'s behalf', async () => {
    await as(INTRUDER);
    await expect(query(
      `insert into public.stock_plans (user_id, symbol, baseline_price, target_price, invalidation_price, horizon_date)
       values ($1, 'AAPL', 100, 120, 90, date '2026-12-31')`,
      [OWNER],
    )).rejects.toThrow(/row-level security/i);
  });
});

describe('the baseline is the plan\'s own past', () => {
  it('refuses an update that moves it', async () => {
    const id = await seedPlan();

    await as(OWNER);
    await expect(query(
      'update public.stock_plans set baseline_price = 150 where id = $1', [id],
    )).rejects.toThrow(/STOCK_PLAN_BASELINE_IMMUTABLE/);
  });

  /*
    The refusal is the table's, not the API's. A trusted server connection with
    RLS switched off entirely still cannot move a baseline — which is the whole
    reason this is a trigger and not a validation rule.
  */
  it('refuses it even for a connection that owns the table', async () => {
    const id = await seedPlan();

    await asServer();
    await expect(query(
      'update public.stock_plans set baseline_price = 150 where id = $1', [id],
    )).rejects.toThrow(/STOCK_PLAN_BASELINE_IMMUTABLE/);
  });

  it('allows the three things an edit may change', async () => {
    const id = await seedPlan();

    await as(OWNER);
    await query(
      `update public.stock_plans
         set target_price = 140, invalidation_price = 85, horizon_date = date '2027-06-30'
       where id = $1`,
      [id],
    );
    const [plan] = await query<{
      baseline_price: string; target_price: string; invalidation_price: string; horizon_date: string;
    }>('select baseline_price, target_price, invalidation_price, horizon_date from public.stock_plans where id = $1', [id]);

    expect(Number(plan.baseline_price)).toBe(100);
    expect(Number(plan.target_price)).toBe(140);
    expect(Number(plan.invalidation_price)).toBe(85);
  });

  it('refuses to hand the plan to another account', async () => {
    const id = await seedPlan();

    await asServer();
    await expect(query(
      'update public.stock_plans set user_id = $2 where id = $1', [id, INTRUDER],
    )).rejects.toThrow(/STOCK_PLAN_OWNER_IMMUTABLE/);
  });
});

describe('a plan is long-only, in the table itself', () => {
  it('refuses a target at or below the baseline', async () => {
    await as(OWNER);
    await expect(query(
      `insert into public.stock_plans (user_id, symbol, baseline_price, target_price, invalidation_price, horizon_date)
       values ($1, 'AAPL', 100, 100, 90, date '2026-12-31')`,
      [OWNER],
    )).rejects.toThrow(/stock_plans_target_above_baseline/);
  });

  it('refuses an invalidation level at or above the baseline', async () => {
    await as(OWNER);
    await expect(query(
      `insert into public.stock_plans (user_id, symbol, baseline_price, target_price, invalidation_price, horizon_date)
       values ($1, 'AAPL', 100, 120, 100, date '2026-12-31')`,
      [OWNER],
    )).rejects.toThrow(/stock_plans_invalidation_below_baseline/);
  });

  it('refuses a non-positive price', async () => {
    await as(OWNER);
    await expect(query(
      `insert into public.stock_plans (user_id, symbol, baseline_price, target_price, invalidation_price, horizon_date)
       values ($1, 'AAPL', 0, 120, -5, date '2026-12-31')`,
      [OWNER],
    )).rejects.toThrow();
  });

  it('refuses a symbol that is not canonical', async () => {
    await as(OWNER);
    await expect(query(
      `insert into public.stock_plans (user_id, symbol, baseline_price, target_price, invalidation_price, horizon_date)
       values ($1, 'aapl', 100, 120, 90, date '2026-12-31')`,
      [OWNER],
    )).rejects.toThrow();
  });
});

describe('archiving', () => {
  it('keeps the row and stops it being listed', async () => {
    const id = await seedPlan();

    await as(OWNER);
    await query('update public.stock_plans set archived_at = now() where id = $1', [id]);

    expect(await query('select id from public.stock_plans where archived_at is null')).toHaveLength(0);
    // Still there: "delete" costs the reader nothing they cannot get back.
    expect(await query('select id from public.stock_plans where id = $1', [id])).toHaveLength(1);
  });
});
