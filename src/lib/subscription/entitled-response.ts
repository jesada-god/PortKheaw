import 'server-only';

import type { NextResponse } from 'next/server';
import type { SubscriptionTier } from './subscription-types';

/**
 * Mark a response whose body depends on the reader's plan.
 *
 * The market-data helpers set a shared `s-maxage` cache header, which is right
 * for a public quote and wrong for anything shaped by entitlement: a CDN or a
 * proxy that kept one reader's Elite chain would hand it to the next reader.
 * This replaces that header with a private, uncacheable one and declares the
 * cookie as the varying input, so no intermediary can key the two together.
 */
export function withEntitledCacheHeaders<T extends NextResponse>(
  response: T,
  tier: SubscriptionTier,
): T {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.delete('CDN-Cache-Control');
  response.headers.delete('Vercel-CDN-Cache-Control');
  const vary = response.headers.get('Vary');
  response.headers.set('Vary', vary && !vary.includes('Cookie') ? `${vary}, Cookie` : 'Cookie');
  // The reader's own plan, on a response only they can receive. It is what makes
  // the shaping verifiable from the network panel during QA.
  response.headers.set('X-Entitlement-Tier', tier);
  return response;
}
