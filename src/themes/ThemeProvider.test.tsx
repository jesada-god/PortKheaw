// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from './ThemeProvider';
import { THEME_STORAGE_KEY } from './storage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('ThemeProvider system appearance', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-appearance');
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('tracks OS changes live and cleans up the media listener', async () => {
    let matches = false;
    let changeListener: (() => void) | undefined;
    const addEventListener = vi.fn((_type: string, listener: () => void) => {
      changeListener = listener;
    });
    const removeEventListener = vi.fn();
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({
      get matches() { return matches; },
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({
      theme: 'portkheaw',
      appearance: 'system',
    }));

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ThemeProvider><div>app</div></ThemeProvider>);
    });

    expect(document.documentElement.dataset.appearance).toBe('light');
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    matches = true;
    await act(async () => changeListener?.());
    expect(document.documentElement.dataset.appearance).toBe('dark');

    await act(async () => root.unmount());
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    host.remove();
  });
});
