import 'server-only';

import { createClient } from '@/src/lib/supabase/server';
import { captureServerError } from '@/src/lib/monitoring/report';
import { resolveRequestId } from '@/src/lib/monitoring/request-id';
import { resolveClientAddress } from '@/src/lib/security/rate-limit';
import {
  detectSecurityAlert,
  SECURITY_ALERT_RULES,
  SecurityEventCounter,
  type SecurityEventKey,
  type SecurityOutcome,
} from './security-events';

/**
 * Recording a security-relevant event.
 *
 * Two destinations, deliberately, because they answer different questions:
 *
 *   * **`admin_audit_events`** is the durable record an incident is reconstructed
 *     from afterwards. It is append-only by trigger, revoked from every client
 *     role, and outlives the accounts it describes.
 *   * **`captureServerError`** is the thing somebody might actually see while it
 *     is happening — a structured line in the platform's log today, a Sentry
 *     event the day a DSN is configured.
 *
 * Neither is a notification system, and that is on purpose. Eight conditions did
 * not justify a pager pipeline with its own credentials, its own delivery
 * failures and its own silent death; they justified writing the evidence where
 * the evidence already goes.
 *
 * **Nothing here can throw.** This is called from inside authorization failure
 * paths — the moment a request is already being refused — and a recorder that
 * turns a clean 404 into a 500 has converted an attacker's failed probe into a
 * working denial of service. Every path below swallows.
 *
 * **What is never recorded.** No password, no token, no cookie, no API key, no
 * request body, no mailbox, no client address. `targetRef` is a route, a limiter
 * scope or a class name — chosen by this application, never echoed from the
 * caller — and the database truncates it to 160 characters and stores nothing
 * else free-form. The actor is `auth.uid()`, resolved inside the database, so a
 * caller cannot record an event as somebody else.
 */

/**
 * The two events where every single occurrence is worth its own row.
 *
 * Both are individually consequential and neither happens at a rate anybody can
 * force: a destructive console action and a privileged override of what an
 * account may open. Summarising these would lose the thing an incident is
 * actually reconstructed from — *which* accounts were touched, and in what
 * order.
 *
 * Everything else is bounded: an identity's first occurrence in the rule's
 * window is written, the occurrence that crosses the alert threshold is written,
 * and the ones between are counted in memory and dropped. That is not tidiness.
 * A recorder that wrote a row per refused request would be an amplifier — flood
 * the console, and each cheap refusal becomes a database insert into a table
 * that is append-only and therefore cannot be cleaned up afterwards. Two rows
 * per identity per window is enough to reconstruct an incident and is not enough
 * to be worth attacking.
 */
const PERSIST_EVERY_OCCURRENCE: ReadonlySet<SecurityEventKey> = new Set<SecurityEventKey>([
  'admin.destructive.performed',
  'security.subscription.override',
]);

/**
 * In-process, per-instance, and that is understood.
 *
 * Vercel runs many isolates that share no memory, so a threshold counted here is
 * counted per instance and the real rate across the fleet is higher than what any
 * one of them sees. That makes this detection *conservative* — it under-reports
 * and never over-reports — which is the correct direction for a signal a person
 * has to trust at 03:00. The authoritative, cross-instance counting is the
 * database limiter in `rate-limit.ts`; this is the layer that decides when a
 * pattern is worth a row, and it costs no round trip to do it.
 */
const counter = new SecurityEventCounter();

/** Test seam: drop all in-process detection state between cases. */
export function resetSecurityEventCounter(): void {
  counter.reset();
}

export interface SecurityEventInput {
  event: SecurityEventKey;
  /**
   * A safe reference for what the event is about: a route, a limiter scope, a
   * class name. Never an address, a mailbox, a token or anything echoed from the
   * caller's input.
   */
  targetRef: string;
  outcome: SecurityOutcome;
  /**
   * The account the event is about, when there is one. Used only to key the
   * in-process counter — the row's actor is resolved inside the database from
   * `auth.uid()` and is never taken from here.
   */
  userId?: string | null;
}

/**
 * Record one event, detect whether it has become a condition, and report it if
 * it has.
 *
 * Returns nothing and rejects never. Callers `await` it where they can and
 * deliberately do not where the calling path is a refusal that must stay fast.
 */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    const identity = await counterIdentity(input.userId);
    const rule = ruleWindowFor(input.event);
    const count = counter.observe(`${input.event}|${identity}`, rule);
    const alert = detectSecurityAlert({ event: input.event, count });

    if (alert) {
      /*
       * `warning` for a condition, `error` for a critical one, so the two are
       * distinguishable in a log without reading the message. Every value here
       * is on the monitoring context allowlist, which is what guarantees this
       * report cannot carry anything the allowlist has not approved.
       */
      captureServerError({
        scope: 'security.alert',
        level: alert.severity === 'critical' ? 'error' : 'warning',
        message: `${alert.event}: ${alert.meaning}`,
        context: {
          code: alert.event,
          route: input.targetRef,
          outcome: input.outcome,
          attempt: alert.count,
          status: alert.severity,
        },
      });
    }

    const worthARow = PERSIST_EVERY_OCCURRENCE.has(input.event)
      || count === 1
      || (alert !== null && count === alert.threshold);
    if (!worthARow) return;

    const client = await createClient();
    if (!client) return;
    await client.rpc('record_security_event', {
      input_event_key: input.event,
      input_target_ref: input.targetRef,
      input_observed_count: count,
      input_outcome: input.outcome,
      input_request_id: await resolveRequestId(),
    });
  } catch {
    /*
     * Swallowed, always. This runs inside paths that are already refusing a
     * request; a recorder that throws here turns a clean refusal into a 500 and
     * hands an attacker a way to break the product by tripping the logger.
     */
  }
}

/**
 * The key the in-process counter groups by.
 *
 * The account when there is one, because that is the identity the event is
 * actually about. Otherwise the client address, because the events worth
 * counting for a signed-out caller — probing the console, hammering a form — have
 * no account by definition. Neither value is stored: this key lives in a bounded
 * in-memory map and never reaches the database, the audit row or a report.
 */
async function counterIdentity(userId: string | null | undefined): Promise<string> {
  if (userId) return `user:${userId}`;
  const address = await resolveClientAddress();
  return address ? `addr:${address}` : 'anonymous';
}

/**
 * The window an event is counted in, taken from its rule.
 *
 * An event with no rule is counted in a minute — it is never alerted on, so the
 * window only decides what number appears in `observedCount`, and a minute is
 * the most readable answer to "how often was this happening at the time".
 */
function ruleWindowFor(event: SecurityEventKey): number {
  const rule = Object.values(SECURITY_ALERT_RULES)
    .find((candidate) => candidate.event === event);
  return rule?.windowMs ?? 60_000;
}
