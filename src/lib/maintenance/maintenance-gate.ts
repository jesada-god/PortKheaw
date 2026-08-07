/**
 * The maintenance gate, as a pure decision.
 *
 * One function decides what happens to a request while the product is switched
 * off, and middleware is the only thing that calls it. Duplicating this rule
 * into each route is how a product ends up with a page that redirects and an
 * API beneath it that happily keeps writing.
 *
 * Nothing here performs I/O, reads a cookie or trusts a header. It takes two
 * facts the server has already established — is maintenance on, and is this
 * caller an operator — and returns one of three outcomes.
 */

export const MAINTENANCE_PATH = '/maintenance';

/**
 * Paths that are never gated, and why each one is on the list.
 *
 * This is the part of the feature that causes an incident if it is wrong, so
 * every entry is a system path that maintenance must not be able to break:
 *
 *   `/maintenance`        the destination itself. Gating it is a redirect loop.
 *   `/auth/…`, `/api/auth/…`
 *                         an operator has to be able to sign in *during* the
 *                         outage in order to end it, and the callback is where a
 *                         confirmation or recovery link lands. Signing in does
 *                         not grant access to the product — the gate still runs
 *                         on the page they land on.
 *   `/api/billing/webhook`
 *                         Stripe. A redirect or an HTML body here is a failed
 *                         delivery, a retry storm, and eventually a subscription
 *                         that silently did not renew. Never gated, in any mode.
 *   `/api/cron/…`, `/api/alerts/evaluate`
 *                         scheduled internal work. A maintenance window is not a
 *                         reason for the alert sweep to stop running.
 *   `/api/health`, `/api/version`
 *                         liveness and readiness. An uptime monitor must be able
 *                         to reach them while the product is down for readers —
 *                         that is the moment they matter most.
 *   `/api/maintenance/…`  the state the `/maintenance` page polls to notice the
 *                         product came back. Gating it strands every reader on
 *                         the page until they refresh by hand.
 *   the icon/manifest set the `/maintenance` page's own assets.
 */
const EXEMPT_PREFIXES = [
  '/maintenance/',
  '/auth/',
  '/api/auth/',
  '/api/billing/webhook',
  '/api/cron/',
  '/api/alerts/evaluate',
  '/api/maintenance/',
  '/icons/',
] as const;

const EXEMPT_EXACT = new Set<string>([
  MAINTENANCE_PATH,
  '/auth',
  '/api/health',
  '/api/version',
  '/icon.svg',
  '/favicon.ico',
  '/manifest.json',
  '/manifest.webmanifest',
]);

/** Methods that only read. Everything else is treated as a mutation. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMaintenanceExemptPath(pathname: string): boolean {
  if (EXEMPT_EXACT.has(pathname)) return true;
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export type MaintenanceDecision =
  /** Serve the request unchanged. */
  | { action: 'allow' }
  /** A page request from a reader: send them to the notice. */
  | { action: 'redirect'; location: string }
  /**
   * Refuse in place, with a status rather than a redirect. Used for every API
   * request and for every mutation — including a server action posted by a tab
   * that was already open when the switch was thrown, which is the one bypass a
   * page-only guard would leave open.
   */
  | { action: 'block'; status: 503 };

export interface MaintenanceRequest {
  pathname: string;
  method: string;
  /** Whether the switch is on. Resolved server-side; never from a client flag. */
  maintenanceEnabled: boolean;
  /** The *stored* operator role, resolved server-side in the same round trip. */
  isAdmin: boolean;
}

/**
 * Three rules, in order:
 *
 *   1. Maintenance off, or the caller is an operator → nothing changes. An
 *      operator keeps the whole product, which is the point: they are the one
 *      who has to check it before switching it back on.
 *   2. A read of an ordinary page → the notice.
 *   3. Anything else — every API call, and every non-read method anywhere —
 *      → 503. A refusal, never a redirect, so a webhook-shaped or fetch-shaped
 *      caller gets a status it can act on instead of a page it cannot parse.
 */
export function decideMaintenance(request: MaintenanceRequest): MaintenanceDecision {
  if (!request.maintenanceEnabled) return { action: 'allow' };
  if (request.isAdmin) return { action: 'allow' };
  if (isMaintenanceExemptPath(request.pathname)) return { action: 'allow' };

  const isRead = READ_METHODS.has(request.method.toUpperCase());
  if (!isRead || request.pathname.startsWith('/api/')) return { action: 'block', status: 503 };

  return { action: 'redirect', location: MAINTENANCE_PATH };
}

/** The refusal body. Shaped like the other typed refusals this app returns. */
export const MAINTENANCE_DENIAL_BODY = {
  error: {
    code: 'MAINTENANCE_ACTIVE',
    message: 'ระบบกำลังปรับปรุงชั่วคราว กรุณาลองใหม่อีกครั้งในภายหลัง',
  },
} as const;
