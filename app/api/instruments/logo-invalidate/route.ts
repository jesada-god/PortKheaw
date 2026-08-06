import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { normalizeLogoUrl } from '@/src/lib/instruments/logo-policy';
import { invalidateInstrumentLogo, rememberBrokenLogoUrl } from '@/src/lib/instruments/logo-store';

/**
 * Retires a stored logo that no longer loads.
 *
 * Reported by `InstrumentLogo` when a persisted URL fails in a real browser —
 * the only place that can tell the difference between a URL that is stored and
 * one that actually paints. The request carries the URL it saw fail, and the
 * store only clears the row when that is exactly what is stored, so the worst a
 * caller can do is retire a picture that was already broken. The next page
 * render re-asks the profile providers and stores whatever answers.
 */

const requestSchema = z.object({
  symbol: symbolSchema,
  url: z.string().max(2_048),
});

export async function POST(request: NextRequest) {
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
