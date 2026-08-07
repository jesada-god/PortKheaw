import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The database half of "รีเซ็ตพอร์ต".
 *
 * Run against a real PostgreSQL replaying the real migration chain, because
 * every claim here is a behaviour: that the portfolio survives while its money
 * does not, that a neighbouring portfolio is untouched down to the transfer it
 * received, that somebody else's portfolio is not resettable, that a failure
 * partway through leaves nothing half-emptied, and that a second submission
 * cannot damage what the first one already did.
 *
 * The financial assertions deliberately re-derive value the way the application
 * does — from the ledger — rather than reading a stored total, because there is
 * no stored total, and a test that invented one would be testing itself.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const MIGRATION_FILE = '202608080001_portfolio_reset.sql';

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
  '202608050008_option_chain_portfolio_purchase.sql',
  '202608070002_portfolio_asset_transfer_and_soft_delete.sql',
  MIGRATION_FILE,
];

/** Seeded by the Phase 3.1 migration, so it has to exist before the chain runs. */
const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const USER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';

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
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    insert into auth.users (id) values ('${OWNER}'), ('${USER}'), ('${STRANGER}');
  `);
  await setUser(db, USER);
  for (const file of MIGRATION_CHAIN) {
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec(`
    grant usage on schema public, auth to authenticated;
    grant select on all tables in schema public to authenticated;
  `);
  // Both accounts are paid, so the Basic tier's one-writable-stock-portfolio
  // rule is not what most of these cases happens to be measuring. The one case
  // that *is* about it downgrades the account itself.
  for (const id of [USER, STRANGER]) {
    await db.query(`
      insert into public.user_subscriptions (user_id, tier, status, current_period_end)
      values ($1, 'elite', 'active', now() + interval '365 days')
      on conflict (user_id) do update set
        tier = 'elite', status = 'active', current_period_end = now() + interval '365 days'
    `, [id]);
  }
  return db;
}

async function setUser(db: PGlite, userId: string) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
}

async function createPortfolio(db: PGlite, name: string, type: 'STOCK' | 'OPTION' = 'STOCK') {
  const result = await db.query<{ create_portfolio: string }>(
    `select public.create_portfolio($1, $2)`,
    [name, type],
  );
  return result.rows[0].create_portfolio;
}

interface LedgerFields {
  symbol?: string | null;
  quantity?: number | null;
  price?: number | null;
  amount?: number | null;
  fee?: number | null;
  underlying?: string | null;
  contract?: string | null;
  kind?: string | null;
  side?: string | null;
  strike?: number | null;
  expiration?: string | null;
  multiplier?: number | null;
  occurredAt?: string;
}

async function ledger(db: PGlite, portfolio: string, type: string, fields: LedgerFields = {}) {
  const f = {
    symbol: null, quantity: null, price: null, amount: null, fee: null,
    underlying: null, contract: null, kind: null, side: null, strike: null,
    expiration: null, multiplier: null, occurredAt: '2026-01-05 12:00:00+07',
    ...fields,
  } as Required<LedgerFields>;
  await db.query(`
    select public.create_portfolio_ledger_transaction(
      $1, $2, $3, $4, $5, $6, $7, 'USD', null, $15::timestamptz, null,
      $8, $9, $10, $11, $12, $13, $14, null, gen_random_uuid()
    )
  `, [portfolio, type, f.symbol, f.quantity, f.price, f.amount, f.fee,
      f.underlying, f.contract, f.kind, f.side, f.strike, f.expiration, f.multiplier, f.occurredAt]);
}

interface ResetOutcome {
  transactions_removed: number;
  option_positions_removed: number;
  option_targets_removed: number;
  goal_cleared: boolean;
}

async function reset(db: PGlite, portfolio: string) {
  const result = await db.query<ResetOutcome>(
    `select * from public.reset_portfolio($1)`, [portfolio],
  );
  return result.rows[0];
}

/**
 * Cash, derived exactly as the rest of the schema derives it — by replaying the
 * ledger. This is the number the card shows as "เงินสด".
 */
async function cash(db: PGlite, portfolio: string) {
  const result = await db.query<{ balance: string }>(`
    select coalesce(sum(case
      when transaction_type in ('deposit', 'dividend', 'adjustment', 'transfer_in') then normalized_amount_usd
      when transaction_type in ('withdrawal', 'fee', 'transfer_out') then -normalized_amount_usd
      when transaction_type = 'acquisition' then -(normalized_price_usd * quantity + coalesce(normalized_fee_usd, 0))
      when transaction_type = 'disposal' then normalized_price_usd * quantity - coalesce(normalized_fee_usd, 0)
      else 0
    end), 0)::text as balance
    from public.portfolio_transactions where portfolio_id = $1
  `, [portfolio]);
  return Number(result.rows[0].balance);
}

async function openQuantity(db: PGlite, portfolio: string, symbol: string) {
  const result = await db.query<{ q: string }>(
    `select public.portfolio_open_equity_quantity($1, $2)::text as q`, [portfolio, symbol],
  );
  return Number(result.rows[0].q);
}

async function openContracts(db: PGlite, portfolio: string, contract: string) {
  const result = await db.query<{ q: string }>(
    `select public.portfolio_open_option_contracts($1, $2)::text as q`, [portfolio, contract],
  );
  return Number(result.rows[0].q);
}

async function counts(db: PGlite, portfolio: string) {
  const result = await db.query<{ ledger: number; positions: number; targets: number }>(`
    select
      (select count(*) from public.portfolio_transactions where portfolio_id = $1)::int as ledger,
      (select count(*) from public.portfolio_option_positions where portfolio_id = $1)::int as positions,
      (select count(*) from public.portfolio_option_targets where portfolio_id = $1)::int as targets
  `, [portfolio]);
  return result.rows[0];
}

async function portfolioRow(db: PGlite, portfolio: string) {
  const result = await db.query<{
    id: string; name: string; portfolio_type: string; is_legacy: boolean;
    base_currency: string; archived_at: string | null; deleted_at: string | null;
    target_value_usd: string | null; target_date: string | null;
  }>(`select * from public.portfolios where id = $1`, [portfolio]);
  return result.rows[0] ?? null;
}

const CONTRACT = 'AAPL260116C00150000';

/**
 * Loads a portfolio with everything a reset has to clear that its own type will
 * accept: cash, an open option lot, a legacy option position row, an option
 * target and a goal — plus an equity position where the portfolio takes one.
 *
 * The type gate is the schema's, not this file's: a STOCK portfolio refuses
 * option rows and an OPTION portfolio refuses equity rows, so the only portfolio
 * that can hold literally all of it at once is the Default / Legacy one.
 */
async function loadPortfolio(db: PGlite, portfolio: string, { equity = false } = {}) {
  await ledger(db, portfolio, 'deposit', { amount: 100_000 });
  if (equity) {
    await ledger(db, portfolio, 'acquisition', { symbol: 'AAPL', quantity: 10, price: 150, fee: 1 });
  }
  await ledger(db, portfolio, 'buy_to_open', {
    quantity: 2, price: 5, fee: 1, underlying: 'AAPL', contract: CONTRACT,
    kind: 'call', side: 'long', strike: 150, expiration: '2026-01-16', multiplier: 100,
  });
  await db.query(`
    insert into public.portfolio_option_positions (
      portfolio_id, underlying_symbol, option_kind, contracts, premium_per_share,
      strike_price, opened_at, expiration_date, idempotency_key
    ) values ($1, 'AAPL', 'call', 1, 5, 150, '2026-01-05', '2026-06-19', gen_random_uuid())
  `, [portfolio]);
  await db.query(`
    insert into public.portfolio_option_targets (
      portfolio_id, contract_symbol, side, mode, target_value, target_premium
    ) values ($1, $2, 'long', 'premium', 9, 9)
  `, [portfolio, CONTRACT]);
  await db.query(`select public.set_portfolio_goal($1, 50000, '2026-12-31')`, [portfolio]);
  return portfolio;
}

async function legacyPortfolio(db: PGlite) {
  const result = await db.query<{ get_or_create_default_portfolio: string }>(
    `select public.get_or_create_default_portfolio()`,
  );
  return result.rows[0].get_or_create_default_portfolio;
}

describe('resetting a portfolio', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await database();
  });

  /**
   * A clean portfolio per case. Earlier ones are archived rather than deleted so
   * the ten-portfolio plan limit does not run out halfway through the file.
   */
  async function fresh(name: string) {
    await db.query(`
      update public.portfolios set archived_at = now()
      where user_id = $1 and archived_at is null and not is_legacy
    `, [USER]);
    const portfolio = await createPortfolio(db, `${name} ${crypto.randomUUID().slice(0, 8)}`, 'OPTION');
    return loadPortfolio(db, portfolio);
  }

  /** Cash, an equity position, an option position, history, targets and a goal. */
  it('empties every financial record the portfolio owns', async () => {
    await setUser(db, USER);
    const portfolio = await legacyPortfolio(db);
    await loadPortfolio(db, portfolio, { equity: true });

    expect(await cash(db, portfolio)).toBeGreaterThan(0);
    expect(await openQuantity(db, portfolio, 'AAPL')).toBe(10);
    expect(await openContracts(db, portfolio, CONTRACT)).toBe(2);

    const outcome = await reset(db, portfolio);

    expect(outcome.transactions_removed).toBe(3);
    expect(outcome.option_positions_removed).toBe(1);
    expect(outcome.option_targets_removed).toBe(1);
    expect(outcome.goal_cleared).toBe(true);

    // Cash, positions, cost basis and every P&L figure are derived from these
    // rows, so an empty ledger is the whole of "the portfolio reads zero".
    expect(await counts(db, portfolio)).toEqual({ ledger: 0, positions: 0, targets: 0 });
    expect(await cash(db, portfolio)).toBe(0);
    expect(await openQuantity(db, portfolio, 'AAPL')).toBe(0);
    expect(await openContracts(db, portfolio, CONTRACT)).toBe(0);

    // And the portfolio the account is anchored to is still there — the one
    // that cannot be deleted, so this is the only way to empty it.
    const row = await portfolioRow(db, portfolio);
    expect(row.is_legacy).toBe(true);
    expect(row.portfolio_type).toBe('LEGACY');
  });

  it('keeps the portfolio itself — name, type, currency and place in the list', async () => {
    await setUser(db, USER);
    const portfolio = await fresh('Keeps identity');
    const before = await portfolioRow(db, portfolio);

    await reset(db, portfolio);

    const after = await portfolioRow(db, portfolio);
    expect(after).not.toBeNull();
    expect(after.id).toBe(before.id);
    expect(after.name).toBe(before.name);
    expect(after.portfolio_type).toBe(before.portfolio_type);
    expect(after.is_legacy).toBe(before.is_legacy);
    expect(after.base_currency).toBe(before.base_currency);
    expect(after.archived_at).toBeNull();
    expect(after.deleted_at).toBeNull();
    // The goal goes with the money: a target left standing over an empty ledger
    // would report 0% against a plan that no longer exists.
    expect(after.target_value_usd).toBeNull();
    expect(after.target_date).toBeNull();
  });

  it('leaves every other portfolio exactly as it was, including a transfer it received', async () => {
    await setUser(db, USER);
    const source = await fresh('Transfer source');
    const neighbour = await createPortfolio(db, `Neighbour ${crypto.randomUUID().slice(0, 8)}`);
    await ledger(db, neighbour, 'deposit', { amount: 500 });
    await db.query(
      `select public.transfer_portfolio_cash($1, $2, 250, now(), null, gen_random_uuid())`,
      [source, neighbour],
    );

    const neighbourBefore = await cash(db, neighbour);
    const neighbourCounts = await counts(db, neighbour);
    expect(neighbourBefore).toBe(750);

    await reset(db, source);

    expect(await cash(db, neighbour)).toBe(neighbourBefore);
    expect(await counts(db, neighbour)).toEqual(neighbourCounts);
    /*
     * The surviving leg keeps its link. The purge has to null this because there
     * the source row disappears; here it does not, so the destination still
     * reads "received from <that portfolio>", which is true — the transfer did
     * happen, and only the source's own record of it is gone.
     */
    const leg = await db.query<{ counterparty_portfolio_id: string | null; normalized_amount_usd: string }>(`
      select counterparty_portfolio_id, normalized_amount_usd::text
      from public.portfolio_transactions
      where portfolio_id = $1 and transaction_type = 'transfer_in'
    `, [neighbour]);
    expect(leg.rows).toHaveLength(1);
    expect(leg.rows[0].counterparty_portfolio_id).toBe(source);
    expect(Number(leg.rows[0].normalized_amount_usd)).toBe(250);
  });

  it('refuses a portfolio the caller does not own, and says nothing about it', async () => {
    await setUser(db, USER);
    const portfolio = await fresh('Not yours');

    await setUser(db, STRANGER);
    await expect(reset(db, portfolio)).rejects.toThrow(/Portfolio not found/);

    await setUser(db, USER);
    // Refused, not partially applied.
    expect((await counts(db, portfolio)).ledger).toBe(2);
  });

  it('refuses an id that belongs to nobody with the same answer', async () => {
    await setUser(db, USER);
    await expect(reset(db, crypto.randomUUID())).rejects.toThrow(/Portfolio not found/);
  });

  it('refuses a deleted portfolio, whose ledger the recovery window exists to hand back', async () => {
    await setUser(db, USER);
    const portfolio = await fresh('Deleted');
    // A second active portfolio, so the deletion is not the last one standing.
    await createPortfolio(db, `Spare ${crypto.randomUUID().slice(0, 8)}`);
    const name = (await portfolioRow(db, portfolio)).name;
    await db.query(`select public.soft_delete_portfolio($1, $2)`, [portfolio, name]);

    await expect(reset(db, portfolio)).rejects.toThrow(/PORTFOLIO_ALREADY_DELETED/);
    expect((await counts(db, portfolio)).ledger).toBe(2);
  });

  it('is gated by the same entitlement rule as every other portfolio write', async () => {
    await setUser(db, USER);
    const portfolio = await fresh('Read only');
    // A second stock portfolio exists from earlier cases, so under Basic this
    // one is not the single writable stock portfolio.
    await db.query(`
      update public.user_subscriptions set tier = 'basic', status = 'active' where user_id = $1
    `, [USER]);

    await expect(reset(db, portfolio)).rejects.toThrow(/UPGRADE_REQUIRED|READ_ONLY_SUBSCRIPTION/);
    expect((await counts(db, portfolio)).ledger).toBe(2);

    await db.query(`
      update public.user_subscriptions
      set tier = 'elite', status = 'active', current_period_end = now() + interval '365 days'
      where user_id = $1
    `, [USER]);
  });

  it('rolls back completely when any part of the clear-out fails', async () => {
    await setUser(db, USER);
    const portfolio = await fresh('Rollback');
    const before = await counts(db, portfolio);

    /*
     * The failure is injected at the *last* child the routine deletes, so a
     * reset that was not one transaction would already have destroyed the ledger
     * and the legacy positions by the time it hit this.
     */
    await db.exec(`
      create function public.reset_test_refuse() returns trigger
      language plpgsql as $$ begin raise exception 'RESET_TEST_FAILURE'; end; $$;
      create trigger reset_test_refuse before delete on public.portfolio_option_targets
      for each row execute function public.reset_test_refuse();
    `);
    try {
      await expect(reset(db, portfolio)).rejects.toThrow(/RESET_TEST_FAILURE/);
    } finally {
      await db.exec(`
        drop trigger reset_test_refuse on public.portfolio_option_targets;
        drop function public.reset_test_refuse();
      `);
    }

    expect(await counts(db, portfolio)).toEqual(before);
    expect(await cash(db, portfolio)).toBeGreaterThan(0);
    const row = await portfolioRow(db, portfolio);
    expect(row.target_value_usd).not.toBeNull();
  });

  it('survives being submitted twice — the second one clears nothing and fails at nothing', async () => {
    await setUser(db, USER);
    const portfolio = await fresh('Double submit');

    const first = await reset(db, portfolio);
    const second = await reset(db, portfolio);

    expect(first.transactions_removed).toBe(2);
    expect(second.transactions_removed).toBe(0);
    expect(second.option_positions_removed).toBe(0);
    expect(second.option_targets_removed).toBe(0);
    expect(second.goal_cleared).toBe(false);
    expect(await counts(db, portfolio)).toEqual({ ledger: 0, positions: 0, targets: 0 });
    expect(await portfolioRow(db, portfolio)).not.toBeNull();
  });

  it('is executable by a signed-in reader and by nobody else', async () => {
    const grants = await db.query<{ grantee: string }>(`
      select grantee from information_schema.routine_privileges
      where routine_name = 'reset_portfolio' and privilege_type = 'EXECUTE'
    `);
    const grantees = grants.rows.map((row) => row.grantee);
    expect(grantees).toContain('authenticated');
    expect(grantees).not.toContain('anon');
    expect(grantees).not.toContain('PUBLIC');
  });
});
