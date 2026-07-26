/**
 * Timeframe catalog — the single place that knows the difference between a
 * **candle interval** and a **historical data range**.
 *
 * They are two independent axes and the UI must never blur them:
 *  - an interval is how wide one candle is (`1m` … `Week`),
 *  - a range is how far back the loaded history reaches (`1d` … `5y`).
 *
 * "12 เดือน" is a *range*. It is a UI label for the canonical range key `1y`
 * that the provider, the request key, the cache and localStorage already use —
 * there is deliberately no second `12M` key anywhere in the data layer, only the
 * display alias resolved by {@link canonicalRange}.
 */

import { candleIntervalSchema, candleRangeSchema, type CandleInterval, type CandleRange } from '@/src/lib/market-data/candles/contracts';
import { isCompatibleSelection, supportedRangesForInterval } from '@/src/lib/market-data/gateway/capabilities';

export type IntervalGroup = 'minute' | 'hour' | 'day';

export interface IntervalOption {
  id: CandleInterval;
  /** Compact token for the quick-access strip and the trigger button. */
  short: string;
  /** Beginner-Thai label for the popup rows. */
  label: string;
  group: IntervalGroup;
  seconds: number;
}

export interface RangeOption {
  id: CandleRange;
  short: string;
  label: string;
}

export const INTERVAL_OPTIONS: readonly IntervalOption[] = [
  { id: '1m', short: '1m', label: '1 นาที', group: 'minute', seconds: 60 },
  { id: '2m', short: '2m', label: '2 นาที', group: 'minute', seconds: 120 },
  { id: '3m', short: '3m', label: '3 นาที', group: 'minute', seconds: 180 },
  { id: '5m', short: '5m', label: '5 นาที', group: 'minute', seconds: 300 },
  { id: '10m', short: '10m', label: '10 นาที', group: 'minute', seconds: 600 },
  { id: '15m', short: '15m', label: '15 นาที', group: 'minute', seconds: 900 },
  { id: '30m', short: '30m', label: '30 นาที', group: 'minute', seconds: 1_800 },
  { id: '45m', short: '45m', label: '45 นาที', group: 'minute', seconds: 2_700 },
  { id: '1h', short: '1h', label: '1 ชั่วโมง', group: 'hour', seconds: 3_600 },
  { id: '2h', short: '2h', label: '2 ชั่วโมง', group: 'hour', seconds: 7_200 },
  { id: '3h', short: '3h', label: '3 ชั่วโมง', group: 'hour', seconds: 10_800 },
  { id: '4h', short: '4h', label: '4 ชั่วโมง', group: 'hour', seconds: 14_400 },
  { id: '1D', short: '1D', label: '1 วัน', group: 'day', seconds: 86_400 },
  { id: 'Week', short: '1W', label: '1 สัปดาห์', group: 'day', seconds: 604_800 },
  { id: 'Month', short: '1Mo', label: 'รายเดือน', group: 'day', seconds: 2_678_400 },
];

/**
 * Ranges in display order. `1y` is deliberately labelled "12 เดือน": the label is
 * what a beginner reads, the id is what every request/cache/storage key uses.
 */
export const RANGE_OPTIONS: readonly RangeOption[] = [
  // Prefixed so a range can never be misread as the same-named candle interval
  // ("1 วัน" the interval vs "1 วัน" of history).
  { id: '1d', short: '1D', label: 'ย้อนหลัง 1 วัน' },
  { id: '5d', short: '5D', label: 'ย้อนหลัง 5 วัน' },
  { id: '1m', short: '1M', label: '1 เดือน' },
  { id: '3m', short: '3M', label: '3 เดือน' },
  { id: '6m', short: '6M', label: '6 เดือน' },
  { id: 'ytd', short: 'YTD', label: 'ต้นปีถึงปัจจุบัน' },
  { id: '1y', short: '12M', label: '12 เดือน' },
  { id: '3y', short: '3Y', label: '3 ปี' },
  { id: '5y', short: '5Y', label: '5 ปี' },
];

export const INTERVAL_GROUP_LABEL: Record<IntervalGroup, string> = {
  minute: 'นาที',
  hour: 'ชั่วโมง',
  day: 'วัน',
};

export const RANGE_SECTION_LABEL = 'ช่วงข้อมูล';

/**
 * Display aliases accepted from the UI/legacy storage. `12M` and `12 เดือน` mean
 * "one year of history" and resolve to the one canonical key, `1y` — a second
 * range key with the same meaning would fork the cache and double the requests.
 */
const RANGE_ALIASES: Record<string, CandleRange> = {
  '12m': '1y',
  '12เดือน': '1y',
  '1yr': '1y',
  '1year': '1y',
};

const INTERVAL_BY_ID = new Map(INTERVAL_OPTIONS.map((option) => [option.id, option]));
const RANGE_BY_ID = new Map(RANGE_OPTIONS.map((option) => [option.id, option]));

/** Resolves any accepted spelling of a range to its canonical key, else `null`. */
export function canonicalRange(value: unknown): CandleRange | null {
  if (typeof value !== 'string') return null;
  const direct = candleRangeSchema.safeParse(value.trim());
  if (direct.success) return direct.data;
  const key = value.trim().toLowerCase().replace(/\s+/g, '');
  return RANGE_ALIASES[key] ?? null;
}

/** Resolves a candle interval, else `null`. Never accepts a range key. */
export function canonicalInterval(value: unknown): CandleInterval | null {
  if (typeof value !== 'string') return null;
  const parsed = candleIntervalSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : null;
}

export function intervalOption(interval: CandleInterval): IntervalOption {
  const option = INTERVAL_BY_ID.get(interval);
  if (!option) throw new Error(`Unknown candle interval: ${interval}`);
  return option;
}

export function rangeOption(range: CandleRange): RangeOption {
  const option = RANGE_BY_ID.get(range);
  if (!option) throw new Error(`Unknown candle range: ${range}`);
  return option;
}

export function intervalsByGroup(group: IntervalGroup): IntervalOption[] {
  return INTERVAL_OPTIONS.filter((option) => option.group === group);
}

/**
 * Whether a range can currently be requested for the selected interval. An
 * unsupported combination is *disabled with a reason*, never a request that
 * errors after the click.
 */
export function isRangeEnabled(interval: CandleInterval, range: CandleRange): boolean {
  return isCompatibleSelection(interval, range);
}

/** Whether any range at all supports this interval (always true today; guards future edits). */
export function isIntervalEnabled(interval: CandleInterval): boolean {
  return supportedRangesForInterval(interval).length > 0;
}

export function unsupportedReason(interval: CandleInterval, range: CandleRange): string | null {
  if (isRangeEnabled(interval, range)) return null;
  const supported = supportedRangesForInterval(interval).map((id) => rangeOption(id).label).join(' · ');
  return `แท่ง ${intervalOption(interval).label} ใช้ได้กับช่วง ${supported}`;
}
