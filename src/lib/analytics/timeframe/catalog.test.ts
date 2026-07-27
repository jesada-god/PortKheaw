import { describe, expect, it } from 'vitest';
import {
  INTERVAL_OPTIONS,
  RANGE_OPTIONS,
  canonicalInterval,
  canonicalRange,
  intervalOption,
  intervalsByGroup,
  isRangeEnabled,
  rangeOption,
  unsupportedReason,
} from './catalog';
import {
  DEFAULT_CHART_PREFERENCES,
  mergeChartPreferences,
  readChartPreferences,
  toggleFavoriteInterval,
  toggleFavoriteRange,
  writeChartPreferences,
  CHART_PREFERENCES_STORAGE_KEY,
  LEGACY_CHART_PREFERENCES_STORAGE_KEY,
} from './preferences';
import { candleIntervalSchema, candleRangeSchema } from '@/src/lib/market-data/candles/contracts';
import { CHART_TYPE_OPTIONS } from '@/src/lib/analytics/chart-types/catalog';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, value); },
  } as Storage;
}

describe('timeframe catalog', () => {
  it('offers every interval the provider contract accepts', () => {
    expect(INTERVAL_OPTIONS.map((option) => option.id).sort())
      .toEqual([...candleIntervalSchema.options].sort());
  });

  it('offers every canonical range the provider contract accepts', () => {
    expect(RANGE_OPTIONS.map((option) => option.id).sort())
      .toEqual([...candleRangeSchema.options].sort());
  });

  it('groups intervals into minutes, hours and days for the popup sections', () => {
    expect(intervalsByGroup('minute').map((option) => option.id))
      .toEqual(['1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m']);
    expect(intervalsByGroup('hour').map((option) => option.id)).toEqual(['1h', '2h', '3h', '4h']);
    expect(intervalsByGroup('day').map((option) => option.id)).toEqual(['1D', 'Week', 'Month']);
  });

  it('labels the one-year range "12 เดือน" while keeping the canonical key 1y', () => {
    const option = rangeOption('1y');
    expect(option.label).toBe('12 เดือน');
    expect(option.id).toBe('1y');
    expect(option.short).toBe('12M');
  });

  it('resolves the 12M display alias onto the single canonical 1y key', () => {
    expect(canonicalRange('12M')).toBe('1y');
    expect(canonicalRange('12m')).toBe('1y');
    expect(canonicalRange('12 เดือน')).toBe('1y');
    expect(canonicalRange('1y')).toBe('1y');
  });

  it('keeps 12M a range and never a candle interval', () => {
    // `1m` is a valid *interval* (one minute) and a valid *range* (one month);
    // the two axes must not be resolvable from one another.
    expect(canonicalInterval('12M')).toBeNull();
    expect(canonicalInterval('1y')).toBeNull();
    expect(INTERVAL_OPTIONS.some((option) => option.label === '12 เดือน')).toBe(false);
    expect(intervalsByGroup('day').some((option) => option.seconds >= 365 * 86_400)).toBe(false);
  });

  it('marks a range unsupported for an interval with a reason instead of failing on click', () => {
    expect(isRangeEnabled('1D', '1y')).toBe(true);
    expect(isRangeEnabled('1m', '1y')).toBe(false);
    expect(unsupportedReason('1m', '1y')).toContain('1 นาที');
    expect(unsupportedReason('1D', '1y')).toBeNull();
  });

  it('names the new provider-native intervals in Thai', () => {
    expect(intervalOption('2m').label).toBe('2 นาที');
    expect(intervalOption('45m').label).toBe('45 นาที');
    expect(intervalOption('3h').label).toBe('3 ชั่วโมง');
  });
});

