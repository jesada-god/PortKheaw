/**
 * Repair the rows reconciliation reports as `missing-period-end`.
 *
 * These are accounts holding a granting status (`active` or `past_due`) with no
 * `current_period_end` behind it — the shape `apply_billing_subscription_event`
 * could produce before `202608240003`, when a failed first PromptPay invoice
 * wrote the status flat from the event while the period took a branch that
 * assigned NULL. The routine can no longer write it; this pass corrects the rows
 * that were written before it shipped.
 *
 * **The one rule this script exists to enforce: a period is read off a paid
 * invoice, or it is not written at all.**
 *
 * There is a number sitting right there that would fill every row in one pass —
 * `subscription.items.data[0].current_period_end`, the lease Stripe opens the
 * moment a `send_invoice` subscription is created, before a satang has moved. It
 * is deliberately never read here. Writing it would hand a paid period to
 * accounts whose invoice nobody ever paid, which is the same mistake as
 * inventing a date, only harder to spot afterwards. For the same reason nothing
 * below does arithmetic on a date: no `+ 30 days`, no rounding to a month
 * boundary, no "the invoice was issued then, so the period must end here".
 *
 * So each row takes exactly one of three paths:
 *
 *   restore  a paid invoice for this subscription exists and states the period
 *            it paid for → that pair is written, start and end together.
 *   expire   no paid invoice exists anywhere for this subscription → nothing was
 *            ever bought, so the status becomes `expired` and the tier drops
 *            back to `basic`. Nothing is invented; a claim that was never true
 *            is removed.
 *   skip     anything else — the provider could not be reached, the row names no
 *            subscription, a paid invoice exists but states no period, the row
 *            belongs to the other provider mode. Reported, never guessed at.
 *
 * Dry run is the default and has to be turned off explicitly. Every row is
 * printed either way, with the reason for the path it took.
 *
 *   node --import=tsx --env-file-if-exists=.env.local scripts/backfill-billing-period-end.ts
 *   node --import=tsx --env-file-if-exists=.env.local scripts/backfill-billing-period-end.ts --apply
 *
 * Output carries our own user id and the provider's subscription/invoice
 * identifiers, because an operator reviewing a repair needs to be able to open
 * the same objects in the provider's dashboard. It carries no email, no name and
 * no payment detail.
 */

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { normalizeStripeInvoice } from '../src/lib/billing/providers/stripe/normalize-stripe-event';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!url || !serviceRoleKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (!stripeSecretKey) {
  console.error('STRIPE_SECRET_KEY is required: the period has to come from the provider.');
  process.exit(1);
}

/**
 * Which environment this key can speak for.
 *
 * A live row must never be repaired from a test-mode object and the other way
 * round, so a row whose stored mode does not match the key is skipped rather
 * than looked up. Same rule the webhook enforces on `livemode`.
 */
const keyMode: 'live' | 'test' = stripeSecretKey.startsWith('sk_live_') ? 'live' : 'test';

/** Dry run is the default. Writing takes a deliberate flag. */
const apply = process.argv.includes('--apply');
const dryRun = !apply;

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stripe = new Stripe(stripeSecretKey, {
  // Not pinned, for the same reason the application does not pin it: the shapes
  // read here moved between versions and would read `undefined` under a
  // different string. The SDK release is the contract.
  appInfo: { name: 'PortKheaw backfill', url: 'https://portkheaw.vercel.app' },
});

interface OffendingRow {
  user_id: string;
  tier: string;
  status: string;
  billing_provider_mode: string | null;
  billing_subscription_id: string | null;
  billing_collection_method: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
}

type Plan =
  | { action: 'restore'; reason: string; invoiceId: string; periodStart: string | null; periodEnd: string }
  | { action: 'expire'; reason: string }
  | { action: 'skip'; reason: string };

