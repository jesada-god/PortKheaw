export const subscriptionTiers = ['basic', 'pro', 'elite'] as const;
export type SubscriptionTier = typeof subscriptionTiers[number];

export const subscriptionStatuses = [
  'basic',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'expired',
] as const;
export type SubscriptionStatus = typeof subscriptionStatuses[number];

export interface SubscriptionRecord {
  userId: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialUsedAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  billingCustomerId: string | null;
  billingSubscriptionId: string | null;
  billingPriceId: string | null;
  founderPromoApplied: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SubscriptionSnapshot extends SubscriptionRecord {
  databaseNow: string;
}
