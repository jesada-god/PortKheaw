import type { SubscriptionRecord, SubscriptionTier } from './subscription-types';

function isAfter(value: string | null, boundary: string): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  const boundaryTimestamp = Date.parse(boundary);
  return Number.isFinite(timestamp)
    && Number.isFinite(boundaryTimestamp)
    && timestamp > boundaryTimestamp;
}

/**
 * The statuses that open the purchased tier while the paid period is still
 * running.
 *
 * `past_due` is here deliberately. A failed renewal starts the provider's
 * dunning retries, and access continues to the end of the period already paid
 * for rather than being cut off mid-month — but only to the end of it, because
 * the bound is a timestamp the provider set. When the provider gives up it sends
 * a status that maps to `canceled` or `expired`, neither of which is on this
 * list.
 *
 * `resolve_effective_subscription_tier` in the database implements the same
 * rule, and a test asserts the two lists agree.
 */
const TIER_GRANTING_STATUSES = ['active', 'past_due'] as const;

export function resolveEffectiveTier(
  subscription: Pick<SubscriptionRecord, 'tier' | 'status' | 'trialEndsAt' | 'currentPeriodEnd'> | null,
  currentTime: string,
): SubscriptionTier {
  if (!subscription) return 'basic';
  if (subscription.status === 'trialing' && isAfter(subscription.trialEndsAt, currentTime)) return 'elite';
  if (
    (TIER_GRANTING_STATUSES as readonly string[]).includes(subscription.status)
    && isAfter(subscription.currentPeriodEnd, currentTime)
  ) {
    return subscription.tier;
  }
  return 'basic';
}
