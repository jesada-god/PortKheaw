import 'server-only';

import { signalGateEnabled, signalZonesEnabled } from '@/src/config/signal-flags';
import { loadEarningsSchedule } from '@/src/lib/analytics/earnings/service';
import { getCandleMarketDataService } from '@/src/lib/market-data/candles';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { calculateMarketSignal } from './calculations';
import type { MarketSignalCandle, MarketSignalEarningsContext, MarketSignalResult } from './types';

const unavailableFreshness: DataFreshness = {
  status: 'unavailable',
  asOf: null,
  maxAgeSeconds: null,
};

/**
 * Days to the next scheduled report, or nothing at all.
 *
 * Every failure mode here — no provider key, no scheduled report, a rate limit,
 * an outage — resolves to `null`, which makes the engine skip its earnings rules
 * entirely rather than assume the print is far away. The call is made ONLY when
 * the gate is on, so a deployment with the flag off issues exactly the provider
 * requests it issued before P1.
 */
async function loadEarningsContext(symbol: string): Promise<MarketSignalEarningsContext | undefined> {
  if (!signalGateEnabled()) return undefined;
  try {
    const schedule = await loadEarningsSchedule(symbol);
    return { daysToNextReport: schedule.status === 'available' ? schedule.daysToEarnings : null };
  } catch {
    return { daysToNextReport: null };
  }
}

export async function loadMarketSignal(
  symbol: string,
  options: { now?: () => Date } = {},
): Promise<MarketSignalResult> {
  const calculatedAt = (options.now ?? (() => new Date()))().toISOString();
  const features = { gate: signalGateEnabled(), zones: signalZonesEnabled() };
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
      features,
      earnings: await loadEarningsContext(symbol),
    });
  } catch {
    return calculateMarketSignal([], {
      symbol,
      source: null,
      freshness: unavailableFreshness,
      calculatedAt,
      features,
    });
  }
}
