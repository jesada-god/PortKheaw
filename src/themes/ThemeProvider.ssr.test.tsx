// @vitest-environment node

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from './ThemeProvider';
import { THEME_BOOTSTRAP } from './bootstrap';

describe('PortKheaw theme on the server', () => {
  it('renders without touching window, document or localStorage', () => {
    expect(globalThis).not.toHaveProperty('window');
    expect(renderToStaticMarkup(<ThemeProvider><p>app</p></ThemeProvider>)).toBe('<p>app</p>');
  });

  it('restores the preference before paint from the head bootstrap alone', () => {
    // The pre-paint script is the only thing that may read storage synchronously,
    // and it must resolve system against the OS instead of persisting the result.
    expect(THEME_BOOTSTRAP).toContain('portkheaw-theme-preferences');
    expect(THEME_BOOTSTRAP).toContain('prefers-color-scheme: dark');
    expect(THEME_BOOTSTRAP).toContain("dataset.theme='portkheaw'");
    expect(THEME_BOOTSTRAP).not.toContain('setItem');
  });
});
