// @vitest-environment node

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from './ThemeProvider';
import { themeBootstrap } from './bootstrap';

describe('PortKheaw theme on the server', () => {
  it('renders without touching window, document or localStorage', () => {
    expect(globalThis).not.toHaveProperty('window');
    expect(renderToStaticMarkup(<ThemeProvider><p>app</p></ThemeProvider>)).toBe('<p>app</p>');
  });

  it('restores the preference before paint from the head bootstrap alone', () => {
    // The pre-paint script is the only thing that may read storage synchronously,
    // and it must resolve system against the OS instead of persisting the result.
    const script = themeBootstrap(true);
    expect(script).toContain('portkheaw-theme-preferences');
    expect(script).toContain('prefers-color-scheme: dark');
    expect(script).toContain("dataset.theme='portkheaw'");
    expect(script).not.toContain('setItem');
  });

  /**
   * The no-flash guarantee, asserted on the string itself.
   *
   * A premium theme can only be painted when the server already decided the
   * reader may have it, so the entitlement is baked in rather than read from the
   * browser. Without the entitlement the script has no branch that can produce
   * `bitswap` or `dokturek` at all — which is what makes "no premium flash"
   * structural instead of a race the provider has to win afterwards.
   */
  it('cannot select a premium theme when the server refused it', () => {
    const refused = themeBootstrap(false);
    expect(refused).toContain('P=false');
    expect(refused).toMatch(/const t=P&&\[[^\]]*\]\.includes\(v\.theme\)\?v\.theme:'portkheaw'/);
    expect(themeBootstrap(true)).toContain('P=true');
  });
});
