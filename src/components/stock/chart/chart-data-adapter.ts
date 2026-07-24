import type { AreaData, BarData, CandlestickData, HistogramData, LineData, Time, UTCTimestamp } from 'lightweight-charts';
import { heikinAshi } from '@/src/lib/analytics/chart-types/calculations';
import type { AdvancedChartType } from '@/src/lib/analytics/chart-types/types';
import { normalizeOhlcvTimeline, type OhlcvInputBar } from '@/src/lib/analytics/chart-data/timeline';
import type { ChartBar } from './chart-types';

function toTimestamp(value: string): UTCTimestamp {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
  return Math.floor(date.valueOf() / 1_000) as UTCTimestamp;
}

export function adaptChartBars(rows: readonly OhlcvInputBar[], chartType: AdvancedChartType): ChartBar[] {
  const raw = normalizeOhlcvTimeline(rows);
  const transformed = chartType === 'heikin-ashi'
    ? heikinAshi(raw.map((bar) => ({ date: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0 })))
    : raw.map((bar) => ({ date: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
  return raw.map((bar, index) => {
    const display = transformed[index];
    const extra = rows[index] as OhlcvInputBar & { transactions?: number; vwap?: number; partial?: boolean };
    return {
      time: toTimestamp(bar.time),
      sourceTime: bar.time,
      open: display.open,
      high: display.high,
      low: display.low,
      close: display.close,
      volume: bar.volume ?? 0,
      rawOpen: bar.open,
      rawHigh: bar.high,
      rawLow: bar.low,
      rawClose: bar.close,
      ...(Number.isFinite(extra.transactions) ? { transactions: extra.transactions } : {}),
      ...(Number.isFinite(extra.vwap) ? { vwap: extra.vwap } : {}),
      partial: Boolean(extra.partial),
    };
  });
}

export function candlestickData(bars: readonly ChartBar[]): CandlestickData<Time>[] {
  return bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
}

export function barData(bars: readonly ChartBar[]): BarData<Time>[] {
  return bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
}

export function lineData(bars: readonly ChartBar[]): LineData<Time>[] {
  return bars.map(({ time, close: value }) => ({ time, value }));
}

export function areaData(bars: readonly ChartBar[]): AreaData<Time>[] {
  return bars.map(({ time, close: value }) => ({ time, value }));
}

export function volumeData(bars: readonly ChartBar[]): HistogramData<Time>[] {
  return bars.map((bar) => ({
    time: bar.time,
    value: bar.volume,
    color: bar.rawClose >= bar.rawOpen ? '#00c57f99' : '#ff3b3099',
  }));
}

export function canUpdateLatest(previous: readonly ChartBar[], next: readonly ChartBar[]): boolean {
  if (!previous.length || !next.length || next.length < previous.length || next.length > previous.length + 1) return false;
  const stableCount = Math.max(0, previous.length - 1);
  for (let index = 0; index < stableCount; index += 1) {
    if (previous[index].time !== next[index].time) return false;
  }
  return next.length === previous.length
    ? previous.at(-1)?.time === next.at(-1)?.time
    : Number(previous.at(-1)!.time) < Number(next.at(-1)!.time);
}