describe('chart preferences', () => {
  it('defaults EMA 20 and 50 on, EMA 100 and 200 off', () => {
    expect(DEFAULT_CHART_PREFERENCES.ema20).toBe(true);
    expect(DEFAULT_CHART_PREFERENCES.ema50).toBe(true);
    expect(DEFAULT_CHART_PREFERENCES.ema100).toBe(false);
    expect(DEFAULT_CHART_PREFERENCES.ema200).toBe(false);
  });

  it('defaults the range to the canonical 1y key that "12 เดือน" displays', () => {
    expect(DEFAULT_CHART_PREFERENCES.selectedRange).toBe('1y');
    expect(rangeOption(DEFAULT_CHART_PREFERENCES.selectedRange).label).toBe('12 เดือน');
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const next = { ...DEFAULT_CHART_PREFERENCES, rsi: true, macd: true, selectedInterval: '4h' as const };
    writeChartPreferences(next, storage);
    expect(readChartPreferences(storage)).toEqual(next);
  });

  it('persists 12 เดือน as the canonical key, not a duplicate alias', () => {
    const storage = memoryStorage();
    writeChartPreferences({ ...DEFAULT_CHART_PREFERENCES, selectedRange: '1y', favoriteRanges: ['1y'] }, storage);
    const raw = storage.getItem(CHART_PREFERENCES_STORAGE_KEY) as string;
    expect(raw).toContain('"selectedRange":"1y"');
    expect(raw).not.toContain('12M');
  });

  it('folds a legacy 12M record onto the canonical key instead of resetting', () => {
    const restored = mergeChartPreferences({ selectedRange: '12M', favoriteRanges: ['12M', '3m'] });
    expect(restored.selectedRange).toBe('1y');
    expect(restored.favoriteRanges).toEqual(['1y', '3m']);
  });

  it('upgrades persisted Week/Month lookbacks to 5Y before the first request', () => {
    expect(mergeChartPreferences({ selectedInterval: 'Week', selectedRange: '6m' }))
      .toMatchObject({ selectedInterval: 'Week', selectedRange: '5y' });
    expect(mergeChartPreferences({ selectedInterval: 'Month', selectedRange: '1y' }))
      .toMatchObject({ selectedInterval: 'Month', selectedRange: '5y' });
  });

  it('opens the Options section by default so the page order is Chart → Options → S/R', () => {
    expect(DEFAULT_CHART_PREFERENCES.options).toBe(true);
  });

  it('persists every catalogued chart type and still restores the two original ones', () => {
    for (const option of CHART_TYPE_OPTIONS) {
      expect(mergeChartPreferences({ chartType: option.id }).chartType).toBe(option.id);
    }
    // Records written before the wider list must survive untouched.
    expect(mergeChartPreferences({ chartType: 'heikin-ashi' }).chartType).toBe('heikin-ashi');
    // An unknown value is not a chart type; the record degrades to the default.
    expect(mergeChartPreferences({ chartType: 'renko' }).chartType).toBe(DEFAULT_CHART_PREFERENCES.chartType);
  });

  it('carries a v1 record forward, keeping real choices but re-taking the Options default', () => {
    const storage = memoryStorage();
    storage.setItem(LEGACY_CHART_PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_CHART_PREFERENCES, options: false, selectedInterval: '4h', selectedRange: '3m', macd: true,
    }));
    const restored = readChartPreferences(storage);
    expect(restored.selectedInterval).toBe('4h');
    expect(restored.selectedRange).toBe('3m');
    expect(restored.macd).toBe(true);
    expect(restored.options).toBe(true);
  });

  it('prefers an existing v2 record over the legacy one', () => {
    const storage = memoryStorage();
    storage.setItem(LEGACY_CHART_PREFERENCES_STORAGE_KEY, JSON.stringify({ selectedInterval: '4h' }));
    writeChartPreferences({ ...DEFAULT_CHART_PREFERENCES, options: false, selectedInterval: '1h' }, storage);
    const restored = readChartPreferences(storage);
    expect(restored.selectedInterval).toBe('1h');
    expect(restored.options).toBe(false); // a genuine later choice is never overridden
  });

  it('ignores a corrupt record and falls back to the defaults', () => {
    const storage = memoryStorage();
    storage.setItem(CHART_PREFERENCES_STORAGE_KEY, '{not json');
    expect(readChartPreferences(storage)).toEqual(DEFAULT_CHART_PREFERENCES);
  });

  it('drops invalid fields rather than restoring an impossible selection', () => {
    const restored = mergeChartPreferences({ selectedInterval: '7m', rsi: 'yes', macd: true });
    expect(restored.selectedInterval).toBe(DEFAULT_CHART_PREFERENCES.selectedInterval);
    expect(restored.rsi).toBe(DEFAULT_CHART_PREFERENCES.rsi);
  });

  it('keeps interval and range favourites in separate typed lists', () => {
    const withInterval = toggleFavoriteInterval(DEFAULT_CHART_PREFERENCES, '30m');
    expect(withInterval.favoriteIntervals).toContain('30m');
    expect(withInterval.favoriteRanges).toEqual(DEFAULT_CHART_PREFERENCES.favoriteRanges);

    const withRange = toggleFavoriteRange(withInterval, '3m');
    expect(withRange.favoriteRanges).toContain('3m');
    expect(withRange.favoriteIntervals).toEqual(withInterval.favoriteIntervals);
  });

  it('toggles a favourite off again', () => {
    const added = toggleFavoriteRange(DEFAULT_CHART_PREFERENCES, '5y');
    expect(toggleFavoriteRange(added, '5y').favoriteRanges).not.toContain('5y');
    expect(toggleFavoriteRange(DEFAULT_CHART_PREFERENCES, '1y').favoriteRanges).not.toContain('1y');
  });

  it('survives a storage that throws (privacy mode) without losing the session state', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    } as unknown as Storage;
    expect(readChartPreferences(throwing)).toEqual(DEFAULT_CHART_PREFERENCES);
    expect(() => writeChartPreferences(DEFAULT_CHART_PREFERENCES, throwing)).not.toThrow();
  });
});
