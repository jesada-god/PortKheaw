import 'server-only';

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';

/**
 * Server-side rate limiting, shared across instances.
 *
 * The counter lives in the database rather than in this process, because the
 * application runs on serverless functions that share no memory: an in-process
 * limiter would bound one instance and let every other one through, which is not
 * a limit so much as a suggestion.
 *
 * Three properties this module exists to hold:
 *
 *   * **The key carries no personal data.** It is a SHA-256 of a scope plus
 *     either an account id or a client address. What is stored is the digest —
 *     a rate limiter should not double as a log of who acted from where.
 *   * **It works behind a proxy.** On Vercel the socket address is the proxy's,
 *     so the client is taken from `x-forwarded-for`'s *first* hop, which is the
 *     one the platform appends and the one an attacker cannot forge past.
 *   * **It fails open.** A limiter that cannot reach the database must not take
 *     checkout down with it. Every refusal below is a deliberate decision by the
 *     database, never an error; the authorization gates are separate and are what
 *     actually protect the operation.
 */

export const rateLimitScopes = [
  'checkout.start',
  'checkout.promptpay-renewal',
  'billing.portal',
  'support.ticket',
  'support.reply',
  'refund.request',
  'admin.search',
  'admin.mutation',
  'funnel.record',
] as const;
export type RateLimitScope = typeof rateLimitScopes[number];

export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
}

/**
 * The bounds.
 *
 * Chosen to sit well above what a person doing the task legitimately does, and
 * well below what an abusive client wants — the point is to bound cost and abuse,
 * not to police ordinary use. The money paths are the tightest because each one
 * of them creates an object at the provider.
 *
 * Deliberately absent: the Stripe webhook. Rate limiting an inbound webhook would
 * drop legitimate retries, and a dropped retry is a paid invoice that never opens
 * a plan. Its protection is the signature check, which is the correct one.
 */
export const RATE_LIMITS: Readonly<Record<RateLimitScope, RateLimitPolicy>> = {
  'checkout.start': { limit: 8, windowSeconds: 300 },
  'checkout.promptpay-renewal': { limit: 8, windowSeconds: 300 },
  'billing.portal': { limit: 10, windowSeconds: 300 },
  'support.ticket': { limit: 5, windowSeconds: 600 },
  'support.reply': { limit: 20, windowSeconds: 600 },
  'refund.request': { limit: 5, windowSeconds: 600 },
  'admin.search': { limit: 60, windowSeconds: 60 },
  'admin.mutation': { limit: 40, windowSeconds: 60 },
  'funnel.record': { limit: 120, windowSeconds: 60 },
};

/**
 * The client address, as seen through the platform's proxy.
 *
 * `x-forwarded-for` is a list appended to by each hop. A client can send its own
 * value, but the platform appends the address it actually saw, so the *first*
 * entry is the only one worth reading and is what every hop after it agrees on.
 */
export function clientAddressFrom(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || null;
}

/**
 * The client address, when there is a request to read it from.
 *
 * `headers()` throws outside a request scope — a scheduler tick, or a unit test
 * calling a server action directly. That must not turn a rate-limit check into a
 * failed checkout, so the address simply resolves to `null` and the caller is
 * bucketed by account instead, which is the better key anyway.
 */
export async function resolveClientAddress(): Promise<string | null> {
  try {
    const { headers } = await import('next/headers');
    return clientAddressFrom(await headers());
  } catch {
    return null;
  }
}

/**
 * The bucket key: a digest, never the inputs.
 *
 * An account id is preferred over an address — it is stable, it is not shared by
 * everybody behind one NAT, and it is the identity the operation is actually
 * about. A caller with neither is bucketed as `anonymous`, which deliberately
 * pools them: an unauthenticated flood should be bounded in aggregate.
 */
export function rateLimitBucketKey(input: {
  scope: RateLimitScope;
  userId?: string | null;
  clientAddress?: string | null;
}): string {
  const subject = input.userId
    ? `user:${input.userId}`
    : input.clientAddress
      ? `addr:${input.clientAddress}`
      : 'anonymous';
  return createHash('sha256').update(`${input.scope}|${subject}`).digest('hex');
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  /** True when the limiter itself could not be consulted. See `fails open` above. */
  unavailable: boolean;
}

const ALLOWED_UNAVAILABLE: RateLimitResult = {
  allowed: true,
  remaining: 0,
  retryAfterSeconds: 0,
  unavailable: true,
};

/**
 * Consume one unit against a scope.
 *
 * The window and the bound are supplied from `RATE_LIMITS` rather than by the
 * caller, so a call site cannot quietly widen its own limit, and the database
 * clamps both again on the way in.
 */
export async function consumeRateLimit(
  client: SupabaseClient<Database> | null,
  input: { scope: RateLimitScope; userId?: string | null; clientAddress?: string | null },
): Promise<RateLimitResult> {
  if (!client) return ALLOWED_UNAVAILABLE;
  const policy = RATE_LIMITS[input.scope];
  if (!policy) return ALLOWED_UNAVAILABLE;

  try {
    const { data, error } = await client.rpc('consume_rate_limit', {
      input_bucket_key: rateLimitBucketKey(input),
      input_limit: policy.limit,
      input_window_seconds: policy.windowSeconds,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row) return ALLOWED_UNAVAILABLE;
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      retryAfterSeconds: row.retry_after_seconds,
      unavailable: false,
    };
  } catch {
    return ALLOWED_UNAVAILABLE;
  }
}

/** What a reader is told when a limit is reached. Never names the bound. */
export function rateLimitMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(Math.max(retryAfterSeconds, 1) / 60);
  return minutes <= 1
    ? 'คุณทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง'
    : `คุณทำรายการถี่เกินไป กรุณารออีกประมาณ ${minutes} นาที แล้วลองใหม่อีกครั้ง`;
}
