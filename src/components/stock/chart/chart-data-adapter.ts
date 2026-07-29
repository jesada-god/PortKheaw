import type { AreaData, BarData, CandlestickData, HistogramData, LineData, Time, UTCTimestamp, WhitespaceData } from 'lightweight-charts';
import type { AdvancedChartType } from '@/src/lib/analytics/chart-types/types';
import type { OhlcvInputBar } from '@/src/lib/analytics/chart-data/timeline';
import { normalizeCanonicalBars, toDisplayBars, toEpochSeconds } from '@/src/lib/analytics/canonical-bars';
import type { ChartBar } from './chart-types';

export function adaptChartBars(rows: readonly OhlcvInputBar[], chartType: AdvancedChartType): ChartBar[] {
  const raw = normalizeCanonicalBars(rows);
  const display = toDisplayBars(raw, chartType);
  // Provider metadata follows the same canonical timestamp normalization and
  // duplicate rule as OHLCV. It is never paired by array index after filtering.
  const metadataByTime = new Map<number, OhlcvInputBar & { transactions?: number; vwap?: number; partial?: boolean }>();
  rows.forEach((row) => {
    const time = toEpochSeconds(row.time ?? row.date);
    if (time != null) metadataByTime.set(time, row);
  });
  return display.map((bar) => {
    const extra = metadataByTime.get(bar.time);
    return {
      time: bar.time as UTCTimestamp,
      sourceTime: new Date(bar.time * 1_000).toISOString(),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      rawOpen: bar.rawOpen,
      rawHigh: bar.rawHigh,
      rawLow: bar.rawLow,
      rawClose: bar.rawClose,
      transformed: bar.transformed,
      ...(extra && Number.isFinite(extra.transactions) ? { transactions: extra.transactions } : {}),
      ...(extra && Number.isFinite(extra.vwap) ? { vwap: extra.vwap } : {}),
      partial: bar.partial,
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

export function volumeData(bars: readonly ChartBar[]): Array<HistogramData<Time> | WhitespaceData<Time>> {
  return bars.map((bar) => bar.volume == null
    ? { time: bar.time }
    : {
      time: bar.time,
      value: bar.volume,
      color: bar.rawClose >= bar.rawOpen ? '#00c57f99' : '#ff3b3099',
    });
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
