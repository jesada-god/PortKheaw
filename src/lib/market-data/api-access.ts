import 'server-only';
import { NextResponse } from 'next/server';
import { guardApiRequest } from '@/src/lib/security/request-guard';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';

/**
 * Which market-data endpoints a signed-out visitor may reach, and which they
 * may not.
 *
 * ===========================================================================
 * THE RULE, AND WHERE IT COMES FROM
 * ===========================================================================
 * An API route is public exactly when a PAGE that renders for a signed-out
 * visitor needs it. Nothing else. After the split, two pages are public —
 * `/stock/{symbol}` and `/search` — so the public API surface is the set of
 * endpoints those two call, and every other market endpoint requires a session.
 *
 * That is the whole design: the surface is derived from the pages rather than
 * chosen per route, so a route cannot drift into being public because somebody
 * forgot a guard. When a page changes side, the endpoints it calls move with
 * it, and the reason is written down in one place instead of thirteen.
 *
 * ===========================================================================
 * WHY 401 AND NOT A REDIRECT
 * ===========================================================================
 * These are fetched by client components. A 302 to the sign-in form would be
 * followed by `fetch`, parsed as JSON, and fail with a syntax error somewhere
 * unrelated to the cause — so the caller is told plainly, in the envelope every
 * other market route already speaks, and the UI can decide what to show.
 *
 * ===========================================================================
 * WHAT THIS IS NOT
 * ===========================================================================
 * Not an entitlement check. It answers "is anyone signed in", never "which
 * plan" — `guardRouteEntitlement` owns that question and the options routes
 * already ask it. Conflating them is how a 403 stops telling you which of the
 * two refused.
 */

function unauthenticated(): NextResponse {
  const response = NextResponse.json({
    data: null,
    error: {
      code: 'unauthenticated',
      message: 'กรุณาเข้าสู่ระบบเพื่อดูข้อมูลนี้',
      retryable: false,
    },
    meta: {
      provider: null,
      timestamp: new Date().toISOString(),
      freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
    },
  }, { status: 401 });
  /*
   * `no-store` and `Vary: Cookie` together. A refusal is per-reader: without
   * them a shared cache could keep this 401 and serve it to a signed-in reader,
   * turning one anonymous probe into an outage for everybody behind that cache.
   */
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Cookie');
  return response;
}

export interface MarketRouteAccess {
  /** The response to return, or `null` when the request may proceed. */
  refusal: NextResponse | null;
  userId: string | null;
}

/**
 * The gate an authenticated market route opens with.
 *
 * Session first, then rate — in that order, because a signed-out caller should
 * cost one session read and never reach the limiter's bookkeeping, let alone a
 * provider.
 *
 * The limit is charged through `guardApiRequest`, which expands the caller into
 * `identityKeys` — the account AND the address, counted independently with the
 * tighter answer winning. An address-only limit is the wrong key here: a
 * university NAT puts hundreds of unrelated readers in one bucket, and a
 * residential proxy pool gives one script as many buckets as it likes.
 */
export async function guardAuthenticatedMarketRoute(
  request: { headers: Headers },
  operation: string,
): Promise<MarketRouteAccess> {
  const access = await resolveRequestAccountAccess();
  if (!access.authenticated || !access.userId) {
    return { refusal: unauthenticated(), userId: null };
  }
  const limited = await guardApiRequest(request, {
    abuseClass: 'api',
    userId: access.userId,
    operation,
  });
  return { refusal: limited.refusal, userId: access.userId };
}

/**
 * The same gate, plus a line saying somebody actually called this.
 *
 * Four market endpoints have no caller anywhere in this repository:
 * `/api/market/overview`, `/api/market/chart`, `/api/market/session/{symbol}`
 * and `/api/market/history/intraday`. One of them — `/api/market/chart` — has a
 * contract test asserting the UI must NOT call it, so it is retired by
 * intention rather than by neglect.
 *
 * They are gated rather than deleted, because "grep found nothing" is evidence
 * about this repository and not about the internet: a QA script, a monitor or
 * something outside this tree could be calling them. This log is what turns the
 * question into an answerable one. If `market_route_orphan_called` appears
 * nowhere in two to four weeks of production logs, they can be deleted with a
 * fact behind the decision instead of a guess.
 *
 * It logs AFTER the gate deliberately: a probe from a signed-out scanner is not
 * evidence that a feature depends on the route, and counting it would produce
 * exactly the false positive that keeps dead code alive forever.
 */
export async function guardOrphanMarketRoute(
  request: { headers: Headers },
  route: string,
): Promise<MarketRouteAccess> {
  const access = await guardAuthenticatedMarketRoute(request, `orphan:${route}`);
  if (access.refusal) return access;
  console.info(JSON.stringify({
    event: 'market_route_orphan_called',
    route,
    // Neither the account nor the address: the question is "does anything call
    // this", and a caller identity would make a deletion log into a record of
    // who browsed what.
    timestamp: new Date().toISOString(),
  }));
  return access;
}
