import type { NextRequest } from 'next/server';
import { getMarketDataProvider } from '@/src/lib/market-data';
import { guardOrphanMarketRoute } from '@/src/lib/market-data/api-access';
import { marketDataResponse } from '@/src/lib/market-data/route';

/**
 * No caller in this repository. Gated and logged rather than deleted, so the
 * decision to remove it can be made from production evidence — see
 * `guardOrphanMarketRoute`. The dashboard uses `/api/market/overview/section`,
 * which is a different route and already required a session.
 */
export async function GET(request: NextRequest) {
  const access = await guardOrphanMarketRoute(request, '/api/market/overview');
  if (access.refusal) return access.refusal;

  const response = await marketDataResponse(() => getMarketDataProvider().getMarketOverview());
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
