import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mapProviderSubscriptionStatus } from './billing-events';
import { resolveEffectiveTier } from '@/src/lib/subscription/resolve-effective-tier';

/**
 * Billing state is decided inside PostgreSQL — idempotency, row locking,
 * identity matching and out-of-order rejection are all enforced by one routine —
 * so it is tested inside PostgreSQL. Each case runs the real migration chain
 * against an in-process database rather than asserting on SQL text; the text
 * assertions are the exceptions, and they check absences a behavioural test
 * cannot observe.
 */
/*
 * Most cases here boot a fresh in-process PostgreSQL and replay the whole
 * migration chain, so that each one observes a clean database and they cannot
 * contaminate one another. That is genuinely several seconds of work per case,
 * and alongside the rest of the suite it exceeds the default five. The timeout
 * is raised to match the real cost of the setup — nothing here waits on a race.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const migrationFile = '202608030003_billing_subscriptions.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationFile), 'utf8');
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();
/** Statements only. Used where a comment mentioning a word is not the concern. */
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
  migrationFile,
];

const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const BUYER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const PERIOD_START = '2026-08-01T00:00:00.000Z';
const PERIOD_END = '2027-08-01T00:00:00.000Z';
/** Inside the paid period. */
const DURING = '2026-09-01T00:00:00.000Z';
/** After it. */
const AFTER = '2028-09-01T00:00:00.000Z';

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
    if (file === '202608030002_admin_role_and_access_preview.sql') {
      await db.exec(`
        insert into auth.users (id, email, email_confirmed_at) values
          ('${OWNER}', 'owner@example.com', now()),
          ('${BUYER}', 'buyer@example.com', now()),
          ('${OTHER}', 'other@example.com', now());
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec('grant usage on schema public, auth to anon, authenticated');
  return db;
}

interface ApplyOptions {
  eventId?: string;
  eventType?: string;
  occurredAt?: string | null;
  userId?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
  planKey?: string | null;
  tier?: string | null;
  status?: string | null;
  interval?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  cancelAtPeriodEnd?: boolean | null;
  invoiceId?: string | null;
  paymentStatus?: string | null;
  founder?: boolean | null;
}

async function apply(db: PGlite, options: ApplyOptions = {}): Promise<string> {
  const result = await db.query<{ outcome: string }>(
    `select * from public.apply_billing_subscription_event(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      'stripe',
      options.eventId ?? 'evt_default',
      options.eventType ?? 'customer.subscription.updated',
      options.occurredAt === undefined ? PERIOD_START : options.occurredAt,
      'digest-abc',
      options.userId === undefined ? BUYER : options.userId,
      options.customerId === undefined ? 'cus_1' : options.customerId,
      options.subscriptionId === undefined ? 'sub_1' : options.subscriptionId,
      options.planKey === undefined ? 'pro_annual' : options.planKey,
      'price_1',
      options.tier === undefined ? 'pro' : options.tier,
      options.status === undefined ? 'active' : options.status,
      options.interval === undefined ? 'year' : options.interval,
      options.periodStart === undefined ? PERIOD_START : options.periodStart,
      options.periodEnd === undefined ? PERIOD_END : options.periodEnd,
      options.cancelAtPeriodEnd === undefined ? false : options.cancelAtPeriodEnd,
      options.invoiceId === undefined ? 'in_1' : options.invoiceId,
      options.paymentStatus === undefined ? 'succeeded' : options.paymentStatus,
      options.founder === undefined ? false : options.founder,
    ],
  );
  return result.rows[0].outcome;
}

async function subscriptionRow(db: PGlite, userId = BUYER) {
  const result = await db.query<Record<string, unknown>>(
    'select * from public.user_subscriptions where user_id = $1',
    [userId],
  );
  return result.rows[0];
}

async function eventRows(db: PGlite) {
  const result = await db.query<{ provider_event_id: string; status: string; error_code: string | null }>(
    'select provider_event_id, status, error_code from public.billing_webhook_events order by id',
  );
  return result.rows;
}

