import { capabilityValue, type SubscriptionCapability } from './capabilities';
import type { SubscriptionTier } from './subscription-types';

export type EntitlementErrorCode = 'UPGRADE_REQUIRED' | 'LIMIT_REACHED';

export class EntitlementError extends Error {
  constructor(
    readonly code: EntitlementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EntitlementError';
  }
}

export function requireEntitlement(
  tier: SubscriptionTier,
  capability: SubscriptionCapability,
): void {
  const value = capabilityValue(tier, capability);
  if (typeof value !== 'boolean') {
    throw new TypeError(`Capability ${capability} is a limit, not a boolean entitlement`);
  }
  if (!value) throw new EntitlementError('UPGRADE_REQUIRED', `Upgrade required for ${capability}`);
}
