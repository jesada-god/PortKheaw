import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from './manifest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/**
 * Every "must NOT contain" assertion below runs against code with comments
 * removed. Each of these settings is documented in place by a comment that
 * names the wrong value and explains why it is wrong — so asserting against the
 * raw file makes the explanation itself fail the test, and the only way to go
 * green would be to delete the reasoning.
 *
 * `://` is preserved so a URL is never mistaken for a line comment.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const layout = read('app/layout.tsx');
const css = read('app/globals.css');
const serviceWorker = read('public/sw.js');
const nextConfig = read('next.config.ts');
const middleware = read('middleware.ts');

const layoutCode = code(layout);
const cssCode = code(css);
const serviceWorkerCode = code(serviceWorker);

/**
 * The properties that decide whether a Home Screen launch opens as PortKheaw or
 * as a browser tab pointed at PortKheaw. Each one is a single field that, if
 * dropped, degrades silently: the app still works, it just stops being an app.
 */
describe('installed app (Home Screen / standalone)', () => {
  const value = manifest();

  it('declares the identity a launcher needs', () => {
    expect(value.name).toBe('PortKheaw');
    expect(value.short_name).toBe('PortKheaw');
    expect(value.start_url).toBe('/');
    expect(value.scope).toBe('/');
  });

  it('launches without browser chrome, locked to the orientation the layout is built for', () => {
    // `display: standalone` is the field Android reads to drop the address bar;
    // anything else ("browser", or the field missing) puts it back.
    expect(value.display).toBe('standalone');
    expect(value.orientation).toBe('portrait-primary');
  });

  it('paints the launch in the app palette rather than a white flash', () => {
    // --bg of the dark appearance, matching the layout's dark themeColor.
    expect(value.theme_color).toBe('#070A08');
    expect(value.background_color).toBe('#000000');
  });

  it('ships the icon sizes the two platforms actually install from', () => {
    const icons = value.icons ?? [];
    const bySize = (sizes: string, purpose?: string) => icons.some((icon) => (
      icon.sizes === sizes && (purpose ? icon.purpose === purpose : true)
    ));
    expect(bySize('192x192')).toBe(true);
    expect(bySize('512x512')).toBe(true);
    expect(bySize('512x512', 'maskable')).toBe(true);
  });

  it('gives iOS a real 180 apple-touch-icon instead of a resampled 192', () => {
    // iOS ignores the manifest for the Home Screen icon and reads this link.
    expect(layout).toContain('/icons/apple-touch-icon-180.png');
    expect(layout).toContain("sizes: '180x180'");

    const bytes = readFileSync(resolve(process.cwd(), 'public/icons/apple-touch-icon-180.png'));
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([180, 180]);
  });

  it('opts in on both platforms, with a status bar that follows the theme', () => {
    expect(layout).toContain('capable: true');
    expect(layout).toContain("title: appConfig.shortName");
    /*
     * Two different metas, one per platform, and the app needs both.
     *
     * `capable: true` makes Next emit only the standardised
     * `mobile-web-app-capable`, which is what Android/Chrome read — Next dropped
     * the Apple-prefixed spelling after Chrome deprecated it. iOS never followed
     * and reads `apple-mobile-web-app-capable` and nothing else to decide
     * whether a Home Screen launch opens standalone; it does not consult the
     * manifest's `display` at all. So the Apple one has to be declared here by
     * hand, or an iOS install opens inside Safari with the address bar showing.
     *
     * That both end up in the served <head> exactly once is measured against a
     * real production response in `.qa/pwa-mobile-qa.mjs`, which a source-text
     * assertion cannot do.
     */
    expect(layout).toContain("'apple-mobile-web-app-capable': 'yes'");
    /*
     * `black-translucent` pins the status bar text to white and would make it
     * unreadable on the light appearance's #F4F7F3. `default` lets iOS fill the
     * bar from themeColor and pick a readable text colour for it.
     */
    expect(layout).toContain("statusBarStyle: 'default'");
    expect(layoutCode).not.toContain('black-translucent');
  });

  it('points the document at the manifest route, with the old URL still answered', () => {
    expect(layout).toContain("manifest: '/manifest.webmanifest'");
    // Installs predating the move re-fetch /manifest.json on every launch.
    expect(nextConfig).toContain("source: '/manifest.json', destination: '/manifest.webmanifest'");
    expect(middleware).toContain('manifest.webmanifest');
  });

  it('renders the shell edge to edge and pads it back off the notch', () => {
    expect(layout).toContain("viewportFit: 'cover'");
    for (const [path, needle] of [
      ['src/components/layout/BottomNav.tsx', 'env(safe-area-inset-bottom)'],
      ['src/components/layout/Header.tsx', 'env(safe-area-inset-top)'],
      ['src/components/auth/AuthShell.tsx', 'env(safe-area-inset-bottom)'],
    ] as const) {
      expect(`${path}: ${read(path).includes(needle)}`).toBe(`${path}: true`);
    }
    // Full-height panes use dvh, so the shell tracks the collapsing mobile URL
    // bar instead of overflowing by its height.
    expect(read('src/components/layout/MainLayout.tsx')).toContain('min-h-dvh');
  });
});

