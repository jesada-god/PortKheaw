import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { clientAddressFromHeaders } from './abuse-policy';
import {
  detectSecurityAlert,
  SECURITY_ALERT_RULES,
  SecurityEventCounter,
  type SecurityEventKey,
  type SecurityOutcome,
} from './security-events';

/**
 * Recording a security event from the edge.
 *
 * Middleware is where the events that matter most are actually caught — a
 * non-operator reaching the console is refused there, before a renderer exists —
 * so the recorder has to work there too. It cannot be the Node one:
 * `security-audit.ts` imports `server-only`, `node:crypto` and `next/headers`,
 * none of which exist in an Edge isolate. So this is a second, smaller writer
 * against the same routine, taking the Supabase client middleware has already
 * built rather than constructing one.
 *
 * **The write is bounded, and that is the whole design of this file.**
 *
 * A recorder that wrote a row per refused request would hand an attacker an
 * amplifier: flood `/admin`, and each refusal — already cheap for us — becomes a
 * database insert we pay for, in a table that is append-only and therefore
 * cannot be cleaned up afterwards. So an identity's first occurrence in a window
 * is written, the occurrence that crosses the alert threshold is written, and
 * everything between them is counted in memory and dropped. Two rows per
 * identity per window is enough to reconstruct an incident and is not enough to
 * be worth attacking.
 *
 * The failure mode is silence. Every path swallows: this runs inside a refusal,
 * and a recorder that throws would turn a clean 404 into a 500 and hand the
 * attacker a working denial of service through the logger.
 */

/**
 * Per-isolate, and understood to be. Vercel runs many edge isolates sharing no
 * memory, so this under-counts the fleet — which makes it conservative in the
 * right direction: it never reports a rate higher than what really happened.
 */
const counter = new SecurityEventCounter(5_000);

/** Test seam: drop all in-isolate detection state between cases. */
export function resetEdgeSecurityCounter(): void {
  counter.reset();
}

export interface EdgeSecurityEventInput {
  event: SecurityEventKey;
  /**
   * A safe reference: the route class this happened on. Passed by this
   * application from a fixed set, never echoed from the caller's URL — an
   * attacker-chosen path written into an audit row is an attacker-chosen string
   * in an append-only table.
   */
  targetRef: string;
  outcome: SecurityOutcome;
  headers: Headers;
  /** The verified account, when middleware has resolved one. */
  userId?: string | null;
}

/**
 * Record one event. Returns a promise the caller may ignore — and middleware
 * does ignore it, deliberately: an audit write must not add a round trip to the
 * latency of a refusal.
 */
export async function recordEdgeSecurityEvent(
  client: SupabaseClient<Database>,
  input: EdgeSecurityEventInput,
): Promise<void> {
  try {
    const rule = Object.values(SECURITY_ALERT_RULES)
      .find((candidate) => candidate.event === input.event);
    const windowMs = rule?.windowMs ?? 60_000;

    /*
     * The account when there is one, the address otherwise. Neither is stored:
     * this key lives in a bounded in-memory map and never reaches the audit row,
     * which carries only `auth.uid()` as resolved inside the database.
     */
    const address = clientAddressFromHeaders(input.headers);
    const identity = input.userId
      ? `user:${input.userId}`
      : address ? `addr:${address}` : 'anonymous';

    const count = counter.observe(`${input.event}|${identity}`, windowMs);
    const alert = detectSecurityAlert({ event: input.event, count });

    // First in the window, or the one that crossed the rule. See the note above.
    if (count !== 1 && !(alert && count === alert.threshold)) return;

    await client.rpc('record_security_event', {
      input_event_key: input.event,
      input_target_ref: input.targetRef,
      input_observed_count: count,
      input_outcome: input.outcome,
      input_request_id: safeRequestId(input.headers),
    });
  } catch {
    // Silence. See the note above on why a throwing recorder is a vulnerability.
  }
}

/**
 * The platform's request id, narrowed to characters an identifier may contain.
 *
 * It arrives in a header, which makes it caller-controlled, so it is filtered
 * rather than trusted — an audit row is not a place to let somebody write
 * arbitrary bytes. An absent or unusable value is simply `null`; inventing one
 * here would produce an id that correlates with nothing.
 */
function safeRequestId(headers: Headers): string | null {
  const supplied = headers.get('x-request-id') ?? headers.get('x-vercel-id');
  const normalized = supplied?.trim().replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 64);
  return normalized || null;
}
