import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * The Phase 5 migration, run against a real Postgres.
 *
 * These are the rules somebody loses money or privacy over if they are wrong:
 *
 *   * a full refund ends paid access, and a later "you're active" event from the
 *     provider cannot hand it back — only money can;
 *   * a partial refund changes nothing about access;
 *   * a dispute suspends and a won dispute restores;
 *   * one account cannot see another's ticket, refund request, invoice or
 *     attachment, and no reader can see an operator's internal note;
 *   * a client cannot write its own ticket status, tier snapshot or audit row;
 *   * `refunded` cannot be claimed without evidence;
 *   * the audit log cannot be edited or deleted, by anyone.
 */

const MIGRATION_FILE = '202608050003_operations_support_and_trust.sql';

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
  MIGRATION_FILE,
  '202608050004_audit_allows_parent_cascade.sql',
  '202608050005_admin_thread_audit.sql',
  '202608050006_admin_search_email_cast.sql',
];

/** The owner UUID the Phase 3.1 migration seeds; its account must exist first. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const day = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();

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
      -- varchar(255), exactly as Supabase declares it. A set-returning function
      -- that declares this column as text fails at run time with 42804, and
      -- declaring it text here would hide that.
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

  // Two ordinary readers, both on a live paid period bought with a card.
  for (const user of [ALICE, BOB]) {
    await db.exec(`
      -- \`handle_new_user()\` already created the profile with a null name, so
      -- this has to update rather than skip on conflict — otherwise the name
      -- stays null and the operator's name search has nothing to find.
      insert into public.profiles (id, full_name) values ('${user}', 'Reader')
        on conflict (id) do update set full_name = excluded.full_name;
      insert into public.user_settings (user_id) values ('${user}')
        on conflict (user_id) do nothing;
      insert into public.user_roles (user_id) values ('${user}')
        on conflict (user_id) do nothing;
      insert into public.user_subscriptions (user_id) values ('${user}')
        on conflict (user_id) do nothing;
      update public.user_subscriptions set
        tier = 'elite', status = 'active',
        billing_provider = 'stripe', billing_provider_mode = 'test',
        billing_plan_key = 'elite_annual', billing_interval = 'year',
        billing_customer_id = 'cus_${user.slice(0, 8)}',
        billing_subscription_id = 'sub_${user.slice(0, 8)}',
        billing_collection_method = 'charge_automatically',
        current_period_start = '${at(-1)}', current_period_end = '${at(364)}',
        latest_payment_status = 'succeeded'
      where user_id = '${user}';
    `);
  }
});

/** One webhook delivery, in the vocabulary the route hands the database. */
async function applySubscriptionEvent(options: {
  userId: string;
  eventId: string;
  subscriptionId: string;
  customerId: string;
  status: string;
  paymentStatus?: string | null;
  periodEnd?: string | null;
  occurredAt?: string;
}): Promise<string> {
  const rows = await query<{ outcome: string }>(
    `select outcome from public.apply_billing_subscription_event(
       'stripe', 'test', $1, 'customer.subscription.updated', $2, 'digest',
       $3, $4, $5, 'elite_annual', 'price_1', 'elite', $6, 'year',
       null, $7, false, null, $8, false)`,
    [
      options.eventId,
      options.occurredAt ?? at(0),
      options.userId,
      options.customerId,
      options.subscriptionId,
      options.status,
      options.periodEnd ?? null,
      options.paymentStatus ?? null,
    ],
  );
  return rows[0]?.outcome ?? 'none';
}

async function applyRefundEvent(options: {
  eventId: string;
  userId: string | null;
  subscriptionId: string | null;
  invoiceId: string | null;
  kind: 'refund' | 'dispute_opened' | 'dispute_closed';
  action: 'revoke' | 'suspend' | 'restore' | 'record_only';
  amountMinor: number;
  chargeAmountMinor: number | null;
  isFull: boolean;
  disputeOutcome?: string | null;
}) {
  const rows = await query<{ outcome: string; entitlement_changed: boolean }>(
    `select outcome, entitlement_changed from public.apply_billing_refund_event(
       'stripe','test',$1,'charge.refunded',$2,$3, now(), $4, $5, $6, 'ch_1', $7, $8, 'thb', $9, $10)`,
    [
      options.eventId,
      options.kind,
      options.action,
      options.userId,
      options.subscriptionId,
      options.invoiceId,
      options.amountMinor,
      options.chargeAmountMinor,
      options.isFull,
      options.disputeOutcome ?? null,
    ],
  );
  return rows[0];
}

