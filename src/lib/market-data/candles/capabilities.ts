import type { CandleInterval, CandleRange, ProviderCapabilities, TimeframeCapability } from './contracts';

export const CANDLE_INTERVALS: readonly CandleInterval[] = [
  '1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m',
  '1h', '2h', '3h', '4h',
  '1D', 'Week', 'Month',
];
export const CANDLE_RANGES: readonly CandleRange[] = [
  '1d', '5d', '1m', '3m', '6m', 'ytd', '1y', '3y', '5y',
];

const INTRADAY_SHORT: CandleRange[] = ['1d', '5d'];
const INTRADAY_MONTH: CandleRange[] = [...INTRADAY_SHORT, '1m'];
const INTRADAY_QUARTER: CandleRange[] = [...INTRADAY_MONTH, '3m'];
const INTRADAY_TWO_YEARS: CandleRange[] = [...INTRADAY_QUARTER, '6m', 'ytd', '1y'];
const DAILY_RANGES: CandleRange[] = [...CANDLE_RANGES];

function capability(
  interval: CandleInterval,
  supportedRanges: CandleRange[],
  native: boolean,
  aggregationSources?: CandleInterval[],
  maxLookbackDays?: number,
): TimeframeCapability {
  return { interval, supportedRanges, native, ...(aggregationSources ? { aggregationSources } : {}), ...(maxLookbackDays ? { maxLookbackDays } : {}) };
}

export const FMP_CANDLE_CAPABILITIES: ProviderCapabilities = {
  adjustedHistorical: false,
  extendedHours: false,
  intervals: [
    capability('1m', INTRADAY_SHORT, true, undefined, 5),
    capability('2m', INTRADAY_SHORT, false, ['1m'], 5),
    capability('3m', INTRADAY_SHORT, false, ['1m'], 5),
    capability('5m', INTRADAY_MONTH, true, undefined, 30),
    capability('10m', INTRADAY_MONTH, false, ['5m'], 30),
    capability('15m', INTRADAY_MONTH, true, undefined, 30),
    capability('30m', INTRADAY_QUARTER, true, undefined, 90),
    capability('45m', INTRADAY_QUARTER, false, ['15m'], 30),
    capability('1h', INTRADAY_TWO_YEARS, true, undefined, 730),
    capability('2h', INTRADAY_TWO_YEARS, false, ['1h'], 730),
    capability('3h', INTRADAY_TWO_YEARS, false, ['1h'], 730),
    capability('4h', INTRADAY_TWO_YEARS, true, undefined, 730),
    capability('1D', DAILY_RANGES, true, undefined, 1_825),
    capability('Week', DAILY_RANGES, false, ['1D'], 1_825),
    capability('Month', DAILY_RANGES, false, ['1D'], 1_825),
  ],
};

export const ALPHA_VANTAGE_CANDLE_CAPABILITIES: ProviderCapabilities = {
  adjustedHistorical: false,
  extendedHours: true,
  intervals: [
    capability('1m', INTRADAY_MONTH, true, undefined, 30),
    capability('2m', INTRADAY_MONTH, false, ['1m'], 30),
    capability('3m', INTRADAY_MONTH, false, ['1m'], 30),
    capability('5m', INTRADAY_MONTH, true, undefined, 30),
    capability('10m', INTRADAY_MONTH, false, ['5m'], 30),
    capability('15m', INTRADAY_MONTH, true, undefined, 30),
    capability('30m', INTRADAY_MONTH, true, undefined, 30),
    capability('45m', INTRADAY_MONTH, false, ['15m'], 30),
    capability('1h', INTRADAY_MONTH, true, undefined, 30),
    capability('2h', INTRADAY_MONTH, false, ['1h'], 30),
    capability('3h', INTRADAY_MONTH, false, ['1h'], 30),
    capability('4h', INTRADAY_MONTH, false, ['1h'], 30),
    capability('1D', DAILY_RANGES, true, undefined, 1_825),
    capability('Week', DAILY_RANGES, false, ['1D'], 1_825),
    capability('Month', DAILY_RANGES, false, ['1D'], 1_825),
  ],
};

export const YAHOO_CANDLE_CAPABILITIES: ProviderCapabilities = {
  adjustedHistorical: true,
  extendedHours: true,
  intervals: [
    capability('1m', INTRADAY_SHORT, true, undefined, 8),
    capability('2m', INTRADAY_SHORT, false, ['1m'], 8),
    capability('3m', INTRADAY_SHORT, false, ['1m'], 8),
    capability('5m', INTRADAY_MONTH, true, undefined, 60),
    capability('10m', INTRADAY_MONTH, false, ['5m'], 60),
    capability('15m', INTRADAY_MONTH, true, undefined, 60),
    capability('30m', INTRADAY_MONTH, true, undefined, 60),
    capability('45m', INTRADAY_MONTH, false, ['15m'], 60),
    capability('1h', INTRADAY_TWO_YEARS, true, undefined, 730),
    capability('2h', INTRADAY_TWO_YEARS, false, ['1h'], 730),
    capability('3h', INTRADAY_TWO_YEARS, false, ['1h'], 730),
    capability('4h', INTRADAY_TWO_YEARS, false, ['1h'], 730),
    capability('1D', DAILY_RANGES, true, undefined, 1_825),
    capability('Week', DAILY_RANGES, true, undefined, 1_825),
    capability('Month', DAILY_RANGES, true, undefined, 1_825),
  ],
};

export function timeframeCapability(
  capabilities: ProviderCapabilities,
  interval: CandleInterval,
): TimeframeCapability | undefined {
  return capabilities.intervals.find((item) => item.interval === interval);
}

export function supportsCandleRequest(
  capabilities: ProviderCapabilities,
  interval: CandleInterval,
  range: CandleRange,
  adjusted: boolean,
  session: 'regular' | 'extended',
): boolean {
  const item = timeframeCapability(capabilities, interval);
  if (!item?.supportedRanges.includes(range)) return false;
  if (adjusted && !['1D', 'Week', 'Month'].includes(interval)) return false;
  if (adjusted && !capabilities.adjustedHistorical) return false;
  if (session === 'extended' && !capabilities.extendedHours) return false;
  return true;
}

export function sourceIntervalFor(
  capabilities: ProviderCapabilities,
  interval: CandleInterval,
): CandleInterval | null {
  const item = timeframeCapability(capabilities, interval);
  if (!item) return null;
  return item.native ? interval : item.aggregationSources?.[0] ?? null;
}

export function supportedRangesFor(interval: CandleInterval): CandleRange[] {
  // Client controls advertise only combinations with a verified no-key Yahoo
  // fallback. Configured paid providers may improve provenance/native coverage,
  // but a plan-specific 402 must never leave the UI promising an unusable range.
  const ranges = new Set<CandleRange>(timeframeCapability(YAHOO_CANDLE_CAPABILITIES, interval)?.supportedRanges ?? []);
  return CANDLE_RANGES.filter((range) => ranges.has(range));
}

export function recommendedInterval(range: CandleRange): CandleInterval {
  if (range === '1d') return '1m';
  if (range === '5d') return '5m';
  if (range === '1m') return '30m';
  if (range === '3m') return '1h';
  if (range === '6m' || range === 'ytd' || range === '1y') return '1D';
  return 'Week';
}
