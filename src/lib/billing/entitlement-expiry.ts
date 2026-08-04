import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { entitlementExpiredNotification } from '@/src/lib/notifications/account-events';
import { notifyAccount } from '@/src/lib/notifications/dispatch';
import { planNameFor } from './billing-notifications';

/**
 * "Your plan has ended", said once, shortly after it actually ends.
 *
 * A lapse is the one billing event with no webhook behind it: nothing happens at
 * the provider when a paid period simply runs out, so the only way a reader
 * hears about it is a scheduled pass noticing that the timestamp went by. The
 * PromptPay rail already gets 7/3/1-day warnings before that point; this is the
 * notice after it, and it is the one that says the plan is over and the data is
 * not.
 *
 * Two bounds keep it honest:
 *
 *   * a **window**. Only a period that ended in the last few days is announced,
 *     so introducing this feature does not mail every account that ever lapsed.
 *   * a **key on the period**. `billing-expired:<subscription>:<periodEnd>` is
 *     unique per lapse, so re-running the pass every fifteen minutes for three
 *     days produces exactly one Inbox row.
 */

/** How far back a lapse is still news. */
const LOOKBACK_MS = 3 * 86_400_000;

const BATCH = 200;

/** Statuses that mean the period ended by itself rather than being taken away. */
const LAPSED_STATUSES = ['active', 'past_due', 'canceled', 'expired'] as const;

export interface EntitlementExpiryRun {
  notified: number;
  unavailable: number;
}

export async function runEntitlementExpiryNotices(
  client: SupabaseClient<Database>,
  now = new Date(),
): Promise<EntitlementExpiryRun> {
  const result: EntitlementExpiryRun = { notified: 0, unavailable: 0 };
  const windowStart = new Date(now.getTime() - LOOKBACK_MS).toISOString();

  const { data, error } = await client
    .from('user_subscriptions')
    .select('user_id, billing_subscription_id, billing_plan_key, current_period_end, status, trial_ends_at')
    .in('status', [...LAPSED_STATUSES])
    .not('billing_subscription_id', 'is', null)
    .not('current_period_end', 'is', null)
    .gte('current_period_end', windowStart)
    .lte('current_period_end', now.toISOString())
    .order('current_period_end', { ascending: false })
    .limit(BATCH);
  if (error) throw error;

  for (const row of data ?? []) {
    if (!row.billing_subscription_id || !row.current_period_end) continue;
    /*
     * An account inside a running Elite trial is not lapsed, whatever its paid
     * period says — the trial is a separate grant and telling somebody their
     * access ended while they are still using it would simply be wrong.
     */
    if (row.trial_ends_at && Date.parse(row.trial_ends_at) > now.getTime()) continue;

    const delivered = await notifyAccount(
      row.user_id,
      entitlementExpiredNotification({
        subscriptionId: row.billing_subscription_id,
        planName: planNameFor(row.billing_plan_key),
        periodEnd: row.current_period_end,
        // The period's own end, not the moment the pass happened to run: the
        // notice is about a deadline, and the deadline is the trusted fact.
        observedAt: row.current_period_end,
      }),
      client,
    );
    if (delivered) result.notified += 1;
    else result.unavailable += 1;
  }

  return result;
}
