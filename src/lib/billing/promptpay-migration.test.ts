import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

/**
 * The PromptPay migration, run against a real Postgres.
 *
 * The rules being proven here are the ones a reader would pay for twice, or pay
 * for once and never receive, if they were wrong:
 *
 *   * an invoice that exists but has not been paid grants nothing;
 *   * recording that invoice cannot reach an entitlement column;
 *   * a subscription identifier already stored blocks a different one only while
 *     it is still live — otherwise a reader who cancelled and came back would
 *     pay and be granted nothing, forever;
 *   * on the invoice rail "still live" means the *paid period* is still running,
 *     because there the status outlives the lease.
 */

const migrationFile = '202608050001_promptpay_invoice_subscriptions.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationFile), 'utf8');
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
  '202608040001_effective_access_tier.sql',
  '202608040002_live_billing_readiness.sql',
  '202608040003_prevent_billing_mode_downgrade.sql',
  migrationFile,
];

/** The owner UUID the Phase 3.1 migration seeds; its account must exist first. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const SCANNER = '44444444-4444-4444-8444-444444444444';
const RETURNER = '55555555-5555-4555-8555-555555555555';
const CARD_HOLDER = '66666666-6666-4666-8666-666666666666';
const TWICE = '77777777-7777-4777-8777-777777777777';

/*
 * Every routine below judges "is this still live?" against the database's own
 * clock, so the fixtures are anchored to real time rather than to a fixed date
 * that would silently stop meaning "in the past" a month from now.
 */
const day = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();

/** A period that has already run out. */
const LAPSED_START = at(-60);
const LAPSED_END = at(-30);
/** A period still running. */
const LIVE_START = at(-1);
const LIVE_END = at(30);
/** An invoice a reader could still pay. */
const FUTURE_DUE = at(3);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
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
          ('${SCANNER}', 'scanner@example.com', now()),
          ('${RETURNER}', 'returner@example.com', now()),
          ('${CARD_HOLDER}', 'card@example.com', now()),
          ('${TWICE}', 'twice@example.com', now());
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec('grant usage on schema public, auth to anon, authenticated');
});

/** One webhook delivery, in the vocabulary the route hands the database. */
async function applyEvent(options: {
  userId: string;
  eventId: string;
  eventType?: string;
  subscriptionId: string;
  customerId?: string;
  status: string;
  planKey?: string;
  tier?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  occurredAt?: string;
  paymentStatus?: string | null;
  founder?: boolean;
}) {
  const result = await db.query<{ outcome: string }>(
    `select * from public.apply_billing_subscription_event(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
    )`,
    [
      'stripe', 'live', options.eventId, options.eventType ?? 'invoice.paid',
      options.occurredAt ?? LAPSED_START, 'digest', options.userId,
      options.customerId ?? 'cus_1', options.subscriptionId,
      options.planKey ?? 'pro_monthly', 'price_1', options.tier ?? 'pro',
      options.status, 'month',
      options.periodStart === undefined ? LIVE_START : options.periodStart,
      options.periodEnd === undefined ? LIVE_END : options.periodEnd,
      false, 'in_1', options.paymentStatus ?? 'succeeded', options.founder ?? false,
    ],
  );
  return result.rows[0].outcome;
}

