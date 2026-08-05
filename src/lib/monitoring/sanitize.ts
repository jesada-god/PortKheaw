/**
 * What may leave this process in an error report.
 *
 * An exception report is the easiest place in a product to leak a secret: it
 * carries a message somebody wrote under pressure, a stack, and whatever context
 * the call site happened to have. This module is the one gate every report passes
 * through, and it is a *allowlist* on the context and a redactor on the text.
 *
 * Pure and total, so the rule can be exercised without a monitoring provider —
 * which matters, because this product currently has none configured and the rule
 * still has to be right on the day one is.
 */

/** Shapes that must never appear in a report, whatever produced them. */
const REDACTIONS: readonly { pattern: RegExp; replacement: string }[] = [
  // Provider secrets and restricted keys.
  { pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}/g, replacement: '[redacted:provider-key]' },
  { pattern: /\bwhsec_[A-Za-z0-9_-]{6,}/g, replacement: '[redacted:webhook-secret]' },
  // JSON Web Tokens — a Supabase service key is one.
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, replacement: '[redacted:token]' },
  // `Authorization: Bearer …` and `apikey: …` in a captured header dump.
  { pattern: /\b(?:bearer|apikey|api_key|authorization)\s*[:=]\s*\S+/gi, replacement: '[redacted:credential]' },
  // Provider object identifiers. Not secret, but they identify a customer's
  // payment record, and a report is not where that belongs.
  { pattern: /\b(?:cus|sub|in|pi|ch|evt|price|cs|seti|re|dp)_[A-Za-z0-9]{10,}/g, replacement: '[redacted:provider-id]' },
  // Anything card-shaped.
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: '[redacted:pan]' },
  // Mailboxes.
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[redacted:email]' },
  // Query strings that carry a token or a key.
  { pattern: /([?&](?:token|key|secret|password|signature)=)[^&\s]+/gi, replacement: '$1[redacted]' },
];

/** Redact every known shape from a string. Order matters: keys before ids. */
export function sanitizeText(value: string): string {
  return REDACTIONS.reduce(
    (text, rule) => text.replace(rule.pattern, rule.replacement),
    value,
  ).slice(0, 2_000);
}

/**
 * The context keys a report may carry.
 *
 * An allowlist rather than a denylist, because the failure mode of a denylist is
 * that the one field nobody thought of is the one that leaks. Everything here is
 * product configuration or a coarse state word — no identifier, no amount, no
 * mailbox, no payload.
 */
export const allowedContextKeys = [
  'scope',
  'route',
  'operation',
  'code',
  'outcome',
  'planKey',
  'paymentRail',
  'providerMode',
  'eventType',
  'stage',
  'attempt',
  'status',
  'requestId',
  'featureKey',
] as const;
export type AllowedContextKey = typeof allowedContextKeys[number];

export type MonitoringContext = Partial<Record<AllowedContextKey, string | number | boolean | null>>;

/**
 * Drop every key that is not on the list, and sanitize what survives.
 *
 * Values are stringified and truncated: a context value is a label, and a call
 * site that hands over an object is handing over more than it meant to.
 */
export function sanitizeContext(context: Record<string, unknown> | undefined): MonitoringContext {
  if (!context) return {};
  const safe: Record<string, string | number | boolean | null> = {};
  for (const key of allowedContextKeys) {
    if (!(key in context)) continue;
    const value = context[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) { safe[key] = value; continue; }
    if (typeof value === 'boolean') { safe[key] = value; continue; }
    safe[key] = sanitizeText(String(value)).slice(0, 120);
  }
  return safe;
}

export interface SanitizedError {
  name: string;
  message: string;
  /** Frames only — file, function, line. Never a captured variable. */
  stack: string | null;
}

/**
 * Reduce a thrown value to a reportable shape.
 *
 * The stack is kept because it is the whole reason to report an exception, and
 * truncated because a deep async stack is mostly framework noise. Every line
 * still goes through the redactor: a message interpolated into a stack frame is
 * exactly how a key ends up in a monitoring dashboard.
 */
export function sanitizeError(cause: unknown): SanitizedError {
  if (cause instanceof Error) {
    return {
      name: sanitizeText(cause.name).slice(0, 80),
      message: sanitizeText(cause.message),
      stack: cause.stack
        ? sanitizeText(cause.stack.split('\n').slice(0, 12).join('\n'))
        : null,
    };
  }
  return {
    name: 'NonError',
    message: sanitizeText(typeof cause === 'string' ? cause : Object.prototype.toString.call(cause)),
    stack: null,
  };
}
