import 'server-only';

import { hasCapability } from '@/src/lib/subscription/capabilities';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { loadMarketSignal } from './service';
import type { MarketSignalResult } from './types';

export interface EntitledMarketSignalDependencies {
  load(symbol: string): Promise<MarketSignalResult>;
}

const DEFAULT_DEPENDENCIES: EntitledMarketSignalDependencies = {
  load: loadMarketSignal,
};

/**
 * Technical Outlook is an Elite server value, not a visually hidden card.
 * Resolve the tier from the request before calling this boundary; a tier below
 * Elite returns `null` without touching candles or running the signal engine.
 */
export async function loadEntitledMarketSignal(
  symbol: string,
  tier: SubscriptionTier,
  dependencies: EntitledMarketSignalDependencies = DEFAULT_DEPENDENCIES,
): Promise<MarketSignalResult | null> {
  if (!hasCapability(tier, 'technical.outlook')) return null;
  return dependencies.load(symbol);
}
