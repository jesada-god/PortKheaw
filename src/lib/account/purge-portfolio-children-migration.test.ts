import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

/**
 * Account deletion, for an account that recorded something.
 *
 * THE DEFECT. `purge_account_data` removes `portfolios` by `user_id`, and every
 * table hanging off a portfolio keys on `portfolio_id` — so none of them was on
 * its list and none was ever removed. That was survivable while the children
 * went with the parent: `portfolio_transactions_portfolio_id_fkey` was created
 * `on delete cascade`. `202607310002_multi_portfolios.sql` changed it to
 * `on delete restrict`, correctly — a ledger is the account's financial record —
 * and did not give the purge a way to remove the ledger deliberately.
 *
 * From that migration onward, deleting an account that held one transaction
 * raised 23503, the purge aborted, and `deleteAccount` returned `purge-failed`
 * with the account already closed to writes and the auth user still present.
 * Confirmed against production on a QA account: 20 residual rows, the
 * foreign-key error, 20 residual rows still there.
 *
 * WHY THESE ASSERTIONS AND NOT A READING OF THE FILE. Every claim here is about
 * what two function bodies DO to real rows under the real constraints, and the
 * defect is precisely a case where reading either function alone tells you
 * nothing: the purge looked complete, the count agreed with it, and both were
 * blind to the same tables.
 */

const MIGRATION_FILE = '202608280001_purge_account_data_portfolio_children.sql';

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
  '202608060001_purchase_consent_and_refund_window.sql',
  '202608060002_account_deletion_and_trial_identity.sql',
  '202608060003_trial_retention_and_deletion_recovery.sql',
  '202608150001_stock_plans.sql',
  '202608160001_stock_plans_account_deletion.sql',
];

/** The owner UUID the Phase 3.1 migration seeds; its account must exist first. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
/** The account being closed, which has a ledger. */
const LEAVER = '11111111-1111-4111-8111-111111111111';
/** The account that must be untouched by any of it. */
const BYSTANDER = '22222222-2222-4222-8222-222222222222';

let db: PGlite;

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

/** Service context: no session, which is what the pipeline runs as. */
const asServer = () => db.exec(`select set_config('request.jwt.claim.sub', '', false)`);

async function residualFor(userId: string): Promise<number> {
  const rows = await query<{ account_residual_data_count: number }>(
    'select public.account_residual_data_count($1)', [userId],
  );
  return rows[0]!.account_residual_data_count;
}

async function countIn(table: string, column: string, parent: string, userId: string): Promise<number> {
  const rows = await query<{ total: number }>(
    `select count(*)::int as total from public.${table}
      where ${column} in (select id from public.${parent} where user_id = $1)`,
    [userId],
  );
  return rows[0]!.total;
}

/** A portfolio with a ledger and a watchlist with an item — an account that was used. */
async function seedAccount(userId: string, label: string): Promise<string> {
  const portfolio = await query<{ id: string }>(
    `insert into public.portfolios (user_id, name, base_currency)
     values ($1, $2, 'USD') returning id`,
    [userId, label],
  );
  const portfolioId = portfolio[0]!.id;
  /*
   * Rows the ledger's own constraints accept, rather than a fixture shortcut.
   * Three rules have to be satisfied at once and each one rejected an earlier
   * version of this seed:
   *
   *   `occurred_at_time` is the ledger's source of truth and is NOT NULL;
   *   `portfolio_transactions_fields` wants an acquisition to carry a symbol, a
   *     positive quantity and price, a fee, and NO amount; and
   *   `portfolio_transactions_currency_metadata` pairs every money column with
   *     its normalized twin, so price and fee each bring one.
   *
   * Two acquisitions rather than an acquisition and a dividend: a cash row
   * would need the whole amount group, and none of that is what this file is
   * about. What matters is that the rows exist and the restrict FK sees them.
   */
  await query(
    `insert into public.portfolio_transactions
       (portfolio_id, transaction_type, symbol, quantity, price, normalized_price_usd,
        fee, normalized_fee_usd, original_currency,
        occurred_at, occurred_at_time, idempotency_key)
     values ($1, 'acquisition', 'AAPL', 10, 100, 100, 0, 0, 'USD',
             current_date, now(), gen_random_uuid()),
            ($1, 'acquisition', 'NVDA', 5, 200, 200, 0, 0, 'USD',
             current_date, now(), gen_random_uuid())`,
    [portfolioId],
  );
  /*
   * The account already HAS a watchlist — `watchlists_one_per_user` says so, and
   * the schema creates it. So the item goes into the one that exists, which is
   * also the shape the purge has to cope with in production.
   */
  const watchlist = await query<{ id: string }>(
    `insert into public.watchlists (user_id, name) values ($1, $2)
     on conflict (user_id) do update set name = public.watchlists.name
     returning id`,
    [userId, `${label} watchlist`],
  );
  await query(
    `insert into public.watchlist_items (watchlist_id, symbol) values ($1, 'NVDA')`,
    [watchlist[0]!.id],
  );
  return portfolioId;
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
          ('${LEAVER}', 'leaver@example.com', now()),
          ('${BYSTANDER}', 'bystander@example.com', now());
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await asServer();
});