describe('billing migration: shape and safety', () => {
  it('adds only — nothing that could remove a table, a column or a row', () => {
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/drop column/);
    expect(sql).not.toMatch(/drop index/);
    expect(sql).not.toMatch(/truncate/);
    expect(sql).not.toMatch(/delete from/);
    expect(sql).not.toMatch(/drop policy/);
    // No function already serving production has its signature changed: the
    // reader-facing snapshot is a NEW function rather than a redefinition.
    expect(sql).not.toMatch(/drop function/);
    expect(sql).toContain('create or replace function public.get_my_billing_snapshot');
  });

  it('never touches the role or preview tables', () => {
    // A webhook must not be able to promote anyone or end a running preview.
    expect(sql).not.toContain('user_roles');
    expect(sql).not.toContain('admin_access_previews');
  });

  it('stores no card data and no raw payload', () => {
    // Statements only: the prose above them is allowed to name what is absent.
    for (const forbidden of ['card_number', 'cvv', 'cvc', 'payload jsonb', 'raw_body', 'secret']) {
      expect(statements, forbidden).not.toContain(forbidden);
    }
    // A digest is kept instead, which proves two deliveries matched and is
    // useless to anyone who reads it.
    expect(sql).toContain('payload_digest');
  });

  it('keeps every Phase 1–3.1 subscription column', async () => {
    const db = await database();
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'user_subscriptions'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const column of [
      'user_id', 'tier', 'status', 'trial_started_at', 'trial_ends_at', 'trial_used_at',
      'current_period_start', 'current_period_end', 'cancel_at_period_end',
      'billing_customer_id', 'billing_subscription_id', 'billing_price_id',
      'founder_promo_applied', 'created_at', 'updated_at',
    ]) {
      expect(names, column).toContain(column);
    }
    // …and adds the Phase 4 ones.
    for (const column of [
      'billing_provider', 'billing_plan_key', 'billing_interval',
      'latest_invoice_id', 'latest_payment_status', 'latest_payment_at',
      'provider_event_at', 'provider_event_id',
    ]) {
      expect(names, column).toContain(column);
    }
  });
});

