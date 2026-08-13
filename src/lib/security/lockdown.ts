/**
 * The security lockdown, as a pure decision.
 *
 * **What this is, and what it is not.**
 *
 * Maintenance mode answers "is the product serving readers". Lockdown answers
 * "do we currently trust our own privileged paths". They are separate switches
 * with separate audiences: maintenance is announced and redirects everybody to a
 * notice, while lockdown is silent to ordinary readers and binds *operators
 * hardest of all* — because the incident it exists for is a compromised operator
 * session.
 *
 * **What it deliberately does not do.**
 *
 * It does not make the product read-only. That was considered and rejected, and
 * the reasoning is worth keeping: an ordinary reader's write is already confined
 * by row-level security to rows they own, so refusing it costs every paying
 * customer their product and buys no containment. The classes below are the ones
 * where a write crosses an account boundary, grants privilege, moves money, or
 * cannot be undone — and those are refused outright. An operator who genuinely
 * needs a read-only product has maintenance mode for that, and can engage both
 * switches at once; that is why they are two controls and not two notches of one.
 *
 * This module is pure and runtime-agnostic — no `server-only`, no Node built-in,
 * no Next import — because the same decision has to be made in Edge middleware,
 * in a Node server action, and in a test.
 */

/**
 * The classes a write can belong to. Every guarded mutation names one, so
 * "is this blocked during an incident" is a property of the operation rather
 * than a judgement made at each call site.
 */
export const LOCKDOWN_CLASSES = [
  /** Anything the operator console changes. Refused wholesale. */
  'admin-mutation',
  /** Granting, revoking or changing an operator role. */
  'role-change',
  /** An operator changing what an account may open, or its plan. */
  'billing-override',
  /** Irreversible account-level writes: deletion, purge, reset. */
  'account-destructive',
  /**
   * Moving the lockdown switch itself. **Never blocked.** A control that cannot
   * be released while engaged is a lockout, not a control — and the operator
   * ending the incident is the one caller who must always get through. What
   * stands between a stolen session and this class is the second factor, which
   * a stolen cookie does not carry and cannot be upgraded to.
   */
  'security-toggle',
  /**
   * The maintenance switch. **Never blocked**, because taking the product
   * offline is an incident-response action: an operator who has just locked down
   * must still be able to put up the notice.
   */
  'maintenance-toggle',
  /**
   * An ordinary reader writing their own data. Allowed — see the note above on
   * why lockdown is not a read-only mode.
   */
  'ordinary-write',
] as const;

export type LockdownClass = typeof LOCKDOWN_CLASSES[number];

/**
 * The classes lockdown refuses. Written as the *blocked* set rather than the
 * allowed one on purpose: a class added to the union above without a decision
 * here is allowed, which is the safe direction for availability, and the two
 * classes that must never be blocked are named explicitly below so that reading
 * either list tells you the whole rule.
 */
const BLOCKED: ReadonlySet<LockdownClass> = new Set<LockdownClass>([
  'admin-mutation',
  'role-change',
  'billing-override',
  'account-destructive',
]);

/**
 * The classes that stay open no matter what. Asserted in the regression suite,
 * because the failure they prevent — an operator unable to end the incident they
 * are responding to — is one nobody discovers until it is happening.
 */
export const LOCKDOWN_EXEMPT_CLASSES: readonly LockdownClass[] = [
  'security-toggle',
  'maintenance-toggle',
];

export function isBlockedDuringLockdown(lockdownClass: LockdownClass): boolean {
  return BLOCKED.has(lockdownClass);
}

/**
 * The URL-level rule, for the edge.
 *
 * Middleware cannot know which class a server action belongs to — it sees a POST
 * to a page URL and nothing more — so this layer is deliberately coarse: it
 * refuses privileged *surfaces* by path, and leaves everything else to the
 * server gate, which knows exactly what it is about to do. Neither layer is
 * trusted to be the only one.
 */
export interface LockdownRequest {
  pathname: string;
  method: string;
  /** Resolved server-side from the database. Never from a header or a cookie. */
  lockdownEnabled: boolean;
}

export type LockdownDecision =
  | { action: 'allow' }
  /**
   * 423 Locked, and never a redirect. A server action posts to its own page URL,
   * and a 302 would let the browser follow it into a page render instead of
   * failing the write — the same bypass a redirect-only maintenance gate leaves
   * behind. 423 rather than 503 because the resource is not unavailable, it is
   * deliberately closed, and an operator reading a log should be able to tell
   * those two apart at a glance.
   */
  | { action: 'block'; status: 423 };

/** Methods that only read. Everything else is treated as a mutation. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths that stay reachable with a mutation while the product is locked down.
 *
 * Every entry is something an incident makes *more* necessary, not less:
 *
 *   `/admin/security`   where the switch is released and where a second factor
 *                       is enrolled and presented. Gating it is a lockout.
 *   `/auth/…`, `/api/auth/…`
 *                       an operator has to be able to sign in during the
 *                       incident in order to end it. Signing in grants nothing
 *                       on its own; every gate still runs afterwards.
 *   `/api/billing/webhook`
 *                       Stripe. A refusal here is a failed delivery, a retry
 *                       storm, and eventually a paid subscription that silently
 *                       did not renew. Never gated, in any mode.
 *   `/api/cron/…`, `/api/alerts/evaluate`
 *                       scheduled internal work, which has no session to steal.
 */
const EXEMPT_PREFIXES = [
  '/admin/security',
  '/auth/',
  '/api/auth/',
  '/api/billing/webhook',
  '/api/cron/',
  '/api/alerts/evaluate',
] as const;

/**
 * The privileged surfaces, by URL. A mutation aimed at one of these is refused
 * at the edge before a renderer or a route handler exists to run it.
 */
const PRIVILEGED_PREFIXES = ['/admin/', '/api/admin/'] as const;
const PRIVILEGED_EXACT = new Set<string>(['/admin']);

export function isLockdownExemptPath(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export function isPrivilegedSurfacePath(pathname: string): boolean {
  if (PRIVILEGED_EXACT.has(pathname)) return true;
  return PRIVILEGED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function decideLockdown(request: LockdownRequest): LockdownDecision {
  if (!request.lockdownEnabled) return { action: 'allow' };
  if (READ_METHODS.has(request.method.toUpperCase())) return { action: 'allow' };
  if (isLockdownExemptPath(request.pathname)) return { action: 'allow' };
  if (isPrivilegedSurfacePath(request.pathname)) return { action: 'block', status: 423 };
  return { action: 'allow' };
}

/**
 * The refusal body, in the envelope every route in this product already speaks.
 *
 * It says the operation is closed and does not say why. An ordinary reader never
 * sees this — they have no privileged writes to make — and the caller who does
 * see it is either an operator, who knows, or somebody probing, who should not
 * learn that a security incident is in progress.
 */
export const LOCKDOWN_DENIAL_BODY = {
  data: null,
  error: {
    code: 'security-lockdown',
    message: 'ระบบปิดรับการทำรายการสิทธิ์พิเศษชั่วคราวเพื่อความปลอดภัย',
    retryable: false,
  },
} as const;

/** What an operator is told when a console mutation is refused by the switch. */
export const LOCKDOWN_DENIAL_MESSAGE =
  'ขณะนี้ระบบอยู่ในโหมดล็อกดาวน์ความปลอดภัย จึงไม่สามารถทำรายการสิทธิ์พิเศษได้';
