import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveAccountAccess } from './admin-access';
import { resolveEffectiveTier } from './resolve-effective-tier';

/**
 * Phase 3.2 — the database half of the effective access tier.
 *
 * The application already resolved role, preview and subscription into one
 * answer. The database resolved only the subscription, so the portfolio gates —
 * the only gates that can actually protect data — disagreed with every gate
 * above them. That disagreement is a behaviour, not a string, so it is tested
 * against a real PostgreSQL running the real migration chain. The two text
 * assertions are the exceptions, and they check absences (no destructive
 * statement, no billing write) that a behavioural test cannot observe.
 */
/*
 * Each case that boots its own database replays the whole migration chain, which
 * is several seconds of genuine work. The timeout matches that cost; nothing
 * here waits on a race.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const migrationFile = '202608040001_effective_access_tier.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationFile), 'utf8');
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();
/** Statements only, for assertions a comment mentioning a word would spoil. */
const statements = rawSql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();

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
  '202608030002_admin_role_and_access_preview.sql',
  '202608030003_billing_subscriptions.sql',
  migrationFile,
];

/** The owner UUID the Phase 3.1 migration seeds as the one administrator. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const BASIC = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const ELITE = '33333333-3333-4333-8333-333333333333';
const TRIALING = '44444444-4444-4444-8444-444444444444';
const EXPIRED = '55555555-5555-4555-8555-555555555555';

const ALL_USERS = [OWNER, BASIC, PRO, ELITE, TRIALING, EXPIRED];

const FUTURE = '2027-08-01 00:00:00+00';
const PAST = '2026-01-08 00:00:00+00';

const PREVIEW_TIERS = {
  basic: 'basic',
  pro: 'pro',
  elite: 'elite',
  elite_trial: 'elite',
  expired_trial: 'basic',
} as const;

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
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

  for (const file of MIGRATION_CHAIN) {
    /*
     * The Phase 3.1 migration seeds the owner against a foreign key, so every
     * account has to exist before it runs — that ordering is the point of the
     * key, and reproducing it here keeps the chain honest.
     */
    if (file === '202608030002_admin_role_and_access_preview.sql') {
      await db.query(
        `insert into auth.users (id, email_confirmed_at)
         select value, timestamptz '2026-01-01 00:00:00+00' from unnest($1::uuid[]) as value`,
        [ALL_USERS],
      );
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec(`grant usage on schema public, auth to anon, authenticated`);

  // Stored plans. Every administrator case below runs against the owner's real
  // row, which is Basic — the exact state that produced the defect.
  await db.exec(`
    update public.user_subscriptions
      set tier = 'pro', status = 'active', current_period_end = timestamptz '${FUTURE}'
      where user_id = '${PRO}';
    update public.user_subscriptions
      set tier = 'elite', status = 'active', current_period_end = timestamptz '${FUTURE}'
      where user_id = '${ELITE}';
    update public.user_subscriptions
      set tier = 'elite', status = 'trialing',
          trial_started_at = timestamptz '2026-01-01 00:00:00+00',
          trial_ends_at = timestamptz '${FUTURE}',
          trial_used_at = timestamptz '2026-01-01 00:00:00+00'
      where user_id = '${TRIALING}';
    update public.user_subscriptions
      set tier = 'elite', status = 'trialing',
          trial_started_at = timestamptz '2026-01-01 00:00:00+00',
          trial_ends_at = timestamptz '${PAST}',
          trial_used_at = timestamptz '2026-01-01 00:00:00+00'
      where user_id = '${EXPIRED}';
  `);
  return db;
}

async function setUser(db: PGlite, userId: string | null) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
}

async function accessTier(db: PGlite, userId: string): Promise<string> {
  const result = await db.query<{ tier: string }>(
    `select public.resolve_effective_access_tier($1, statement_timestamp()) as tier`,
    [userId],
  );
  return result.rows[0].tier;
}

async function subscriptionTier(db: PGlite, userId: string): Promise<string> {
  const result = await db.query<{ tier: string }>(
    `select public.resolve_effective_subscription_tier($1, statement_timestamp()) as tier`,
    [userId],
  );
  return result.rows[0].tier;
}