describe('billing migration: privileges', () => {
  let db: PGlite;
  beforeAll(async () => { db = await database(); });

  it('gives no client any privilege on the webhook ledger', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        const result = await db.query<{ allowed: boolean }>(
          `select has_table_privilege($1, 'public.billing_webhook_events', $2) as allowed`,
          [role, privilege],
        );
        expect(result.rows[0].allowed, `${role} ${privilege}`).toBe(false);
      }
    }
  });

  it('enables row level security on the webhook ledger', async () => {
    const result = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.billing_webhook_events'::regclass`,
    );
    expect(result.rows[0].relrowsecurity).toBe(true);
  });

  /*
   * The one routine that changes billing state must be unreachable from a
   * session, whatever that session's JWT claims. Only the service role — held
   * exclusively by the webhook route — may execute it.
   */
  it('lets no client execute the billing write routine', async () => {
    const signature = 'public.apply_billing_subscription_event(text,text,text,timestamptz,text,uuid,'
      + 'text,text,text,text,text,text,text,timestamptz,timestamptz,boolean,text,text,boolean)';
    for (const role of ['anon', 'authenticated']) {
      const result = await db.query<{ allowed: boolean }>(
        `select has_function_privilege($1, $2, 'execute') as allowed`,
        [role, signature],
      );
      expect(result.rows[0].allowed, role).toBe(false);
    }
  });

  it('keeps the subscription table read-only for a signed-in reader', async () => {
    for (const privilege of ['insert', 'update', 'delete']) {
      const result = await db.query<{ allowed: boolean }>(
        `select has_table_privilege('authenticated', 'public.user_subscriptions', $1) as allowed`,
        [privilege],
      );
      expect(result.rows[0].allowed, privilege).toBe(false);
    }
    const read = await db.query<{ allowed: boolean }>(
      `select has_table_privilege('authenticated', 'public.user_subscriptions', 'select') as allowed`,
    );
    expect(read.rows[0].allowed).toBe(true);
  });

  it('refuses a client attempting to write its own billing state', async () => {
    await db.exec('set role authenticated');
    try {
      await expect(
        db.query(`update public.user_subscriptions set tier = 'elite', status = 'active'`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query(`insert into public.user_subscriptions (user_id, tier) values ($1, 'elite')`, [OTHER]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec('reset role');
    }
  });

  it('keeps billing identifiers unique across accounts when set', async () => {
    const indexes = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'user_subscriptions'`,
    );
    const defs = indexes.rows.map((row) => row.indexdef).join('\n');
    expect(defs).toMatch(/unique index .*billing_customer_id.*where \(billing_customer_id is not null\)/i);
    expect(defs).toMatch(/unique index .*billing_subscription_id.*where \(billing_subscription_id is not null\)/i);
  });
});

describe('billing migration: applying events', () => {
  it('activates a purchase and records the provider clock', async () => {
    const db = await database();
    expect(await apply(db, { eventId: 'evt_1' })).toBe('applied');

    const row = await subscriptionRow(db);
    expect(row.tier).toBe('pro');
    expect(row.status).toBe('active');
    expect(row.billing_plan_key).toBe('pro_annual');
    expect(row.billing_interval).toBe('year');
    expect(row.billing_customer_id).toBe('cus_1');
    expect(row.provider_event_id).toBe('evt_1');
    expect(row.latest_payment_status).toBe('succeeded');
  });

  /*
   * The idempotency guarantee. A provider redelivers on any non-2xx, and on
   * timeouts it cannot distinguish from failures — so the same event id must be
   * a no-op however many times it lands.
   */
  it('applies an event exactly once however often it is redelivered', async () => {
    const db = await database();
    expect(await apply(db, { eventId: 'evt_1' })).toBe('applied');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await apply(db, { eventId: 'evt_1', status: 'canceled', tier: 'elite' })).toBe('duplicate');
    }

    // The replay carried a different tier and status, and changed neither.
    const row = await subscriptionRow(db);
    expect(row.tier).toBe('pro');
    expect(row.status).toBe('active');
    expect((await eventRows(db)).filter((event) => event.provider_event_id === 'evt_1')).toHaveLength(1);
  });

  /*
   * Out-of-order delivery. A retry of an older event arriving after a newer one
   * must not undo it.
   */
  it('refuses an event older than the one already applied', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_new', occurredAt: '2026-08-10T00:00:00.000Z' });

    expect(await apply(db, {
      eventId: 'evt_old',
      occurredAt: '2026-08-01T00:00:00.000Z',
      status: 'canceled',
      tier: 'basic',
    })).toBe('stale');

    const row = await subscriptionRow(db);
    expect(row.status).toBe('active');
    expect(row.tier).toBe('pro');
    expect((await eventRows(db)).find((e) => e.provider_event_id === 'evt_old')?.status).toBe('stale');
  });

  it('accepts an event sharing a second with the last applied one', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_a', occurredAt: PERIOD_START });
    expect(await apply(db, {
      eventId: 'evt_b',
      occurredAt: PERIOD_START,
      status: 'past_due',
      paymentStatus: 'failed',
    })).toBe('applied');
    expect((await subscriptionRow(db)).status).toBe('past_due');
  });

  /*
   * Identity must not drift. Guessing which identifier is right is exactly the
   * mistake that moves a paid plan onto the wrong account.
   */
  it('fails closed when the customer does not match the stored one', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_1', customerId: 'cus_1' });

    expect(await apply(db, {
      eventId: 'evt_2',
      customerId: 'cus_SOMEONE_ELSE',
      tier: 'elite',
      occurredAt: '2026-08-20T00:00:00.000Z',
    })).toBe('customer_mismatch');

    const row = await subscriptionRow(db);
    expect(row.tier).toBe('pro');
    expect(row.billing_customer_id).toBe('cus_1');
    expect((await eventRows(db)).find((e) => e.provider_event_id === 'evt_2')?.error_code)
      .toBe('customer_mismatch');
  });

  it('fails closed when the subscription does not match the stored one', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_1', subscriptionId: 'sub_1' });
    expect(await apply(db, {
      eventId: 'evt_2',
      subscriptionId: 'sub_OTHER',
      occurredAt: '2026-08-20T00:00:00.000Z',
    })).toBe('subscription_mismatch');
    expect((await subscriptionRow(db)).billing_subscription_id).toBe('sub_1');
  });

  it('records an event for an account that does not exist without failing', async () => {
    const db = await database();
    expect(await apply(db, {
      eventId: 'evt_ghost',
      userId: '99999999-9999-4999-8999-999999999999',
    })).toBe('unknown_user');
    expect((await eventRows(db)).find((e) => e.provider_event_id === 'evt_ghost')?.error_code)
      .toBe('unknown_user');
  });

  it('records an unrecognised event without touching entitlement', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_1' });
    expect(await apply(db, {
      eventId: 'evt_refund',
      eventType: 'charge.refunded',
      status: null,
      occurredAt: '2026-08-20T00:00:00.000Z',
    })).toBe('ignored');

    const row = await subscriptionRow(db);
    expect(row.status).toBe('active');
    expect(row.tier).toBe('pro');
  });

  /*
   * Founder's Club is one discounted first period per account, forever. The flag
   * must survive every later event, including ones that assert `false`.
   */
  it('spends the Founder promotion once and never gives it back', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_1', planKey: 'pro_annual_founder', founder: true });
    expect((await subscriptionRow(db)).founder_promo_applied).toBe(true);

    await apply(db, {
      eventId: 'evt_2',
      planKey: 'pro_annual',
      founder: false,
      occurredAt: '2027-08-01T00:00:00.000Z',
    });
    expect((await subscriptionRow(db)).founder_promo_applied).toBe(true);
  });

  it('holds the plan key to the same allowlist the application ships', async () => {
    const db = await database();
    await expect(apply(db, { eventId: 'evt_bad', planKey: 'pro_weekly' }))
      .rejects.toThrow(/billing_plan_key_check/i);
  });
});

describe('billing migration: lifecycle and entitlement', () => {
  it('keeps access to the period end when cancellation is scheduled', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_1', cancelAtPeriodEnd: true });

    const row = await subscriptionRow(db);
    expect(row.cancel_at_period_end).toBe(true);
    expect(row.status).toBe('active');

    const during = await db.query<{ tier: string }>(
      'select public.resolve_effective_subscription_tier($1, $2) as tier', [BUYER, DURING],
    );
    expect(during.rows[0].tier).toBe('pro');

    const after = await db.query<{ tier: string }>(
      'select public.resolve_effective_subscription_tier($1, $2) as tier', [BUYER, AFTER],
    );
    expect(after.rows[0].tier).toBe('basic');
  });

  /*
   * The dunning grace policy, and the identical rule in TypeScript. If these two
   * ever disagreed, a page and an API guard would answer differently for the
   * same reader.
   */
  it('implements the same past_due grace as the application resolver', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_1', status: 'past_due', paymentStatus: 'failed' });

    for (const [asOf, expected] of [[DURING, 'pro'], [AFTER, 'basic']] as const) {
      const result = await db.query<{ tier: string }>(
        'select public.resolve_effective_subscription_tier($1, $2) as tier', [BUYER, asOf],
      );
      expect(result.rows[0].tier, asOf).toBe(expected);
      expect(resolveEffectiveTier({
        tier: 'pro',
        status: mapProviderSubscriptionStatus('past_due'),
        trialEndsAt: null,
        currentPeriodEnd: PERIOD_END,
      }, asOf), asOf).toBe(expected);
    }
  });

  it('returns an upgraded and then a downgraded plan without losing data', async () => {
    const db = await database();
    await db.query(
      `insert into public.portfolios (user_id, name, portfolio_type) values ($1, 'QA', 'STOCK')`,
      [BUYER],
    );

    await apply(db, { eventId: 'evt_pro', planKey: 'pro_annual', tier: 'pro' });
    await apply(db, {
      eventId: 'evt_elite',
      planKey: 'elite_annual',
      tier: 'elite',
      occurredAt: '2026-08-15T00:00:00.000Z',
    });
    expect((await subscriptionRow(db)).tier).toBe('elite');

    await apply(db, {
      eventId: 'evt_cancel',
      eventType: 'customer.subscription.deleted',
      status: 'canceled',
      occurredAt: '2026-08-20T00:00:00.000Z',
    });

    const row = await subscriptionRow(db);
    expect(row.status).toBe('canceled');
    const tier = await db.query<{ tier: string }>(
      'select public.resolve_effective_subscription_tier($1, $2) as tier', [BUYER, DURING],
    );
    expect(tier.rows[0].tier).toBe('basic');

    // The reader keeps everything they made.
    const portfolios = await db.query<{ count: string }>(
      'select count(*)::text as count from public.portfolios where user_id = $1', [BUYER],
    );
    expect(Number(portfolios.rows[0].count)).toBeGreaterThan(0);
  });

  it('never alters another account while applying an event', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_1', userId: BUYER });
    const other = await subscriptionRow(db, OTHER);
    expect(other.tier).toBe('basic');
    expect(other.status).toBe('basic');
    expect(other.billing_customer_id).toBeNull();
  });

  it('leaves the trial columns alone, so a purchase neither spends nor returns it', async () => {
    const db = await database();
    const before = await subscriptionRow(db);
    await apply(db, { eventId: 'evt_1' });
    const after = await subscriptionRow(db);
    expect(after.trial_used_at).toEqual(before.trial_used_at);
    expect(after.trial_ends_at).toEqual(before.trial_ends_at);
    expect(after.trial_started_at).toEqual(before.trial_started_at);
  });
});

describe('billing migration: what a reader may see', () => {
  it('returns the caller their own sanitized billing snapshot', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_1', planKey: 'elite_annual', tier: 'elite' });

    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [BUYER]);
    const snapshot = await db.query<Record<string, unknown>>('select * from public.get_my_billing_snapshot()');
    const row = snapshot.rows[0];

    expect(row.user_id).toBe(BUYER);
    expect(row.billing_plan_key).toBe('elite_annual');
    expect(row.has_billing_customer).toBe(true);

    /*
     * The projection carries no provider identifier. The manage page answers
     * "what plan, when does it renew, for how much" without any of them ever
     * reaching a browser.
     */
    const columns = Object.keys(row);
    for (const forbidden of [
      'billing_customer_id', 'billing_subscription_id', 'billing_price_id',
      'latest_invoice_id', 'provider_event_id',
    ]) {
      expect(columns, forbidden).not.toContain(forbidden);
    }
    expect(JSON.stringify(row)).not.toContain('cus_1');
    expect(JSON.stringify(row)).not.toContain('sub_1');
  });

  it('shows a reader nothing of anyone else', async () => {
    const db = await database();
    await apply(db, { eventId: 'evt_1', userId: BUYER, planKey: 'elite_annual', tier: 'elite' });

    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [OTHER]);
    const snapshot = await db.query<Record<string, unknown>>('select * from public.get_my_billing_snapshot()');
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].user_id).toBe(OTHER);
    expect(snapshot.rows[0].billing_plan_key).toBeNull();
    expect(snapshot.rows[0].has_billing_customer).toBe(false);
  });

  it('returns nothing at all to an unauthenticated caller', async () => {
    const db = await database();
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    const snapshot = await db.query('select * from public.get_my_billing_snapshot()');
    expect(snapshot.rows).toHaveLength(0);
  });
});
