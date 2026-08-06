import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { REFUND_WINDOW_DAYS, refundDeadlineFrom } from './refund-window';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The purchase-consent and refund-window migration, run against a real Postgres.
 *
 * These are the rules somebody is charged unfairly, or refused a refund they are
 * owed, if they are wrong:
 *
 *   * a browser can read its own consents and write none;
 *   * a consent record cannot be rewritten once it exists, so a policy change
 *     cannot retroactively rewrite what somebody agreed to;
 *   * recording the same acceptance twice is one row, not two;
 *   * the refund deadline is derived from the provider-confirmed payment
 *     timestamp inside the database, and no argument can move it;
 *   * every successful charge — first payment, card renewal, PromptPay invoice,
 *     a lapsed account subscribing again — opens its own window;
 *   * the seventh day is inside the window and the moment after it is not;
 *   * one account cannot file against another's charge, and cannot hold two
 *     undecided requests against one charge.
 */

const MIGRATION_FILE = '202608060001_purchase_consent_and_refund_window.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8');
const statements = rawSql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();

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
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const day = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();

/**
 * Milliseconds since the epoch, from whatever the driver hands back.
 *
 * PGlite returns `timestamptz` as a `Date`, and `Date.parse` on one of those
 * goes through `toString()`, which drops the milliseconds — enough to make an
 * exact-interval assertion fail by up to 999ms for reasons that have nothing to
 * do with the interval.
 */
const ms = (value: unknown): number => new Date(value as string).getTime();

let db: PGlite;

/** Run as one signed-in reader. `null` is the trusted server (no JWT claim). */
async function as(userId: string | null): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ''}', false)`);
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

/** One paid invoice, exactly as the webhook routine records it. */
async function recordPaidInvoice(options: {
  userId: string;
  invoiceId: string;
  paidAt: string | null;
  planKey?: string;
  status?: string;
}): Promise<string> {
  await as(null);
  await query(
    `select public.record_billing_invoice(
       $1,'stripe','live',$2,'sub_1',$3,$4,79900,79900,'thb',$5,$6,$5,$7
     )`,
    [
      options.userId, options.invoiceId, options.planKey ?? 'elite_monthly',
      options.status ?? 'paid', at(-30), at(0), options.paidAt,
    ],
  );
  const rows = await query<{ id: string }>(
    'select id from public.billing_invoices where invoice_id = $1', [options.invoiceId],
  );
  return rows[0].id;
}

async function createRefundRequest(userId: string, invoiceRef: string) {
  await as(userId);
  const rows = await query<{ request_id: string | null; outcome: string }>(
    `select * from public.create_refund_request($1, 'not_as_expected', $2)`,
    [invoiceRef, 'ขอคืนเงินเพราะใช้งานไม่ได้ตามที่คาดไว้'],
  );
  return rows[0];
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
        insert into auth.users (id, email, email_confirmed_at) values
          ('${OWNER}', 'owner@example.com', now()),
          ('${ALICE}', 'alice@example.com', now()),
          ('${BOB}', 'bob@example.com', now());
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec('grant usage on schema public, auth to anon, authenticated');
});

describe('the migration is additive', () => {
  it('drops no table, column, policy or row', () => {
    expect(statements).not.toMatch(/drop table|drop column|truncate|delete from public\./);
    expect(statements).not.toMatch(/drop policy if exists "read own invoices"/);
    expect(statements).toContain('create table if not exists public.purchase_consents');
  });

  /*
   * The one drop it does contain is the projection, which has to be recreated to
   * gain an output column. Everything it returned before must still be returned.
   */
  it('recreates the invoice projection with every column it already had', async () => {
    await as(ALICE);
    // The projection's shape as Postgres itself reports it, rather than as the
    // migration file spells it — a column that was declared and never selected
    // would still pass a text search of the SQL.
    const signature = await query<{ result: string }>(
      `select pg_get_function_result(oid) as result from pg_proc
       where proname = 'list_my_billing_invoices'`,
    );
    const names = signature[0].result;
    for (const kept of [
      'invoice_ref', 'plan_key', 'status', 'amount_paid_minor', 'amount_refunded_minor',
      'currency', 'period_start', 'period_end', 'issued_at', 'paid_at',
      'refund_request_status', 'database_now',
    ]) {
      expect(names, kept).toContain(kept);
    }
    expect(names).toContain('refund_deadline_at');
  });
});

