/**
 * The one decision every premium path makes, written once.
 *
 * Nothing here reads a request, a cookie or a database — it takes an already
 * resolved entitlement and a capability and answers whether the caller may
 * proceed. That keeps the rule pure and testable, and lets the API routes, the
 * server components and the browser fetchers all agree by construction instead
 * of by convention.
 *
 * The guard fails closed on purpose: an unresolved subscription is Basic, and
 * Basic is refused wherever the capability is not in the matrix.
 */

import { hasCapability, requiredTierFor, type SubscriptionCapability } from './capabilities';
import type { SubscriptionTier } from './subscription-types';

/** What the server knows about the caller before any capability is considered. */
export interface RequestEntitlement {
  /** False for an anonymous visitor. Their effective tier is still `basic`. */
  authenticated: boolean;
  tier: SubscriptionTier;
}

export const ANONYMOUS_ENTITLEMENT: RequestEntitlement = { authenticated: false, tier: 'basic' };

export type EntitlementDenialCode = 'AUTHENTICATION_REQUIRED' | 'UPGRADE_REQUIRED';

export interface EntitlementDenial {
  code: EntitlementDenialCode;
  capability: SubscriptionCapability;
  /** The cheapest plan that carries the capability — derived from the matrix. */
  requiredTier: SubscriptionTier | null;
  status: 401 | 403;
  message: string;
}

const AUTHENTICATION_MESSAGE = 'กรุณาเข้าสู่ระบบก่อนใช้ฟีเจอร์นี้';

const TIER_NAME: Record<SubscriptionTier, string> = { basic: 'Basic', pro: 'Pro', elite: 'Elite' };

export function upgradeMessage(requiredTier: SubscriptionTier | null): string {
  return requiredTier && requiredTier !== 'basic'
    ? `ฟีเจอร์นี้ใช้ได้ในแพ็กเกจ ${TIER_NAME[requiredTier]} ขึ้นไป`
    : 'ฟีเจอร์นี้ยังไม่เปิดให้ใช้กับแพ็กเกจปัจจุบัน';
}

/**
 * `null` means proceed. Otherwise the returned denial is the whole answer: its
 * status, code and required tier are what the route responds with and what the
 * upgrade prompt reads, so the two can never describe different plans.
 *
 * An anonymous caller is refused with an authentication error rather than an
 * upgrade prompt, because signing in is the step that could actually change the
 * outcome. A capability every tier has (`chart.sr.levels`) is never refused, so
 * a signed-out reader keeps the Basic surface they already had.
 */
export function denyEntitlement(
  entitlement: RequestEntitlement,
  capability: SubscriptionCapability,
): EntitlementDenial | null {
  const requiredTier = requiredTierFor(capability);
  if (hasCapability(entitlement.tier, capability)) return null;
  if (!entitlement.authenticated) {
    return {
      code: 'AUTHENTICATION_REQUIRED',
      capability,
      requiredTier,
      status: 401,
      message: AUTHENTICATION_MESSAGE,
    };
  }
  return {
    code: 'UPGRADE_REQUIRED',
    capability,
    requiredTier,
    status: 403,
    message: upgradeMessage(requiredTier),
  };
}

/**
 * The wire shape of a refusal. Deliberately narrow: a code, the capability that
 * failed and the plan that would carry it. No provider data, no subscription
 * record, no identifiers — a refusal must not become a side channel.
 */
export interface EntitlementDenialBody {
  data: null;
  error: {
    code: EntitlementDenialCode;
    capability: SubscriptionCapability;
    requiredTier: SubscriptionTier | null;
    message: string;
    retryable: false;
  };
}

export function entitlementDenialBody(denial: EntitlementDenial): EntitlementDenialBody {
  return {
    data: null,
    error: {
      code: denial.code,
      capability: denial.capability,
      requiredTier: denial.requiredTier,
      message: denial.message,
      retryable: false,
    },
  };
}

/** Recognises a refusal in a response body the browser received. */
export function readEntitlementDenial(payload: unknown): {
  code: EntitlementDenialCode;
  capability: SubscriptionCapability | null;
  requiredTier: SubscriptionTier | null;
  message: string;
} | null {
  const error = (payload as { error?: Record<string, unknown> } | null)?.error;
  const code = error?.code;
  if (code !== 'AUTHENTICATION_REQUIRED' && code !== 'UPGRADE_REQUIRED') return null;
  const capability = typeof error?.capability === 'string'
    ? error.capability as SubscriptionCapability
    : null;
  const requiredTier = error?.requiredTier === 'pro' || error?.requiredTier === 'elite' || error?.requiredTier === 'basic'
    ? error.requiredTier
    : null;
  return {
    code,
    capability,
    requiredTier,
    message: typeof error?.message === 'string' ? error.message : upgradeMessage(requiredTier),
  };
}
