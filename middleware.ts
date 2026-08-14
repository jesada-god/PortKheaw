import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isSupabaseConfigured, clientEnv } from '@/src/config/env/client';
import { isPlatformAdminForEdge } from '@/src/lib/admin/admin-edge';
import {
  getSafeReturnPath, isAdminConsolePath, isAuthFormPath, isProtectedPath,
} from '@/src/lib/auth/paths';
import {
  ADMIN_SECURITY_PATH, ASSURANCE_DENIAL_MESSAGE, isAssuranceExemptAdminPath,
} from '@/src/lib/security/admin-assurance';
import { resolveAdminAssuranceForEdge } from '@/src/lib/security/admin-assurance-edge';
import { guardEdgeAbuse } from '@/src/lib/security/edge-abuse';
import {
  decideLockdown, isPrivilegedSurfacePath, LOCKDOWN_DENIAL_BODY,
} from '@/src/lib/security/lockdown';
import { readRuntimePostureForEdge } from '@/src/lib/security/posture-edge';
import { recordEdgeSecurityEvent } from '@/src/lib/security/security-audit-edge';
import {
  decideMaintenance, isMaintenanceExemptPath, MAINTENANCE_DENIAL_BODY,
} from '@/src/lib/maintenance/maintenance-gate';
import type { Database } from '@/src/types/database';

function supabaseConnectSources(): string[] {
  if (!clientEnv.NEXT_PUBLIC_SUPABASE_URL) return [];
  try {
    const url = new URL(clientEnv.NEXT_PUBLIC_SUPABASE_URL);
    return [url.origin, `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`];
  } catch {
    return [];
  }
}

/**
 * The Nexora WebSocket Gateway origin the browser is allowed to connect to.
 * Resolved from `NEXT_PUBLIC_MARKET_WS_URL` (e.g. `ws://localhost:8081/ws` in
 * development, `wss://<gateway-host>/ws` in production) and reduced to its origin
 * so the full path is not baked into the policy. No production host is hardcoded:
 * the origin always comes from the environment. A missing or unparseable value
 * yields no source (never throws) so the build/policy stays intact. Development
 * falls back to the local Gateway so a forgotten env var does not break DX.
 */
function marketWsConnectSources(): string[] {
  const raw = process.env.NEXT_PUBLIC_MARKET_WS_URL?.trim();
  if (raw) {
    try {
      return [new URL(raw).origin];
    } catch {
      // fall through to the development fallback below
    }
  }
  return process.env.NODE_ENV === 'development' ? ['ws://localhost:8081'] : [];
}

/**
 * A fresh nonce per request.
 *
 * `crypto.randomUUID` is available in the edge runtime and is a CSPRNG. A nonce
 * only has to be unguessable and unique per response — an attacker who can
 * predict it can nonce their own injected script, which is the whole property
 * being bought here.
 */
function createNonce(): string {
  return btoa(crypto.randomUUID()).replace(/=+$/, '');
}

/**
 * The policy, built around a nonce rather than around `'unsafe-inline'`.
 *
 * `script-src` was `'self' 'unsafe-inline'`, which is the same as having no
 * script policy at all against the attack it exists to stop: `'unsafe-inline'`
 * permits exactly the injected `<script>` that an XSS is. It was there because
 * this app renders two inline scripts of its own and Next.js renders several of
 * its own, and nothing distinguished those from an attacker's.
 *
 * A nonce distinguishes them. Three sources, and each is load-bearing:
 *
 *   * `'nonce-…'` — the two inline scripts in `app/layout.tsx` carry it
 *     explicitly, and Next.js reads it off the request's own
 *     `Content-Security-Policy` header and stamps it onto the framework scripts
 *     it emits. That is why the header below is set on the *request* as well as
 *     the response.
 *   * `'strict-dynamic'` — the framework bootstrap injects the chunk `<script>`
 *     tags for each route at runtime; this is what lets a trusted script load
 *     more scripts without every chunk URL being in the policy.
 *   * `'self'` — not redundant. A browser that understands nonces but not
 *     `'strict-dynamic'` ignores the latter, and needs `'self'` to keep loading
 *     the same-origin chunks. It is the CSP2 floor, and it still refuses the
 *     inline injection that `'unsafe-inline'` used to allow.
 *
 * `'unsafe-inline'` is gone rather than kept as a fallback: a browser that
 * honours nonces ignores it, and a browser that does not would be handed back
 * the exact hole this closes.
 *
 * **`style-src` deliberately keeps `'unsafe-inline'`.** React sets element
 * styles inline and the design system carries CSS custom properties on the
 * elements themselves, so removing it would require a second nonce plumbed
 * through every styled node for a far smaller prize — injected CSS cannot
 * execute, and `object-src 'none'`, `base-uri 'self'` and `form-action 'self'`
 * already close the exfiltration shapes that style injection is used for.
 */