async function subscriptionOf(userId: string) {
  const rows = await query<{
    status: string;
    tier: string;
    access_revoked_at: string | null;
    access_revoked_reason: string | null;
    current_period_end: string | null;
  }>(
    `select status, tier, access_revoked_at, access_revoked_reason, current_period_end
     from public.user_subscriptions where user_id = $1`,
    [userId],
  );
  return rows[0];
}

async function recordInvoice(userId: string, invoiceId: string, amountMinor = 799_000) {
  await query(
    `select public.record_billing_invoice(
       $1,'stripe','test',$2,$3,'elite_annual','paid',$4,$4,'thb',$5,$6,$5,$5)`,
    [userId, invoiceId, `sub_${userId.slice(0, 8)}`, amountMinor, at(-1), at(364)],
  );
  const rows = await query<{ id: string }>(
    'select id from public.billing_invoices where invoice_id = $1',
    [invoiceId],
  );
  return rows[0].id;
}

describe('refund and dispute entitlement policy', () => {
  it('ends paid access on a provider-confirmed full refund, and preserves the evidence', async () => {
    await as(null);
    await recordInvoice(ALICE, 'in_full_refund');

    const before = await subscriptionOf(ALICE);
    expect(before.status).toBe('active');

    const result = await applyRefundEvent({
      eventId: 'evt_full_refund',
      userId: ALICE,
      subscriptionId: `sub_${ALICE.slice(0, 8)}`,
      invoiceId: 'in_full_refund',
      kind: 'refund',
      action: 'revoke',
      amountMinor: 799_000,
      chargeAmountMinor: 799_000,
      isFull: true,
    });

    expect(result.outcome).toBe('revoked');
    expect(result.entitlement_changed).toBe(true);

    const after = await subscriptionOf(ALICE);
    expect(after.status).toBe('expired');
    expect(after.access_revoked_reason).toBe('refund');
    // The billing evidence is untouched: the period that was bought still says
    // what was bought, which is what an operator and an auditor both need.
    expect(String(after.current_period_end)).toBe(String(before.current_period_end));
    expect(after.tier).toBe('elite');

    const effective = await query<{ tier: string }>(
      'select public.resolve_effective_subscription_tier($1, now()) as tier',
      [ALICE],
    );
    expect(effective[0].tier).toBe('basic');
  });

  it('refuses to hand access back on a later subscription event with no money behind it', async () => {
    await as(null);
    const outcome = await applySubscriptionEvent({
      userId: ALICE,
      eventId: 'evt_after_refund',
      subscriptionId: `sub_${ALICE.slice(0, 8)}`,
      customerId: `cus_${ALICE.slice(0, 8)}`,
      status: 'active',
      periodEnd: at(364),
    });

    expect(outcome).toBe('revoked_hold');
    expect((await subscriptionOf(ALICE)).status).toBe('expired');
  });

  it('lifts the revocation when a new payment covers a period beyond it', async () => {
    await as(null);
    const outcome = await applySubscriptionEvent({
      userId: ALICE,
      eventId: 'evt_paid_again',
      subscriptionId: `sub_${ALICE.slice(0, 8)}`,
      customerId: `cus_${ALICE.slice(0, 8)}`,
      status: 'active',
      paymentStatus: 'succeeded',
      periodEnd: at(400),
      occurredAt: at(1),
    });

    expect(outcome).toBe('applied');
    const after = await subscriptionOf(ALICE);
    expect(after.status).toBe('active');
    expect(after.access_revoked_at).toBeNull();
  });

  it('records a partial refund without touching access', async () => {
    await as(null);
    await recordInvoice(BOB, 'in_partial');

    const result = await applyRefundEvent({
      eventId: 'evt_partial',
      userId: BOB,
      subscriptionId: `sub_${BOB.slice(0, 8)}`,
      invoiceId: 'in_partial',
      kind: 'refund',
      action: 'record_only',
      amountMinor: 20_000,
      chargeAmountMinor: 799_000,
      isFull: false,
    });

    expect(result.entitlement_changed).toBe(false);
    const after = await subscriptionOf(BOB);
    expect(after.status).toBe('active');
    expect(after.access_revoked_at).toBeNull();

    const invoice = await query<{ status: string; amount_refunded_minor: number }>(
      'select status, amount_refunded_minor from public.billing_invoices where invoice_id = $1',
      ['in_partial'],
    );
    expect(invoice[0].status).toBe('partially_refunded');
    expect(Number(invoice[0].amount_refunded_minor)).toBe(20_000);
  });

  it('suspends on a dispute and restores it when the dispute is won', async () => {
    await as(null);
    const suspended = await applyRefundEvent({
      eventId: 'evt_dispute_open',
      userId: BOB,
      subscriptionId: `sub_${BOB.slice(0, 8)}`,
      invoiceId: 'in_partial',
      kind: 'dispute_opened',
      action: 'suspend',
      amountMinor: 799_000,
      chargeAmountMinor: 799_000,
      isFull: false,
    });
    expect(suspended.outcome).toBe('suspended');
    expect((await subscriptionOf(BOB)).status).toBe('expired');

    const restored = await applyRefundEvent({
      eventId: 'evt_dispute_won',
      userId: BOB,
      subscriptionId: `sub_${BOB.slice(0, 8)}`,
      invoiceId: 'in_partial',
      kind: 'dispute_closed',
      action: 'restore',
      amountMinor: 799_000,
      chargeAmountMinor: 799_000,
      isFull: false,
      disputeOutcome: 'won',
    });
    expect(restored.outcome).toBe('restored');

    const after = await subscriptionOf(BOB);
    expect(after.status).toBe('active');
    expect(after.access_revoked_at).toBeNull();
  });

  it('is idempotent on the provider event id', async () => {
    await as(null);
    const repeat = await applyRefundEvent({
      eventId: 'evt_dispute_open',
      userId: BOB,
      subscriptionId: `sub_${BOB.slice(0, 8)}`,
      invoiceId: 'in_partial',
      kind: 'dispute_opened',
      action: 'suspend',
      amountMinor: 799_000,
      chargeAmountMinor: 799_000,
      isFull: false,
    });
    expect(repeat.outcome).toBe('duplicate');
    // The redelivery did not re-suspend the account the won dispute restored.
    expect((await subscriptionOf(BOB)).status).toBe('active');
  });
});

