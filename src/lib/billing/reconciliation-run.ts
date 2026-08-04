import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/src/types/database';
import { zonedClock } from '@/src/lib/notifications/schedule';
import { adminReconciliationNotification } from '@/src/lib/notifications/account-events';
import { notifyAdmins } from '@/src/lib/notifications/dispatch';
import { getBillingConfig } from './billing-server';
import type { TrustedBillingProviderMode } from './billing-provider-mode';
import {
  deadLetterIssue,
  reconcileAccount,
  type ReconciliationAccount,
  type ReconciliationInvoice,
  type ReconciliationIssue,
} from './reconciliation';

/**
 * The daily reconciliation pass, run from the scheduler that already exists.
 *
 * It rides the fifteen-minute alert cron rather than adding a second one, and
 * gates itself on a Bangkok calendar date held in `billing_reconciliation_runs`
 * — the unique index on `(local_date, provider_mode)` is the gate, so two ticks
 * arriving together produce one run rather than two.
 *
 * It reports and never repairs. See `reconciliation.ts` for why that restraint
 * is the design rather than a limitation.
 */

const ACCOUNT_BATCH = 500;
const INVOICE_BATCH = 2_000;
const DEAD_LETTER_BATCH = 100;

export interface ReconciliationRunSummary {
  ran: boolean;
  outcome: 'started' | 'resumed' | 'already_ran' | 'unconfigured' | 'failed';
  checked: number;
  issues: number;
  critical: number;
}

const SKIPPED: ReconciliationRunSummary = {
  ran: false,
  outcome: 'already_ran',
  checked: 0,
  issues: 0,
  critical: 0,
};

/**
 * Whether an account is worth comparing at all.
 *
 * An account that has never touched billing has nothing to reconcile, and
 * fetching every row in the product once a day to prove that would be a large
 * query to learn nothing. The filter is "has a provider identity, a paid status,
 * or an invoice", which is the closure of every state the checks can fire on.
 */
function billingRelevant(row: Database['public']['Tables']['user_subscriptions']['Row']): boolean {
  return Boolean(
    row.billing_customer_id
    || row.billing_subscription_id
    || row.access_revoked_at
    || (row.status !== 'basic' && row.status !== 'trialing'),
  );
}

