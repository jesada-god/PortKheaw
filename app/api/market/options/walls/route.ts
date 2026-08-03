import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { observedMarketDataResponse } from '@/src/lib/market-data/route';
import { optionExpirationSchema, symbolSchema } from '@/src/lib/market-data/validation';
import { checkMarketDataRateLimit } from '@/src/lib/market-data/api-rate-limit';
import { withOptionsRouteDiagnostics } from '@/src/lib/market-data/options/route-diagnostics';
import { computeOptionsSupportResistance } from '@/src/lib/analytics/options-sr';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

/**
 * Options Walls — Call Wall, Put Wall and Max Pain.
 *
 * They live behind their own endpoint rather than riding along on the chain,
 * because they are the one Elite analytic derived from open interest and the
 * chain itself is sold at Pro. Putting them here means the capability is checked
 * before the calculation runs, not after: a reader without
 * `options.analytics.walls` never causes a wall to be computed, so there is no
 * value in the process, let alone in the response.
 */

const querySchema = z.object({
  symbol: symbolSchema,
  expiration: optionExpirationSchema,
  /**
   * The single accepted underlying price the header and chart already show,
   * used only for the distance each level reports. It cannot move a level: the
   * strikes come from the provider's open interest. Anything unusable falls back
   * to the provider's own spot.
   */
  underlyingPrice: z.coerce.number().finite().positive().optional(),
});

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');

  const gate = await guardRouteEntitlement('options.analytics.walls');
  if (gate.denied) {
    return withOptionsRouteDiagnostics(gate.denied, { route: 'options-walls', symbol });
  }
  const { tier } = gate.entitlement;

  const rate = checkMarketDataRateLimit(request, 'options-chain');
  if (!rate.allowed) {
    return withOptionsRouteDiagnostics(NextResponse.json({
      data: null,
      error: { code: 'rate-limited', message: 'Public market-data request limit exceeded', retryable: true, retryAfterSeconds: rate.retryAfterSeconds },
      meta: { provider: null, timestamp: new Date().toISOString(), freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null } },
    }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds), 'Cache-Control': 'no-store' } }), { route: 'options-walls', symbol, routeRateLimited: true });
  }

  const response = await observedMarketDataResponse(request, { route: '/api/market/options/walls', symbol }, async () => {
    const query = querySchema.parse({
      symbol,
      expiration: request.nextUrl.searchParams.get('expiration'),
      underlyingPrice: request.nextUrl.searchParams.get('underlyingPrice') ?? undefined,
    });
    // The same 60s server cache the chain route reads, so opening the Options
    // section as an Elite reader is one provider request, not two.
    const result = await getOptionsMarketDataService().getChain(query.symbol, query.expiration);
    const chain = result.data;
    const acceptedPrice = query.underlyingPrice ?? chain.spot;
    return {
      ...result,
      data: computeOptionsSupportResistance({
        symbol: chain.underlyingSymbol,
        expiration: chain.expiration,
        acceptedPrice,
        calls: chain.calls,
        puts: chain.puts,
        provider: chain.provider,
        asOf: chain.asOf,
        status: chain.status,
      }),
    };
  });

  return withOptionsRouteDiagnostics(
    withEntitledCacheHeaders(response, tier),
    { route: 'options-walls', symbol },
  );
}
