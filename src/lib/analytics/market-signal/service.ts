import 'server-only';

import { getCandleMarketDataService } from '@/src/lib/market-data/candles';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { calculateMarketSignal } from './calculations';
import type { MarketSignalCandle, MarketSignalResult } from './types';

const unavailableFreshness: DataFreshness = {
  status: 'unavailable',
  asOf: null,
  maxAgeSeconds: null,
};

export async function loadMarketSignal(
  symbol: string,
  options: { now?: () => Date } = {},
): Promise<MarketSignalResult> {
  const calculatedAt = (options.now ?? (() => new Date()))().toISOString();
  try {
    // One canonical 1D dataset supplies the signal. The candle service owns its
    // 6h/7d cache and in-flight dedupe, so opening tabs/dialogs or receiving a
    // WebSocket tick never triggers another provider request or recalculation.
    const result = await getCandleMarketDataService().getCandles({
      symbol,
      interval: '1D',
      range: '5y',
      adjusted: true,
      session: 'regular',
    });
    const candles: MarketSignalCandle[] = result.data.candles.map((candle) => ({
      date: new Date(candle.timestamp * 1_000).toISOString().slice(0, 10),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: Math.round(candle.volume),
      finalized: candle.partial !== true,
    }));
    return calculateMarketSignal(candles, {
      symbol,
      source: result.provider ?? result.data.provider,
      freshness: result.freshness,
      calculatedAt,
    });
  } catch {
    return calculateMarketSignal([], {
      symbol,
      source: null,
      freshness: unavailableFreshness,
      calculatedAt,
    });
  }
}
