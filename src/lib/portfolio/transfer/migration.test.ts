import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The database half of asset transfer and reversible deletion.
 *
 * Run against a real PostgreSQL replaying the real migration chain, because
 * every claim here is a behaviour rather than a string: that a transfer is all
 * or nothing, that a repeat writes nothing, that a stale plan is refused, that a
 * purged source cannot take a surviving destination's holdings with it. A text
 * assertion could only tell us the SQL mentions those words.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const MIGRATION_FILE = '202608070002_portfolio_asset_transfer_and_soft_delete.sql';
const rawSql = readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_FILE), 'utf8');

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
  /*
   * Both accounts are paid, so the Basic tier's one-writable-stock-portfolio
   * rule is not what any of these tests happens to be measuring.
   *
   * `current_period_end` has to be set on the conflict path too: the entitlement
   * migration already seeded a Basic row for every account, so this is always an
   * update, and a tier without a period end resolves straight back to Basic.
   */
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
  const f: Required<LedgerFields> = {
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

async function transfer(db: PGlite, source: string, destination: string, options: {
  groupId?: string;
  legs: unknown[];
  expected?: unknown[];
}) {
  const result = await db.query<{
    transfer_group_id: string; legs_written: number; already_applied: boolean;
  }>(`
    select * from public.transfer_portfolio_assets($1, $2, $3, $4::jsonb, $5::jsonb, now(), null)
  `, [
    source, destination,
    options.groupId ?? crypto.randomUUID(),
    JSON.stringify(options.legs),
    JSON.stringify(options.expected ?? []),
  ]);
  return result.rows[0];
}

function equityLeg(symbol: string, quantity: string, unitCost: string, costBasis: string) {
  return {
    kind: 'equity', transferId: crypto.randomUUID(), symbol,
    quantity, unitCostUsd: unitCost, costBasisUsd: costBasis,
    acquiredAt: '2026-01-05T05:00:00Z',
  };
}

async function openQuantity(db: PGlite, portfolio: string, symbol: string) {
  const result = await db.query<{ q: string }>(
    `select public.portfolio_open_equity_quantity($1, $2)::text as q`, [portfolio, symbol],
  );
  return Number(result.rows[0].q);
}

async function ledgerCount(db: PGlite, portfolio: string) {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from public.portfolio_transactions where portfolio_id = $1`, [portfolio],
  );
  return result.rows[0].n;
}

describe('transferring assets between portfolios', () => {
  let db: PGlite;
  let source: string;
  let destination: string;

  beforeAll(async () => {
    db = await database();
  });

  /**
   * A clean pair per case. Earlier pairs are archived rather than deleted so the
   * ten-portfolio plan limit does not run out halfway through the file — and so
   * each case starts from a ledger nothing else has written to.
   */
  async function freshPair() {
    await db.query(`
      update public.portfolios set archived_at = now()
      where user_id = $1 and archived_at is null and not is_legacy
    `, [USER]);
    const suffix = crypto.randomUUID().slice(0, 8);
    source = await createPortfolio(db, `Source ${suffix}`);
    destination = await createPortfolio(db, `Dest ${suffix}`);
    await ledger(db, source, 'deposit', { amount: 100_000 });
    await ledger(db, source, 'acquisition', { symbol: 'AAPL', quantity: 10, price: 150, fee: 0 });
    return { source, destination };
  }

  it('moves quantity and cost basis, and moves no cash', async () => {
    const pair = await freshPair();
    const before = await db.query<{ cash: string }>(`
      select coalesce(sum(case when transaction_type = 'deposit' then normalized_amount_usd else 0 end), 0)::text as cash
      from public.portfolio_transactions where portfolio_id = $1
    `, [pair.source]);

    const result = await transfer(db, pair.source, pair.destination, {
      legs: [equityLeg('AAPL', '6', '150', '900')],
      expected: [{ kind: 'equity', key: 'AAPL', quantity: '10' }],
    });

    expect(result.legs_written).toBe(2);
    expect(result.already_applied).toBe(false);
    expect(await openQuantity(db, pair.source, 'AAPL')).toBe(4);
    expect(await openQuantity(db, pair.destination, 'AAPL')).toBe(6);

    const arrived = await db.query<{ basis: string; amount: string | null; acquired: string }>(`
      select transfer_cost_basis_usd::text as basis, amount::text as amount,
             transfer_acquired_at::text as acquired
      from public.portfolio_transactions
      where portfolio_id = $1 and transaction_type = 'transfer_in'
    `, [pair.destination]);
    expect(Number(arrived.rows[0].basis)).toBe(900);
    // No amount means no cash reader can mistake this for money moving.
    expect(arrived.rows[0].amount).toBeNull();
    expect(arrived.rows[0].acquired).toContain('2026-01-05');
    expect(Number(before.rows[0].cash)).toBe(100_000);
  });

  it('writes nothing on a repeat of the same group', async () => {
    const pair = await freshPair();
    const groupId = crypto.randomUUID();
    const legs = [equityLeg('AAPL', '6', '150', '900')];
    const first = await transfer(db, pair.source, pair.destination, { groupId, legs });
    const second = await transfer(db, pair.source, pair.destination, { groupId, legs });

    expect(first.already_applied).toBe(false);
    expect(second.already_applied).toBe(true);
    expect(second.legs_written).toBe(0);
    // Six shares moved once, not twice.
    expect(await openQuantity(db, pair.destination, 'AAPL')).toBe(6);
  });

  it('refuses a plan whose position changed after the preview, and writes nothing', async () => {
    const pair = await freshPair();
    // Four shares are sold between preview and confirm.
    await ledger(db, pair.source, 'disposal', {
      symbol: 'AAPL', quantity: 4, price: 180, fee: 0, occurredAt: '2026-02-05 12:00:00+07',
    });
    const destinationRowsBefore = await ledgerCount(db, pair.destination);

    await expect(transfer(db, pair.source, pair.destination, {
      legs: [equityLeg('AAPL', '10', '150', '1500')],
      expected: [{ kind: 'equity', key: 'AAPL', quantity: '10' }],
    })).rejects.toThrow(/TRANSFER_POSITIONS_CHANGED/);

    expect(await openQuantity(db, pair.source, 'AAPL')).toBe(6);
    expect(await ledgerCount(db, pair.destination)).toBe(destinationRowsBefore);
  });

  it('rolls back every leg when one of them is impossible', async () => {
    const pair = await freshPair();
    const destinationRowsBefore = await ledgerCount(db, pair.destination);
    const sourceRowsBefore = await ledgerCount(db, pair.source);

    // The first leg is fine; the second asks for shares that are not there.
    await expect(transfer(db, pair.source, pair.destination, {
      legs: [
        equityLeg('AAPL', '4', '150', '600'),
        equityLeg('AAPL', '50', '150', '7500'),
      ],
    })).rejects.toThrow(/Transfer exceeds available quantity/);

    expect(await ledgerCount(db, pair.source)).toBe(sourceRowsBefore);
    expect(await ledgerCount(db, pair.destination)).toBe(destinationRowsBefore);
    expect(await openQuantity(db, pair.source, 'AAPL')).toBe(10);
  });

  it('refuses a zero-quantity leg instead of silently writing an empty transfer', async () => {
    const pair = await freshPair();
    await expect(transfer(db, pair.source, pair.destination, {
      legs: [equityLeg('AAPL', '0', '150', '0')],
    })).rejects.toThrow(/TRANSFER_EMPTY_LEG/);
  });

  it('refuses an expired option contract', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    await db.query(`
      update public.portfolios set archived_at = now()
      where user_id = $1 and archived_at is null and not is_legacy
    `, [USER]);
    const optionSource = await createPortfolio(db, `Opt ${suffix}`, 'OPTION');
    const optionDestination = await createPortfolio(db, `OptDest ${suffix}`, 'OPTION');
    await expect(transfer(db, optionSource, optionDestination, {
      legs: [{
        kind: 'option', transferId: crypto.randomUUID(),
        contractSymbol: 'AAPL250117C00200000', underlyingSymbol: 'AAPL',
        optionKind: 'call', optionSide: 'long', strikePrice: '200',
        expirationDate: '2025-01-17', multiplier: '100',
        quantity: '1', unitCostUsd: '3', costBasisUsd: '300', acquiredAt: null,
      }],
    })).rejects.toThrow(/TRANSFER_OPTION_EXPIRED/);
  });

  it('refuses a destination belonging to somebody else', async () => {
    const pair = await freshPair();
    await setUser(db, STRANGER);
    const theirs = await createPortfolio(db, `Theirs ${crypto.randomUUID().slice(0, 8)}`);
    await setUser(db, USER);

    await expect(transfer(db, pair.source, theirs, {
      legs: [equityLeg('AAPL', '1', '150', '150')],
    })).rejects.toThrow(/Portfolio not found/);
    expect(await openQuantity(db, pair.source, 'AAPL')).toBe(10);
  });

  it('refuses a source and destination that are the same portfolio', async () => {
    const pair = await freshPair();
    await expect(transfer(db, pair.source, pair.source, {
      legs: [equityLeg('AAPL', '1', '150', '150')],
    })).rejects.toThrow(/must differ/);
  });
});

describe('deleting a portfolio', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await database();
  });

  /** Archives what came before, so the plan limit outlasts the file. */
  async function deletable(name: string) {
    await db.query(`
      update public.portfolios set archived_at = now()
      where user_id = $1 and archived_at is null and not is_legacy
    `, [USER]);
    const id = await createPortfolio(db, name);
    await ledger(db, id, 'deposit', { amount: 500 });
    return id;
  }

  it('refuses a name that does not match the portfolio', async () => {
    const id = await deletable('Typed Name');
    await expect(db.query(`select public.soft_delete_portfolio($1, 'Something Else')`, [id]))
      .rejects.toThrow(/PORTFOLIO_NAME_MISMATCH/);
  });

  it('hides the portfolio and stamps a seven-day deadline, destroying nothing', async () => {
    const id = await deletable('To Delete');
    const rowsBefore = await ledgerCount(db, id);
    const result = await db.query<{ purge_after: string }>(
      `select public.soft_delete_portfolio($1, 'To Delete') as purge_after`, [id],
    );
    expect(result.rows[0].purge_after).toBeTruthy();

    const state = await db.query<{ deleted_at: string; days: string }>(`
      select deleted_at::text, extract(day from purge_after - deleted_at)::text as days
      from public.portfolios where id = $1
    `, [id]);
    expect(state.rows[0].deleted_at).toBeTruthy();
    expect(state.rows[0].days).toBe('7');
    // The ledger is untouched; only visibility changed.
    expect(await ledgerCount(db, id)).toBe(rowsBefore);
  });

  it('refuses to delete the last active portfolio', async () => {
    await setUser(db, STRANGER);
    await db.query(`select public.get_or_create_default_portfolio()`);
    const only = await createPortfolio(db, 'Only One');
    // Archive everything else so this really is the last active one.
    await db.query(`
      update public.portfolios set archived_at = now()
      where user_id = $1 and id <> $2
    `, [STRANGER, only]);
    await expect(db.query(`select public.soft_delete_portfolio($1, 'Only One')`, [only]))
      .rejects.toThrow(/PORTFOLIO_LAST_ACTIVE/);
    await db.query(`update public.portfolios set archived_at = null where user_id = $1`, [STRANGER]);
    await setUser(db, USER);
  });

  it('refuses to delete the Default / Legacy portfolio', async () => {
    const legacy = await db.query<{ id: string }>(`select public.get_or_create_default_portfolio() as id`);
    await expect(db.query(
      `select public.soft_delete_portfolio($1, 'Default / Legacy')`, [legacy.rows[0].id],
    )).rejects.toThrow(/Legacy portfolio cannot be deleted/);
  });

  it('frees the name for reuse while the portfolio is deleted', async () => {
    const id = await deletable('Reusable Name');
    await db.query(`select public.soft_delete_portfolio($1, 'Reusable Name')`, [id]);
    // The very next thing a person does after deleting is often recreating.
    await expect(createPortfolio(db, 'Reusable Name')).resolves.toBeTruthy();
  });

  it('brings a portfolio back under a new name when the old one was taken', async () => {
    const id = await deletable('Contested');
    await db.query(`select public.soft_delete_portfolio($1, 'Contested')`, [id]);
    await createPortfolio(db, 'Contested');
    const restored = await db.query<{ name: string }>(
      `select public.restore_deleted_portfolio($1) as name`, [id],
    );
    expect(restored.rows[0].name).toBe('Contested (2)');
    const state = await db.query<{ deleted_at: string | null }>(
      `select deleted_at from public.portfolios where id = $1`, [id],
    );
    expect(state.rows[0].deleted_at).toBeNull();
  });

  it('treats a second restore as a no-op rather than an error', async () => {
    const id = await deletable('Double Restore');
    await db.query(`select public.soft_delete_portfolio($1, 'Double Restore')`, [id]);
    await db.query(`select public.restore_deleted_portfolio($1)`, [id]);
    const again = await db.query<{ name: string }>(
      `select public.restore_deleted_portfolio($1) as name`, [id],
    );
    expect(again.rows[0].name).toBe('Double Restore');
  });

  it('refuses a second deletion of an already-deleted portfolio', async () => {
    const id = await deletable('Twice Deleted');
    await db.query(`select public.soft_delete_portfolio($1, 'Twice Deleted')`, [id]);
    await expect(db.query(`select public.soft_delete_portfolio($1, 'Twice Deleted')`, [id]))
      .rejects.toThrow(/PORTFOLIO_ALREADY_DELETED/);
  });

  it('refuses new ledger rows on a deleted portfolio', async () => {
    const id = await deletable('No More Writes');
    await db.query(`select public.soft_delete_portfolio($1, 'No More Writes')`, [id]);
    await expect(ledger(db, id, 'deposit', { amount: 10 })).rejects.toThrow(/Portfolio not found/);
  });

  it('refuses to restore once the window has closed', async () => {
    const id = await deletable('Too Late');
    await db.query(`select public.soft_delete_portfolio($1, 'Too Late')`, [id]);
    await db.query(`update public.portfolios set purge_after = now() - interval '1 hour' where id = $1`, [id]);
    await expect(db.query(`select public.restore_deleted_portfolio($1)`, [id]))
      .rejects.toThrow(/PORTFOLIO_RESTORE_WINDOW_CLOSED/);
  });
});

describe('the purge', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await database();
  });

  it('leaves a portfolio alone until its deadline has passed', async () => {
    const id = await createPortfolio(db, 'Not Yet Due');
    await ledger(db, id, 'deposit', { amount: 10 });
    await db.query(`select public.soft_delete_portfolio($1, 'Not Yet Due')`, [id]);
    const run = await db.query<{ scanned: number; purged: number }>(
      `select * from public.purge_deleted_portfolios(gen_random_uuid(), true, 100)`,
    );
    expect(run.rows[0].scanned).toBe(0);
    expect(run.rows[0].purged).toBe(0);
    const still = await db.query<{ n: number }>(
      `select count(*)::int as n from public.portfolios where id = $1`, [id],
    );
    expect(still.rows[0].n).toBe(1);
  });

  it('reports without deleting when it is not asked to apply', async () => {
    const id = await createPortfolio(db, 'Dry Run');
    await ledger(db, id, 'deposit', { amount: 10 });
    await db.query(`select public.soft_delete_portfolio($1, 'Dry Run')`, [id]);
    await db.query(`update public.portfolios set purge_after = now() - interval '1 day' where id = $1`, [id]);

    const run = await db.query<{ mode: string; scanned: number; purged: number }>(
      `select * from public.purge_deleted_portfolios(gen_random_uuid(), false, 100)`,
    );
    expect(run.rows[0].mode).toBe('dry_run');
    expect(run.rows[0].scanned).toBeGreaterThan(0);
    expect(run.rows[0].purged).toBe(0);
    await db.query(`select public.restore_deleted_portfolio($1)`, [id]).catch(() => undefined);
  });

  it('keeps the destination ledger and its holdings when the source is purged', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const source = await createPortfolio(db, `Purged Source ${suffix}`);
    const destination = await createPortfolio(db, `Kept Dest ${suffix}`);
    await ledger(db, source, 'deposit', { amount: 10_000 });
    await ledger(db, source, 'acquisition', { symbol: 'MSFT', quantity: 8, price: 300, fee: 0 });
    await transfer(db, source, destination, {
      legs: [equityLeg('MSFT', '8', '300', '2400')],
      expected: [{ kind: 'equity', key: 'MSFT', quantity: '8' }],
    });

    const rowsBefore = await ledgerCount(db, destination);
    const quantityBefore = await openQuantity(db, destination, 'MSFT');
    expect(quantityBefore).toBe(8);

    await db.query(`select public.soft_delete_portfolio($1, $2)`, [source, `Purged Source ${suffix}`]);
    await db.query(`update public.portfolios set purge_after = now() - interval '1 day' where id = $1`, [source]);
    const run = await db.query<{ purged: number }>(
      `select * from public.purge_deleted_portfolios(gen_random_uuid(), true, 100)`,
    );
    expect(run.rows[0].purged).toBeGreaterThan(0);

    // The source is gone; the destination is exactly as it was.
    const gone = await db.query<{ n: number }>(
      `select count(*)::int as n from public.portfolios where id = $1`, [source],
    );
    expect(gone.rows[0].n).toBe(0);
    expect(await ledgerCount(db, destination)).toBe(rowsBefore);
    expect(await openQuantity(db, destination, 'MSFT')).toBe(8);

    // And it can still say where the shares came from, by name.
    const provenance = await db.query<{ transfer_source_name: string; counterparty_portfolio_id: string | null }>(`
      select transfer_source_name, counterparty_portfolio_id
      from public.portfolio_transactions
      where portfolio_id = $1 and transaction_type = 'transfer_in'
    `, [destination]);
    expect(provenance.rows[0].transfer_source_name).toBe(`Purged Source ${suffix}`);
    expect(provenance.rows[0].counterparty_portfolio_id).toBeNull();
  });

  it('records one run per id and repeats none of it', async () => {
    const runId = crypto.randomUUID();
    const first = await db.query<{ already_recorded: boolean }>(
      `select * from public.purge_deleted_portfolios($1, true, 100)`, [runId],
    );
    const second = await db.query<{ already_recorded: boolean }>(
      `select * from public.purge_deleted_portfolios($1, true, 100)`, [runId],
    );
    expect(first.rows[0].already_recorded).toBe(false);
    expect(second.rows[0].already_recorded).toBe(true);
  });
});

describe('the migration itself', () => {
  it('runs twice without changing anything the second time', async () => {
    const db = await database();
    const id = await createPortfolio(db, 'Survives Replay');
    await ledger(db, id, 'deposit', { amount: 250 });
    const before = await ledgerCount(db, id);

    await db.exec(rawSql);

    expect(await ledgerCount(db, id)).toBe(before);
    const still = await db.query<{ n: number }>(
      `select count(*)::int as n from public.portfolios where id = $1`, [id],
    );
    expect(still.rows[0].n).toBe(1);
  });

  it('leaves existing cash transfers valid and gives them a group', async () => {
    const db = await database();
    const suffix = crypto.randomUUID().slice(0, 8);
    const source = await createPortfolio(db, `Cash Source ${suffix}`);
    const destination = await createPortfolio(db, `Cash Dest ${suffix}`);
    await ledger(db, source, 'deposit', { amount: 1000 });
    await db.query(`
      select public.transfer_portfolio_cash($1, $2, 400, now(), null, gen_random_uuid())
    `, [source, destination]);

    const rows = await db.query<{ transfer_group_id: string; transfer_id: string; amount: string }>(`
      select transfer_group_id::text, transfer_id::text, amount::text
      from public.portfolio_transactions where transaction_type = 'transfer_in' and portfolio_id = $1
    `, [destination]);
    expect(rows.rows[0].transfer_group_id).toBe(rows.rows[0].transfer_id);
    expect(Number(rows.rows[0].amount)).toBe(400);
  });
});
