import type { CandleInterval, HistoricalRange, MarketSessionMode } from '@/src/lib/market-data/gateway/contracts';

export interface TraderChartPreset {
  interval: CandleInterval;
  label: string;
  range: HistoricalRange;
  session: MarketSessionMode;
}

/**
 * Direct timeframe workflow from the legacy quant terminal.
 *
 * Each button chooses both the candle interval and a provider-compatible history
 * window. Intraday presets include extended hours, matching the legacy chart's
 * pre/post-market behavior. Daily and weekly bars stay regular-session.
 */
export const TRADER_TIMEFRAME_PRESETS: readonly TraderChartPreset[] = [
  { interval: '1m', label: '1m', range: '5d', session: 'extended' },
  { interval: '5m', label: '5m', range: '1m', session: 'extended' },
  { interval: '10m', label: '10m', range: '1m', session: 'extended' },
  { interval: '15m', label: '15m', range: '1m', session: 'extended' },
  { interval: '1h', label: '1h', range: '3m', session: 'extended' },
  { interval: '4h', label: '4h', range: '6m', session: 'extended' },
  { interval: '1D', label: '1D', range: '1y', session: 'regular' },
  { interval: 'Week', label: 'Week', range: '5y', session: 'regular' },
];

export function traderPresetForInterval(interval: CandleInterval): TraderChartPreset | null {
  return TRADER_TIMEFRAME_PRESETS.find((preset) => preset.interval === interval) ?? null;
}
