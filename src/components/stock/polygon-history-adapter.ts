import type { NormalizedCandleResult } from '@/src/lib/market-data/candles/contracts';
import type { MarketDataStatus, NormalizedBarsResult } from '@/src/lib/market-data/gateway/contracts';

function candleStatus(status: MarketDataStatus): NormalizedCandleResult['dataStatus'] {
  switch (status) {
    case 'real-time':
      return 'live';
    case 'partial':
      // Polygon REST is the bootstrap/history source, not the live authority.
      return 'delayed';
    default:
      return status;
  }
}

/**
 * Adapts the existing server-validated Polygon gateway result to the chart's
 * presentation contract. Prices are already adjusted by Polygon when the
 * request's `adjusted=true`; no client-side split math is performed.
 */
export function polygonBarsToChartResult(bars: NormalizedBarsResult): NormalizedCandleResult {
  return {
    symbol: bars.symbol,
    provider: bars.provider,
    attemptedProviders: [bars.provider],
    requestedInterval: bars.interval,
    actualInterval: bars.interval,
    sourceInterval: bars.interval,
    requestedRange: bars.range,
    actualStart: bars.firstTimestamp,
    actualEnd: bars.lastTimestamp,
    exchangeTimezone: bars.timezone,
    currency: bars.currency,
    dataStatus: candleStatus(bars.dataStatus),
    delayedByMinutes: bars.delayedByMinutes,
    adjusted: bars.adjusted,
    aggregated: false,
    cacheStatus: bars.dataStatus === 'stale'
      ? 'stale'
      : bars.dataStatus === 'cached'
        ? 'hit'
        : 'miss',
    candles: bars.bars.map((bar) => ({
      timestamp: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      partial: bar.partial,
    })),
    warnings: bars.warnings,
    fallbackReason: null,
  };
}
