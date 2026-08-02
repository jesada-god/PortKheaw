import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { resolveEffectiveTier } from './resolve-effective-tier';
import type { SubscriptionSnapshot, SubscriptionTier } from './subscription-types';

type SnapshotRow = Database['public']['Functions']['get_my_subscription_snapshot']['Returns'][number];

function mapSnapshot(row: SnapshotRow): SubscriptionSnapshot {
  return {
    userId: row.user_id,
    tier: row.tier,
    status: row.status,
    trialStartedAt: row.trial_started_at,
    trialEndsAt: row.trial_ends_at,
    trialUsedAt: row.trial_used_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    billingCustomerId: row.billing_customer_id,
    billingSubscriptionId: row.billing_subscription_id,
    billingPriceId: row.billing_price_id,
    founderPromoApplied: row.founder_promo_applied,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    databaseNow: row.database_now,
  };
}

export class SubscriptionRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async getSnapshot(): Promise<SubscriptionSnapshot> {
    const { data, error } = await this.client.rpc('get_my_subscription_snapshot');
    if (error) throw error;
    const row = data?.[0];
    if (!row) throw new Error('Authenticated subscription snapshot was not found');
    return mapSnapshot(row);
  }

  async getEffectiveTier(): Promise<SubscriptionTier> {
    const snapshot = await this.getSnapshot();
    return resolveEffectiveTier(snapshot, snapshot.databaseNow);
  }
}
