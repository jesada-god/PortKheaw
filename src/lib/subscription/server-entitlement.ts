import 'server-only';

import { NextResponse } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';
import type { SubscriptionCapability } from './capabilities';
import {
  ANONYMOUS_ENTITLEMENT,
  denyEntitlement,
  entitlementDenialBody,
  type EntitlementDenial,
  type RequestEntitlement,
} from './entitlement-guard';
import { SubscriptionRepository } from './repository';

/**
 * Resolve the caller's entitlement for THIS request.
 *
 * The tier is read from the database through the same repository the
 * subscription centre uses, so a trial that started a second ago is already in
 * force and one that expired a second ago is already gone — the resolver reads
 * the database clock, never a cron job's idea of the time.
 *
 * Every failure resolves to Basic. A caller with no session, a misconfigured
 * Supabase, or a snapshot that could not be read gets the free surface, never
 * the premium one.
 */
export async function resolveRequestEntitlement(): Promise<RequestEntitlement> {
  const client = await createClient();
  if (!client) return ANONYMOUS_ENTITLEMENT;

  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return ANONYMOUS_ENTITLEMENT;

  try {
    return { authenticated: true, tier: await new SubscriptionRepository(client).getEffectiveTier() };
  } catch {
    // A readable session with an unreadable subscription is still a signed-in
    // reader — they simply get nothing premium until the snapshot resolves.
    return { authenticated: true, tier: 'basic' };
  }
}

/**
 * Refusal as an HTTP response, in the same envelope the market-data routes use
 * so existing clients parse it without a special case.
 *
 * `no-store` is not decoration: a refusal is per-reader, and a shared cache that
 * kept it would serve one reader's plan to another.
 */
export function entitlementDenialResponse(denial: EntitlementDenial): NextResponse {
  return NextResponse.json(
    {
      ...entitlementDenialBody(denial),
      meta: {
        provider: null,
        timestamp: new Date().toISOString(),
        freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
      },
    },
    {
      status: denial.status,
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        // Names the refusal so route diagnostics never conflate a plan refusal
        // with a data-provider entitlement refusal, which is also a 403.
        'X-Entitlement-Denial': denial.code,
        'X-Entitlement-Capability': denial.capability,
        ...(denial.requiredTier ? { 'X-Entitlement-Required-Tier': denial.requiredTier } : {}),
      },
    },
  );
}

/**
 * The guard an entitled route opens with. It returns either the refusal to send
 * back — before a single provider call is made — or the resolved entitlement the
 * handler shapes its response with.
 */
export async function guardRouteEntitlement(capability: SubscriptionCapability): Promise<
  { denied: NextResponse; entitlement: null } | { denied: null; entitlement: RequestEntitlement }
> {
  const entitlement = await resolveRequestEntitlement();
  const denial = denyEntitlement(entitlement, capability);
  if (denial) return { denied: entitlementDenialResponse(denial), entitlement: null };
  return { denied: null, entitlement };
}
