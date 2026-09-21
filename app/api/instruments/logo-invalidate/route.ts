import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { normalizeLogoUrl } from '@/src/lib/instruments/logo-policy';
import { invalidateInstrumentLogo, rememberBrokenLogoUrl } from '@/src/lib/instruments/logo-store';
import { guardApiRequest } from '@/src/lib/security/request-guard';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';

/**
 * Retires a stored logo that no longer loads.
 *
 * Reported by `InstrumentLogo` when a persisted URL fails in a real browser —
 * the only place that can tell the difference between a URL that is stored and
 * one that actually paints. The request carries the URL it saw fail, and the
 * store only clears the row when that is exactly what is stored, so the worst a
 * caller can do is retire a picture that was already broken. The next page
 * render re-asks the profile providers and stores whatever answers.
 *
 * ===========================================================================
 * WHY IT NOW REQUIRES A SESSION
 * ===========================================================================
 * "The worst a caller can do is retire a picture that was already broken" was
 * true of ONE request and wrong about a script. This writes shared state — the
 * row every reader sees — and the URL it has to name is printed in the public
 * HTML of the page, so an unauthenticated caller could walk the instrument list
 * and clear every logo in the market. Each cleared row is a profile re-fetch on
 * the next render, which is a provider bill somebody else pays.
 *
 * It is NOT admin-only. A broken logo is reported by the browser of whoever
 * happened to open the page, which is the only vantage point from which the
 * failure is observable at all; requiring an operator would mean the product
 * only ever learns about broken images an operator personally saw. A session
 * plus a rate limit keeps the report coming from the reader who witnessed it
 * while making the walk-the-market script cost an account.
 */

const requestSchema = z.object({
  symbol: symbolSchema,
  url: z.string().max(2_048),
});

export async function POST(request: NextRequest) {
  const access = await resolveRequestAccountAccess();
  if (!access.authenticated || !access.userId) {
    // 404, not 401: this endpoint is an internal reporting channel, and a
    // signed-out caller learning it exists and is merely gated is the first
    // half of the walk described above.
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  const limited = await guardApiRequest(request, {
    abuseClass: 'api',
    userId: access.userId,
    operation: 'logo-invalidate',
  });
  if (limited.refusal) return limited.refusal;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid-request' }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-request' }, { status: 400 });
  }
  const url = normalizeLogoUrl(parsed.data.url);
  if (!url) return NextResponse.json({ error: 'invalid-request' }, { status: 400 });

  rememberBrokenLogoUrl(url);
  const invalidated = await invalidateInstrumentLogo(parsed.data.symbol, url);
  return NextResponse.json({ invalidated }, { status: 200 });
}
