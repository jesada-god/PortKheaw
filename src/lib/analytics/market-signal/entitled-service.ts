import 'server-only';

import { hasCapability, type SubscriptionCapability } from '@/src/lib/subscription/capabilities';
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
 * Technical Outlook is a SERVER value, not a visually hidden card.
 *
 * Resolve the tier from the request before calling this boundary; a tier that
 * does not carry the capability returns `null` without touching candles or
 * running the signal engine, so an unentitled reader's page contains no result
 * to be found in the payload.
 *
 * `capability` is which row of the matrix pays for this instrument's signal, and
 * it is passed in rather than assumed here — an equity is sold the outlook at
 * Elite, a commodity contract at Pro, and this boundary must enforce whichever
 * one the page is actually about. It comes from
 * `resolveAssetPresentationPolicy`, the same answer the client reads to decide
 * whether to draw the padlock, so the server gate and the painted gate cannot
 * name different capabilities. Defaulted to the equity row so every existing
 * caller keeps the behaviour it had.
 */
export async function loadEntitledMarketSignal(
  symbol: string,
  tier: SubscriptionTier,
  capability: SubscriptionCapability = 'technical.outlook',
  dependencies: EntitledMarketSignalDependencies = DEFAULT_DEPENDENCIES,
): Promise<MarketSignalResult | null> {
  if (!hasCapability(tier, capability)) return null;
  return dependencies.load(symbol);
}
