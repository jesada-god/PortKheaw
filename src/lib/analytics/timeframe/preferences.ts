/**
 * Persisted chart preferences.
 *
 * Everything a user toggles on the chart survives a reload: chart type, every
 * indicator, the overlays, the selected interval/range and the favourites. All
 * of it is *presentation* state — restoring it never triggers a market request
 * beyond the single load the restored selection needs.
 *
 * Storage is validated field by field. A corrupt or partially-written record
 * degrades to the defaults for the bad fields instead of throwing, and the
 * defaults are identical on the server and on the first client render so
 * hydration cannot mismatch.
 */

import { z } from 'zod';
import { candleIntervalSchema, candleRangeSchema, type CandleInterval, type CandleRange } from '@/src/lib/market-data/candles/contracts';
import { canonicalRange } from './catalog';

export const CHART_PREFERENCES_STORAGE_KEY = 'nexora.chart.preferences.v2';
/** v1 stored the Options section closed by default; v2 opens it as part of the page order. */
export const LEGACY_CHART_PREFERENCES_STORAGE_KEY = 'nexora.chart.preferences.v1';

export type ChartDisplayType = 'candlestick' | 'heikin-ashi';

export interface ChartPreferences {
  chartType: ChartDisplayType;
  volume: boolean;
  ema20: boolean;
  ema50: boolean;
  ema100: boolean;
  ema200: boolean;
  rsi: boolean;
  macd: boolean;
  vpvr: boolean;
  supportResistance: boolean;
  options: boolean;
  selectedInterval: CandleInterval;
  /** Canonical range key. "12 เดือน" persists as `1y`, never as a duplicate alias. */
  selectedRange: CandleRange;
  favoriteIntervals: CandleInterval[];
  favoriteRanges: CandleRange[];
}

export const DEFAULT_CHART_PREFERENCES: ChartPreferences = {
  chartType: 'candlestick',
  volume: true,
  ema20: true,
  ema50: true,
  ema100: false,
  ema200: false,
  rsi: false,
  macd: false,
  vpvr: false,
  supportResistance: true,
  // The Options section below the chart opens by default: it is part of the
  // standard Chart → Options → S/R page order, and opening it costs one
  // expirations request plus one chain request, both coordinator-cached.
  options: true,
  selectedInterval: '1D',
  selectedRange: '1y',
  favoriteIntervals: ['1m', '5m', '15m', '1h', '1D'],
  favoriteRanges: ['1y'],
};

const preferencesSchema = z.object({
  chartType: z.enum(['candlestick', 'heikin-ashi']),
  volume: z.boolean(),
  ema20: z.boolean(),
  ema50: z.boolean(),
  ema100: z.boolean(),
  ema200: z.boolean(),
  rsi: z.boolean(),
  macd: z.boolean(),
  vpvr: z.boolean(),
  supportResistance: z.boolean(),
  options: z.boolean(),
  selectedInterval: candleIntervalSchema,
  selectedRange: candleRangeSchema,
  favoriteIntervals: z.array(candleIntervalSchema),
  favoriteRanges: z.array(candleRangeSchema),
}).partial();

/** localStorage is absent in SSR and throws in some privacy modes. */
export function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Merges a stored record over the defaults, keeping only fields that validate.
 * A legacy `12M` range alias is folded onto the canonical `1y` key.
 */
export function mergeChartPreferences(stored: unknown): ChartPreferences {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_CHART_PREFERENCES };
  const source = stored as Record<string, unknown>;
  // The range fields accept display aliases before schema validation so an older
  // record written as "12M" restores as the canonical `1y` rather than resetting.
  const normalized: Record<string, unknown> = {
    ...source,
    ...(source.selectedRange === undefined ? {} : { selectedRange: canonicalRange(source.selectedRange) ?? undefined }),
    ...(Array.isArray(source.favoriteRanges)
      ? { favoriteRanges: source.favoriteRanges.map((value) => canonicalRange(value)).filter((value): value is CandleRange => value != null) }
      : {}),
  };
  const parsed = preferencesSchema.safeParse(normalized);
  if (!parsed.success) return { ...DEFAULT_CHART_PREFERENCES };
  const value = parsed.data;
  return {
    ...DEFAULT_CHART_PREFERENCES,
    ...Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)),
    ...(value.favoriteIntervals ? { favoriteIntervals: unique(value.favoriteIntervals) } : {}),
    ...(value.favoriteRanges ? { favoriteRanges: unique(value.favoriteRanges) } : {}),
  } as ChartPreferences;
}

/**
 * Carries a v1 record forward. Everything the user genuinely chose — interval,
 * range, favourites, chart type, indicators — is kept; only the Options section
 * flag is re-taken from the v2 defaults, because a stored `false` there was the
 * old default rather than a decision.
 */
export function migrateLegacyChartPreferences(stored: unknown): ChartPreferences {
  return { ...mergeChartPreferences(stored), options: DEFAULT_CHART_PREFERENCES.options };
}

export function readChartPreferences(storage: Storage | undefined = safeStorage()): ChartPreferences {
  if (!storage) return { ...DEFAULT_CHART_PREFERENCES };
  try {
    const raw = storage.getItem(CHART_PREFERENCES_STORAGE_KEY);
    if (raw) return mergeChartPreferences(JSON.parse(raw));
    const legacy = storage.getItem(LEGACY_CHART_PREFERENCES_STORAGE_KEY);
    return legacy ? migrateLegacyChartPreferences(JSON.parse(legacy)) : { ...DEFAULT_CHART_PREFERENCES };
  } catch {
    return { ...DEFAULT_CHART_PREFERENCES };
  }
}

export function writeChartPreferences(preferences: ChartPreferences, storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(CHART_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    /* quota or privacy mode — preferences stay in memory for this session */
  }
}

/** Adds/removes a favourite. Favourites are typed, so an interval can never land in the range list. */
export function toggleFavoriteInterval(preferences: ChartPreferences, interval: CandleInterval): ChartPreferences {
  const has = preferences.favoriteIntervals.includes(interval);
  return {
    ...preferences,
    favoriteIntervals: has
      ? preferences.favoriteIntervals.filter((item) => item !== interval)
      : [...preferences.favoriteIntervals, interval],
  };
}

export function toggleFavoriteRange(preferences: ChartPreferences, range: CandleRange): ChartPreferences {
  const has = preferences.favoriteRanges.includes(range);
  return {
    ...preferences,
    favoriteRanges: has
      ? preferences.favoriteRanges.filter((item) => item !== range)
      : [...preferences.favoriteRanges, range],
  };
}