async function recordPending(options: {
  userId: string;
  subscriptionId: string;
  planKey?: string;
  amountBaht?: number;
  dueAt?: string | null;
}) {
  const result = await db.query<{ record_pending_billing_payment: string }>(
    `select public.record_pending_billing_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      options.userId, 'stripe', 'live', 'promptpay', options.planKey ?? 'pro_monthly',
      options.subscriptionId, 'in_pending', 'https://invoice.test/i/1',
      options.amountBaht ?? 349, options.dueAt === undefined ? FUTURE_DUE : options.dueAt,
    ],
  );
  return result.rows[0].record_pending_billing_payment;
}

async function subscriptionRow(userId: string) {
  const result = await db.query<Record<string, unknown>>(
    'select * from public.user_subscriptions where user_id = $1', [userId],
  );
  return result.rows[0];
}

async function effectiveTier(userId: string, asOf: string) {
  const result = await db.query<{ tier: string }>(
    'select public.resolve_effective_subscription_tier($1, $2) as tier', [userId, asOf],
  );
  return result.rows[0].tier;
}

describe('promptpay invoice subscriptions migration', () => {
  it('is additive: no table, column or row is removed', () => {
    expect(statements).not.toMatch(/drop table|drop column|truncate|delete from public\.user_subscriptions/);
    expect(statements).toContain('billing_collection_method');
    expect(statements).toContain('billing_pending_payments');
  });

  /*
   * The pending table is a ledger of intent, not of access. A reader may read
   * their own row — they need the address of their own QR — and may write
   * nothing at all.
   */
  it('lets a reader see only their own pending invoice, and write none', async () => {
    const grants = await db.query<{ privilege_type: string; grantee: string }>(
      `select privilege_type, grantee from information_schema.role_table_grants
       where table_name = 'billing_pending_payments'`,
    );
    const readerGrants = grants.rows
      .filter((row) => row.grantee === 'authenticated')
      .map((row) => row.privilege_type);
    expect(readerGrants).toEqual(['SELECT']);
    for (const write of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(readerGrants, write).not.toContain(write);
    }

    const policies = await db.query<{ cmd: string; qual: string }>(
      `select cmd, qual from pg_policies where tablename = 'billing_pending_payments'`,
    );
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0].cmd).toBe('SELECT');
    expect(policies.rows[0].qual).toContain('auth.uid()');
  });

  /*
   * The whole point of the rail's safety story: creating the invoice moves
   * nothing. The row exists, and the account is still on `basic`.
   */
  it('grants nothing when an invoice is recorded', async () => {
    expect(await recordPending({ userId: SCANNER, subscriptionId: 'sub_scan' })).toBe('recorded');

    const row = await subscriptionRow(SCANNER);
    expect(row.tier).toBe('basic');
    expect(row.status).toBe('basic');
    expect(row.current_period_end).toBeNull();
    expect(await effectiveTier(SCANNER, LAPSED_START)).toBe('basic');

    const pending = await db.query<Record<string, unknown>>(
      'select * from public.billing_pending_payments where user_id = $1', [SCANNER],
    );
    expect(pending.rows[0]).toMatchObject({
      status: 'awaiting_payment',
      payment_method: 'promptpay',
      subscription_id: 'sub_scan',
      amount_baht: 349,
    });
  });

  it('opens the plan when the paid invoice arrives, and closes the pending row', async () => {
    expect(await applyEvent({
      userId: SCANNER, eventId: 'evt_paid', subscriptionId: 'sub_scan', status: 'active',
      periodStart: LAPSED_START, periodEnd: LAPSED_END,
    })).toBe('applied');

    const rail = await db.query<{ rail_updated: boolean; pending_cleared: boolean }>(
      `select * from public.apply_billing_payment_rail($1,$2,$3,$4,$5,$6)`,
      [SCANNER, 'stripe', 'live', 'sub_scan', 'send_invoice', true],
    );
    expect(rail.rows[0]).toEqual({ rail_updated: true, pending_cleared: true });

    const row = await subscriptionRow(SCANNER);
    expect(row.tier).toBe('pro');
    expect(row.billing_collection_method).toBe('send_invoice');
    expect(await effectiveTier(SCANNER, at(-45))).toBe('pro');

    const pending = await db.query('select * from public.billing_pending_payments where user_id = $1', [SCANNER]);
    expect(pending.rows).toHaveLength(0);
  });

  /*
   * The grace policy is unchanged, and on this rail it needs no special case:
   * only paid invoices ever advance the period, so an unpaid one simply lets the
   * lease run out.
   */
  it('ends access when the paid period runs out, with no further events', async () => {
    expect(await effectiveTier(SCANNER, at(-1))).toBe('basic');
    // The row still says `active`: the provider keeps an invoice-collected
    // subscription active through a period nobody paid for, and its events are
    // ignored precisely so they cannot extend the lease. The period is what
    // ended access, exactly as intended.
    const row = await subscriptionRow(SCANNER);
    expect(row.status).toBe('active');
  });

  /*
   * The correction this migration exists for. A reader whose PromptPay
   * subscription lapsed buys again; the new subscription must be accepted, or
   * they pay and are granted nothing.
   */
  it('accepts a replacement subscription once the paid period has lapsed', async () => {
    expect(await applyEvent({
      userId: SCANNER,
      eventId: 'evt_second',
      subscriptionId: 'sub_scan_2',
      status: 'active',
      occurredAt: LIVE_START,
    })).toBe('applied');

    const row = await subscriptionRow(SCANNER);
    expect(row.billing_subscription_id).toBe('sub_scan_2');
    // The replaced subscription's rail is not carried across: it described a
    // subscription that no longer exists.
    expect(row.billing_collection_method).toBeNull();
    expect(await effectiveTier(SCANNER, LIVE_START)).toBe('pro');
  });

  /*
   * The protection the guard exists for is intact: while a subscription is
   * genuinely live, an event naming a different one is refused — including a
   * stale event for the subscription it replaced.
   */
  it('still refuses a different subscription while one is live', async () => {
    // The replacement is on the invoice rail too, and its paid period is still
    // running — so this is the guard's real case, not a status technicality.
    await db.query(
      `select * from public.apply_billing_payment_rail($1,$2,$3,$4,$5,$6)`,
      [SCANNER, 'stripe', 'live', 'sub_scan_2', 'send_invoice', true],
    );

    expect(await applyEvent({
      userId: SCANNER,
      eventId: 'evt_stale_old',
      subscriptionId: 'sub_scan',
      status: 'canceled',
      occurredAt: at(1),
    })).toBe('subscription_mismatch');

    const row = await subscriptionRow(SCANNER);
    expect(row.billing_subscription_id).toBe('sub_scan_2');
    expect(row.status).toBe('active');
  });

  /*
   * On the card rail the period is not the authority — a card is charged before
   * the period it grants, so a lapsed period there means a webhook we have not
   * seen yet, and a second subscription must still be refused.
   */
  it('judges a card subscription on its status, not its period', async () => {
    expect(await applyEvent({
      userId: CARD_HOLDER, eventId: 'evt_card', subscriptionId: 'sub_card',
      customerId: 'cus_card', status: 'active',
    })).toBe('applied');
    await db.query(
      `select * from public.apply_billing_payment_rail($1,$2,$3,$4,$5,$6)`,
      [CARD_HOLDER, 'stripe', 'live', 'sub_card', 'charge_automatically', false],
    );

    /*
     * Its stored period has already lapsed, which on the invoice rail would mean
     * "buy again" — here it means a renewal webhook we have not seen yet, and a
     * second subscription must still be refused.
     */
    await db.query(
      `update public.user_subscriptions
         set current_period_start = $2, current_period_end = $3
       where user_id = $1`,
      [CARD_HOLDER, LAPSED_START, LAPSED_END],
    );

    expect(await applyEvent({
      userId: CARD_HOLDER, eventId: 'evt_card_2', subscriptionId: 'sub_card_other',
      customerId: 'cus_card', status: 'active', occurredAt: at(1),
    })).toBe('subscription_mismatch');
  });

  /*
   * Defence in depth for the one-purchase-at-a-time rule: the checkout gate
   * refuses this first, and the trusted routine refuses it again.
   */
  it('refuses to record an invoice for an account already being billed', async () => {
    expect(await applyEvent({
      userId: RETURNER, eventId: 'evt_returner', subscriptionId: 'sub_returner',
      customerId: 'cus_returner', status: 'active',
    })).toBe('applied');

    expect(await recordPending({
      userId: RETURNER, subscriptionId: 'sub_returner_other',
    })).toBe('already_subscribed');

    const pending = await db.query('select * from public.billing_pending_payments where user_id = $1', [RETURNER]);
    expect(pending.rows).toHaveLength(0);
  });

  it('refuses a second invoice while the first is still payable', async () => {
    expect(await recordPending({ userId: TWICE, subscriptionId: 'sub_twice' })).toBe('recorded');
    expect(await recordPending({ userId: TWICE, subscriptionId: 'sub_twice_2' })).toBe('pending_exists');

    // The same invoice may be recorded again — a retried request must not be
    // mistaken for a second purchase.
    expect(await recordPending({ userId: TWICE, subscriptionId: 'sub_twice' })).toBe('recorded');
  });

  /*
   * And once it can no longer be paid it stops blocking, so an abandoned
   * attempt cannot lock a reader out of buying.
   */
  it('lets a new invoice replace one that has expired', async () => {
    await db.query(
      `update public.billing_pending_payments set due_at = $2 where user_id = $1`,
      [TWICE, at(-1)],
    );
    expect(await recordPending({ userId: TWICE, subscriptionId: 'sub_twice_3' })).toBe('recorded');
  });

  /*
   * Abandoning keeps the row and marks it, so the next attempt's idempotency key
   * differs from the one the provider would otherwise replay.
   */
  it('marks an abandoned invoice rather than deleting it', async () => {
    const canceled = await db.query<{ cancel_pending_billing_payment: boolean }>(
      'select public.cancel_pending_billing_payment($1,$2,$3)',
      [TWICE, 'live', 'sub_twice_3'],
    );
    expect(canceled.rows[0].cancel_pending_billing_payment).toBe(true);

    const pending = await db.query<Record<string, unknown>>(
      'select * from public.billing_pending_payments where user_id = $1', [TWICE],
    );
    expect(pending.rows[0].status).toBe('canceled');

    // Cancelling twice changes nothing, and cancelling somebody else's does not
    // reach it at all.
    const again = await db.query<{ cancel_pending_billing_payment: boolean }>(
      'select public.cancel_pending_billing_payment($1,$2,$3)',
      [TWICE, 'live', 'sub_twice_3'],
    );
    expect(again.rows[0].cancel_pending_billing_payment).toBe(false);
  });

  /*
   * The rail routine is descriptive only. Pointed at a subscription the account
   * does not hold, it changes nothing at all.
   */
  it('never writes a rail for a subscription the account does not hold', async () => {
    const rail = await db.query<{ rail_updated: boolean; pending_cleared: boolean }>(
      `select * from public.apply_billing_payment_rail($1,$2,$3,$4,$5,$6)`,
      [RETURNER, 'stripe', 'live', 'sub_somebody_else', 'send_invoice', true],
    );
    expect(rail.rows[0]).toEqual({ rail_updated: false, pending_cleared: false });

    const row = await subscriptionRow(RETURNER);
    expect(row.billing_collection_method).toBeNull();
    expect(row.tier).toBe('pro');
  });

  /*
   * Least privilege, asserted rather than assumed: no reader session can reach
   * any of the three routines that write billing state.
   */
  it('grants no billing routine to anon or authenticated', async () => {
    const grants = await db.query<{ routine_name: string; grantee: string }>(
      `select routine_name, grantee from information_schema.routine_privileges
       where routine_name in (
         'record_pending_billing_payment',
         'apply_billing_payment_rail',
         'cancel_pending_billing_payment',
         'apply_billing_subscription_event'
       ) and grantee in ('anon', 'authenticated', 'PUBLIC')`,
    );
    expect(grants.rows).toEqual([]);
  });
});
