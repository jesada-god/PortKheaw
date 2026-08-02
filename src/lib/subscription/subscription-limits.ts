import { capabilityValue } from './capabilities';
import type { SubscriptionTier } from './subscription-types';

export type EntitledPortfolioType = 'STOCK' | 'OPTION';

export interface PortfolioCreationEntitlement {
  canCreate: boolean;
  maxCount: number;
}

export function portfolioCreationEntitlement(
  tier: SubscriptionTier,
  type: EntitledPortfolioType,
): PortfolioCreationEntitlement {
  if (type === 'STOCK') {
    return {
      canCreate: capabilityValue(tier, 'portfolio.stock.create'),
      maxCount: capabilityValue(tier, 'portfolio.stock.max_count'),
    };
  }
  return {
    canCreate: capabilityValue(tier, 'portfolio.options.create'),
    maxCount: capabilityValue(tier, 'portfolio.options.max_count'),
  };
}
