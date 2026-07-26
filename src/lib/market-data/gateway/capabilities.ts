import type { CandleInterval, HistoricalRange } from './contracts';

export const GATEWAY_INTERVALS: readonly CandleInterval[] = [
  '1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m',
  '1h', '2h', '3h', '4h',
  '1D', 'Week', 'Month',
];
export const GATEWAY_RANGES: readonly HistoricalRange[] = [
  '1d', '5d', '1m', '3m', '6m', 'ytd', '1y', '3y', '5y',
];

const COMPATIBILITY: Record<CandleInterval, readonly HistoricalRange[]> = {
  '1m': ['1d', '5d'],
  '2m': ['1d', '5d'],
  '3m': ['1d', '5d'],
  '5m': ['1d', '5d', '1m'],
  '10m': ['1d', '5d', '1m'],
  '15m': ['1d', '5d', '1m'],
  '30m': ['5d', '1m', '3m'],
  '45m': ['5d', '1m', '3m'],
  '1h': ['5d', '1m', '3m', '6m'],
  '2h': ['1m', '3m', '6m'],
  '3h': ['1m', '3m', '6m'],
  '4h': ['1m', '3m', '6m', 'ytd', '1y'],
  '1D': ['1m', '3m', '6m', 'ytd', '1y', '3y', '5y'],
  Week: ['3m', '6m', 'ytd', '1y', '3y', '5y'],
  Month: ['1y', '3y', '5y'],
};

const RANGE_LABEL: Record<HistoricalRange, string> = {
  '1d': '1D', '5d': '5D', '1m': '1M', '3m': '3M', '6m': '6M',
  ytd: 'YTD', '1y': '1Y', '3y': '3Y', '5y': '5Y',
};

export function supportedRangesForInterval(interval: CandleInterval): readonly HistoricalRange[] {
  return COMPATIBILITY[interval];
}

export function isCompatibleSelection(interval: CandleInterval, range: HistoricalRange): boolean {
  return COMPATIBILITY[interval].includes(range);
}

export function defaultIntervalForRange(range: HistoricalRange): CandleInterval {
  if (range === '1d') return '5m';
  if (range === '5d') return '15m';
  if (range === '1m') return '1h';
  if (range === '3m') return '4h';
  if (['6m', 'ytd', '1y'].includes(range)) return '1D';
  return 'Week';
}

export interface CompatibleSelection {
  interval: CandleInterval;
  range: HistoricalRange;
  changed: boolean;
  notice: string | null;
}

export function compatibleSelection(
  interval: CandleInterval,
  range: HistoricalRange,
  changedControl: 'interval' | 'range',
): CompatibleSelection {
  if (isCompatibleSelection(interval, range)) return { interval, range, changed: false, notice: null };
  if (changedControl === 'range') {
    const nextInterval = defaultIntervalForRange(range);
    return {
      interval: nextInterval,
      range,
      changed: true,
      notice: `ช่วง ${RANGE_LABEL[range]} ใช้แท่ง ${nextInterval} เพื่อให้มีข้อมูลเพียงพอ`,
    };
  }
  const nextRange: HistoricalRange = interval === '1D' ? '6m'
    : interval === 'Week' ? '1y'
      : interval === 'Month' ? '5y'
        : COMPATIBILITY[interval][0];
  return {
    interval,
    range: nextRange,
    changed: true,
    notice: interval === '1D'
      ? 'แท่ง 1D ต้องใช้ช่วงย้อนหลังอย่างน้อย 1 เดือน ระบบเปลี่ยนช่วงเป็น 6M'
      : `แท่ง ${interval} ใช้ช่วง ${RANGE_LABEL[nextRange]} เพื่อให้มีข้อมูลเพียงพอ`,
  };
}

export interface PolygonAggregateResolution {
  multiplier: number;
  timespan: 'minute' | 'hour' | 'day' | 'week' | 'month';
  seconds: number;
}

export function polygonAggregateResolution(interval: CandleInterval): PolygonAggregateResolution {
  // Match the named daily/weekly/monthly intervals first: 'Month' ends with 'h',
  // which would otherwise be misread as an hourly resolution.
  if (interval === '1D') return { multiplier: 1, timespan: 'day', seconds: 86_400 };
  if (interval === 'Week') return { multiplier: 1, timespan: 'week', seconds: 7 * 86_400 };
  if (interval === 'Month') return { multiplier: 1, timespan: 'month', seconds: 31 * 86_400 };
  if (interval.endsWith('m')) {
    const multiplier = Number(interval.slice(0, -1));
    return { multiplier, timespan: 'minute', seconds: multiplier * 60 };
  }
  if (interval.endsWith('h')) {
    const multiplier = Number(interval.slice(0, -1));
    return { multiplier, timespan: 'hour', seconds: multiplier * 3_600 };
  }
  return { multiplier: 1, timespan: 'day', seconds: 86_400 };
}

