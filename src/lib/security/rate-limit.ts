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
  // --- Class A: the credential-bearing entry forms -------------------------
  'auth.sign-in',
  'auth.sign-up',
  'auth.password-reset',
  'auth.password-update',
  // --- Class B/C: the operator console -------------------------------------
  'admin.read',
  // --- Class D: work that costs CPU seconds or provider quota ---------------
  'simulator.compute',
  'analytics.expensive',
  // --- Class E: ordinary product API traffic --------------------------------
  'api.standard',
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
  /*
   * The tightest budget of any authenticated class, and deliberately so. These
   * are the operations that change what other people may do — a role, a plan
   * override, the maintenance switch — and there is no operator workflow that
   * needs more than one every three seconds sustained. A stolen operator session
   * is worth far less when it can only spend it twenty times a minute.
   */
  'admin.mutation': { limit: 20, windowSeconds: 60 },
  'funnel.record': { limit: 120, windowSeconds: 60 },

  /*
   * The auth forms. Bounded per address AND per attempted address (see
   * `consumeLayeredRateLimit`), because those catch different attacks: one
   * machine trying a thousand passwords, and a thousand machines trying one
   * account. Supabase applies its own project-level limits; these are the
   * per-identity ones it does not have.
   */
  'auth.sign-in': { limit: 10, windowSeconds: 300 },
  'auth.sign-up': { limit: 6, windowSeconds: 3_600 },
  'auth.password-reset': { limit: 5, windowSeconds: 900 },
  'auth.password-update': { limit: 8, windowSeconds: 900 },

  'admin.read': { limit: 90, windowSeconds: 60 },

  /*
   * Expensive work. A Monte Carlo run is CPU seconds the platform pays for, and
   * an options-chain assembly is provider quota; both are worth a tight bound
   * even for an entitled caller, because entitlement is not the same as intent.
   */
  'simulator.compute': { limit: 30, windowSeconds: 60 },
  'analytics.expensive': { limit: 60, windowSeconds: 60 },

  'api.standard': { limit: 300, windowSeconds: 60 },
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
  /**
   * A non-account subject the action is about — the email address a sign-in is
   * being attempted against. It sits between the two because it is more specific
   * than an address and less trustworthy than a verified account id: it is what
   * the caller *claims* to be acting on, which is exactly what makes it the key
   * that sees one account being attacked from a thousand addresses.
   */
  subject?: string | null;
}): string {
  const bucket = input.userId
    ? `user:${input.userId}`
    : input.subject
      ? `subject:${input.subject.trim().toLowerCase()}`
      : input.clientAddress
        ? `addr:${input.clientAddress}`
        : 'anonymous';
  return createHash('sha256').update(`${input.scope}|${bucket}`).digest('hex');
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
  input: {
    scope: RateLimitScope;
    userId?: string | null;
    clientAddress?: string | null;
    subject?: string | null;
  },
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

/**
 * Consume against **every** identity the caller has, and report the tightest
 * refusal.
 *
 * A single-key limiter has to choose which identity to trust, and every choice
 * is wrong somewhere. Keying by account leaves the sign-in form — where there is
 * no account yet — unbounded. Keying by address pools a whole campus behind one
 * budget and gives anyone with a proxy pool as many budgets as they like. Keying
 * by the *attempted* address is the only thing that sees credential stuffing,
 * and it is not an identity the caller has at all.
 *
 * So all of them are counted separately. The call is refused if any single
 * bucket is over, and — this is the part that matters — every bucket is charged
 * even once one has refused. Returning early would mean a caller who is over
 * their account budget spends nothing against their address budget, and rotating
 * whichever key is cheapest is precisely how a layered limiter with an early
 * return gets walked around.
 *
 * Buckets are consumed in one round trip each, in parallel. Fails open, for the
 * same reason the single-key path does: the authorization gates are the boundary,
 * this is the bound.
 */
export async function consumeLayeredRateLimit(
  client: SupabaseClient<Database> | null,
  input: {
    scope: RateLimitScope;
    userId?: string | null;
    clientAddress?: string | null;
    /** A subject the action is *about* — the email a sign-in is attempted against. */
    subject?: string | null;
  },
): Promise<RateLimitResult> {
  if (!client) return ALLOWED_UNAVAILABLE;

  const layers: Array<{ userId?: string | null; clientAddress?: string | null; subject?: string | null }> = [];
  if (input.userId) layers.push({ userId: input.userId });
  if (input.subject) layers.push({ subject: input.subject });
  if (input.clientAddress) layers.push({ clientAddress: input.clientAddress });
  // Nothing identifying at all: the shared anonymous bucket, pooled on purpose.
  if (layers.length === 0) layers.push({});

  const results = await Promise.all(
    layers.map((layer) => consumeRateLimit(client, { scope: input.scope, ...layer })),
  );

  let worst: RateLimitResult | null = null;
  for (const result of results) {
    if (result.allowed) continue;
    if (!worst || result.retryAfterSeconds > worst.retryAfterSeconds) worst = result;
  }
  if (worst) return worst;

  const remaining = Math.min(...results.map((result) => result.remaining));
  return {
    allowed: true,
    remaining: Number.isFinite(remaining) ? remaining : 0,
    retryAfterSeconds: 0,
    unavailable: results.every((result) => result.unavailable),
  };
}

/** What a reader is told when a limit is reached. Never names the bound. */
export function rateLimitMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(Math.max(retryAfterSeconds, 1) / 60);
  return minutes <= 1
    ? 'คุณทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง'
    : `คุณทำรายการถี่เกินไป กรุณารออีกประมาณ ${minutes} นาที แล้วลองใหม่อีกครั้ง`;
}
