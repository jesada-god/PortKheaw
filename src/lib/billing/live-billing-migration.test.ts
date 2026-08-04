import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const migrationFile = '202608040002_live_billing_readiness.sql';
const hardeningMigrationFile = '202608040003_prevent_billing_mode_downgrade.sql';
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
  migrationFile,
  hardeningMigrationFile,
];

const OWNER = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const LEGACY = '22222222-2222-4222-8222-222222222222';
const SWITCHER = '33333333-3333-4333-8333-333333333333';
const PERIOD_START = '2026-08-01T00:00:00.000Z';
const PERIOD_END = '2027-08-01T00:00:00.000Z';

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
          ('${LEGACY}', 'legacy@example.com', now()),
          ('${SWITCHER}', 'switcher@example.com', now());
      `);
    }
    if (file === migrationFile) {
      await db.exec(`
        update public.user_subscriptions set
          tier = 'pro', status = 'active',
          billing_provider = 'stripe', billing_plan_key = 'pro_annual',
          billing_customer_id = 'cus_legacy', billing_subscription_id = 'sub_legacy',
          billing_price_id = 'price_legacy', current_period_end = '${PERIOD_END}'
        where user_id = '${LEGACY}';
      `);
    }
    await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  await db.exec('grant usage on schema public, auth to anon, authenticated');
});

async function apply(options: {
  mode: 'test' | 'live';
  eventId: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  occurredAt?: string;
}) {
  const result = await db.query<{ outcome: string }>(
    `select * from public.apply_billing_subscription_event(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
    )`,
    [
      'stripe', options.mode, options.eventId, 'customer.subscription.updated',
      options.occurredAt ?? PERIOD_START, 'digest', SWITCHER,
      options.customerId === undefined ? `cus_${options.mode}` : options.customerId,
      options.subscriptionId === undefined ? `sub_${options.mode}` : options.subscriptionId,
      'pro_annual', `price_${options.mode}`, 'pro', 'active', 'year',
      PERIOD_START, PERIOD_END, false, `in_${options.mode}`, 'succeeded', false,
    ],
  );
  return result.rows[0].outcome;
}

describe('live billing readiness migration', () => {
  it('is forward-only for data and adds the trusted mode contract', () => {
    expect(statements).not.toMatch(/drop table|drop column|truncate|delete from/);
    expect(statements).toContain('billing_provider_mode');
    expect(statements).toContain("'test', 'live', 'legacy_unknown'");
    expect(statements).toContain('on conflict (provider, provider_mode, provider_event_id)');
  });

  it('preserves ambiguous identifiers as legacy_unknown and grants them nothing', async () => {
    const row = await db.query<{
      billing_provider_mode: string;
      billing_customer_id: string;
      billing_subscription_id: string;
      billing_price_id: string;
      tier: string;
      status: string;
    }>('select * from public.user_subscriptions where user_id = $1', [LEGACY]);
    expect(row.rows[0]).toMatchObject({
      billing_provider_mode: 'legacy_unknown',
      billing_customer_id: 'cus_legacy',
      billing_subscription_id: 'sub_legacy',
      billing_price_id: 'price_legacy',
      tier: 'basic',
      status: 'basic',
    });
    const access = await db.query<{ tier: string }>(
      'select public.resolve_effective_subscription_tier($1, $2) as tier',
      [LEGACY, '2026-09-01T00:00:00.000Z'],
    );
    expect(access.rows[0].tier).toBe('basic');
  });

  it('scopes unique provider objects and webhook idempotency by mode', async () => {
    const indexes = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where tablename in ('user_subscriptions', 'billing_webhook_events')`,
    );
    const definitions = indexes.rows.map((row) => row.indexdef).join('\n');
    expect(definitions).toMatch(/provider, provider_mode, provider_event_id/i);
    expect(definitions).toMatch(/billing_provider, billing_provider_mode, billing_customer_id/i);
    expect(definitions).toMatch(/billing_provider, billing_provider_mode, billing_subscription_id/i);

    expect(await apply({ mode: 'test', eventId: 'evt_shared' })).toBe('applied');
    expect(await apply({ mode: 'test', eventId: 'evt_shared' })).toBe('duplicate');
    expect(await apply({ mode: 'live', eventId: 'evt_shared' })).toBe('applied');

    const events = await db.query<{ provider_mode: string }>(
      `select provider_mode from public.billing_webhook_events
       where provider = 'stripe' and provider_event_id = 'evt_shared'
       order by provider_mode`,
    );
    expect(events.rows.map((row) => row.provider_mode)).toEqual(['live', 'test']);
  });

  it('does not let a different mode block controlled live activation', async () => {
    const row = await db.query<Record<string, unknown>>(
      'select * from public.user_subscriptions where user_id = $1', [SWITCHER],
    );
    expect(row.rows[0].billing_provider_mode).toBe('live');
    expect(row.rows[0].billing_customer_id).toBe('cus_live');
    expect(row.rows[0].billing_subscription_id).toBe('sub_live');
    expect(row.rows[0].tier).toBe('pro');
    expect(row.rows[0].founder_promo_applied).toBe(false);
  });

  it('never lets a test event overwrite an established live identity', async () => {
    expect(await apply({
      mode: 'test', eventId: 'evt_downgrade',
      occurredAt: '2026-08-03T00:00:00.000Z',
    })).toBe('provider_mode_downgrade');

    const row = await db.query<Record<string, unknown>>(
      'select * from public.user_subscriptions where user_id = $1', [SWITCHER],
    );
    expect(row.rows[0].billing_provider_mode).toBe('live');
    expect(row.rows[0].billing_customer_id).toBe('cus_live');
    expect(row.rows[0].billing_subscription_id).toBe('sub_live');
  });

  it('fails closed on incomplete or mismatched identity within one mode', async () => {
    expect(await apply({ mode: 'live', eventId: 'evt_missing', customerId: null }))
      .toBe('identity_incomplete');
    expect(await apply({
      mode: 'live', eventId: 'evt_mismatch', customerId: 'cus_someone_else',
      occurredAt: '2026-08-02T00:00:00.000Z',
    })).toBe('customer_mismatch');
  });

  it('turns the old unscoped write function into a fail-closed stub', async () => {
    await expect(db.query(
      `select * from public.apply_billing_subscription_event(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
      )`,
      [
        'stripe', 'evt_old', 'customer.subscription.updated', PERIOD_START,
        'digest', SWITCHER, 'cus_old', 'sub_old', 'pro_annual', 'price_old',
        'pro', 'active', 'year', PERIOD_START, PERIOD_END, false, 'in_old',
        'succeeded', false,
      ],
    )).rejects.toThrow(/BILLING_PROVIDER_MODE_REQUIRED/);
  });
});
