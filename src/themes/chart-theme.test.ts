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
    };
    expect(readChartThemeColors((property) => values[property] ?? '')).toEqual({
      background: '#fff',
      grid: '#ddd',
      axis: '#666',
      text: '#444',
      border: '#bbb',
    });
    expect(readChartThemeColors(() => '').background).toBe('#0D120F');
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
