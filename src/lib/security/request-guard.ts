import 'server-only';

import { NextResponse } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';
import {
  BURST_POLICIES,
  BurstLimiter,
  clientAddressFromHeaders,
  tooManyRequestsBody,
  tooManyRequestsHeaders,
  type AbuseClass,
  type AbuseIdentity,
} from './abuse-policy';
import {
  consumeLayeredRateLimit,
  type RateLimitScope,
} from './rate-limit';
import { recordSecurityEvent } from './security-audit';

/**
 * The one gate an API route opens with.
 *
 * It runs the two layers in cost order, and the order is the design:
 *
 *   1. **The burst layer**, in this instance's memory, costing nothing. It runs
 *      before the session is resolved and before any provider is touched, so a
 *      flood is refused without becoming database load or a provider bill. This
 *      is what a route calls *first*, ahead of the work.
 *   2. **The sustained layer**, in the database, authoritative across every
 *      instance. It costs a round trip, so only traffic layer 1 already let
 *      through ever reaches it.
 *
 * Layer 2 is deliberately not applied to every class. Ordinary product API
 * traffic (`api`) is bounded by the burst layer alone: a live quote poll is
 * high-volume and per-reader, and putting a database round trip in front of each
 * one would cost more — in latency and in load — than the abuse it prevents,
 * while the class that actually needs stopping (a script) is exactly the traffic
 * the burst layer already catches. The classes where one request buys real work
 * or real consequence — auth, the console, and the expensive endpoints — pay for
 * the round trip and get a limit that holds across instances.
 */

/**
 * One limiter per instance, shared by every route.
 *
 * Module scope is what makes it shared, which is the point: a limiter
 * constructed per request counts to one and refuses nothing. It holds no
 * personal data — the keys are a class, a scope and either an account id or an
 * address, and the whole map is bounded and swept.
 */
const burst = new BurstLimiter();

/** Test seam: drop all in-process burst state between cases. */
export function resetBurstLimiter(): void {
  burst.reset();
}

export interface RequestGuardInput {
  /** The risk class, which is what chooses the burst bound. */
  abuseClass: AbuseClass;
  /**
   * The database-backed scope. Omitted for classes bounded in-process only —
   * see the note above on why `api` does not pay for a round trip.
   */
  scope?: RateLimitScope;
  /** The verified account, when the caller has one. Never read from the request. */
  userId?: string | null;
  /** A non-account subject the action is about (an attempted email address). */
  subject?: string | null;
  /**
   * Distinguishes buckets inside one class, so a burst of quote requests does
   * not spend the budget for chart requests. Defaults to the class.
   */
  operation?: string;
}

export interface RequestGuardResult {
  /** The 429 to return, or `null` when the request may proceed. */
  refusal: NextResponse | null;
  identity: AbuseIdentity;
}

/**
 * Charge one request against both layers.
 *
 * `headers` is taken from the request rather than `next/headers` so this works
 * identically in a route handler, a server action and a test — and so the
 * address is read from the hop the platform appended, never from a value the
 * caller chose.
 */
export async function guardApiRequest(
  request: { headers: Headers },
  input: RequestGuardInput,
): Promise<RequestGuardResult> {
  const identity: AbuseIdentity = {
    userId: input.userId ?? null,
    clientAddress: clientAddressFromHeaders(request.headers),
    subject: input.subject ?? null,
  };
  const operation = input.operation ?? input.abuseClass;

  const burstDecision = burst.consumeIdentity(
    `${input.abuseClass}:${operation}`,
    identity,
    BURST_POLICIES[input.abuseClass],
  );
  if (!burstDecision.allowed) {
    noteThrottled(input, identity);
    return { refusal: tooManyRequestsResponse(burstDecision.retryAfterSeconds), identity };
  }

  if (!input.scope) return { refusal: null, identity };

  const client = await createClient();
  const sustained = await consumeLayeredRateLimit(client, {
    scope: input.scope,
    userId: identity.userId,
    clientAddress: identity.clientAddress,
    subject: identity.subject,
  });
  if (!sustained.allowed) {
    noteThrottled(input, identity);
    return { refusal: tooManyRequestsResponse(sustained.retryAfterSeconds), identity };
  }

  return { refusal: null, identity };
}

/**
 * A refusal, offered to the detection layer.
 *
 * One throttled request is ordinary — a retry loop, an impatient reload — and is
 * deliberately *not* worth a row. The recorder counts them and writes only the
 * first in a window and the one that crosses the rule, so what reaches the audit
 * trail is the pattern rather than the traffic. Without that bound this call
 * would be an amplifier: every cheap refusal would become a database insert into
 * an append-only table.
 *
 * `void`, never awaited. A 429 must not get slower because somebody is watching,
 * and the recorder swallows its own failures.
 *
 * `targetRef` is the class and the scope — both chosen from fixed sets in this
 * application — and never the caller's path or address.
 */
function noteThrottled(input: RequestGuardInput, identity: AbuseIdentity): void {
  void recordSecurityEvent({
    event: 'security.rate_limit.repeated',
    targetRef: `${input.abuseClass}:${input.scope ?? 'burst'}`,
    outcome: 'throttled',
    userId: identity.userId,
  });
}

/**
 * The burst layer on its own, for the hot paths that must not pay for a round
 * trip and for call sites that have no request-scoped Supabase client.
 */
export function guardBurst(
  request: { headers: Headers },
  input: { abuseClass: AbuseClass; operation?: string; userId?: string | null },
): NextResponse | null {
  const identity: AbuseIdentity = {
    userId: input.userId ?? null,
    clientAddress: clientAddressFromHeaders(request.headers),
  };
  const decision = burst.consumeIdentity(
    `${input.abuseClass}:${input.operation ?? input.abuseClass}`,
    identity,
    BURST_POLICIES[input.abuseClass],
  );
  return decision.allowed ? null : tooManyRequestsResponse(decision.retryAfterSeconds);
}

export function tooManyRequestsResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(tooManyRequestsBody(retryAfterSeconds), {
    status: 429,
    headers: tooManyRequestsHeaders(retryAfterSeconds),
  });
}
