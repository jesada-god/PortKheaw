import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * A granting status and the period that bounds it are one write — against a real
 * Postgres.
 *
 * The defect these tests are written from was found on five production rows:
 * `status = 'past_due'` with `current_period_end = NULL`, reported by
 * reconciliation as `missing-period-end`. The cause was two columns written
 * under two different rules — `status` flat from the event, the period only
 * carried forward when the event named the *same* subscription under the *same*
 * provider identity. A reader buying on PromptPay for the first time has no
 * stored subscription id, so the failed first invoice wrote a granting status
 * with nothing to bound it, and raised `tier` to a plan nobody had paid for.
 *
 * Every case below is that rule from a different angle:
 *
 *   * a granting status is never stored without a period behind it;
 *   * a period that *was* paid for is never dropped by an event that carries
 *     none — which is the whole point of the invoice rail's grace policy;
 *   * a period bought on one subscription cannot open a plan on another;
 *   * the card rail, which was never affected, still behaves exactly as it did.
 */

const MIGRATION_FILE = '202608240003_billing_period_status_atomicity.sql';

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
  '202608060002_account_deletion_and_trial_identity.sql',
  '202608060003_trial_retention_and_deletion_recovery.sql',
  '202608080002_admin_total_users.sql',
  '202608160003_admin_overview_trial_semantics.sql',
  '202608170001_admin_trial_history_figures.sql',
  MIGRATION_FILE,
  '202608230003_trial_guard_reads_effective_tier.sql',
];

/** The owner UUID the Phase 3.1 migration seeds as the platform administrator. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const READER = '11111111-1111-4111-8111-111111111111';

let db: PGlite;

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

interface SubscriptionRow {
  tier: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  billing_subscription_id: string | null;
  billing_collection_method: string | null;
  founder_promo_applied: boolean;
}

async function readRow(): Promise<SubscriptionRow> {
  const [row] = await query<SubscriptionRow>(
    'select * from public.user_subscriptions where user_id = $1',
    [READER],
  );
  return row;
}

/** Put the account into a starting state, as the trusted server would have. */
async function given(columns: Record<string, string>): Promise<void> {
  const assignments = Object.entries(columns)
    .map(([column, value]) => `${column} = ${value}`)
    .join(', ');
  await db.exec(`update public.user_subscriptions set ${assignments} where user_id = '${READER}'`);
}

interface EventInput {
  eventId?: string;
  eventType?: string;
  occurredAt?: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  planKey?: string | null;
  tier?: string | null;
  status?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  invoiceId?: string | null;
  paymentStatus?: string | null;
  founder?: boolean | null;
  providerMode?: string;
}

let eventSeq = 0;

/** The webhook's own call, argument for argument. */
async function applyEvent(input: EventInput): Promise<string> {
  eventSeq += 1;
  const [row] = await query<{ outcome: string }>(
    `select * from public.apply_billing_subscription_event(
       'stripe', $1::text, $2::text, $3::text, $4::timestamptz, 'digest',
       $5::uuid, $6::text, $7::text, $8::text, 'price_1', $9::text, $10::text,
       'month', $11::timestamptz, $12::timestamptz, false, $13::text, $14::text, $15::boolean
     )`,
    [
      input.providerMode ?? 'test',
      input.eventId ?? `evt_${eventSeq}`,
      input.eventType ?? 'invoice.payment_failed',
      input.occurredAt ?? new Date().toISOString(),
      READER,
      input.customerId === undefined ? 'cus_1' : input.customerId,
      input.subscriptionId === undefined ? 'sub_new' : input.subscriptionId,
      input.planKey ?? 'elite_monthly',
      input.tier ?? 'elite',
      input.status ?? 'past_due',
      input.periodStart ?? null,
      input.periodEnd ?? null,
      input.invoiceId ?? null,
      input.paymentStatus ?? null,
      input.founder ?? false,
    ],
  );
  return row.outcome;
}

/** What the audit row says about the delivery we just applied. */
async function lastAudit(): Promise<{ status: string; error_code: string | null }> {
  const [row] = await query<{ status: string; error_code: string | null }>(
    'select status, error_code from public.billing_webhook_events order by id desc limit 1',
  );
  return row;
}

