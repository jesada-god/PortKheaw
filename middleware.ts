import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isSupabaseConfigured, clientEnv } from '@/src/config/env/client';
import { isPlatformAdminForEdge } from '@/src/lib/admin/admin-edge';
import {
  getSafeReturnPath, isAdminConsolePath, isAuthFormPath, isProtectedPath,
} from '@/src/lib/auth/paths';
import { readMaintenanceForEdge } from '@/src/lib/maintenance/maintenance-edge';
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

function withSecurityHeaders(response: NextResponse): NextResponse {
  const scriptSources = [`'self'`, `'unsafe-inline'`, ...(process.env.NODE_ENV === 'development' ? [`'unsafe-eval'`] : [])];
  const policy = [
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
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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

  if (!isSupabaseConfigured) {
    if (!protectedRoute) return withSecurityHeaders(NextResponse.next());
    const url = request.nextUrl.clone();
    url.pathname = '/auth/configuration-required';
    url.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    return withSecurityHeaders(NextResponse.redirect(url));
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL as string,
    clientEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const hadSessionCookie = request.cookies.getAll().some(({ name }) => name.startsWith('sb-'));
  const { data: { user } } = await supabase.auth.getUser();

  function redirectCarryingSession(url: URL): NextResponse {
    const redirectResponse = NextResponse.redirect(url);
    // Carry any refreshed auth cookies onto the redirect, or the refresh is lost
    // and the next request starts the same round trip again.
    response.cookies.getAll().forEach(({ name, value }) => redirectResponse.cookies.set(name, value));
    return withSecurityHeaders(redirectResponse);
  }

  /*
   * The maintenance gate.
   *
   * It runs here — after the session is resolved, before every other rule —
   * because it is the only rule that can decide a request should not reach the
   * product at all, and because the two facts it needs (is the switch on, is
   * this caller an operator) are only knowable once the session is.
   *
   * Exempt paths skip the read entirely rather than reading it and ignoring the
   * answer. That is not an optimisation: it is what guarantees a Stripe webhook
   * delivery cannot be delayed, redirected or failed by a database that is
   * having a bad minute during a maintenance window.
   *
   * Note what is *not* gated on the reader's side: a mutation is refused with a
   * 503, never a redirect. A tab left open before the switch was thrown posts a
   * server action to its own page URL, and a 302 would let the browser follow it
   * into a page render instead of failing the write — which is exactly the
   * bypass a page-only guard leaves behind.
   */
  if (!isMaintenanceExemptPath(pathname)) {
    const maintenance = await readMaintenanceForEdge(supabase);
    const decision = decideMaintenance({
      pathname,
      method: request.method,
      maintenanceEnabled: maintenance.maintenanceEnabled,
      isAdmin: maintenance.isAdmin,
    });

    if (decision.action === 'block') {
      return withSecurityHeaders(NextResponse.json(MAINTENANCE_DENIAL_BODY, {
        status: decision.status,
        headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '120' },
      }));
    }
    if (decision.action === 'redirect') {
      const url = request.nextUrl.clone();
      url.pathname = decision.location;
      url.search = '';
      return redirectCarryingSession(url);
    }
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
  if (isAdminConsolePath(pathname) && !(await isPlatformAdminForEdge(supabase))) {
    return withSecurityHeaders(new NextResponse(ADMIN_DENIAL_BODY, {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
    }));
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

  return withSecurityHeaders(response);
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
