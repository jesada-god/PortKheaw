'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { hasCapability, type SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import { recordPaywallEvent } from '@/src/lib/subscription/paywall-telemetry';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { upgradeTargetTier } from '@/src/lib/subscription/upgrade-copy';
import { UpgradeModal } from './UpgradeModal';

/**
 * Whether this reader has ever spent the one free Elite trial. Resolved on the
 * server from the subscription snapshot, because it decides which call to action
 * the prompt offers and a browser cannot be trusted with it.
 */
export type TrialOffer = 'available' | 'active' | 'used';

export interface EntitlementContextValue {
  tier: SubscriptionTier;
  authenticated: boolean;
  trialOffer: TrialOffer;
  /** True when the reader's effective tier carries the capability. */
  can(capability: SubscriptionCapability): boolean;
  /** Open the shared upgrade prompt for a capability the reader does not have. */
  requestUpgrade(request: { capability: SubscriptionCapability; source: string }): void;
}

/**
 * The default is Basic and signed-out on purpose. A subtree that forgot its
 * provider shows the free surface rather than a premium one, so the failure mode
 * of a wiring mistake is a locked feature, never a leaked one.
 */
const FALLBACK: EntitlementContextValue = {
  tier: 'basic',
  authenticated: false,
  trialOffer: 'available',
  can: () => false,
  requestUpgrade: () => undefined,
};

const EntitlementContext = createContext<EntitlementContextValue>(FALLBACK);

export interface EntitlementProviderProps {
  tier: SubscriptionTier;
  authenticated: boolean;
  trialOffer: TrialOffer;
  children: ReactNode;
}

/**
 * One entitlement source and one upgrade prompt per page.
 *
 * The tier arrives already resolved from the server, so nothing in the browser
 * decides it, and every gate in the subtree reads the same value. The prompt is
 * mounted once here rather than beside each gate: a page with a dozen locked
 * surfaces still has exactly one dialog in the DOM.
 */
export function EntitlementProvider({ tier, authenticated, trialOffer, children }: EntitlementProviderProps) {
  const [prompt, setPrompt] = useState<{ capability: SubscriptionCapability; source: string } | null>(null);

  const requestUpgrade = useCallback((request: { capability: SubscriptionCapability; source: string }) => {
    setPrompt(request);
    recordPaywallEvent({
      event: 'paywall_viewed',
      capability: request.capability,
      source: request.source,
      requiredTier: upgradeTargetTier(request.capability),
      currentTier: tier,
    });
  }, [tier]);

  const value = useMemo<EntitlementContextValue>(() => ({
    tier,
    authenticated,
    trialOffer,
    can: (capability) => hasCapability(tier, capability),
    requestUpgrade,
  }), [tier, authenticated, trialOffer, requestUpgrade]);

  return (
    <EntitlementContext.Provider value={value}>
      {children}
      <UpgradeModal
        request={prompt}
        currentTier={tier}
        trialOffer={trialOffer}
        onClose={() => setPrompt(null)}
      />
    </EntitlementContext.Provider>
  );
}

export function useEntitlement(): EntitlementContextValue {
  return useContext(EntitlementContext);
}

/** The common case: "may this reader use X?" without pulling in the rest. */
export function useCapability(capability: SubscriptionCapability): boolean {
  return useContext(EntitlementContext).can(capability);
}
