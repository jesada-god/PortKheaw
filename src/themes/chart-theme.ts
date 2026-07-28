import { APPEARANCE_CHANGE_EVENT } from './ThemeProvider';

export interface ChartThemeColors {
  background: string;
  grid: string;
  axis: string;
  text: string;
  border: string;
}

const FALLBACK: ChartThemeColors = {
  background: '#0D120F',
  grid: '#223128',
  axis: '#89958D',
  text: '#B7C1BA',
  border: '#304438',
};

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