function buildContentSecurityPolicy(nonce: string): string {
  const scriptSources = [
    `'self'`,
    `'nonce-${nonce}'`,
    `'strict-dynamic'`,
    ...(process.env.NODE_ENV === 'development' ? [`'unsafe-eval'`] : []),
  ];
  return [
    `default-src 'self'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `script-src ${scriptSources.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    // News thumbnails come from the publisher CDN named by each article, an
    // unbounded and per-article set, so no hostname allowlist can express them.
    // The scheme source keeps the guarantee that matters — HTTPS only, no
    // mixed content — and images cannot execute. Every other directive stays
    // origin-locked, and `referrerPolicy="no-referrer"` on the thumbnails keeps
    // the reader's page out of the publisher's logs.
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src ${[`'self'`, ...supabaseConnectSources(), ...marketWsConnectSources()].join(' ')}`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
  ].join('; ');
}

function withSecurityHeaders(response: NextResponse, nonce: string): NextResponse {
  response.headers.set('Content-Security-Policy', buildContentSecurityPolicy(nonce));
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  /*
   * `Strict-Transport-Security` is deliberately **not** set here.
   *
   * The platform already sends it on every response — verified against paths
   * this middleware's matcher explicitly excludes (`/icon.svg`, and a 404 under
   * `/_next/static`, both of which carry HSTS and none of the headers below).
   * Vercel's value is `max-age=63072000; includeSubDomains; preload`, which is
   * strictly stronger than anything worth setting from here.
   *
   * Setting it in middleware as well would be actively worse, not merely
   * redundant: middleware runs on a subset of paths, so the origin would answer
   * with two different HSTS policies depending on the URL, and the one this file
   * produced would be the weaker of the two — dropping `preload` on exactly the
   * pages that carry a session. A security header with one owner is a header
   * that cannot drift.
   */
  /*
   * `same-origin-allow-popups`, not `same-origin`.
   *
   * This severs the `window.opener` relationship with cross-origin documents,
   * which is what closes the cross-window scripting and XS-Leak class. The
   * `-allow-popups` variant keeps working for a window this page opened itself.
   *
   * Google sign-in is a top-level redirect here (`signInWithOAuth` with
   * `redirectTo`) and Stripe is hosted checkout with `success_url`, so neither
   * relies on an opener at all — but the stricter value buys nothing over this
   * one and would break the first provider that ever needs a popup.
   */
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  /*
   * Features this product does not use, refused for every frame including its
   * own. `payment` is on the list precisely *because* the product takes money:
   * checkout is a redirect to Stripe's own page, so the Payment Request API is
   * never called here and an injected script asking for it is not a thing that
   * should work.
   */
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  );
  return response;
}

/**
 * What a non-operator gets for an operator URL: the product's own not-found
 * sentence and nothing else — no navigation, no shell, no hint that the path
 * means anything. Written out here rather than rendered, because rendering is
 * the thing this response exists to avoid.
 */
const ADMIN_DENIAL_BODY = `<!doctype html><html lang="th"><head><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<meta name="robots" content="noindex">`
  + `<title>PortKheaw</title></head>`
  + `<body style="margin:0;background:#0b0f14;color:#e5e7eb;font-family:system-ui,sans-serif">`
  + `<main style="min-height:100dvh;display:flex;flex-direction:column;align-items:center;`
  + `justify-content:center;gap:12px;padding:24px;text-align:center">`
  + `<p style="color:#D4FF00;font-weight:600;margin:0">PortKheaw</p>`
  + `<h1 style="margin:0;font-size:1.875rem">ไม่พบหน้าที่ต้องการ</h1>`
  + `<p style="margin:0;color:#94a3b8">ลิงก์นี้อาจถูกย้ายหรือไม่มีอยู่แล้ว</p>`
  + `<a href="/" style="margin-top:12px;display:inline-flex;align-items:center;min-height:44px;`
  + `border-radius:8px;background:#D4FF00;color:#000;padding:0 20px;font-weight:600;`
  + `text-decoration:none">กลับหน้าแรก</a>`
  + `</main></body></html>`;

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const protectedRoute = isProtectedPath(pathname);

  /*
   * One nonce per request, minted before anything can answer.
   *
   * It has to exist this early because every exit below carries the policy that
   * names it, and a response that leaves without one would be a page whose own
   * scripts the browser then refuses.
   */
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy(nonce);

  /**
   * A pass-through response that hands the nonce *forward* into rendering.
   *
   * Two consumers, and they read different headers: the root layout reads
   * `x-nonce` to stamp its own inline scripts, and Next.js reads the
   * `Content-Security-Policy` request header to stamp the scripts it generates
   * itself. Both have to be on the request, not just the response.
   *
   * Rebuilt from `request.headers` at each call rather than captured once,
   * because the auth library mutates `request.cookies` — which is to say the
   * request's `cookie` header — when it refreshes a session, and a snapshot
   * taken before that would carry the stale cookie forward and lose the refresh.
   */
  const passThrough = (): NextResponse => {
    const headers = new Headers(request.headers);
    headers.set('x-nonce', nonce);
    headers.set('Content-Security-Policy', policy);
    return NextResponse.next({ request: { headers } });
  };

  /*
   * Abuse control comes first — before the session lookup, before maintenance,
   * before anything that costs a round trip.
   *
   * That ordering is the point. Everything below this line begins by asking
   * Supabase who is calling, so without this gate a flood of anonymous requests
   * at `/auth/sign-in` is a flood of auth-server round trips we pay for and do
   * not control. Refusing here means an abusive caller costs one map lookup.
   *
   * It only ever answers for the guarded classes (auth forms, the console, the
   * expensive APIs, the API surface); ordinary page requests are not touched.
   */
  const abuse = guardEdgeAbuse(request);
  if (abuse.refusal) return withSecurityHeaders(abuse.refusal, nonce);

  if (!isSupabaseConfigured) {
    if (!protectedRoute) return withSecurityHeaders(passThrough(), nonce);
    const url = request.nextUrl.clone();
    url.pathname = '/auth/configuration-required';
    url.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    return withSecurityHeaders(NextResponse.redirect(url), nonce);
  }

  let response = passThrough();
  const supabase = createServerClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL as string,
    clientEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = passThrough();
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const hadSessionCookie = request.cookies.getAll().some(({ name }) => name.startsWith('sb-'));
  const { data: { user } } = await supabase.auth.getUser();

  function redirectCarryingSession(url: URL): NextResponse {
    const redirectResponse = NextResponse.redirect(url);
    /*
     * Carry any refreshed auth cookies onto the redirect, or the refresh is lost
     * and the next request starts the same round trip again.
     *
     * **The whole cookie, not its name and value.** This used to re-set each one
     * as `set(name, value)`, which silently dropped every attribute Supabase had
     * attached — `httpOnly`, `secure`, `sameSite`, `path`, `maxAge`. The result
     * was that on any middleware redirect that happened to coincide with a token
     * refresh (sign-in, maintenance, the assurance gate), the session cookie was
     * rewritten as a plain, script-readable cookie. `httpOnly` is the single
     * control that keeps an XSS anywhere in the product from being a session
     * theft, and it was being removed by the code carrying the session forward.
     *
     * Passing the `ResponseCookie` object keeps the attributes the auth library
     * chose, which is the only correct answer: this function has no business
     * having an opinion about how a session cookie is scoped.
     */
    response.cookies.getAll().forEach((cookie) => redirectResponse.cookies.set(cookie));
    return withSecurityHeaders(redirectResponse, nonce);
  }

  /*
   * Both runtime switches, read together, once.
   *
   * This runs here — after the session is resolved, before every other rule —
   * because these are the only rules that can decide a request should not reach
   * the product at all, and because the facts they need (are the switches on, is
   * this caller an operator) are only knowable once the session is.
   *
   * One round trip answers all three. Adding the lockdown as a second RPC would
   * have doubled the latency of the gate that runs on every request — at exactly
   * the moment the product is fragile, which is when both switches are most
   * likely to be on.
   *
   * The read is skipped entirely when neither gate could act on it, rather than
   * performed and ignored. That is not an optimisation: it is what guarantees a
   * Stripe webhook delivery cannot be delayed, redirected or failed by a database
   * having a bad minute during a window or an incident.
   */
  const needsPosture = !isMaintenanceExemptPath(pathname) || isPrivilegedSurfacePath(pathname);
  const posture = needsPosture
    ? await readRuntimePostureForEdge(supabase)
    : { maintenanceEnabled: false, lockdownEnabled: false, isAdmin: false };

  /*
   * The maintenance gate.
   *
   * Note what is *not* gated on the reader's side: a mutation is refused with a
   * 503, never a redirect. A tab left open before the switch was thrown posts a
   * server action to its own page URL, and a 302 would let the browser follow it
   * into a page render instead of failing the write — which is exactly the
   * bypass a page-only guard leaves behind.
   */
  if (!isMaintenanceExemptPath(pathname)) {
    const decision = decideMaintenance({
      pathname,
      method: request.method,
      maintenanceEnabled: posture.maintenanceEnabled,
      isAdmin: posture.isAdmin,
    });

    if (decision.action === 'block') {
      return withSecurityHeaders(NextResponse.json(MAINTENANCE_DENIAL_BODY, {
        status: decision.status,
        headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '120' },
      }), nonce);
    }
    if (decision.action === 'redirect') {
      const url = request.nextUrl.clone();
      url.pathname = decision.location;
      url.search = '';
      return redirectCarryingSession(url);
    }
  }

  /*
   * The security lockdown, refused at the edge.
   *
   * Note what is *not* here: an operator exemption. Maintenance lets an operator
   * through because they are the one who has to check the product before
   * switching it back on; lockdown binds them hardest of all, because the
   * incident it exists for is a compromised operator session, and a switch the
   * attacker in that session can walk around is not a control.
   *
   * This layer is deliberately coarse — it sees a POST to a URL and nothing
   * more, so it refuses privileged *surfaces* by path. The server gate below it
   * knows which class of write is actually about to happen and refuses on that.
   * Neither is trusted to be the only one, and `/admin/security` stays reachable
   * through both so the switch can always be released.
   */
  const lockdown = decideLockdown({
    pathname,
    method: request.method,
    lockdownEnabled: posture.lockdownEnabled,
  });
  if (lockdown.action === 'block') {
    return withSecurityHeaders(NextResponse.json(LOCKDOWN_DENIAL_BODY, {
      status: lockdown.status,
      headers: { 'Cache-Control': 'private, no-store' },
    }), nonce);
  }

  if (protectedRoute && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/sign-in';
    url.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    if (hadSessionCookie) url.searchParams.set('reason', 'session_expired');
    return redirectCarryingSession(url);
  }

  /*
   * The operator console, refused before anything renders it.
   *
   * This runs here rather than in a layout because of what the App Router does
   * with a layout that refuses: the page beneath it renders *concurrently*, so
   * by the time `notFound()` is thrown the console has already queried its
   * projections and built its tree, and that tree is serialised into the
   * response beside the 404 marker — under a 200, because the shell was flushed
   * before either finished. A reader who never hydrates simply reads it. Refusing
   * at the edge is the only place the request can be stopped before a renderer
   * exists to leak from.
   *
   * The refusal is a bare 404 with no product chrome: not a redirect, which
   * would confirm the URL is real and gettable, and not a 403, which would
   * confirm the console exists and that this account is not on it.
   *
   * Signed-out visitors never reach this — the rule above has already sent them
   * to sign-in — so this only ever answers for a caller with a session, and it
   * answers false unless the database says otherwise.
   */
  if (isAdminConsolePath(pathname)) {
    if (!(await isPlatformAdminForEdge(supabase))) {
      /*
       * The event worth keeping, recorded where it is actually caught.
       *
       * `void`, not `await`: an audit write must not add a round trip to the
       * latency of a refusal, and an attacker learning the console exists from a
       * timing difference is exactly what the bare 404 above exists to prevent.
       * The recorder bounds its own writes and swallows its own failures — see
       * `security-audit-edge.ts` for why both are load-bearing.
       *
       * `targetRef` is the *class* of surface, never `pathname`: an
       * attacker-chosen path written into an append-only table is an
       * attacker-chosen string nobody can delete afterwards.
       */
      void recordEdgeSecurityEvent(supabase, {
        event: 'admin.authorization.denied',
        targetRef: 'admin-console',
        outcome: 'denied',
        headers: request.headers,
        userId: user?.id ?? null,
      });
      return withSecurityHeaders(new NextResponse(ADMIN_DENIAL_BODY, {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
      }), nonce);
    }

    /*
     * The second factor, required of operators and of nobody else.
     *
     * It runs only after the line above has established that this caller really
     * is an operator, which is what keeps the requirement off every ordinary
     * reader: a Basic account never reaches this branch, and a non-operator gets
     * the 404 above rather than a security prompt that would confirm the console
     * exists.
     *
     * `/admin/security` is exempt, because it is the page where the factor is
     * enrolled and verified — a gate that refuses entry to the room containing
     * its own key is not a gate, it is a lockout. The exemption is scoped to
     * that one path and is still behind the operator check.
     *
     * A GET is redirected so the operator lands somewhere they can act. A
     * mutation is refused with a 403 and never a redirect: a server action posts
     * to its own page URL, and a 302 would let the browser follow it into a page
     * render instead of failing the write — the same bypass a redirect-only
     * maintenance gate leaves behind.
     */
    if (!isAssuranceExemptAdminPath(pathname)) {
      const assurance = await resolveAdminAssuranceForEdge(supabase, user);
      if (!assurance.satisfied) {
        // An operator holding a session but not the device is the scenario
        // `aal2` exists for, so the repetition of this is the signal, not the
        // single occurrence. The recorder decides which ones are worth a row.
        void recordEdgeSecurityEvent(supabase, {
          event: 'admin.assurance.denied',
          targetRef: 'admin-console',
          outcome: 'denied',
          headers: request.headers,
          userId: user?.id ?? null,
        });
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return withSecurityHeaders(NextResponse.json(
            { data: null, error: { code: 'mfa-required', message: ASSURANCE_DENIAL_MESSAGE, retryable: false } },
            { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
          ), nonce);
        }
        const url = request.nextUrl.clone();
        url.pathname = ADMIN_SECURITY_PATH;
        url.search = '';
        url.searchParams.set('next', pathname);
        return redirectCarryingSession(url);
      }
    }
  }

  /*
   * A signed-in visitor has no business sitting on a sign-in form, so the entry
   * pages send them on to where they were heading (or to the dashboard).
   * `/auth/reset-password` is not an entry page and is never bounced: recovery
   * runs on a real session, and redirecting it away would make the password
   * reset link impossible to complete. `getSafeReturnPath` refuses to return an
   * entry path, which is what stops this rule from redirecting into itself.
   */
  if (user && isAuthFormPath(pathname)) {
    const target = getSafeReturnPath(request.nextUrl.searchParams.get('next'));
    return redirectCarryingSession(new URL(target, request.url));
  }

  return withSecurityHeaders(response, nonce);
}

/*
 * `manifest.webmanifest` is the URL `app/manifest.ts` is served from and joins
 * the existing static exclusions: it is fetched on every Home Screen launch and
 * carries nothing account-specific, so putting a session refresh in front of it
 * only adds a Supabase round trip to the install. `manifest.json` stays listed
 * so the compatibility redirect in `next.config.ts` is reached the same way.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|icon.svg|manifest.json|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
