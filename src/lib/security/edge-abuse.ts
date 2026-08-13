import { NextResponse, type NextRequest } from 'next/server';
import {
  abuseClassForPath,
  BURST_POLICIES,
  BurstLimiter,
  clientAddressFromHeaders,
  tooManyRequestsBody,
  tooManyRequestsHeaders,
  type AbuseClass,
} from './abuse-policy';

/**
 * The outermost gate: abuse control at the edge, before the session exists.
 *
 * This runs as the *first* thing in middleware, ahead of
 * `supabase.auth.getUser()`, and that ordering is the entire reason it exists.
 * Every request through this product used to begin with a round trip to the auth
 * server to find out who was asking — which means a flood of anonymous requests
 * to `/auth/sign-in` was, before this, a flood of authenticated round trips
 * against Supabase, paid for and rate-limited by the platform rather than by us.
 * A limiter that runs after the lookup bounds the response but not the cost.
 *
 * What it can and cannot do, stated honestly:
 *
 *   * **It is per-isolate.** Vercel runs middleware in many edge isolates and
 *     they share no memory, so this bounds a burst against *one* of them, not
 *     the fleet. That is why the bounds here are burst bounds and the
 *     authoritative per-identity limits live in the database, behind the routes.
 *     It is also why the Vercel WAF rules in
 *     `docs/operations/edge-abuse-protection.md` are part of this design and not
 *     an optional extra — the platform is the only layer that can see the fleet.
 *   * **It keys on the address the platform observed**, the first
 *     `x-forwarded-for` hop, never a header the caller chose.
 *   * **It never gates a page render.** `abuseClassForPath` answers `null` for
 *     everything that is not a guarded surface, and `null` means untouched.
 */

const limiter = new BurstLimiter();

/** Test seam: drop all in-isolate state between cases. */
export function resetEdgeAbuseLimiter(): void {
  limiter.reset();
}

export interface EdgeAbuseDecision {
  /** The 429 to return, or `null` when the request may continue. */
  refusal: NextResponse | null;
  /** Which class the path fell into, for tests and for logging. */
  abuseClass: AbuseClass | null;
}

/**
 * Charge one request at the edge.
 *
 * Identity here is the address alone — deliberately. The account is not known
 * yet, and finding out is the round trip this gate exists to protect. A signed-in
 * caller is bounded again, as themselves, by the per-identity limits inside the
 * routes; this layer only has to be cheap and blunt.
 */
export function guardEdgeAbuse(request: NextRequest): EdgeAbuseDecision {
  const abuseClass = abuseClassForPath(request.nextUrl.pathname, request.method);
  if (!abuseClass || abuseClass === 'realtime') return { refusal: null, abuseClass };

  const address = clientAddressFromHeaders(request.headers);
  // No address at all means no proxy hop identified the caller. They are pooled
  // into one bucket rather than exempted: an unattributable flood is still a
  // flood, and letting "unknown" through unbounded is the bypass.
  const key = `edge:${abuseClass}|${address ?? 'unknown'}`;
  const decision = limiter.consume(key, BURST_POLICIES[abuseClass]);
  if (decision.allowed) return { refusal: null, abuseClass };

  return { refusal: refusalFor(request, decision.retryAfterSeconds), abuseClass };
}

/**
 * A refusal in the shape the caller can read. An API client gets the error
 * envelope every route in this product already speaks; a browser navigating to
 * `/auth/sign-in` gets a short page rather than a wall of JSON, because a person
 * who reloaded too eagerly is the most likely reader of this response.
 */
function refusalFor(request: NextRequest, retryAfterSeconds: number): NextResponse {
  const headers = tooManyRequestsHeaders(retryAfterSeconds);
  const wantsHtml = !request.nextUrl.pathname.startsWith('/api/')
    && (request.headers.get('accept') ?? '').includes('text/html');

  if (!wantsHtml) {
    return NextResponse.json(tooManyRequestsBody(retryAfterSeconds), { status: 429, headers });
  }
  return new NextResponse(throttledPage(retryAfterSeconds), {
    status: 429,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Written out rather than rendered, for the same reason the operator console's
 * refusal is: this response exists to avoid running the thing that would have
 * rendered it. It names no limit and no rule — only how long to wait.
 */
function throttledPage(retryAfterSeconds: number): string {
  const seconds = Math.max(1, retryAfterSeconds);
  return `<!doctype html><html lang="th"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex">`
    + `<title>PortKheaw</title></head>`
    + `<body style="margin:0;background:#0b0f14;color:#e5e7eb;font-family:system-ui,sans-serif">`
    + `<main style="min-height:100dvh;display:flex;flex-direction:column;align-items:center;`
    + `justify-content:center;gap:12px;padding:24px;text-align:center">`
    + `<p style="color:#D4FF00;font-weight:600;margin:0">PortKheaw</p>`
    + `<h1 style="margin:0;font-size:1.5rem">คำขอถี่เกินไป</h1>`
    + `<p style="margin:0;color:#94a3b8">กรุณารออีกประมาณ ${seconds} วินาที แล้วลองใหม่อีกครั้ง</p>`
    + `</main></body></html>`;
}
