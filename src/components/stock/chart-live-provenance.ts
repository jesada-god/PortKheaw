import type { DisplayDataStatus } from '@/src/components/market-data/DataProvenance';
import type { CandleDataStatus } from '@/src/lib/market-data/candles/contracts';
import type { MarketDataStatus } from '@/src/lib/market-data/gateway/contracts';
import type { MarketDataLabel } from '@/src/lib/stock-detail/market-source';

export interface ChartProvenance {
  status: DisplayDataStatus;
  provider?: string;
  asOf?: string;
  realtime: boolean;
}

/**
 * Prefer the accepted live candle's provenance only when the chart is actually
 * consuming that candle and the gateway confirms an entitled real-time feed.
 */
export function resolveChartProvenance(input: {
  historyStatus: MarketDataStatus | CandleDataStatus;
  historyProvider?: string;
  historyAsOf?: string;
  coveredByLiveSource: boolean;
  hasLiveCandle: boolean;
  marketLabel?: MarketDataLabel | null;
}): ChartProvenance {
  const live = input.coveredByLiveSource
    && input.hasLiveCandle
    && input.marketLabel?.realtime === true;

  if (live) {
    return {
      status: 'live',
      provider: input.marketLabel?.provider ?? input.historyProvider,
      asOf: input.marketLabel?.exchangeTimestamp ?? input.historyAsOf,
      realtime: true,
    };
  }

  const status: DisplayDataStatus = input.historyStatus === 'real-time'
    || input.historyStatus === 'partial'
    || input.historyStatus === 'live'
    ? 'delayed'
    : input.historyStatus === 'unavailable'
      ? 'unavailable'
      : input.historyStatus;
  return {
    status,
    provider: input.historyProvider,
    asOf: input.historyAsOf,
    realtime: false,
  };
}