/** Starts a preview as the given administrator, through the trusted routine. */
async function setPreview(db: PGlite, userId: string, mode: string) {
  await setUser(db, userId);
  await db.query(`select * from public.set_my_admin_access_preview($1)`, [mode]);
}

/** Lapses a running preview without touching any other column. */
async function lapsePreview(db: PGlite, userId: string) {
  await db.query(
    `update public.admin_access_previews set expires_at = timestamptz '${PAST}' where user_id = $1`,
    [userId],
  );
}

async function createPortfolio(db: PGlite, name: string, type: 'STOCK' | 'OPTION') {
  const result = await db.query<{ create_portfolio: string }>(
    `select public.create_portfolio($1, $2)`,
    [name, type],
  );
  return result.rows[0].create_portfolio;
}

async function addDeposit(db: PGlite, portfolioId: string, amount = 100) {
  const result = await db.query<{ id: string }>(
    `select public.create_portfolio_ledger_transaction(
       $1, 'deposit', null, null, null, $2, null, 'USD', null,
       timestamptz '2026-02-01 10:00:00+00', null, null, null, null, null, null, null, null, null,
       gen_random_uuid()
     ) as id`,
    [portfolioId, amount],
  );
  return result.rows[0].id;
}

async function legacyPortfolio(db: PGlite, userId: string) {
  const result = await db.query<{ id: string }>(
    `select id from public.portfolios where user_id = $1 and is_legacy`,
    [userId],
  );
  return result.rows[0].id;
}

/** The stored row, minus nothing: any drift at all shows up in a comparison. */
async function subscriptionRow(db: PGlite, userId: string) {
  const result = await db.query<Record<string, unknown>>(
    `select * from public.user_subscriptions where user_id = $1`,
    [userId],
  );
  return result.rows[0];
}

