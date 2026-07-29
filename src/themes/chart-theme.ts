import { APPEARANCE_CHANGE_EVENT } from './ThemeProvider';

export interface ChartThemeColors {
  background: string;
  grid: string;
  axis: string;
  text: string;
  border: string;
  /** Semantic up colour — supports, and anything the app draws as a gain. */
  positive: string;
  /** Semantic down colour — resistances, and anything the app draws as a loss. */
  negative: string;
  /** Brand accent, used for the accepted-price line. */
  accent: string;
}

export const FALLBACK_CHART_COLORS: ChartThemeColors = {
  background: '#0D120F',
  grid: '#223128',
  axis: '#89958D',
  text: '#B7C1BA',
  border: '#304438',
  positive: '#10B981',
  negative: '#EF4444',
  accent: '#D7FF00',
};

const FALLBACK = FALLBACK_CHART_COLORS;

export function readChartThemeColors(
  read: (property: string) => string,
): ChartThemeColors {
  const value = (property: string, fallback: string) => read(property).trim() || fallback;
  return {
    background: value('--chart-bg', FALLBACK.background),
    grid: value('--chart-grid', FALLBACK.grid),
    axis: value('--chart-axis', FALLBACK.axis),
    text: value('--text-secondary', FALLBACK.text),
    border: value('--border-strong', FALLBACK.border),
    // The canvas cannot resolve a CSS variable, so the level and accepted-price
    // colours are read here and handed to the chart as literal values. Light mode
    // carries much darker semantic tokens, which is what keeps a support line and
    // the accepted-price line legible on a white surface.
    positive: value('--positive', FALLBACK.positive),
    negative: value('--negative', FALLBACK.negative),
    accent: value('--accent', FALLBACK.accent),
  };
}

export function getChartThemeColors(): ChartThemeColors {
  const styles = getComputedStyle(document.documentElement);
  return readChartThemeColors((property) => styles.getPropertyValue(property));
}

export function subscribeToAppearanceChange(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  listener: EventListener,
): () => void {
  target.addEventListener(APPEARANCE_CHANGE_EVENT, listener);
  return () => target.removeEventListener(APPEARANCE_CHANGE_EVENT, listener);
}
