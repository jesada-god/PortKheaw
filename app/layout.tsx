import type {Metadata, Viewport} from 'next';
import './globals.css';
import MainLayout from '@/src/components/layout/MainLayout';
import { Toaster } from '@/src/components/ui/Toast';
import { appConfig } from '@/src/config/app';
import { ThemeProvider } from '@/src/themes/ThemeProvider';
import { THEME_BOOTSTRAP } from '@/src/themes/bootstrap';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import { AdminPreviewBanner } from '@/src/components/subscription/AdminPreviewBanner';
import { resolvePageEntitlement } from '@/src/lib/subscription/page-entitlement';

export const metadata: Metadata = {
  applicationName: appConfig.name,
  title: {
    default: `${appConfig.name} | ${appConfig.tagline}`,
    template: `%s | ${appConfig.name}`,
  },
  description: appConfig.description,
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    // iOS never reads the manifest for this one — it takes `apple-touch-icon`
    // at its own 180 and resamples anything else, so it gets the real 180.
    apple: [{ url: '/icons/apple-touch-icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  /*
   * `statusBarStyle` is deliberately `default`, not `black-translucent`.
   * Translucent paints the status bar text a fixed white and lets content run
   * underneath it: correct on the dark appearance, invisible on the light one,
   * where the bar sits on `#F4F7F3`. `default` hands the bar to iOS, which
   * fills it from `themeColor` below and picks a readable text colour for it —
   * so the one setting tracks both appearances instead of hard-coding one.
   */
  appleWebApp: { capable: true, title: appConfig.shortName, statusBarStyle: 'default' },
  /*
   * `capable: true` above renders only the standardised `mobile-web-app-capable`
   * — Next dropped the Apple-prefixed spelling because Chrome deprecated it.
   * iOS never followed: Safari reads `apple-mobile-web-app-capable` and nothing
   * else to decide whether a Home Screen launch opens standalone, and unlike
   * Android it does not consult the manifest's `display` at all. Without this
   * line the app installs on iOS and then opens inside Safari, address bar and
   * toolbar included — which is the whole thing this is meant to remove.
   *
   * Verified against the emitted <head>, not assumed; `mobile-web-app-capable`
   * is left to `capable` above so it is not printed twice.
   */
  other: { 'apple-mobile-web-app-capable': 'yes' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /*
   * No `maximumScale`/`userScalable: false`. Pinch zoom is an accessibility
   * affordance and stays available; the accidental zoom this app used to suffer
   * came from two other causes, both fixed at the source in `globals.css` —
   * form controls under 16px (which iOS answers by zooming the page on focus)
   * and controls without `touch-action: manipulation` (which reserve a
   * double-tap-to-zoom gesture on every tap).
   */
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F4F7F3' },
    { media: '(prefers-color-scheme: dark)', color: '#070A08' },
  ],
};

/**
 * Pre-load bootstrap that disables Zod 4's JIT fast path IN THE BROWSER before
 * any Zod module evaluates. Zod's `allowsEval` probe calls `Function("")` to
 * feature-detect eval; under our strict CSP (no `'unsafe-eval'`) that call is
 * blocked and Chrome DevTools surfaces it as an "eval blocked" Issue
 * (zod #4461 / #5414). Zod reads `globalThis.__zod_globalConfig` when its core
 * module first loads, so pre-populating `jitless: true` here — a synchronous
 * inline script at the top of <body>, which runs during HTML parse BEFORE the
 * deferred app bundle — short-circuits the probe. Validation then uses the
 * interpreted path (identical results, no code-from-string). The server keeps
 * the JIT (no CSP there, so no violation and better throughput).
 */
const ZOD_JITLESS_BOOTSTRAP = '(globalThis.__zod_globalConfig=globalThis.__zod_globalConfig||{}).jitless=true;';

/*
  `data-appearance` is deliberately absent here. It is owned by THEME_BOOTSTRAP,
  which resolves the saved or system appearance from <head> before anything paints.
  The server cannot know that value, so rendering a fixed `dark` guess meant React
  hydrated a root the script had already rewritten to `light` — a real attribute
  mismatch that surfaced as React #418 in production for every light-appearance
  reader. Leaving the attribute to its owner removes the mismatch at the source
  instead of suppressing the warning; `dark.css` styles the pre-script state so the
  markup is never token-less.
*/
export default async function RootLayout({children}: {children: React.ReactNode}) {
  const entitlement = await resolvePageEntitlement();
  return (
    <html lang="th" data-theme="portkheaw">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="bg-[var(--bg)] text-[var(--text)] antialiased selection:bg-[var(--accent-soft)]">
        <script dangerouslySetInnerHTML={{ __html: ZOD_JITLESS_BOOTSTRAP }} />
        <ThemeProvider>
          <EntitlementProvider
            tier={entitlement.effectiveAccessTier}
            authenticated={entitlement.authenticated}
            trialOffer={entitlement.trialOffer}
          >
            <MainLayout banner={<AdminPreviewBanner entitlement={entitlement} />}>
              {children}
            </MainLayout>
            <Toaster />
          </EntitlementProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