/**
 * The paid invoice that states the period, as the provider currently reports it.
 *
 * `invoices.list` is filtered by subscription and by `status: 'paid'`, so an
 * open, void or uncollectible invoice can never become a period — that filter is
 * the whole safety property. Among the paid ones the *latest* period wins, which
 * is the one the account would be holding had the write not lost it.
 *
 * `normalizeStripeInvoice` is imported rather than reimplemented so this reads
 * the period from exactly where the webhook reads it: the invoice's line item,
 * not the invoice's own `period_start`/`period_end`, which on a renewal can be a
 * single instant.
 */
async function latestPaidPeriod(subscriptionId: string): Promise<
  { invoiceId: string; periodStart: string | null; periodEnd: string | null } | null
> {
  const invoices = await stripe.invoices.list({
    subscription: subscriptionId,
    status: 'paid',
    limit: 100,
  });

  let best: { invoiceId: string; periodStart: string | null; periodEnd: string | null } | null = null;
  for (const invoice of invoices.data) {
    const normalized = normalizeStripeInvoice(invoice);
    if (!normalized || normalized.status !== 'paid') continue;
    const candidate = {
      invoiceId: normalized.invoiceId,
      periodStart: normalized.periodStart,
      periodEnd: normalized.periodEnd,
    };
    if (!best) { best = candidate; continue; }
    // A comparison, not arithmetic: no date here is ever added to or derived
    // from another. An invoice with no stated period cannot outrank one that has
    // it, so a stated period is always preferred.
    if (candidate.periodEnd && (!best.periodEnd || candidate.periodEnd > best.periodEnd)) {
      best = candidate;
    }
  }
  return best;
}