export async function runBillingReconciliation(
  client: SupabaseClient<Database>,
  now = new Date(),
): Promise<ReconciliationRunSummary> {
  const config = getBillingConfig();
  // With billing unconfigured there is no provider environment to reconcile
  // against, and inventing one would mean comparing live rows to a test mode.
  if (!config) return { ...SKIPPED, outcome: 'unconfigured' };

  const providerMode = config.providerMode;
  const localDate = zonedClock(now, 'Asia/Bangkok').date;

  const { data: startRows, error: startError } = await client.rpc(
    'start_billing_reconciliation_run',
    { input_local_date: localDate, input_provider_mode: providerMode },
  );
  if (startError) throw startError;
  const start = startRows?.[0];
  if (!start || start.outcome === 'already_ran') return SKIPPED;

  const runId = start.run_id;
  let checked = 0;
  const issues: ReconciliationIssue[] = [];

  try {
    const { data: subscriptions, error: subscriptionError } = await client
      .from('user_subscriptions')
      .select('*')
      .eq('billing_provider_mode', providerMode)
      .limit(ACCOUNT_BATCH);
    if (subscriptionError) throw subscriptionError;

    const relevant = (subscriptions ?? []).filter(billingRelevant);
    const invoicesByUser = await loadInvoices(
      client,
      providerMode,
      relevant.map((row) => row.user_id),
    );

    for (const row of relevant) {
      checked += 1;
      const account: ReconciliationAccount = {
        userId: row.user_id,
        tier: row.tier,
        status: row.status,
        providerMode: row.billing_provider_mode,
        collectionMethod: row.billing_collection_method,
        hasCustomer: Boolean(row.billing_customer_id),
        hasSubscription: Boolean(row.billing_subscription_id),
        planKey: row.billing_plan_key,
        currentPeriodStart: row.current_period_start,
        currentPeriodEnd: row.current_period_end,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        latestPaymentStatus: row.latest_payment_status,
        trialEndsAt: row.trial_ends_at,
        accessRevokedAt: row.access_revoked_at,
        accessRevokedReason: row.access_revoked_reason,
        invoices: invoicesByUser.get(row.user_id) ?? [],
      };
      // The database's own clock, read once at the top of the run, so every
      // account in one pass is judged against the same instant.
      issues.push(...reconcileAccount(account, now));
    }

    issues.push(...await loadDeadLetters(client, providerMode));

    for (const issue of issues) {
      const { error } = await client.rpc('record_billing_reconciliation_issue', {
        input_run_id: runId,
        input_dedupe_key: issue.dedupeKey,
        input_issue_type: issue.issueType,
        input_severity: issue.severity,
        input_user_id: issue.userId,
        input_provider_mode: issue.providerMode,
        input_detail: issue.detail as Json,
      });
      if (error) throw error;
    }

    const { error: completeError } = await client.rpc('complete_billing_reconciliation_run', {
      input_run_id: runId,
      input_checked: checked,
      input_issue_count: issues.length,
      input_status: 'completed',
      input_error_code: null,
    });
    if (completeError) throw completeError;

    const critical = issues.filter((issue) => issue.severity === 'critical').length;
    if (issues.length > 0) {
      // One alert per day per mode, whatever the count — the count is in the
      // sentence and the list is on the operations page.
      await notifyAdmins(adminReconciliationNotification({
        localDate,
        providerMode,
        criticalCount: critical,
        totalCount: issues.length,
        observedAt: now.toISOString(),
      }), client);
    }

    return {
      ran: true,
      outcome: start.outcome,
      checked,
      issues: issues.length,
      critical,
    };
  } catch (cause) {
    /*
     * A failed run is marked failed rather than left `running`, so
     * `start_billing_reconciliation_run` picks it up again on the next tick
     * instead of the day being silently skipped. The operator alert for the
     * failure itself is raised by the caller, which knows whether the whole
     * scheduler tick survived.
     */
    await client.rpc('complete_billing_reconciliation_run', {
      input_run_id: runId,
      input_checked: checked,
      input_issue_count: issues.length,
      input_status: 'failed',
      input_error_code: 'reconciliation-failed',
    });
    throw cause;
  }
}

async function loadInvoices(
  client: SupabaseClient<Database>,
  providerMode: TrustedBillingProviderMode,
  userIds: readonly string[],
): Promise<Map<string, ReconciliationInvoice[]>> {
  const byUser = new Map<string, ReconciliationInvoice[]>();
  if (userIds.length === 0) return byUser;

  const { data, error } = await client
    .from('billing_invoices')
    .select('user_id, id, status, amount_paid_minor, amount_refunded_minor, paid_at, period_start, period_end')
    .eq('provider_mode', providerMode)
    .in('user_id', [...userIds])
    .order('issued_at', { ascending: false })
    .limit(INVOICE_BATCH);
  if (error) throw error;

  for (const row of data ?? []) {
    const list = byUser.get(row.user_id) ?? [];
    list.push({
      invoiceRef: row.id,
      status: row.status,
      amountPaidMinor: row.amount_paid_minor,
      amountRefundedMinor: row.amount_refunded_minor,
      paidAt: row.paid_at,
      periodStart: row.period_start,
      periodEnd: row.period_end,
    });
    byUser.set(row.user_id, list);
  }
  return byUser;
}

async function loadDeadLetters(
  client: SupabaseClient<Database>,
  providerMode: TrustedBillingProviderMode,
): Promise<ReconciliationIssue[]> {
  const { data, error } = await client
    .from('billing_webhook_retries')
    .select('provider_mode, provider_event_id, event_type, user_id, attempt_count, last_error_code')
    .eq('provider_mode', providerMode)
    .eq('status', 'dead_letter')
    .order('last_failed_at', { ascending: false })
    .limit(DEAD_LETTER_BATCH);
  if (error) throw error;

  return (data ?? []).map((row) => deadLetterIssue({
    providerMode: row.provider_mode,
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    userId: row.user_id,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
  }));
}
