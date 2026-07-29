import { describe, expect, it, vi } from 'vitest';
import { readChartThemeColors, subscribeToAppearanceChange } from './chart-theme';
import { APPEARANCE_CHANGE_EVENT } from './ThemeProvider';

describe('chart appearance bridge', () => {
  it('reads semantic chart tokens and supplies safe fallbacks', () => {
    const values: Record<string, string> = {
      '--chart-bg': ' #fff ',
      '--chart-grid': '#ddd',
      '--chart-axis': '#666',
      '--text-secondary': '#444',
      '--border-strong': '#bbb',
      '--positive': ' #087A55 ',
      '--negative': '#C93636',
      '--accent': '#5F7300',
    };
    expect(readChartThemeColors((property) => values[property] ?? '')).toEqual({
      background: '#fff',
      grid: '#ddd',
      axis: '#666',
      text: '#444',
      border: '#bbb',
      positive: '#087A55',
      negative: '#C93636',
      accent: '#5F7300',
    });
    expect(readChartThemeColors(() => '').background).toBe('#0D120F');
  });

  it('falls back to the dark semantic colours when a token is missing', () => {
    const colors = readChartThemeColors(() => '');
    expect(colors.positive).toBe('#10B981');
    expect(colors.negative).toBe('#EF4444');
    expect(colors.accent).toBe('#D7FF00');
  });

  it('cleans up its runtime appearance listener', () => {
    const target = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const listener = vi.fn();
    const cleanup = subscribeToAppearanceChange(target as never, listener);
    expect(target.addEventListener).toHaveBeenCalledWith(APPEARANCE_CHANGE_EVENT, listener);
    cleanup();
    expect(target.removeEventListener).toHaveBeenCalledWith(APPEARANCE_CHANGE_EVENT, listener);
  });
});