describe('bounded retry and dead letter', () => {
  it('counts attempts and dead-letters at the bound', async () => {
    await as(null);
    const first = await query<{ attempt_count: number; status: string; newly_dead_lettered: boolean }>(
      `select * from public.record_billing_webhook_attempt(
         'stripe','test','evt_retry','invoice.paid',null,'apply_failed',60,3)`,
    );
    expect(first[0].attempt_count).toBe(1);
    expect(first[0].status).toBe('retrying');

    await query(`select * from public.record_billing_webhook_attempt(
      'stripe','test','evt_retry','invoice.paid',null,'apply_failed',120,3)`);
    const third = await query<{ status: string; newly_dead_lettered: boolean }>(
      `select * from public.record_billing_webhook_attempt(
         'stripe','test','evt_retry','invoice.paid',null,'apply_failed',240,3)`,
    );
    expect(third[0].status).toBe('dead_letter');
    expect(third[0].newly_dead_lettered).toBe(true);

    // The alert is claimed exactly once, however many redeliveries follow.
    const claimed = await query<{ mark_billing_webhook_alerted: boolean }>(
      `select public.mark_billing_webhook_alerted('stripe','test','evt_retry')`,
    );
    expect(claimed[0].mark_billing_webhook_alerted).toBe(true);
    const again = await query<{ mark_billing_webhook_alerted: boolean }>(
      `select public.mark_billing_webhook_alerted('stripe','test','evt_retry')`,
    );
    expect(again[0].mark_billing_webhook_alerted).toBe(false);
  });
});

