import type { NextRequest } from 'next/server';
import { guardOrphanMarketRoute } from '@/src/lib/market-data/api-access';
import { getMarketDataGateway } from '@/src/lib/market-data/gateway/service';
import { gatewayRouteResponse } from '@/src/lib/market-data/gateway/route';
import { symbolSchema } from '@/src/lib/market-data/validation';

/**
 * No caller in this repository. Gated and logged rather than deleted — see
 * `guardOrphanMarketRoute`.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ symbol: string }> }) {
  const access = await guardOrphanMarketRoute(request, '/api/market/session');
  if (access.refusal) return access.refusal;

  return gatewayRouteResponse(request, async () => {
    const symbol = symbolSchema.parse((await context.params).symbol);
    const gateway = getMarketDataGateway();
    const instrument = await gateway.resolveInstrument(symbol);
    const session = await gateway.getSession({ instrument });
    return { data: { instrument, session }, provider: session.provider };
  });
}

