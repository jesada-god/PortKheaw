import { getCandleMarketDataService } from '../../candles';
import type { CandleRange } from '../../candles/contracts';
import type { HistoricalProvider } from '../../historical-service';
import type {
  HistoricalPrices,
  HistoricalRange,
  ProviderResult,
} from '../../types';

const CANDLE_RANGE: Record<HistoricalRange, CandleRange> = {
  '1m': '1m',
  '3m': '3m',
  '6m': '6m',
  '1y': '1y',
  '5y': '5y',
  max: '5y',
};

type CandleService = Pick<
  ReturnType<typeof getCandleMarketDataService>,
  'getCandles'
>;

/** Adapts the app's existing validated Yahoo Chart candle pipeline to the
 * historical-price contract used by deterministic Beta. */
export class YahooHistoricalProvider implements HistoricalProvider {
  readonly id = 'yahoo-finance-chart';

  constructor(
    private readonly candles: CandleService = getCandleMarketDataService(),
  ) {}

  async getHistoricalPrices(
    rawSymbol: string,
    range: HistoricalRange,
  ): Promise<ProviderResult<HistoricalPrices>> {
    const symbol = rawSymbol.trim().toUpperCase();
    const result = await this.candles.getCandles({
      symbol,
      interval: '1D',
      range: CANDLE_RANGE[range],
      adjusted: true,
      session: 'regular',
    });
    return {
      data: {
        symbol,
        range,
        interval: '1d',
        prices: result.data.candles.map((candle) => ({
          date: new Date(candle.timestamp * 1_000).toISOString().slice(0, 10),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: Math.round(candle.volume),
        })),
        providerUsed: result.provider ?? this.id,
        fallbackReason: result.data.fallbackReason,
        asOf: result.freshness.asOf,
        freshness: result.data.dataStatus === 'stale'
          ? 'stale' : result.data.cacheStatus === 'hit' ? 'cached' : 'fresh',
        methodology: 'Adjusted daily OHLCV from the existing validated Yahoo Chart pipeline.',
        limitations: [...result.data.warnings],
      },
      provider: result.provider ?? this.id,
      freshness: result.freshness,
    };
  }
}
