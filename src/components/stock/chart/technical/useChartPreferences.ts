'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { useHydrated } from '@/src/hooks/useHydrated';
import {
  DEFAULT_CHART_PREFERENCES,
  readChartPreferences,
  writeChartPreferences,
  type ChartPreferences,
} from '@/src/lib/analytics/timeframe';

/**
 * Chart preferences as a tiny external store.
 *
 * `useSyncExternalStore` is the right shape here: localStorage *is* an external
 * system, the server snapshot is the shared defaults so hydration markup always
 * matches, and the cached snapshot keeps a stable identity so React does not
 * re-render on every read. It also avoids a setState-in-effect cascade.
 *
 * Every mounted chart on the page reads the same store, so a preference changed
 * in one place is immediately consistent everywhere.
 */

let cached: ChartPreferences | null = null;
const listeners = new Set<() => void>();

function snapshot(): ChartPreferences {
  cached ??= readChartPreferences();
  return cached;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function serverSnapshot(): ChartPreferences {
  return DEFAULT_CHART_PREFERENCES;
}

/** Applies an update, persists it and notifies every subscriber. */
export function updateChartPreferences(updater: (previous: ChartPreferences) => ChartPreferences): void {
  cached = updater(snapshot());
  writeChartPreferences(cached);
  listeners.forEach((listener) => listener());
}

/** Test-only: drops the module cache so each case starts from storage again. */
export function resetChartPreferencesCache(): void {
  cached = null;
  listeners.forEach((listener) => listener());
}

export interface UseChartPreferences {
  preferences: ChartPreferences;
  /**
   * False during the hydration render, true afterwards. The chart holds its
   * first history request until then, so a restored "12 เดือน" selection issues
   * exactly one request instead of loading the default range and replacing it.
   */
  hydrated: boolean;
  update(updater: (previous: ChartPreferences) => ChartPreferences): void;
}

export function useChartPreferences(): UseChartPreferences {
  const preferences = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const hydrated = useHydrated();
  const update = useCallback((updater: (previous: ChartPreferences) => ChartPreferences) => {
    updateChartPreferences(updater);
  }, []);
  return { preferences, hydrated, update };
}