/**
 * A standalone install has no reload button and no address bar. A service
 * worker that caches the wrong thing there is not a stale page the reader can
 * refresh past — it is a portfolio showing yesterday's prices with no way out.
 */
describe('service worker caches only the shell', () => {
  it('never handles account, auth or API traffic', () => {
    for (const path of ["'/api/'", "'/auth/'", "'/login'", "'/signup'"]) {
      expect(serviceWorker).toContain(path);
    }
    // Cross-origin (Supabase, market data providers) is handed straight back to
    // the network before any cache lookup.
    expect(serviceWorker).toContain('url.origin !== self.location.origin');
  });

  it('caches static assets only, and pages network-first', () => {
    expect(serviceWorker).toContain('isStaticAsset');
    expect(serviceWorker).toMatch(/request\.mode === 'navigate'/);

    /*
     * Scoped to the precache list rather than the whole worker: `/notifications`
     * legitimately appears further down as the click target of a push
     * notification, which is routing, not caching. What must never appear is a
     * data-bearing route in the array that gets written to the cache on install.
     */
    const shell = serviceWorkerCode.slice(
      serviceWorkerCode.indexOf('const SHELL = ['),
      serviceWorkerCode.indexOf('];', serviceWorkerCode.indexOf('const SHELL = [')),
    );
    expect(shell).not.toMatch(/'\/(portfolio|watchlist|stock|alerts|notifications|settings|profile|search)/);
  });

  it('evicts the previous cache generation on activate', () => {
    expect(serviceWorker).toContain('nexora-shell-v4');
    expect(serviceWorker).toContain('caches.delete');
    expect(serviceWorker).toContain('/manifest.webmanifest');
    expect(serviceWorkerCode).not.toContain('/manifest.json');
  });
});

/**
 * Accidental zoom on mobile had two causes, and both are fixed where they
 * happen rather than by suppressing gestures.
 */
describe('mobile zoom behaves', () => {
  it('keeps pinch zoom available to everyone', () => {
    // The shortcut fix for focus-zoom is to lock the viewport scale, which
    // takes zoom away from readers who need it. This app must never do that.
    expect(layoutCode).not.toMatch(/maximumScale\s*:/);
    expect(layoutCode).not.toMatch(/userScalable\s*:/);
    expect(cssCode).not.toContain('touch-action: none');
  });

  it('floors text-entry controls at 16px on touch devices, so iOS does not zoom on focus', () => {
    expect(css).toContain('@media (hover: none) and (pointer: coarse)');
    expect(css).toContain('font-size: max(16px, 1em);');
    /*
     * Tailwind v4 emits text-xs/text-sm into @layer utilities, which outranks
     * @layer base regardless of how specific the base selector is — nested in a
     * layer, this rule would be dead on exactly the controls it exists for.
     * Unlayered declarations beat all layered ones, so the at-rule must start at
     * column 0. Anything nested inside a `@layer { … }` block in this file is
     * indented, which is what the anchored newline pins.
     */
    expect(cssCode).toContain('\n@media (hover: none) and (pointer: coarse) {');

    const rule = cssCode.slice(cssCode.indexOf('\n@media (hover: none) and (pointer: coarse) {'));
    expect(rule).toContain('select');
    expect(rule).toContain('textarea');
    // Controls whose hit area is not governed by font-size are left alone.
    expect(rule).toContain('input:not([type="checkbox"])');
  });

  it('removes double-tap zoom from controls without touching pan or pinch', () => {
    expect(css).toContain('touch-action: manipulation;');
    for (const selector of ['button', '[role="tab"]', '[role="button"]', 'select']) {
      expect(`${selector}: ${css.includes(selector)}`).toBe(`${selector}: true`);
    }
  });

  it('stops the browser inflating text past what the layout was measured at', () => {
    expect(css).toContain('text-size-adjust: 100%');
  });
});