describe('reconciliation reports and dedupes', () => {
  it('runs once per day per mode and re-stamps rather than duplicating', async () => {
    await as(null);
    const started = await query<{ run_id: string; outcome: string }>(
      `select * from public.start_billing_reconciliation_run(current_date, 'test')`,
    );
    expect(started[0].outcome).toBe('started');
    const runId = started[0].run_id;

    const second = await query<{ outcome: string }>(
      `select * from public.start_billing_reconciliation_run(current_date, 'test')`,
    );
    expect(second[0].outcome).toBe('already_ran');

    const first = await query<{ record_billing_reconciliation_issue: string }>(
      `select public.record_billing_reconciliation_issue($1,'k-dup','dead_letter_event','critical',null,'test','{}'::jsonb)`,
      [runId],
    );
    expect(first[0].record_billing_reconciliation_issue).toBe('recorded');

    const repeat = await query<{ record_billing_reconciliation_issue: string }>(
      `select public.record_billing_reconciliation_issue($1,'k-dup','dead_letter_event','critical',null,'test','{}'::jsonb)`,
      [runId],
    );
    expect(repeat[0].record_billing_reconciliation_issue).toBe('updated');

    const rows = await query<{ occurrences: number }>(
      `select occurrences from public.billing_reconciliation_issues where dedupe_key = 'k-dup'`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].occurrences)).toBe(2);
  });
});

describe('support tickets', () => {
  let aliceTicket: string;

  it('writes the account, tier and status itself', async () => {
    await as(ALICE);
    const created = await query<{ ticket_id: string; reference: string; outcome: string }>(
      `select * from public.create_support_ticket('billing','เรื่องทดสอบ','รายละเอียดของปัญหาที่พบเจอ')`,
    );
    expect(created[0].outcome).toBe('created');
    aliceTicket = created[0].ticket_id;

    const rows = await query<{ user_id: string; status: string; tier_snapshot: string }>(
      'select user_id, status, tier_snapshot from public.support_tickets where id = $1',
      [aliceTicket],
    );
    expect(rows[0].user_id).toBe(ALICE);
    expect(rows[0].status).toBe('open');
    // Alice's paid period is live again after the re-payment above.
    expect(rows[0].tier_snapshot).toBe('elite');
  });

  it('gives a client no way to write a ticket, a status or an audit row', async () => {
    await db.exec('set role authenticated');
    await expect(db.exec(
      `insert into public.support_tickets (reference, user_id, category, subject, description)
       values ('TK-FORGED', '${ALICE}', 'billing', 'forged', 'forged description here')`,
    )).rejects.toThrow(/permission denied/i);
    await expect(db.exec(
      `update public.support_tickets set status = 'closed'`,
    )).rejects.toThrow(/permission denied/i);
    await expect(db.exec(
      `insert into public.support_audit_events (ticket_id, actor_role, action) values (null, 'admin', 'forged')`,
    )).rejects.toThrow(/permission denied/i);
    await db.exec('reset role');
  });

  it('shows one reader nothing of another reader’s ticket', async () => {
    await db.exec('set role authenticated');
    await as(BOB);
    const visible = await query('select id from public.support_tickets where id = $1', [aliceTicket]);
    expect(visible).toHaveLength(0);
    await db.exec('reset role');
  });

  it('keeps an operator’s internal note away from the reader', async () => {
    await as(OWNER);
    await query(
      `select * from public.admin_reply_support_ticket($1, 'ตรวจสอบกับผู้ให้บริการแล้ว', true)`,
      [aliceTicket],
    );
    await query(
      `select * from public.admin_reply_support_ticket($1, 'ขอบคุณที่แจ้งเข้ามาครับ', false)`,
      [aliceTicket],
    );

    await db.exec('set role authenticated');
    await as(ALICE);
    const seen = await query<{ body: string; is_internal: boolean }>(
      'select body, is_internal from public.support_thread_messages where ticket_id = $1',
      [aliceTicket],
    );
    expect(seen.every((row) => row.is_internal === false)).toBe(true);
    expect(seen.some((row) => row.body.includes('ขอบคุณ'))).toBe(true);
    expect(seen.some((row) => row.body.includes('ตรวจสอบกับผู้ให้บริการ'))).toBe(false);
    await db.exec('reset role');
  });

  it('refuses an operator routine to a reader', async () => {
    await as(BOB);
    await expect(query(
      `select * from public.admin_reply_support_ticket($1, 'ผมเป็นแอดมิน', true)`,
      [aliceTicket],
    )).rejects.toThrow(/ADMIN_REQUIRED/);
    await expect(query(
      `select public.admin_set_support_ticket_status($1, 'closed')`,
      [aliceTicket],
    )).rejects.toThrow(/ADMIN_REQUIRED/);
  });

  it('rate limits a burst of tickets from one account', async () => {
    await as(BOB);
    const outcomes: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      // The 60-second guard would refuse the second one first, so it is stepped
      // past explicitly to exercise the daily bound underneath it.
      await db.exec(
        `update public.support_tickets set created_at = created_at - interval '5 minutes'
         where user_id = '${BOB}'`,
      );
      const rows = await query<{ outcome: string }>(
        `select outcome from public.create_support_ticket('other','หัวข้อทดสอบ','รายละเอียดของปัญหาที่พบเจอ')`,
      );
      outcomes.push(rows[0].outcome);
    }
    expect(outcomes).toContain('rate_limited');
  });
});

