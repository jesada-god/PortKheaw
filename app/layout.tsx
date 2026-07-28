import type {Metadata, Viewport} from 'next';
import './globals.css';
import MainLayout from '@/src/components/layout/MainLayout';
import { Toaster } from '@/src/components/ui/Toast';
import { appConfig } from '@/src/config/app';
import { ThemeProvider } from '@/src/themes/ThemeProvider';
import { THEME_BOOTSTRAP } from '@/src/themes/bootstrap';

export const metadata: Metadata = {
  applicationName: appConfig.name,
  title: {
    default: `${appConfig.name} | ${appConfig.tagline}`,
    template: `%s | ${appConfig.name}`,
  },
  description: appConfig.description,
  manifest: '/manifest.json',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  },
  appleWebApp: { capable: true, title: appConfig.shortName, statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
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

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="th" data-theme="portkheaw" data-appearance="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="bg-[var(--bg)] text-[var(--text)] antialiased selection:bg-[var(--accent-soft)]">
        <script dangerouslySetInnerHTML={{ __html: ZOD_JITLESS_BOOTSTRAP }} />
        <ThemeProvider>
          <MainLayout>{children}</MainLayout>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
