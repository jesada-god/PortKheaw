import { NextResponse, type NextRequest } from 'next/server';
import { projectOptionsSignal } from '@/src/lib/analytics/options-signal/dto';
import { computeServerOptionsSignal } from '@/src/lib/analytics/options-signal/server-signal';
import { checkMarketDataRateLimit } from '@/src/lib/market-data/api-rate-limit';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { hasCapability } from '@/src/lib/subscription/capabilities';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

/**
 * Options Signal Engine.
 *
 * The gauge needs `options.signal.summary`; the numbers behind it need
 * `options.signal.breakdown`. Both are decided here, on the server, and the
 * projection is what gets serialized — a reader without the breakdown receives a
 * payload that does not contain one, so there is nothing for the browser to have
 * to hide.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ symbol: string }> },
) {
  const gate = await guardRouteEntitlement('options.signal.summary');
  if (gate.denied) return gate.denied;
  const { tier } = gate.entitlement;

  const rate = checkMarketDataRateLimit(request, 'options-signal');
  if (!rate.allowed) {
    return NextResponse.json(
      { data: null, error: { code: 'rate-limited', message: 'Public market-data request limit exceeded', retryable: true, retryAfterSeconds: rate.retryAfterSeconds } },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds), 'Cache-Control': 'no-store' } },
    );
  }

  const parsed = symbolSchema.safeParse(decodeURIComponent((await context.params).symbol));
  if (!parsed.success) {
    return withEntitledCacheHeaders(
      NextResponse.json({ data: null, error: { code: 'invalid-symbol', message: 'Symbol is not valid', retryable: false } }, { status: 400 }),
      tier,
    );
  }

  try {
    const { result, expiration } = await computeServerOptionsSignal(parsed.data);
    return withEntitledCacheHeaders(
      NextResponse.json({
        data: projectOptionsSignal(result, {
          includeBreakdown: hasCapability(tier, 'options.signal.breakdown'),
        }),
        meta: { expiration, timestamp: new Date().toISOString() },
      }),
      tier,
    );
  } catch {
    // The engine itself never throws; a failure here is the loader, and it says
    // so plainly rather than presenting an invented signal.
    return withEntitledCacheHeaders(
      NextResponse.json(
        { data: null, error: { code: 'upstream-unavailable', message: 'Options Signal inputs are unavailable', retryable: true } },
        { status: 503 },
      ),
      tier,
    );
  }
}