describe('effective access tier migration', () => {
  it('adds only, and writes nothing to billing, trial or stored-tier state', () => {
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/drop column/);
    expect(sql).not.toMatch(/drop function/);
    expect(sql).not.toMatch(/drop trigger/);
    expect(sql).not.toMatch(/drop policy/);
    expect(sql).not.toMatch(/truncate/);
    /*
     * The two `delete from` occurrences below are inside routine bodies this
     * file re-creates verbatim in order to add a gate above them — a reader
     * removing one of their own rows, which is the routine's whole purpose. What
     * must not appear is a delete against the tables that hold access state, or
     * one executed by the migration itself rather than by a called routine.
     */
    expect(statements).not.toMatch(
      /delete from public\.(user_subscriptions|user_roles|admin_access_previews|portfolios)\b/,
    );
    expect(statements.match(/delete from/g) ?? []).toHaveLength(2);

    // The subscription table is read for a tier and never touched otherwise.
    expect(statements).not.toMatch(/update public\.user_subscriptions/);
    expect(statements).not.toMatch(/insert into public\.user_subscriptions/);
    expect(statements).not.toMatch(/alter table public\.user_subscriptions/);
    expect(statements).not.toMatch(/billing_customer_id|billing_subscription_id|billing_price_id/);
    expect(statements).not.toMatch(/trial_started_at|trial_ends_at|trial_used_at/);
    // …and the role and preview tables are read, never written.
    expect(statements).not.toMatch(/insert into public\.(user_roles|admin_access_previews)/);
    expect(statements).not.toMatch(/update public\.(user_roles|admin_access_previews)/);

    // The resolver is private. A client cannot ask it anything, about anyone.
    expect(sql).toContain(
      'revoke all on function public.resolve_effective_access_tier(uuid,timestamptz) from public, anon, authenticated',
    );
    expect(sql).not.toMatch(/grant execute on function public\.resolve_effective_access_tier/);
    expect(sql).not.toMatch(/grant execute on function public\.assert_options_writable/);
  });

  it('leaves the identity of a gate to auth.uid(), never to an argument', () => {
    // `assert_options_writable` takes no user: the caller is read inside.
    expect(sql).toContain('create or replace function public.assert_options_writable()');
    expect(sql).toContain('requesting_user uuid := (select auth.uid())');
  });

  describe('resolver', () => {
    let db: PGlite;
    beforeAll(async () => { db = await database(); });

    it('gives an ordinary account exactly its subscription tier', async () => {
      for (const [user, expected] of [
        [BASIC, 'basic'], [PRO, 'pro'], [ELITE, 'elite'],
        [TRIALING, 'elite'], [EXPIRED, 'basic'],
      ] as const) {
        expect(await accessTier(db, user), user).toBe(expected);
        expect(await subscriptionTier(db, user), user).toBe(expected);
      }
    });

    it('agrees with the application resolver for every ordinary account', async () => {
      const rows = await db.query<{
        user_id: string; tier: string; status: string;
        trial_ends_at: Date | null; current_period_end: Date | null; now: Date;
      }>(`
        select user_id, tier, status, trial_ends_at, current_period_end, statement_timestamp() as now
        from public.user_subscriptions where user_id <> '${OWNER}'
      `);
      for (const row of rows.rows) {
        const application = resolveEffectiveTier(
          {
            tier: row.tier as 'basic' | 'pro' | 'elite',
            status: row.status as 'basic' | 'active' | 'trialing',
            trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
            currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
          },
          row.now.toISOString(),
        );
        expect(await accessTier(db, row.user_id), row.user_id).toBe(application);
      }
    });

    it('gives the administrator Elite while their stored plan stays Basic', async () => {
      expect(await subscriptionTier(db, OWNER)).toBe('basic');
      expect(await accessTier(db, OWNER)).toBe('elite');
      const stored = await subscriptionRow(db, OWNER);
      expect(stored.tier).toBe('basic');
      expect(stored.status).toBe('basic');
    });

    it.each(Object.entries(PREVIEW_TIERS))('resolves a running %s preview to %s', async (mode, tier) => {
      await setPreview(db, OWNER, mode);
      expect(await accessTier(db, OWNER)).toBe(tier);
      // The plan held is untouched by every one of them.
      expect(await subscriptionTier(db, OWNER)).toBe('basic');
      await setPreview(db, OWNER, 'actual');
      expect(await accessTier(db, OWNER)).toBe('elite');
    });

    it('returns an administrator to Elite the moment a preview lapses', async () => {
      await setPreview(db, OWNER, 'basic');
      expect(await accessTier(db, OWNER)).toBe('basic');
      await lapsePreview(db, OWNER);
      expect(await accessTier(db, OWNER)).toBe('elite');
      await setPreview(db, OWNER, 'actual');
    });

    it('ignores a preview stored against an account that is not an administrator', async () => {
      await db.query(
        `insert into public.admin_access_previews (user_id, mode, expires_at)
         values ($1, 'elite', timestamptz '${FUTURE}')
         on conflict (user_id) do update set mode = excluded.mode, expires_at = excluded.expires_at`,
        [BASIC],
      );
      expect(await accessTier(db, BASIC)).toBe('basic');
      await db.query(`delete from public.admin_access_previews where user_id = $1`, [BASIC]);
    });

    it('fails closed for a null caller and an account that does not exist', async () => {
      const nulled = await db.query<{ tier: string }>(
        `select public.resolve_effective_access_tier(null, statement_timestamp()) as tier`,
      );
      expect(nulled.rows[0].tier).toBe('basic');
      expect(await accessTier(db, '99999999-9999-4999-8999-999999999999')).toBe('basic');
    });

    it('is not executable by anon or authenticated', async () => {
      for (const role of ['anon', 'authenticated']) {
        const granted = await db.query<{ ok: boolean }>(
          `select has_function_privilege($1, 'public.resolve_effective_access_tier(uuid,timestamptz)', 'execute') as ok`,
          [role],
        );
        expect(granted.rows[0].ok, role).toBe(false);
      }
    });

    /*
     * The invariant, asserted against the definitions the chain actually left
     * behind rather than against this file's text: a *feature* gate reads the
     * access tier. `resolve_effective_subscription_tier` still exists and is
     * still correct — it is what the access resolver calls, and what billing
     * copy is derived from — but no gate may call it directly again.
     */
    it('leaves no feature gate reading the subscription tier directly', async () => {
      const gates = ['assert_portfolio_writable', 'enforce_portfolio_limit', 'assert_options_writable'];
      for (const gate of gates) {
        const definition = await db.query<{ body: string }>(
          `select pg_get_functiondef(oid) as body from pg_proc
           where proname = $1 and pronamespace = 'public'::regnamespace`,
          [gate],
        );
        expect(definition.rows, gate).toHaveLength(1);
        const body = definition.rows[0].body;
        expect(body, `${gate} must read the access tier`)
          .toContain('resolve_effective_access_tier');
        expect(body, `${gate} must not read the subscription tier directly`)
          .not.toContain('resolve_effective_subscription_tier');
      }

      // …and the access resolver is the one place that still calls it.
      const callers = await db.query<{ proname: string }>(
        `select proname from pg_proc
         where pronamespace = 'public'::regnamespace
           and prosrc like '%resolve_effective_subscription_tier%'
         order by proname`,
      );
      expect(callers.rows.map((row) => row.proname)).toEqual(['resolve_effective_access_tier']);
    });

    /*
     * Every routine a signed-in client can call that writes a portfolio-scoped
     * table must pass through a gate. The exceptions are named, with the reason
     * each one is deliberate — an unnamed new one fails this test, which is the
     * point.
     */
    it('gates every client-callable routine that writes portfolio data', async () => {
      const UNGATED_BY_DESIGN: Readonly<Record<string, string>> = {
        /*
         * Gated by the `portfolios_enforce_limit` trigger rather than by a call
         * in its body — which is where the Basic allowance and the Options
         * refusal are actually decided. The cases above exercise both through
         * this routine, so the gate is proven, not assumed.
         */
        create_portfolio: 'gated by enforce_portfolio_limit on insert',
        // The escape hatch a downgraded reader needs to step back under the limit.
        archive_portfolio: 'archiving must stay open after a downgrade',
        // Bounded by the limit trigger, which now reads the access tier.
        restore_portfolio: 'bounded by enforce_portfolio_limit',
        // Account-level display settings that every tier has.
        set_portfolio_base_currency: 'account-level setting, not premium data',
        set_aggregate_portfolio_goal: 'account-level setting, not premium data',
        // Creates the one legacy portfolio a new account starts with.
        get_or_create_default_portfolio: 'bootstraps the legacy portfolio',
        // Server-side evaluation of an already-created target, not a user write.
        evaluate_portfolio_option_target: 'marks an existing target triggered',
        // Reads a symbol into canonical form; writes nothing itself.
        canonicalize_portfolio_option_contract: 'pure normalisation',
      };

      const writers = await db.query<{ proname: string; prosrc: string }>(`
        select p.proname, p.prosrc
        from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.prosecdef
          and has_function_privilege('authenticated', p.oid, 'execute')
          and p.prosrc ~* '(insert into|update|delete from)\\s+(public\\.)?portfolio'
        order by p.proname
      `);
      expect(writers.rows.length).toBeGreaterThan(5);

      const ungated = writers.rows
        .filter((row) => !/assert_portfolio_writable|assert_portfolio_accepts_transaction|assert_options_writable/
          .test(row.prosrc))
        .map((row) => row.proname)
        .filter((name) => !(name in UNGATED_BY_DESIGN));

      expect(ungated, 'client-callable portfolio writers with no entitlement gate').toEqual([]);
    });
  });

  describe('portfolio gates read the access tier', () => {
    let db: PGlite;
    beforeAll(async () => { db = await database(); });

    it('holds a Basic subscriber to one stock portfolio and no Options', async () => {
      await setUser(db, BASIC);
      await createPortfolio(db, 'First', 'STOCK');
      await expect(createPortfolio(db, 'Second', 'STOCK')).rejects.toThrow(/LIMIT_REACHED:STOCK:1/);
      await expect(createPortfolio(db, 'Options', 'OPTION'))
        .rejects.toThrow(/UPGRADE_REQUIRED:portfolio\.options\.create/);
    });

    it('gives a Pro subscriber ten of each and full mutation', async () => {
      await setUser(db, PRO);
      const stocks: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        stocks.push(await createPortfolio(db, `Stock ${index}`, 'STOCK'));
      }
      const options: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        options.push(await createPortfolio(db, `Options ${index}`, 'OPTION'));
      }
      await expect(createPortfolio(db, 'Stock 11', 'STOCK')).rejects.toThrow(/LIMIT_REACHED:STOCK:10/);
      await expect(createPortfolio(db, 'Options 11', 'OPTION')).rejects.toThrow(/LIMIT_REACHED:OPTION:10/);

      // Every stock portfolio stays writable, not just the first.
      await expect(addDeposit(db, stocks[9])).resolves.toBeTruthy();
      await expect(addDeposit(db, options[0])).resolves.toBeTruthy();
    });

    it('gives an administrator whose stored plan is Basic every Pro and Elite write', async () => {
      await setUser(db, OWNER);
      expect(await subscriptionTier(db, OWNER)).toBe('basic');

      const options = await createPortfolio(db, 'Owner Options', 'OPTION');
      const second = await createPortfolio(db, 'Owner Stock A', 'STOCK');
      const third = await createPortfolio(db, 'Owner Stock B', 'STOCK');
      await expect(addDeposit(db, options)).resolves.toBeTruthy();
      await expect(addDeposit(db, second)).resolves.toBeTruthy();
      await expect(addDeposit(db, third, 50)).resolves.toBeTruthy();

      // A transfer touches two portfolios, so both ends had to pass the gate.
      await expect(db.query(
        `select public.transfer_portfolio_cash($1, $2, 10, timestamptz '2026-03-01 10:00:00+00', null, gen_random_uuid())`,
        [second, third],
      )).resolves.toBeTruthy();

      const stored = await subscriptionRow(db, OWNER);
      expect(stored.tier).toBe('basic');
      expect(stored.status).toBe('basic');
    });

    it('locks Options and the extra stock portfolios inside a Basic preview', async () => {
      await setPreview(db, OWNER, 'basic');
      await setUser(db, OWNER);
      expect(await accessTier(db, OWNER)).toBe('basic');

      const owned = await db.query<{ id: string; portfolio_type: string; created_at: Date }>(
        `select id, portfolio_type, created_at from public.portfolios
         where user_id = $1 and archived_at is null order by created_at, id`,
        [OWNER],
      );
      const options = owned.rows.find((row) => row.portfolio_type === 'OPTION');
      const stocks = owned.rows.filter((row) => row.portfolio_type === 'STOCK');

      await expect(addDeposit(db, options!.id))
        .rejects.toThrow(/UPGRADE_REQUIRED:portfolio\.options\.write/);
      // The oldest active stock portfolio stays writable; the rest do not.
      await expect(addDeposit(db, stocks[0].id)).resolves.toBeTruthy();
      await expect(addDeposit(db, stocks[1].id))
        .rejects.toThrow(/READ_ONLY_SUBSCRIPTION:portfolio\.stock\.write/);
      await expect(addDeposit(db, await legacyPortfolio(db, OWNER))).resolves.toBeTruthy();

      await expect(createPortfolio(db, 'Blocked', 'OPTION'))
        .rejects.toThrow(/UPGRADE_REQUIRED:portfolio\.options\.create/);
      await expect(createPortfolio(db, 'Blocked', 'STOCK')).rejects.toThrow(/LIMIT_REACHED:STOCK:1/);
    });

    it('opens Options and the Pro allowance inside a Pro preview', async () => {
      await setPreview(db, OWNER, 'pro');
      await setUser(db, OWNER);
      expect(await accessTier(db, OWNER)).toBe('pro');

      const owned = await db.query<{ id: string; portfolio_type: string }>(
        `select id, portfolio_type from public.portfolios
         where user_id = $1 and archived_at is null order by created_at, id`,
        [OWNER],
      );
      const options = owned.rows.find((row) => row.portfolio_type === 'OPTION');
      const stocks = owned.rows.filter((row) => row.portfolio_type === 'STOCK');

      await expect(addDeposit(db, options!.id)).resolves.toBeTruthy();
      await expect(addDeposit(db, stocks[1].id)).resolves.toBeTruthy();
    });

    it.each(['elite', 'elite_trial'] as const)('opens every write inside a %s preview', async (mode) => {
      await setPreview(db, OWNER, mode);
      await setUser(db, OWNER);
      expect(await accessTier(db, OWNER)).toBe('elite');
      const options = await db.query<{ id: string }>(
        `select id from public.portfolios where user_id = $1 and portfolio_type = 'OPTION' limit 1`,
        [OWNER],
      );
      await expect(addDeposit(db, options.rows[0].id)).resolves.toBeTruthy();
    });

    it('falls back to Basic inside an expired-trial preview', async () => {
      await setPreview(db, OWNER, 'expired_trial');
      await setUser(db, OWNER);
      expect(await accessTier(db, OWNER)).toBe('basic');
      const options = await db.query<{ id: string }>(
        `select id from public.portfolios where user_id = $1 and portfolio_type = 'OPTION' limit 1`,
        [OWNER],
      );
      await expect(addDeposit(db, options.rows[0].id))
        .rejects.toThrow(/UPGRADE_REQUIRED:portfolio\.options\.write/);
    });

    it('restores every write the instant the preview ends', async () => {
      await setPreview(db, OWNER, 'actual');
      await setUser(db, OWNER);
      expect(await accessTier(db, OWNER)).toBe('elite');
      const options = await db.query<{ id: string }>(
        `select id from public.portfolios where user_id = $1 and portfolio_type = 'OPTION' limit 1`,
        [OWNER],
      );
      await expect(addDeposit(db, options.rows[0].id)).resolves.toBeTruthy();
    });

    it('has changed no subscription, billing or trial field through any of it', async () => {
      const rows = await db.query<Record<string, unknown>>(
        `select user_id, tier, status, trial_started_at, trial_ends_at, trial_used_at,
                current_period_start, current_period_end, cancel_at_period_end,
                billing_customer_id, billing_subscription_id, billing_price_id, founder_promo_applied
         from public.user_subscriptions order by user_id`,
      );
      const owner = rows.rows.find((row) => row.user_id === OWNER);
      expect(owner).toMatchObject({
        tier: 'basic',
        status: 'basic',
        trial_started_at: null,
        trial_ends_at: null,
        trial_used_at: null,
        billing_customer_id: null,
        billing_subscription_id: null,
        billing_price_id: null,
        founder_promo_applied: false,
      });
      // No preview row survives a cleared preview.
      const previews = await db.query<{ count: number }>(
        `select count(*)::int as count from public.admin_access_previews`,
      );
      expect(previews.rows[0].count).toBe(0);
    });
  });

  describe('the mutation routines that had no gate at all', () => {
    let db: PGlite;
    let basicOptionPortfolio: string;
    let basicExtraStock: string;
    let basicExtraTransaction: string;

    beforeAll(async () => {
      db = await database();
      /*
       * Build the state a downgrade leaves behind: an Options portfolio and a
       * second stock portfolio created while paid, then the plan reverting to
       * Basic. Both stay readable; neither may be written.
       */
      await db.exec(`
        update public.user_subscriptions
          set tier = 'elite', status = 'active', current_period_end = timestamptz '${FUTURE}'
          where user_id = '${BASIC}';
      `);
      await setUser(db, BASIC);
      await createPortfolio(db, 'Kept', 'STOCK');
      basicExtraStock = await createPortfolio(db, 'Extra', 'STOCK');
      basicOptionPortfolio = await createPortfolio(db, 'Options', 'OPTION');
      basicExtraTransaction = await addDeposit(db, basicExtraStock, 250);
      await db.exec(`
        update public.user_subscriptions
          set tier = 'basic', status = 'expired', current_period_end = timestamptz '${PAST}'
          where user_id = '${BASIC}';
      `);
    });

    it('refuses the pre-ledger transaction routines on a downgraded portfolio', async () => {
      await setUser(db, BASIC);
      expect(await accessTier(db, BASIC)).toBe('basic');

      await expect(db.query(
        `select public.update_portfolio_transaction($1, 'deposit', null, null, null, 999,
           date '2026-02-01', null, 'USD', null)`,
        [basicExtraTransaction],
      )).rejects.toThrow(/READ_ONLY_SUBSCRIPTION:portfolio\.stock\.write/);

      await expect(db.query(
        `select public.delete_portfolio_transaction($1)`,
        [basicExtraTransaction],
      )).rejects.toThrow(/READ_ONLY_SUBSCRIPTION:portfolio\.stock\.write/);

      // Untouched: the refusal happened before any write.
      const row = await db.query<{ amount: string }>(
        `select amount from public.portfolio_transactions where id = $1`,
        [basicExtraTransaction],
      );
      expect(Number(row.rows[0].amount)).toBe(250);
    });

    it('refuses every option-position routine for a Basic account', async () => {
      await setUser(db, BASIC);
      const upgrade = /UPGRADE_REQUIRED:portfolio\.options\.write/;

      await expect(db.query(
        `select public.create_option_position('AAPL', 'call', 1, 1.5, 200, date '2026-02-01',
           date '2026-06-19', null, null, null, null, 'open', gen_random_uuid())`,
      )).rejects.toThrow(upgrade);
      await expect(db.query(
        `select public.update_option_position(gen_random_uuid(), 'AAPL', 'call', 1, 1.5, 200,
           date '2026-02-01', date '2026-06-19', null, null, null, null, 'open')`,
      )).rejects.toThrow(upgrade);
      await expect(db.query(
        `select public.close_option_position(gen_random_uuid(), date '2026-03-01')`,
      )).rejects.toThrow(upgrade);
      await expect(db.query(
        `select public.delete_option_position(gen_random_uuid())`,
      )).rejects.toThrow(upgrade);

      const positions = await db.query<{ count: number }>(
        `select count(*)::int as count from public.portfolio_option_positions`,
      );
      expect(positions.rows[0].count).toBe(0);
    });

    it('allows the same option-position routines for Pro and for an administrator', async () => {
      for (const user of [PRO, OWNER]) {
        await setUser(db, user);
        const created = await db.query<{ id: string }>(
          `select public.create_option_position('AAPL', 'call', 1, 1.5, 200, date '2026-02-01',
             date '2026-06-19', null, null, null, null, 'open', gen_random_uuid()) as id`,
        );
        expect(created.rows[0].id).toBeTruthy();
        await expect(db.query(
          `select public.delete_option_position($1)`, [created.rows[0].id],
        )).resolves.toBeTruthy();
      }
    });

    it('refuses an administrator inside a Basic preview exactly as it refuses a Basic reader', async () => {
      await setPreview(db, OWNER, 'basic');
      await setUser(db, OWNER);
      await expect(db.query(
        `select public.create_option_position('AAPL', 'call', 1, 1.5, 200, date '2026-02-01',
           date '2026-06-19', null, null, null, null, 'open', gen_random_uuid())`,
      )).rejects.toThrow(/UPGRADE_REQUIRED:portfolio\.options\.write/);
      await setPreview(db, OWNER, 'actual');
    });

    it('leaves the downgraded reader every row they had', async () => {
      await setUser(db, BASIC);
      const portfolios = await db.query<{ count: number }>(
        `select count(*)::int as count from public.portfolios where user_id = $1 and archived_at is null`,
        [BASIC],
      );
      // Legacy + two stock + one options: nothing was archived or removed.
      expect(portfolios.rows[0].count).toBe(4);
      const transaction = await db.query<{ count: number }>(
        `select count(*)::int as count from public.portfolio_transactions where id = $1`,
        [basicExtraTransaction],
      );
      expect(transaction.rows[0].count).toBe(1);
      expect(basicOptionPortfolio).toBeTruthy();
    });
  });

  describe('database and application agree on every administrator state', () => {
    let db: PGlite;
    beforeAll(async () => { db = await database(); });

    it.each(['actual', ...Object.keys(PREVIEW_TIERS)])('agrees in %s', async (mode) => {
      await setPreview(db, OWNER, mode);
      const database = await accessTier(db, OWNER);
      const application = resolveAccountAccess({
        role: 'admin',
        subscriptionEffectiveTier: 'basic',
        previewMode: mode,
        previewExpiresAt: mode === 'actual' ? null : new Date(Date.now() + 3_600_000).toISOString(),
        now: new Date().toISOString(),
      });
      expect(database).toBe(application.effectiveAccessTier);
    });
  });
});