/** What our own ledger remembers being paid for this subscription. */
async function ledgerPaidCount(userId: string, subscriptionId: string | null): Promise<number | null> {
  const query = admin
    .from('billing_invoices')
    .select('invoice_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['paid', 'refunded', 'partially_refunded', 'disputed']);
  const { count, error } = subscriptionId
    ? await query.eq('subscription_id', subscriptionId)
    : await query;
  if (error) return null;
  return count ?? 0;
}

async function planFor(row: OffendingRow): Promise<Plan> {
  if (row.billing_provider_mode && row.billing_provider_mode !== keyMode) {
    return {
      action: 'skip',
      reason: `row is ${row.billing_provider_mode} mode and this key is ${keyMode}`,
    };
  }

  if (!row.billing_subscription_id) {
    /*
     * No subscription identifier means there is nothing to ask the provider
     * about. If our ledger holds no paid invoice for the account either, then
     * nothing was ever bought and the status is simply false. If it does hold
     * one, the row is ambiguous — a paid purchase whose linkage was lost — and
     * an operator should look at it rather than a script.
     */
    const paid = await ledgerPaidCount(row.user_id, null);
    if (paid === null) return { action: 'skip', reason: 'invoice ledger unreadable' };
    if (paid > 0) {
      return { action: 'skip', reason: `no subscription id, but ${paid} paid invoice(s) in the ledger` };
    }
    return { action: 'expire', reason: 'no subscription id and no paid invoice ever recorded' };
  }

  let paidPeriod;
  try {
    paidPeriod = await latestPaidPeriod(row.billing_subscription_id);
  } catch (error) {
    return { action: 'skip', reason: `provider lookup failed: ${(error as Error).message}` };
  }

  if (!paidPeriod) {
    // Nothing was paid at the provider. Cross-check our own ledger before
    // erasing a claim: the two disagreeing is itself something to look at.
    const paid = await ledgerPaidCount(row.user_id, row.billing_subscription_id);
    if (paid === null) return { action: 'skip', reason: 'invoice ledger unreadable' };
    if (paid > 0) {
      return {
        action: 'skip',
        reason: `provider reports no paid invoice but the ledger holds ${paid} — disagreement, needs a human`,
      };
    }
    return { action: 'expire', reason: 'no paid invoice at the provider or in the ledger' };
  }

  if (!paidPeriod.periodEnd) {
    return {
      action: 'skip',
      reason: `paid invoice ${paidPeriod.invoiceId} states no period — nothing to copy`,
    };
  }

  return {
    action: 'restore',
    reason: `period read from paid invoice ${paidPeriod.invoiceId}`,
    invoiceId: paidPeriod.invoiceId,
    periodStart: paidPeriod.periodStart,
    periodEnd: paidPeriod.periodEnd,
  };
}

/**
 * The write, guarded so it cannot land on a row that has moved.
 *
 * Every update re-states the shape it was planned against — the same status, and
 * a still-absent period. A webhook that repaired the row while this pass was
 * reading the provider therefore wins, and the script reports the row as
 * untouched rather than overwriting a fresher truth.
 */
async function applyPlan(row: OffendingRow, plan: Plan): Promise<'written' | 'moved' | 'failed'> {
  const patch = plan.action === 'restore'
    ? { current_period_start: plan.periodStart, current_period_end: plan.periodEnd }
    : { status: 'expired', tier: 'basic' };

  const { data, error } = await admin
    .from('user_subscriptions')
    .update(patch)
    .eq('user_id', row.user_id)
    .eq('status', row.status)
    .is('current_period_end', null)
    .select('user_id');

  if (error) {
    console.error(`  ! write failed: ${error.message}`);
    return 'failed';
  }
  return (data?.length ?? 0) > 0 ? 'written' : 'moved';
}

async function main(): Promise<void> {
  const { data, error } = await admin
    .from('user_subscriptions')
    .select('user_id, tier, status, billing_provider_mode, billing_subscription_id, billing_collection_method, current_period_start, current_period_end')
    .in('status', ['active', 'past_due'])
    .is('current_period_end', null);

  if (error) {
    console.error('Could not read the offending rows:', error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as OffendingRow[];
  console.info(
    `rows holding a granting status with no period: ${rows.length}`
    + ` | provider key mode: ${keyMode}`
    + ` | ${dryRun ? 'DRY RUN — nothing will be written' : 'APPLYING'}`,
  );
  if (rows.length === 0) return;
  console.info('');

  const tally = { restore: 0, expire: 0, skip: 0, written: 0, moved: 0, failed: 0 };

  for (const row of rows) {
    const plan = await planFor(row);
    tally[plan.action] += 1;

    console.info(`${plan.action.toUpperCase()}  user=${row.user_id}`);
    console.info(
      `  stored: status=${row.status} tier=${row.tier} rail=${row.billing_collection_method ?? 'unknown'}`
      + ` mode=${row.billing_provider_mode ?? 'unknown'} subscription=${row.billing_subscription_id ?? 'none'}`,
    );
    console.info(`  why:    ${plan.reason}`);
    if (plan.action === 'restore') {
      console.info(`  write:  current_period_start=${plan.periodStart ?? 'null'} current_period_end=${plan.periodEnd}`);
    } else if (plan.action === 'expire') {
      console.info(`  write:  status=expired tier=basic (period stays null)`);
    } else {
      console.info('  write:  nothing');
    }

    if (!dryRun && plan.action !== 'skip') {
      const result = await applyPlan(row, plan);
      tally[result] += 1;
      console.info(`  result: ${result === 'moved' ? 'row changed since it was read — left alone' : result}`);
    }
    console.info('');
  }

  console.info(
    `summary: restore=${tally.restore} expire=${tally.expire} skip=${tally.skip}`
    + (dryRun ? ' (dry run)' : ` | written=${tally.written} moved=${tally.moved} failed=${tally.failed}`),
  );
  if (dryRun) {
    console.info('re-run with --apply to write these changes.');
  } else if (tally.skip > 0) {
    console.info(`${tally.skip} row(s) were left for a human. 202608240001 cannot be validated until they are dealt with.`);
  }
}

main().catch((error) => {
  console.error('backfill failed:', error);
  process.exit(1);
});