describe('refund requests', () => {
  let invoiceRef: string;
  let requestId: string;

  it('accepts a request against the reader’s own purchase only', async () => {
    await as(null);
    invoiceRef = await recordInvoice(ALICE, 'in_refund_request');

    // Bob aiming at Alice's purchase gets `not_found`, not a disclosure that it
    // exists.
    await as(BOB);
    const stolen = await query<{ outcome: string }>(
      `select outcome from public.create_refund_request($1,'other','พยายามขอคืนเงินของคนอื่น')`,
      [invoiceRef],
    );
    expect(stolen[0].outcome).toBe('not_found');

    await as(ALICE);
    const created = await query<{ request_id: string; outcome: string }>(
      `select request_id, outcome from public.create_refund_request($1,'not_as_expected','ใช้งานแล้วไม่ตรงกับที่คาดหวังไว้')`,
      [invoiceRef],
    );
    expect(created[0].outcome).toBe('created');
    requestId = created[0].request_id;
  });

  it('allows only one live request per purchase', async () => {
    await as(ALICE);
    const second = await query<{ outcome: string }>(
      `select outcome from public.create_refund_request($1,'other','ขออีกครั้ง')`,
      [invoiceRef],
    );
    expect(second[0].outcome).toBe('already_open');
  });

  it('does not withdraw access when a request is filed or approved', async () => {
    expect((await subscriptionOf(ALICE)).status).toBe('active');

    await as(OWNER);
    const approved = await query<{ admin_set_refund_request_status: string }>(
      `select public.admin_set_refund_request_status($1,'approved',null)`,
      [requestId],
    );
    expect(approved[0].admin_set_refund_request_status).toBe('updated');
    expect((await subscriptionOf(ALICE)).status).toBe('active');
  });

  it('refuses to claim money moved without evidence', async () => {
    await as(OWNER);
    const refused = await query<{ admin_set_refund_request_status: string }>(
      `select public.admin_set_refund_request_status($1,'refunded',null)`,
      [requestId],
    );
    expect(refused[0].admin_set_refund_request_status).toBe('confirmation_required');

    const accepted = await query<{ admin_set_refund_request_status: string }>(
      `select public.admin_set_refund_request_status($1,'refunded','re_test_123')`,
      [requestId],
    );
    expect(accepted[0].admin_set_refund_request_status).toBe('updated');
  });

  it('refuses an illegal transition', async () => {
    await as(OWNER);
    const rows = await query<{ admin_set_refund_request_status: string }>(
      `select public.admin_set_refund_request_status($1,'reviewing',null)`,
      [requestId],
    );
    expect(rows[0].admin_set_refund_request_status).toBe('invalid_transition');
  });

  it('closes an open request when the provider confirms a full refund', async () => {
    await as(null);
    const secondInvoice = await recordInvoice(BOB, 'in_bob_refund');
    await as(BOB);
    const created = await query<{ request_id: string; outcome: string }>(
      `select request_id, outcome from public.create_refund_request($1,'duplicate_charge','ถูกเรียกเก็บซ้ำสองครั้ง')`,
      [secondInvoice],
    );
    expect(created[0].outcome).toBe('created');

    await as(null);
    await applyRefundEvent({
      eventId: 'evt_bob_full_refund',
      userId: BOB,
      subscriptionId: `sub_${BOB.slice(0, 8)}`,
      invoiceId: 'in_bob_refund',
      kind: 'refund',
      action: 'revoke',
      amountMinor: 799_000,
      chargeAmountMinor: 799_000,
      isFull: true,
    });

    const rows = await query<{ status: string; refunded_at: string | null }>(
      'select status, refunded_at from public.refund_requests where id = $1',
      [created[0].request_id],
    );
    expect(rows[0].status).toBe('refunded');
    expect(rows[0].refunded_at).not.toBeNull();
  });

  it('shows a reader only their own requests', async () => {
    await db.exec('set role authenticated');
    await as(BOB);
    const visible = await query('select id from public.refund_requests where id = $1', [requestId]);
    expect(visible).toHaveLength(0);
    await db.exec('reset role');
  });
});

