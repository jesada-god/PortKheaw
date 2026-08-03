import type { NextRequest } from 'next/server';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { observedMarketDataResponse } from '@/src/lib/market-data/route';
import { optionsChainQuerySchema } from '@/src/lib/market-data/validation';
import { checkMarketDataRateLimit } from '@/src/lib/market-data/api-rate-limit';
import { NextResponse } from 'next/server';
import { withOptionsRouteDiagnostics } from '@/src/lib/market-data/options/route-diagnostics';
import {
  optionsChainProjectionFor,
  shapeOptionsChain,
} from '@/src/lib/market-data/options/entitlement-shaping';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

/**
 * The options chain, shaped to the reader's plan.
 *
 * The entitlement check runs first, so a reader without `options.chain.basic`
 * costs the provider nothing at all. A reader with the basic ledger but not full
 * Greeks receives a chain with implied volatility and every Greek removed before
 * serialization — the premium columns never reach the browser, so no UI decision
 * can accidentally reveal them.
 */
export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');

  const gate = await guardRouteEntitlement('options.chain.basic');
  if (gate.denied) {
    return withOptionsRouteDiagnostics(gate.denied, { route: 'options-chain', symbol });
  }
  const { tier } = gate.entitlement;

  const rate = checkMarketDataRateLimit(request, 'options-chain');
  if (!rate.allowed) return withOptionsRouteDiagnostics(NextResponse.json({ data: null, error: { code: 'rate-limited', message: 'Public market-data request limit exceeded', retryable: true, retryAfterSeconds: rate.retryAfterSeconds }, meta: { provider: null, timestamp: new Date().toISOString(), freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null } } }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds), 'Cache-Control': 'no-store' } }), { route: 'options-chain', symbol, routeRateLimited: true });

  const projection = optionsChainProjectionFor(tier);
  const response = await observedMarketDataResponse(request, { route: '/api/market/options/chain', symbol }, async () => {
    const query = optionsChainQuerySchema.parse({
      symbol,
      expiration: request.nextUrl.searchParams.get('expiration'),
    });
    const result = await getOptionsMarketDataService().getChain(query.symbol, query.expiration);
    return { ...result, data: shapeOptionsChain(result.data, projection) };
  });
  return withOptionsRouteDiagnostics(
    withEntitledCacheHeaders(response, tier),
    { route: 'options-chain', symbol },
  );
}
