import 'server-only';

import { cache } from 'react';
import { createClient } from '@/src/lib/supabase/server';
import { resolveEffectiveTier } from './resolve-effective-tier';
import { SubscriptionRepository } from './repository';
import type { SubscriptionTier } from './subscription-types';
import { resolveTrialState } from './trial';

/** What a page hands its client subtree so every gate reads one resolved answer. */
export interface PageEntitlement {
  tier: SubscriptionTier;
  authenticated: boolean;
  /**
   * Whether the one free Elite trial is still on the table. It decides which
   * call to action the upgrade prompt offers, and only the server can know it.
   */
  trialOffer: 'available' | 'active' | 'used';
}

export const ANONYMOUS_PAGE_ENTITLEMENT: PageEntitlement = {
  tier: 'basic',
  authenticated: false,
  trialOffer: 'available',
};

/**
 * Resolve the reader's entitlement for a page render.
 *
 * One snapshot read answers both questions the page asks — which tier is in
 * force right now, and whether the trial has been spent — so adding the upgrade
 * UX to a page costs one query, not two. Every failure resolves to the Basic
 * surface.
 */
async function resolvePageEntitlementUncached(): Promise<PageEntitlement> {
  const client = await createClient();
  if (!client) return ANONYMOUS_PAGE_ENTITLEMENT;

  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return ANONYMOUS_PAGE_ENTITLEMENT;

  try {
    const snapshot = await new SubscriptionRepository(client).getSnapshot();
    const tier = resolveEffectiveTier(snapshot, snapshot.databaseNow);
    const trialState = resolveTrialState(snapshot, Boolean(user.email_confirmed_at));
    const trialOffer = trialState.kind === 'trialing'
      ? 'active' as const
      : trialState.kind === 'used' || trialState.kind === 'paid'
        ? 'used' as const
        : 'available' as const;
    return { tier, authenticated: true, trialOffer };
  } catch {
    return { tier: 'basic', authenticated: true, trialOffer: 'used' };
  }
}

/**
 * React's server cache is scoped to the current render/request. The root layout
 * and a page may both need the same entitlement, but they must observe one
 * database-clock snapshot and issue only one repository read.
 */
export const resolvePageEntitlement = cache(resolvePageEntitlementUncached);