describe('before the fix', () => {
  /*
   * The bug, reproduced on the schema as it stood. This runs BEFORE the new
   * migration is applied, so it is the only place in the suite where the old
   * behaviour still exists to be observed — and it is what makes the rest of
   * the file a proof rather than an assertion that something works.
   */
  it('cannot purge an account that recorded a transaction', async () => {
    await seedAccount(LEAVER, 'ledger');
    await expect(query('select public.purge_account_data($1)', [LEAVER]))
      .rejects.toThrow(/portfolio_transactions_portfolio_id_fkey|violates foreign key/i);
  });

  it('reports the ledger as absent, so the reconciler would have deleted over it', async () => {
    // 20 rows of real data, and the count that gates the auth delete sees none
    // of the four child tables — which is the second half of the same defect.
    expect(await countIn('portfolio_transactions', 'portfolio_id', 'portfolios', LEAVER)).toBe(2);
    const rows = await query<{ def: string }>(
      `select pg_get_functiondef('public.account_residual_data_count(uuid)'::regprocedure) as def`,
    );
    expect(rows[0]!.def).not.toContain('portfolio_transactions');
  });
});

describe('after the fix', () => {
  beforeAll(async () => {
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8'));
    await asServer();
  });

  it('purges an account that has a ledger, a position and a watchlist item', async () => {
    await seedAccount(BYSTANDER, 'bystander');
    expect(await residualFor(LEAVER)).toBeGreaterThan(0);

    await query('select public.purge_account_data($1)', [LEAVER]);

    expect(await residualFor(LEAVER)).toBe(0);
    expect(await countIn('portfolio_transactions', 'portfolio_id', 'portfolios', LEAVER)).toBe(0);
    expect(await countIn('watchlist_items', 'watchlist_id', 'watchlists', LEAVER)).toBe(0);
  });

  /*
   * The auth user is what the purge exists to make deletable, and this is the
   * step that raised 23503 in production. It is asserted through the same
   * cascade the platform uses rather than through a direct delete, because that
   * is the delete that was failing.
   */
  it('lets the auth user go once the purge has run', async () => {
    await expect(query('delete from auth.users where id = $1', [LEAVER])).resolves.toBeDefined();
    const rows = await query<{ total: number }>(
      'select count(*)::int as total from auth.users where id = $1', [LEAVER],
    );
    expect(rows[0]!.total).toBe(0);
  });

  it('leaves every other account exactly where it was', async () => {
    expect(await countIn('portfolio_transactions', 'portfolio_id', 'portfolios', BYSTANDER)).toBe(2);
    expect(await countIn('watchlist_items', 'watchlist_id', 'watchlists', BYSTANDER)).toBe(1);
    expect(await residualFor(BYSTANDER)).toBeGreaterThan(0);
  });

  /*
   * The two routines have to name the same tables. One in the purge and not the
   * count under-reports forever; one in the count and not the purge stalls every
   * deletion at `awaiting_auth_delete`. This is the invariant the stock-plans
   * migration established, extended to the four tables it did not know about.
   */
  it('names every child table in both routines, so neither can be changed alone', async () => {
    const rows = await query<{ purge: string; count: string }>(
      `select pg_get_functiondef('public.purge_account_data(uuid)'::regprocedure) as purge,
              pg_get_functiondef('public.account_residual_data_count(uuid)'::regprocedure) as count`,
    );
    for (const table of [
      'portfolio_transactions',
      'portfolio_option_positions',
      'portfolio_option_targets',
      'watchlist_items',
    ]) {
      expect(rows[0]!.purge, `purge is missing ${table}`).toContain(table);
      expect(rows[0]!.count, `count is missing ${table}`).toContain(table);
    }
  });

  /*
   * NOTHING WAS WIDENED. The fix is order, not cascade — the restrict stays, so
   * a portfolio still cannot be destroyed by anything that has not deliberately
   * removed its ledger first. Reverting the constraint would have made every
   * one of the tests above pass while quietly removing that protection.
   */
  it('leaves the restrict constraint in place', async () => {
    const rows = await query<{ confdeltype: string }>(
      `select confdeltype from pg_constraint
        where conname = 'portfolio_transactions_portfolio_id_fkey'`,
    );
    // 'r' = restrict, 'c' = cascade.
    expect(rows[0]!.confdeltype).toBe('r');
  });

  it('is still reachable only by the trusted server', async () => {
    for (const routine of ['purge_account_data(uuid)', 'account_residual_data_count(uuid)']) {
      const rows = await query<{ anon: boolean; authenticated: boolean; service: boolean }>(
        `select has_function_privilege('anon', '${routine}', 'execute') as anon,
                has_function_privilege('authenticated', '${routine}', 'execute') as authenticated,
                has_function_privilege('service_role', '${routine}', 'execute') as service`,
      );
      expect(rows[0]!.anon, routine).toBe(false);
      expect(rows[0]!.authenticated, routine).toBe(false);
      expect(rows[0]!.service, routine).toBe(true);
    }
  });
});
