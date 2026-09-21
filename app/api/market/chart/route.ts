import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { candleIntervalSchema, candleRangeSchema, candleSessionSchema } from '@/src/lib/market-data/candles/contracts';
import { guardOrphanMarketRoute } from '@/src/lib/market-data/api-access';
import { isCompatibleSelection } from '@/src/lib/market-data/gateway/capabilities';
import { getMarketDataGateway } from '@/src/lib/market-data/gateway/service';
import { gatewayRouteResponse } from '@/src/lib/market-data/gateway/route';
import { symbolSchema } from '@/src/lib/market-data/validation';

const chartQuerySchema = z.object({
  symbol: symbolSchema,
  interval: candleIntervalSchema.default('5m'),
  range: candleRangeSchema.default('1d'),
  adjusted: z.enum(['true', 'false']).transform((value) => value === 'true').default(false),
  session: candleSessionSchema.default('regular'),
}).superRefine((input, context) => {
  if (!isCompatibleSelection(input.interval, input.range)) {
    context.addIssue({ code: 'custom', path: ['interval'], message: `${input.interval} is not compatible with ${input.range}` });
  }
  if (input.adjusted && !['1D', 'Week', 'Month'].includes(input.interval)) {
    context.addIssue({ code: 'custom', path: ['adjusted'], message: 'Adjusted data is available only for daily, weekly, or monthly candles' });
  }
});

/**
 * No caller in this repository, and retired on purpose: `Phase11MarketUi.contract.test.ts`
 * asserts the chart UI must NOT request this route. Gated and logged rather
 * than deleted so the removal can cite production evidence — see
 * `guardOrphanMarketRoute`.
 */
export async function GET(request: NextRequest) {
  const access = await guardOrphanMarketRoute(request, '/api/market/chart');
  if (access.refusal) return access.refusal;

  return gatewayRouteResponse(request, async () => {
    const query = chartQuerySchema.parse({
      symbol: request.nextUrl.searchParams.get('symbol'),
      interval: request.nextUrl.searchParams.get('interval') ?? undefined,
      range: request.nextUrl.searchParams.get('range') ?? undefined,
      adjusted: request.nextUrl.searchParams.get('adjusted') ?? undefined,
      session: request.nextUrl.searchParams.get('session') ?? undefined,
    });
    const gateway = getMarketDataGateway();
    const instrument = await gateway.resolveInstrument(query.symbol);
    const bars = await gateway.getBars({ instrument, interval: query.interval, range: query.range, adjusted: query.adjusted, session: query.session });
    return { data: { instrument, bars }, provider: bars.provider };
  });
}