const day = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();

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
      await db.exec(`
        insert into auth.users (id, email, email_confirmed_at, created_at) values
          ('${OWNER}', 'owner@example.com', now(), now() - interval '90 days'),
          ('${READER}', 'reader@example.com', now(), now() - interval '30 days');
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
});

beforeEach(async () => {
  await db.exec(`
    update public.user_subscriptions set
      tier = 'basic', status = 'basic',
      current_period_start = null, current_period_end = null,
      billing_provider = null, billing_provider_mode = null,
      billing_customer_id = null, billing_subscription_id = null,
      billing_plan_key = null, billing_collection_method = null,
      billing_price_id = null, latest_invoice_id = null,
      latest_payment_status = null, latest_payment_at = null,
      founder_promo_applied = false, cancel_at_period_end = false,
      access_revoked_at = null, access_revoked_reason = null,
      access_revoked_restore_status = null,
      provider_event_at = null, provider_event_id = null
    where user_id = '${READER}';
    delete from public.billing_webhook_events;
  `);
});

/**
 * The exact production shape. A reader who has never bought anything starts a
 * PromptPay purchase, never scans the QR, and the invoice fails. The event
 * asserts `past_due` and — because only a paid invoice may carry a period on
 * this rail — carries no period at all, while the stored row has no period to
 * fall back on and a subscription id (`NULL`) that cannot match the new one.
 */
describe('a first PromptPay purchase that was never paid', () => {
  it('stores expired with no period, and does not raise the tier', async () => {
    const outcome = await applyEvent({
      subscriptionId: 'sub_promptpay',
      status: 'past_due',
      tier: 'elite',
      periodStart: null,
      periodEnd: null,
      paymentStatus: 'failed',
    });

    expect(outcome).toBe('applied');
    const row = await readRow();
    // The bug, stated as an assertion: this must never be `past_due`+NULL again.
    expect(row.status).toBe('expired');
    expect(row.current_period_end).toBeNull();
    // An invoice nobody paid may not buy a plan.
    expect(row.tier).toBe('basic');
    // The identity is still recorded — the account is on this subscription now.
    expect(row.billing_subscription_id).toBe('sub_promptpay');
  });

  it('records the degrade on the audit row rather than hiding it', async () => {
    await applyEvent({ subscriptionId: 'sub_promptpay', status: 'past_due', periodEnd: null });
    expect(await lastAudit()).toEqual({ status: 'applied', error_code: 'period_incomplete' });
  });

  /*
   * The Founder discount is one per account. A write that granted nothing must
   * not spend it — otherwise an unpaid invoice would burn the reader's discount
   * on a plan they never received.
   */
  it('does not spend the founder slot on a write that granted nothing', async () => {
    await applyEvent({
      subscriptionId: 'sub_promptpay',
      status: 'active',
      periodEnd: null,
      founder: true,
    });
    const row = await readRow();
    expect(row.status).toBe('expired');
    expect(row.founder_promo_applied).toBe(false);
  });
});

/**
 * The grace policy, which is the reason the event carries no period in the first
 * place: a failed renewal keeps the period the reader already paid for, and
 * access ends when that period does rather than the moment the invoice failed.
 */
describe('a failed payment on a subscription with a paid period', () => {
  beforeEach(async () => {
    await given({
      tier: "'elite'",
      status: "'active'",
      billing_provider: "'stripe'",
      billing_provider_mode: "'test'",
      billing_customer_id: "'cus_1'",
      billing_subscription_id: "'sub_paid'",
      billing_collection_method: "'send_invoice'",
      current_period_start: "now() - interval '10 days'",
      current_period_end: "now() + interval '20 days'",
      provider_event_at: "now() - interval '1 day'",
    });
  });

  it('leaves the paid period standing and stores past_due against it', async () => {
    const before = await readRow();

    const outcome = await applyEvent({
      subscriptionId: 'sub_paid',
      status: 'past_due',
      periodStart: null,
      periodEnd: null,
      paymentStatus: 'failed',
    });

    expect(outcome).toBe('applied');
    const row = await readRow();
    expect(row.status).toBe('past_due');
    // PGlite hands back `Date` objects, so the comparison is by value.
    expect(row.current_period_end).toStrictEqual(before.current_period_end);
    expect(row.current_period_start).toStrictEqual(before.current_period_start);
    expect(row.tier).toBe('elite');
    expect((await lastAudit()).error_code).toBeNull();
  });

  /*
   * A paid invoice is the one event that may move the period forward, and it
   * moves both ends together — never one end from this event and the other from
   * whatever was stored.
   */
  it('advances both ends together when an invoice is actually paid', async () => {
    await applyEvent({
      subscriptionId: 'sub_paid',
      status: 'active',
      periodStart: at(20),
      periodEnd: at(50),
      paymentStatus: 'succeeded',
    });

    const row = await readRow();
    expect(row.status).toBe('active');
    expect(Date.parse(row.current_period_start!)).toBeGreaterThan(Date.now());
    expect(Date.parse(row.current_period_end!)).toBeGreaterThan(Date.parse(row.current_period_start!));
  });
});

/**
 * A period belongs to the subscription that paid for it.
 *
 * The case that makes this worth a rule: a card subscription is cancelled with
 * time left on it — `canceled` grants nothing here, by design — and the reader
 * then starts a PromptPay purchase and does not pay. Carrying the old period
 * forward *and* accepting the new subscription's `past_due` would have handed
 * out weeks of Elite that the new subscription never bought.
 */
describe('a period bought on a different subscription', () => {
  it('cannot keep a new subscription in a granting status', async () => {
    await given({
      tier: "'elite'",
      status: "'canceled'",
      billing_provider: "'stripe'",
      billing_provider_mode: "'test'",
      billing_customer_id: "'cus_1'",
      billing_subscription_id: "'sub_card'",
      billing_collection_method: "'charge_automatically'",
      current_period_start: "now() - interval '5 days'",
      current_period_end: "now() + interval '25 days'",
      provider_event_at: "now() - interval '1 day'",
    });

    await applyEvent({
      subscriptionId: 'sub_promptpay',
      status: 'past_due',
      periodStart: null,
      periodEnd: null,
      paymentStatus: 'failed',
    });

    const row = await readRow();
    expect(row.status).toBe('expired');
    expect(row.billing_subscription_id).toBe('sub_promptpay');
    // Nothing was raised on the strength of a period the new subscription never
    // paid for. `resolveEffectiveTier` reads `expired` as `basic`.
    expect(row.tier).toBe('elite');
  });
});

/**
 * The card rail was never affected by any of this — it is billed *before* the
 * period it grants, so its own events already carry the period as evidence.
 * These are the regression assertions: nothing about it may have changed.
 */
describe('the card rail', () => {
  it('opens a plan from its own event exactly as it did', async () => {
    const outcome = await applyEvent({
      eventType: 'customer.subscription.updated',
      subscriptionId: 'sub_card',
      status: 'active',
      tier: 'pro',
      periodStart: at(0),
      periodEnd: at(30),
    });

    expect(outcome).toBe('applied');
    const row = await readRow();
    expect(row.status).toBe('active');
    expect(row.tier).toBe('pro');
    expect(Date.parse(row.current_period_end!)).toBeGreaterThan(Date.now());
    expect((await lastAudit()).error_code).toBeNull();
  });

  it('still stores past_due with the period the failed renewal carried', async () => {
    await given({
      tier: "'pro'",
      status: "'active'",
      billing_provider: "'stripe'",
      billing_provider_mode: "'test'",
      billing_customer_id: "'cus_1'",
      billing_subscription_id: "'sub_card'",
      billing_collection_method: "'charge_automatically'",
      current_period_start: "now() - interval '10 days'",
      current_period_end: "now() + interval '20 days'",
      provider_event_at: "now() - interval '1 day'",
    });

    await applyEvent({
      subscriptionId: 'sub_card',
      status: 'past_due',
      tier: 'pro',
      periodStart: at(-10),
      periodEnd: at(20),
      paymentStatus: 'failed',
    });

    const row = await readRow();
    expect(row.status).toBe('past_due');
    expect(row.tier).toBe('pro');
    expect(Date.parse(row.current_period_end!)).toBeGreaterThan(Date.now());
  });
});

/**
 * The constraint, which is the belt to the routine's braces: no future path —
 * one added later, or a hand-run UPDATE during an incident — can reintroduce the
 * shape the five rows were found in.
 */
describe('the granting-status/period constraint', () => {
  it('refuses a granting status with no period, whoever writes it', async () => {
    await expect(db.exec(`
      update public.user_subscriptions
      set status = 'past_due', current_period_end = null
      where user_id = '${READER}'
    `)).rejects.toThrow(/user_subscriptions_granting_status_period_check/);

    await expect(db.exec(`
      update public.user_subscriptions
      set status = 'active', current_period_end = null
      where user_id = '${READER}'
    `)).rejects.toThrow(/user_subscriptions_granting_status_period_check/);
  });

  /*
   * The trial is bounded by `trial_ends_at`, not by a billing period, so it is
   * deliberately outside the constraint — and so are the ended states.
   */
  it('leaves the trial and the ended states alone', async () => {
    await given({
      status: "'trialing'",
      trial_started_at: "now() - interval '1 day'",
      trial_ends_at: "now() + interval '6 days'",
    });
    expect((await readRow()).status).toBe('trialing');

    for (const status of ['basic', 'canceled', 'expired']) {
      await given({ status: `'${status}'`, current_period_end: 'null' });
      expect((await readRow()).status).toBe(status);
    }
  });

  /*
   * Added NOT VALID because five production rows already violate it. It has to
   * be enforcing new writes from the moment it ships, while leaving those five
   * for the backfill — `202608240001` validates it afterwards.
   */
  it('is installed NOT VALID so it can ship before the backfill', async () => {
    const [row] = await query<{ convalidated: boolean }>(`
      select convalidated from pg_constraint
      where conrelid = 'public.user_subscriptions'::regclass
        and conname = 'user_subscriptions_granting_status_period_check'
    `);
    expect(row.convalidated).toBe(false);
  });
});

/**
 * The last decision in the schema that read the stored `tier` column.
 *
 * `PAID_SUBSCRIPTION_ACTIVE` restated the period rule inline beside a
 * `subscription.tier in ('pro','elite')` test. It was bounded correctly, so it
 * was never a hole — but it was the effective-tier rule written a second time,
 * and it now asks `resolve_effective_subscription_tier` instead. These assert
 * that routing it through the resolver changed no answer.
 */
describe('the trial guard reads the effective tier', () => {
  // The ledger stores a sha256 digest and the table's check constraint says so.
  const identities = JSON.stringify([{ type: 'email', hash: 'a'.repeat(64), version: 1 }]);

  async function startTrial(): Promise<string> {
    try {
      await query(
        'select * from public.start_elite_trial_with_identity($1::uuid, $2::jsonb)',
        [READER, identities],
      );
      return 'granted';
    } catch (error) {
      return (error as Error).message;
    }
  }

  beforeEach(async () => {
    await db.exec(`
      delete from public.trial_identity_claims;
      update auth.users set email_confirmed_at = now() where id = '${READER}';
    `);
  });

  it('refuses an account whose paid period is running', async () => {
    await given({
      tier: "'elite'",
      status: "'active'",
      billing_provider: "'stripe'",
      billing_provider_mode: "'live'",
      current_period_start: "now() - interval '5 days'",
      current_period_end: "now() + interval '25 days'",
    });
    expect(await startTrial()).toContain('PAID_SUBSCRIPTION_ACTIVE');
  });

  /*
   * The shape the five rows were found in — a raised `tier` with no period
   * behind it. It never opened a plan, and it must not close the trial either.
   */
  it('does not let a tier with no period behind it refuse the trial', async () => {
    await given({
      tier: "'elite'",
      status: "'expired'",
      billing_provider: "'stripe'",
      billing_provider_mode: "'live'",
      current_period_end: 'null',
    });
    expect(await startTrial()).toBe('granted');
  });

  /*
   * The resolver answers `elite` for a running trial too, so `status = 'active'`
   * stays in front of it — a trialist has to hear the sentence about their trial.
   */
  it('still tells a trialist about their trial rather than about a purchase', async () => {
    await given({
      tier: "'elite'",
      status: "'trialing'",
      trial_started_at: "now() - interval '1 day'",
      trial_ends_at: "now() + interval '6 days'",
    });
    expect(await startTrial()).toContain('TRIAL_ALREADY_ACTIVE');
  });
});
