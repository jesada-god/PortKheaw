import type { NextRequest } from 'next/server';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { observedMarketDataResponse } from '@/src/lib/market-data/route';
import { optionExpirationsQuerySchema } from '@/src/lib/market-data/validation';
import { checkMarketDataRateLimit } from '@/src/lib/market-data/api-rate-limit';
import { NextResponse } from 'next/server';
import { withOptionsRouteDiagnostics } from '@/src/lib/market-data/options/route-diagnostics';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

/**
 * The expiration ladder is the first step of reading a chain, so it carries the
 * same gate. Refusing here means a reader without the ledger never reaches the
 * provider at all, rather than being stopped one request later.
 */
export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');

  const gate = await guardRouteEntitlement('options.chain.basic');
  if (gate.denied) {
    return withOptionsRouteDiagnostics(gate.denied, { route: 'options-expirations', symbol });
  }
  const { tier } = gate.entitlement;

  const rate = checkMarketDataRateLimit(request, 'options-expirations');
  if (!rate.allowed) return withOptionsRouteDiagnostics(NextResponse.json({ data: null, error: { code: 'rate-limited', message: 'Public market-data request limit exceeded', retryable: true, retryAfterSeconds: rate.retryAfterSeconds }, meta: { provider: null, timestamp: new Date().toISOString(), freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null } } }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds), 'Cache-Control': 'no-store' } }), { route: 'options-expirations', symbol, routeRateLimited: true });

  const response = await observedMarketDataResponse(request, { route: '/api/market/options/expirations', symbol }, async () => {
    const query = optionExpirationsQuerySchema.parse({
      symbol,
    });
    return getOptionsMarketDataService().getExpirations(query.symbol);
  });
  return withOptionsRouteDiagnostics(
    withEntitledCacheHeaders(response, tier),
    { route: 'options-expirations', symbol },
  );
}
