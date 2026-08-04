/**
 * Bounded retry for webhook deliveries that fail on our side.
 *
 * The provider owns the transport schedule: we cannot make Stripe redeliver
 * sooner or later than it chooses, and refusing a redelivery that arrives
 * "early" would be strictly worse than handling it. What this file owns is the
 * *bound* — how many failures we will keep asking for before the delivery stops
 * being a retry and becomes an operator's problem.
 *
 * Why a bound at all: an event that fails because it is malformed, or because it
 * names an account that no longer exists, will fail identically on the hundredth
 * attempt. Answering 500 forever keeps the provider hammering an endpoint that
 * can never succeed, and providers eventually disable a webhook endpoint that
 * behaves that way — which would take *every* future delivery down with it, not
 * just the broken one. Dead-lettering trades one lost event for the endpoint
 * staying alive, and the alert is what makes the loss visible.
 *
 * Pure: the backoff is arithmetic, the decision is a comparison, and both are
 * handed to the database rather than computed there.
 */

/** How many failures a single delivery gets before it is dead-lettered. */
export const BILLING_WEBHOOK_MAX_ATTEMPTS = 8;

/** The first delay, in seconds. Doubling from here. */
const BASE_DELAY_SECONDS = 60;

/** The ceiling. Beyond an hour the reconciliation pass is the better instrument. */
const MAX_DELAY_SECONDS = 3_600;

/**
 * Exponential, capped, and starting at one minute: 60, 120, 240 … 3600.
 *
 * `attempt` is the number of failures recorded *including* this one, so the
 * first failure asks for a minute rather than for nothing. Values below one are
 * clamped rather than rejected — a caller that miscounts should still get a
 * sane delay, not a negative one.
 */
export function billingRetryBackoffSeconds(attempt: number): number {
  const ordinal = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  // 2^30 seconds already exceeds the cap by six orders of magnitude; clamping the
  // exponent keeps the shift finite for an absurd attempt count.
  const doublings = Math.min(ordinal - 1, 30);
  return Math.min(BASE_DELAY_SECONDS * 2 ** doublings, MAX_DELAY_SECONDS);
}

/**
 * What the endpoint should answer after a failure.
 *
 * `retry` becomes a 500, which is how a provider is asked to try again.
 * `dead_letter` becomes a 200, which is how it is asked to stop — the event is
 * recorded, operators are told, and reconciliation will keep reporting it until
 * somebody deals with it.
 */
export type WebhookFailureDisposition = 'retry' | 'dead_letter';

export function webhookFailureDisposition(input: {
  attemptCount: number;
  status: 'retrying' | 'dead_letter' | 'resolved';
}): WebhookFailureDisposition {
  if (input.status === 'dead_letter') return 'dead_letter';
  return input.attemptCount >= BILLING_WEBHOOK_MAX_ATTEMPTS ? 'dead_letter' : 'retry';
}
