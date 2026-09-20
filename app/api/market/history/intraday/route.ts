import type { NextRequest } from 'next/server';
import { getIntradayMarketDataService } from '@/src/lib/market-data/intraday';
import { guardOrphanMarketRoute } from '@/src/lib/market-data/api-access';
import { observedMarketDataResponse } from '@/src/lib/market-data/route';
import { intradayQuerySchema } from '@/src/lib/market-data/validation';

/**
 * No browser caller in this repository. The two `providers/*\/intraday.ts`
 * matches for this path are the `route:` LABEL passed to provider-request
 * logging, not a fetch of this endpoint — the intraday series the stock page
 * draws comes through `/api/market/candles`.
 *
 * Gated and logged rather than deleted — see `guardOrphanMarketRoute`. The
 * address-keyed limiter is replaced by the account-keyed one for the same
 * reason as everywhere else in this change.
 */
export async function GET(request: NextRequest) {
  const access = await guardOrphanMarketRoute(request, '/api/market/history/intraday');
  if (access.refusal) return access.refusal;

  const response = await observedMarketDataResponse(request, { route: '/api/market/history/intraday', symbol: request.nextUrl.searchParams.get('symbol') }, async () => {
    const query = intradayQuerySchema.parse({
      symbol: request.nextUrl.searchParams.get('symbol'),
      interval: request.nextUrl.searchParams.get('interval'),
      range: request.nextUrl.searchParams.get('range') ?? undefined,
      session: request.nextUrl.searchParams.get('session') ?? undefined,
    });
    return getIntradayMarketDataService().getIntraday(
      query.symbol,
      query.interval,
      query.range,
      query.session,
    );
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
