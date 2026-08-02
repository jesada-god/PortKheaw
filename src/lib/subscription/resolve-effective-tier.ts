import type { SubscriptionRecord, SubscriptionTier } from './subscription-types';

function isAfter(value: string | null, boundary: string): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  const boundaryTimestamp = Date.parse(boundary);
  return Number.isFinite(timestamp)
    && Number.isFinite(boundaryTimestamp)
    && timestamp > boundaryTimestamp;
}

export function resolveEffectiveTier(
  subscription: Pick<SubscriptionRecord, 'tier' | 'status' | 'trialEndsAt' | 'currentPeriodEnd'> | null,
  currentTime: string,
): SubscriptionTier {
  if (!subscription) return 'basic';
  if (subscription.status === 'trialing' && isAfter(subscription.trialEndsAt, currentTime)) return 'elite';
  if (subscription.status === 'active' && isAfter(subscription.currentPeriodEnd, currentTime)) {
    return subscription.tier;
  }
  return 'basic';
}
