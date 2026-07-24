import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getCandleMarketDataService } from '@/src/lib/market-data/candles';
import { candleIntervalSchema } from '@/src/lib/market-data/candles/contracts';
import { MarketDataError } from '@/src/lib/market-data/errors';
import { gatewayRouteResponse } from '@/src/lib/market-data/gateway/route';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { calculateClassicPivotLevels } from '@/src/components/stock/option-tool-chart/pivot-levels';

const querySchema = z.object({
  symbol: symbolSchema,
  timeframe: candleIntervalSchema,
});

export async function GET(request: NextRequest) {
  return gatewayRouteResponse(request, async () => {
    const query = querySchema.parse({
      symbol: request.nextUrl.searchParams.get('symbol'),
      timeframe: request.nextUrl.searchParams.get('timeframe'),
    });
    const basisInterval = query.timeframe === 'Week' ? 'Week' as const : '1D' as const;
    const result = await getCandleMarketDataService().getCandles({
      symbol: query.symbol,
      interval: basisInterval,
      range: basisInterval === 'Week' ? '1y' : '1m',
      adjusted: false,
      session: 'regular',
    });
    const bars = result.data;
    const source = bars.candles.filter((bar) => !bar.partial).at(-1);
    if (!source) {
      throw new MarketDataError('insufficient-data', `No completed ${basisInterval} bar is available for classic pivot levels`);
    }
    return {
      data: {
        symbol: bars.symbol,
        basisInterval,
        sourceTime: source.timestamp,
        provider: bars.provider,
        ...calculateClassicPivotLevels(source),
      },
      provider: bars.provider,
    };
  });
}
