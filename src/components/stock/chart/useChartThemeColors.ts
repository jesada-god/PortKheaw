'use client';

import { useEffect, useState } from 'react';
import {
  FALLBACK_CHART_COLORS,
  getChartThemeColors,
  subscribeToAppearanceChange,
  type ChartThemeColors,
} from '@/src/themes/chart-theme';

/**
 * The chart's resolved theme colours, refreshed when the appearance changes.
 *
 * Canvas drawing cannot use CSS variables, so anything painted on the chart has
 * to be handed literal colours. Light and dark carry genuinely different
 * semantic values — `--positive` is `#10B981` in the dark and `#087A55` in the
 * light — so reading them once at module load would leave a support line washed
 * out on whichever surface it was not read for.
 */
export function useChartThemeColors(): ChartThemeColors {
  const [colors, setColors] = useState<ChartThemeColors>(
    () => (typeof document === 'undefined' ? FALLBACK_CHART_COLORS : getChartThemeColors()),
  );
  useEffect(() => subscribeToAppearanceChange(
    window,
    () => setColors(getChartThemeColors()),
  ), []);
  return colors;
}