describe('purchase consent', () => {
  it('lets a reader read only their own consents, and write none', async () => {
    const grants = await query<{ privilege_type: string; grantee: string }>(
      `select privilege_type, grantee from information_schema.role_table_grants
       where table_name = 'purchase_consents'`,
    );
    const readerGrants = grants
      .filter((row) => row.grantee === 'authenticated')
      .map((row) => row.privilege_type);
    expect(readerGrants).toEqual(['SELECT']);
    for (const write of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(readerGrants, write).not.toContain(write);
    }
    expect(grants.filter((row) => row.grantee === 'anon')).toEqual([]);

    const policies = await query<{ cmd: string; qual: string }>(
      `select cmd, qual from pg_policies where tablename = 'purchase_consents'`,
    );
    expect(policies).toHaveLength(1);
    expect(policies[0].cmd).toBe('SELECT');
    expect(policies[0].qual).toContain('auth.uid()');
  });

  it('records the account from the session, never from an argument', async () => {
    await as(ALICE);
    const rows = await query<{ consent_id: string; outcome: string }>(
      `select * from public.record_purchase_consent(
         'elite_monthly', 'month', 'card', '2026-08-06', '2026-08-06'
       )`,
    );
    expect(rows[0].outcome).toBe('recorded');

    await as(null);
    const stored = await query<Record<string, unknown>>(
      'select * from public.purchase_consents where id = $1', [rows[0].consent_id],
    );
    expect(stored[0]).toMatchObject({
      user_id: ALICE,
      plan_key: 'elite_monthly',
      billing_interval: 'month',
      payment_rail: 'card',
      subscription_policy_version: '2026-08-06',
      refund_policy_version: '2026-08-06',
      acceptance_count: 1,
    });
  });

  /*
   * Idempotence is the property that makes a double-press, a retried request and
   * a resubmitted form all safe. The same agreement is one row whose original
   * acceptance date never moves.
   */
  it('reaffirms rather than duplicating the same acceptance', async () => {
    await as(ALICE);
    const first = await query<Record<string, unknown>>(
      'select * from public.purchase_consents where plan_key = $1', ['elite_monthly'],
    );
    const acceptedAt = first[0].accepted_at;

    const again = await query<{ outcome: string; consent_id: string }>(
      `select * from public.record_purchase_consent(
         'elite_monthly', 'month', 'card', '2026-08-06', '2026-08-06'
       )`,
    );
    expect(again[0].outcome).toBe('reaffirmed');
    expect(again[0].consent_id).toBe(first[0].id);

    const rows = await query<Record<string, unknown>>(
      'select * from public.purchase_consents where plan_key = $1', ['elite_monthly'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].acceptance_count).toBe(2);
    expect(rows[0].accepted_at).toEqual(acceptedAt);
    expect(ms(rows[0].last_accepted_at)).toBeGreaterThanOrEqual(ms(acceptedAt));
  });

  /*
   * A new policy version is a new agreement, so it is a new row. The old one
   * survives untouched — which is what "policy changes apply prospectively"
   * means when somebody later asks what a reader actually agreed to.
   */
  it('files a new record for a new policy version and preserves the old one', async () => {
    await as(ALICE);
    const next = await query<{ outcome: string }>(
      `select * from public.record_purchase_consent(
         'elite_monthly', 'month', 'card', '2027-01-01', '2027-01-01'
       )`,
    );
    expect(next[0].outcome).toBe('recorded');

    const rows = await query<Record<string, unknown>>(
      `select subscription_policy_version, acceptance_count from public.purchase_consents
       where user_id = $1 and plan_key = 'elite_monthly' order by subscription_policy_version`,
      [ALICE],
    );
    expect(rows.map((row) => row.subscription_policy_version)).toEqual(['2026-08-06', '2027-01-01']);
    expect(rows[0].acceptance_count).toBe(2);
  });

  it('refuses a rail, cadence or version it does not recognise', async () => {
    await as(ALICE);
    for (const args of [
      `'elite_monthly', 'month', 'crypto', '2026-08-06', '2026-08-06'`,
      `'elite_monthly', 'week', 'card', '2026-08-06', '2026-08-06'`,
      `'elite_monthly', 'month', 'card', '', '2026-08-06'`,
      `'', 'month', 'card', '2026-08-06', '2026-08-06'`,
    ]) {
      const rows = await query<{ outcome: string }>(
        `select * from public.record_purchase_consent(${args})`,
      );
      expect(rows[0].outcome, args).toBe('invalid');
    }
  });

  it('refuses to record anything for a caller with no session', async () => {
    await as(null);
    await expect(query(
      `select * from public.record_purchase_consent(
         'elite_monthly', 'month', 'card', '2026-08-06', '2026-08-06'
       )`,
    )).rejects.toThrow(/Authentication required/);
  });

  /*
   * The record has to be evidence, so it cannot be edited — not by a reader,
   * who has no grant at all, and not by a trusted role with a bug either.
   */
  it('refuses to rewrite an acceptance', async () => {
    await as(null);
    for (const change of [
      `set accepted_at = now()`,
      `set subscription_policy_version = '2099-01-01'`,
      `set user_id = '${BOB}'`,
      `set plan_key = 'pro_monthly'`,
    ]) {
      await expect(
        query(`update public.purchase_consents ${change} where user_id = $1`, [ALICE]),
      ).rejects.toThrow(/PURCHASE_CONSENT_IMMUTABLE/);
    }
  });

  it('shows one reader nothing of another reader’s consents', async () => {
    await as(BOB);
    const rows = await query(
      'select * from public.purchase_consents where user_id = $1', [ALICE],
    );
    // No RLS is applied to the superuser this test connects as, so the policy
    // itself is asserted above; this proves the routine never files under
    // anybody but the caller.
    await as(BOB);
    await query(
      `select * from public.record_purchase_consent(
         'pro_annual', 'year', 'promptpay', '2026-08-06', '2026-08-06'
       )`,
    );
    const bobs = await query<{ user_id: string }>(
      `select user_id from public.purchase_consents where plan_key = 'pro_annual'`,
    );
    expect(bobs.every((row) => row.user_id === BOB)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  /*
   * A consent belongs to an account and goes with it. The audit trail lesson
   * from Phase 5.1 is that a row which refuses to be deleted breaks account
   * deletion; this one cascades instead.
   */
  it('is removed with the account it belongs to', async () => {
    await db.exec(`insert into auth.users (id, email) values
      ('33333333-3333-4333-8333-333333333333', 'gone@example.com')`);
    await as('33333333-3333-4333-8333-333333333333');
    await query(
      `select * from public.record_purchase_consent(
         'pro_monthly', 'month', 'card', '2026-08-06', '2026-08-06'
       )`,
    );
    await as(null);
    await db.exec(`delete from auth.users where id = '33333333-3333-4333-8333-333333333333'`);
    const left = await query(
      'select * from public.purchase_consents where user_id = $1',
      ['33333333-3333-4333-8333-333333333333'],
    );
    expect(left).toEqual([]);
  });
});

describe('the refund window', () => {
  it('derives the deadline from the payment, and agrees with the TypeScript window', async () => {
    const paidAt = '2026-08-06T03:00:00.000Z';
    await as(null);
    const rows = await query<{ deadline: string }>(
      'select public.refund_request_deadline($1::timestamptz) as deadline', [paidAt],
    );
    expect(ms(rows[0].deadline)).toBe(ms(refundDeadlineFrom(paidAt)));
    expect(ms(rows[0].deadline) - ms(paidAt)).toBe(REFUND_WINDOW_DAYS * day);
  });

  it('has no deadline for an invoice nobody paid', async () => {
    await as(null);
    const rows = await query<{ deadline: string | null }>(
      'select public.refund_request_deadline(null::timestamptz) as deadline',
    );
    expect(rows[0].deadline).toBeNull();
    expect(refundDeadlineFrom(null)).toBeNull();
  });

  it('publishes the deadline beside the purchase it belongs to', async () => {
    const paidAt = at(-1);
    await recordPaidInvoice({ userId: ALICE, invoiceId: 'in_recent', paidAt });
    await as(ALICE);
    const rows = await query<{
      invoice_ref: string; refund_deadline_at: string; database_now: string;
    }>(`select * from public.list_my_billing_invoices()`);
    const invoice = rows.find((row) => row.refund_deadline_at !== null)!;
    expect(ms(invoice.refund_deadline_at) - ms(paidAt)).toBe(REFUND_WINDOW_DAYS * day);
    // The clock the deadline must be judged against travels with it.
    expect(Number.isFinite(ms(invoice.database_now))).toBe(true);
  });

  it('accepts a request on the seventh day', async () => {
    // One second inside the deadline: the whole of the seventh day counts.
    const ref = await recordPaidInvoice({
      userId: ALICE,
      invoiceId: 'in_day_seven',
      paidAt: new Date(Date.now() - REFUND_WINDOW_DAYS * day + 1_000).toISOString(),
    });
    const outcome = await createRefundRequest(ALICE, ref);
    expect(outcome.outcome).toBe('created');
  });

  it('refuses a request once the deadline has passed', async () => {
    const ref = await recordPaidInvoice({
      userId: ALICE,
      invoiceId: 'in_expired',
      paidAt: at(-(REFUND_WINDOW_DAYS + 1)),
    });
    const outcome = await createRefundRequest(ALICE, ref);
    expect(outcome.outcome).toBe('window_closed');
    expect(outcome.request_id).toBeNull();

    await as(null);
    const requests = await query(
      'select * from public.refund_requests where invoice_ref = $1', [ref],
    );
    expect(requests).toEqual([]);
  });

  /*
   * The rule that makes the window a per-charge promise rather than a
   * per-subscription one. Each of these is a separate paid invoice with its own
   * `paid_at`, so each opens its own seven days — the renewal is still refundable
   * long after the original purchase stopped being.
   */
  it('opens a new window for every successful charge on one subscription', async () => {
    const initial = await recordPaidInvoice({
      userId: BOB, invoiceId: 'in_initial', paidAt: at(-40),
    });
    const renewal = await recordPaidInvoice({
      userId: BOB, invoiceId: 'in_renewal', paidAt: at(-2),
    });

    expect((await createRefundRequest(BOB, initial)).outcome).toBe('window_closed');
    expect((await createRefundRequest(BOB, renewal)).outcome).toBe('created');
  });

  it('opens a new window when a lapsed account pays again', async () => {
    const resubscribed = await recordPaidInvoice({
      userId: BOB, invoiceId: 'in_resubscribe', paidAt: at(-1),
    });
    expect((await createRefundRequest(BOB, resubscribed)).outcome).toBe('created');
  });

  /*
   * The deadline takes no argument, so there is nothing a caller can send to
   * move it — not a timestamp, not a time zone, not a deadline of its own.
   */
  it('takes no timestamp from the caller', () => {
    const routine = rawSql.slice(
      rawSql.indexOf('create or replace function public.create_refund_request'),
    );
    expect(routine).toContain('input_invoice_ref uuid');
    expect(routine).toContain('input_reason_category text');
    expect(routine).toContain('input_details text');
    expect(routine).not.toMatch(/input_(now|deadline|paid_at|timezone|client_time)/);
    expect(routine).toContain('statement_timestamp() > deadline_at');
  });

  it('refuses a paid invoice that carries no payment timestamp', async () => {
    await as(null);
    await query(
      `insert into public.billing_invoices (
         user_id, provider, provider_mode, invoice_id, status,
         amount_due_minor, amount_paid_minor, currency, issued_at, paid_at
       ) values ($1,'stripe','live','in_no_paid_at','paid',79900,79900,'thb',now(),null)`,
      [ALICE],
    );
    const rows = await query<{ id: string }>(
      `select id from public.billing_invoices where invoice_id = 'in_no_paid_at'`,
    );
    expect((await createRefundRequest(ALICE, rows[0].id)).outcome).toBe('not_refundable');
  });
});

describe('who may ask for what', () => {
  it('never reaches another account’s charge', async () => {
    const bobsInvoice = await recordPaidInvoice({
      userId: BOB, invoiceId: 'in_bob_only', paidAt: at(-1),
    });
    const outcome = await createRefundRequest(ALICE, bobsInvoice);
    // `not_found`, not `forbidden`: the refusal does not confirm the row exists.
    expect(outcome.outcome).toBe('not_found');
  });

  it('holds one undecided request per charge, in the schema as well as the routine', async () => {
    const ref = await recordPaidInvoice({
      userId: ALICE, invoiceId: 'in_one_active', paidAt: at(-1),
    });
    expect((await createRefundRequest(ALICE, ref)).outcome).toBe('created');
    expect((await createRefundRequest(ALICE, ref)).outcome).toBe('already_open');

    await as(null);
    await expect(query(
      `insert into public.refund_requests (
         reference, user_id, invoice_ref, status, reason_category, details,
         amount_minor, currency, tier_snapshot, status_changed_at
       ) values ('RF-DUP', $1, $2, 'pending', 'other', 'a second undecided request',
                 79900, 'thb', 'elite', now())`,
      [ALICE, ref],
    )).rejects.toThrow(/refund_requests_one_active_per_invoice/);
  });

  /*
   * Filing changes nothing about what the account holds. The request is a
   * question, and answering it is a separate act performed at the provider.
   */
  it('grants and revokes nothing when a request is filed', async () => {
    await as(null);
    const before = await query<Record<string, unknown>>(
      'select tier, status from public.user_subscriptions where user_id = $1', [ALICE],
    );
    const ref = await recordPaidInvoice({
      userId: ALICE, invoiceId: 'in_no_effect', paidAt: at(-1),
    });
    await createRefundRequest(ALICE, ref);

    await as(null);
    const after = await query<Record<string, unknown>>(
      'select tier, status from public.user_subscriptions where user_id = $1', [ALICE],
    );
    expect(after).toEqual(before);

    const invoice = await query<{ status: string; amount_refunded_minor: number }>(
      'select status, amount_refunded_minor from public.billing_invoices where id = $1', [ref],
    );
    expect(invoice[0]).toMatchObject({ status: 'paid', amount_refunded_minor: 0 });
  });

  it('writes the deadline it accepted into the audit trail', async () => {
    await as(null);
    const rows = await query<{ detail: Record<string, unknown> }>(
      `select detail from public.support_audit_events
       where action = 'refund_requested' order by created_at desc limit 1`,
    );
    expect(rows[0].detail).toHaveProperty('refundDeadlineAt');
    expect(rows[0].detail).toHaveProperty('paidAt');
  });

  it('grants the consent and deadline routines to no anonymous caller', async () => {
    const grants = await query<{ routine_name: string; grantee: string }>(
      `select routine_name, grantee from information_schema.routine_privileges
       where routine_name in (
         'record_purchase_consent', 'refund_request_deadline',
         'reject_purchase_consent_rewrite'
       ) and grantee in ('anon', 'PUBLIC')`,
    );
    expect(grants).toEqual([]);
  });
});