describe('audit is append-only and invoices are private', () => {
  it('refuses an update or delete on the audit log, even as the owner', async () => {
    await as(null);
    await expect(db.exec(
      `update public.support_audit_events set action = 'rewritten'`,
    )).rejects.toThrow(/AUDIT_APPEND_ONLY/);
    await expect(db.exec(
      'delete from public.support_audit_events',
    )).rejects.toThrow(/AUDIT_APPEND_ONLY/);
  });

  /*
   * The append-only rule must not become a reason an account cannot be deleted.
   *
   * Removing an account cascades auth.users → support_tickets / refund_requests
   * → support_audit_events. The first version of the trigger refused that
   * cascade too, which broke `delete_own_account` in production — a privacy
   * feature failing closed in the worst direction. This is the regression.
   */
  it('lets an account be deleted, taking its tickets and audit with it', async () => {
    await as(null);
    const DEPARTING = '99999999-9999-4999-8999-999999999999';
    // `handle_new_user()` populates the profile, settings, role and
    // subscription, so inserting the account is the whole setup.
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at)
        values ('${DEPARTING}', 'departing@example.com', now());
    `);

    await as(DEPARTING);
    const created = await query<{ ticket_id: string }>(
      `select ticket_id from public.create_support_ticket('other','ลาก่อน','กำลังจะลบบัญชีนี้ทิ้ง')`,
    );
    const ticketId = created[0].ticket_id;

    await as(OWNER);
    await query(`select * from public.admin_reply_support_ticket($1,'บันทึกภายใน',true)`, [ticketId]);

    await as(null);
    const before = await query<{ count: number }>(
      'select count(*)::int as count from public.support_audit_events where ticket_id = $1',
      [ticketId],
    );
    expect(Number(before[0].count)).toBeGreaterThan(0);

    // The delete must simply succeed.
    await db.exec(`delete from auth.users where id = '${DEPARTING}'`);

    const tickets = await query('select id from public.support_tickets where id = $1', [ticketId]);
    expect(tickets).toHaveLength(0);
    const audit = await query(
      'select id from public.support_audit_events where ticket_id = $1',
      [ticketId],
    );
    expect(audit).toHaveLength(0);
  });

  it('still refuses a direct delete while the ticket it describes exists', async () => {
    await as(null);
    const rows = await query<{ ticket_id: string }>(
      'select ticket_id from public.support_audit_events where ticket_id is not null limit 1',
    );
    expect(rows.length).toBeGreaterThan(0);
    await expect(db.exec(
      `delete from public.support_audit_events where ticket_id = '${rows[0].ticket_id}'`,
    )).rejects.toThrow(/AUDIT_APPEND_ONLY/);
  });

  /*
   * The operator console reads the audit through a trusted projection, because
   * the table has no grant at all. Reading it directly through an operator's
   * own session is what broke the ticket page in production QA.
   */
  it('serves the audit trail to an operator through the projection', async () => {
    await db.exec('set role authenticated');
    await as(OWNER);
    const rows = await query<{ action: string }>(
      `select action from public.admin_thread_audit(
         (select id from public.support_tickets limit 1), null, 50)`,
    );
    expect(rows.length).toBeGreaterThan(0);
    await db.exec('reset role');
  });

  it('refuses the audit projection to a reader, and the table to everybody', async () => {
    await db.exec('set role authenticated');
    await as(ALICE);
    await expect(query(
      `select * from public.admin_thread_audit(
         (select id from public.support_tickets limit 1), null, 50)`,
    )).rejects.toThrow(/ADMIN_REQUIRED/);
    await expect(db.exec('select * from public.support_audit_events'))
      .rejects.toThrow(/permission denied/i);
    await db.exec('reset role');
  });

  /*
   * Every operator projection is *executed*, not just declared.
   *
   * `admin_search_accounts` declared `email text` while `auth.users.email` is
   * `varchar(255)`, so Postgres refused the result shape at run time (42804) and
   * every search in production returned nothing. A test that only checked the
   * function existed agreed with itself; running it is what catches this.
   */
  it('runs every operator projection against the real column types', async () => {
    await db.exec('set role authenticated');
    await as(OWNER);

    const search = await query<{ email: string; user_id: string }>(
      `select email, user_id from public.admin_search_accounts('alice@example.com', 20)`,
    );
    expect(search).toHaveLength(1);
    expect(search[0].email).toBe('alice@example.com');
    expect(search[0].user_id).toBe(ALICE);

    // The other two search inputs the console offers.
    expect(await query(`select user_id from public.admin_search_accounts('${ALICE}', 20)`)).toHaveLength(1);
    expect(await query(`select user_id from public.admin_search_accounts('Reader', 20)`)).not.toHaveLength(0);

    await query(`select * from public.admin_account_invoices('${ALICE}')`);
    await query(`select * from public.admin_account_webhook_history('${ALICE}')`);
    await query('select * from public.admin_open_billing_issues(null, 20)');
    await db.exec('reset role');
  });

  it('gives no client any grant on the invoice ledger', async () => {
    await db.exec('set role authenticated');
    await as(ALICE);
    await expect(db.exec('select * from public.billing_invoices')).rejects.toThrow(/permission denied/i);
    await expect(db.exec('select * from public.billing_refund_events')).rejects.toThrow(/permission denied/i);
    await expect(db.exec('select * from public.billing_webhook_retries')).rejects.toThrow(/permission denied/i);
    await expect(db.exec('select * from public.billing_reconciliation_issues')).rejects.toThrow(/permission denied/i);
    await db.exec('reset role');
  });

  it('returns a reader their own purchases through the sanitized projection only', async () => {
    await db.exec('set role authenticated');
    await as(ALICE);
    const rows = await query<Record<string, unknown>>('select * from public.list_my_billing_invoices()');
    expect(rows.length).toBeGreaterThan(0);
    // Our uuid, money and dates. No provider identifier of any kind.
    const columns = Object.keys(rows[0]);
    expect(columns).toContain('invoice_ref');
    expect(columns).not.toContain('invoice_id');
    expect(columns).not.toContain('subscription_id');
    await db.exec('reset role');
  });
});
