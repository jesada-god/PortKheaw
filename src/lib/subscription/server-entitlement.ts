import 'server-only';

import { NextResponse } from 'next/server';
import { recordBetaFunnelEvent } from '@/src/lib/beta/beta-server';
import { resolveRequestAccountAccess } from './account-access';
import type { SubscriptionCapability } from './capabilities';
import {
  denyEntitlement,
  entitlementDenialBody,
  type EntitlementDenial,
  type RequestEntitlement,
} from './entitlement-guard';

/**
 * Resolve the caller's entitlement for THIS request.
 *
 * The tier is the *effective access* tier from the one trusted account
 * resolver, so a trial that started a second ago is already in force, one that
 * expired a second ago is already gone, and an administrator previewing Basic is
 * refused exactly what a Basic reader is refused. It reads the database clock,
 * never a cron job's idea of the time.
 *
 * Every failure resolves to Basic. A caller with no session, a misconfigured
 * Supabase, or a snapshot that could not be read gets the free surface, never
 * the premium one.
 */
export async function resolveRequestEntitlement(): Promise<RequestEntitlement> {
  const access = await resolveRequestAccountAccess();
  return { authenticated: access.authenticated, tier: access.effectiveAccessTier };
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
  const access = await resolveRequestAccountAccess();
  const entitlement: RequestEntitlement = {
    authenticated: access.authenticated,
    tier: access.effectiveAccessTier,
  };
  const denial = denyEntitlement(entitlement, capability);

  /*
   * The rollout funnel's two feature signals, taken here because this is the one
   * place both facts are already true and server-verified: a refusal really was a
   * refusal, and a grant really was somebody using a feature. Reading either from
   * a browser would mean trusting a client to report its own paywalls.
   *
   * `feature_used_before_purchase` is narrowed to accounts that have not bought
   * anything — read from `subscriptionEffectiveTier`, the plan actually held,
   * never from the access tier. Using the access tier would count every Elite
   * subscriber, and every administrator, as somebody "using a feature before
   * purchase", which is the opposite of what the report is for.
   *
   * Both are deduplicated per account, per feature, per Bangkok day inside the
   * database, so a chart that polls does not become a thousand rows. Neither is
   * awaited: telemetry must never delay or fail a data response.
   */
  if (access.authenticated) {
    const beforePurchase = access.subscriptionEffectiveTier === 'basic' && !access.isAdmin;
    if (denial || beforePurchase) {
      void recordBetaFunnelEvent(
        denial
          ? { event: 'paywall_blocked', featureKey: capability }
          : { event: 'feature_used_before_purchase', featureKey: capability },
      ).catch(() => {});
    }
  }

  if (denial) return { denied: entitlementDenialResponse(denial), entitlement: null };
  return { denied: null, entitlement };
}
