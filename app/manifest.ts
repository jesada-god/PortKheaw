import type { MetadataRoute } from 'next';
import { appConfig } from '@/src/config/app';

/**
 * The installed-app identity, served by Next at `/manifest.webmanifest`.
 *
 * This replaces the hand-maintained `app/manifest.json`. It is a route rather
 * than a static file so the name/description come from {@link appConfig} — the
 * same constant the header, the title template and the Apple Web App metadata
 * already read. A manifest that disagreed with the app about its own name was
 * previously only prevented by nobody editing one of the two.
 *
 * `/manifest.json` is redirected here in `next.config.ts`, because a Home
 * Screen install made before this change recorded the old URL.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: appConfig.name,
    short_name: appConfig.shortName,
    description: appConfig.description,
    /*
     * `start_url` and `scope` are the two fields that decide whether a Home
     * Screen launch is a standalone app or a browser tab. Every in-app URL is
     * under `/`, so a navigation can never leave the scope and drop the visitor
     * into Safari/Chrome chrome mid-session — including `/auth/callback`, which
     * is where a Google sign-in comes back to.
     */
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // The layout is a single scrolling column; landscape on a phone buys
    // nothing and puts the bottom navigation over the content.
    orientation: 'portrait-primary',
    lang: 'th',
    dir: 'ltr',
    // Matches `--bg` of the dark appearance, which is also the `themeColor`
    // declared in the root layout.
    theme_color: '#070A08',
    /*
     * Deliberately pure black, not `--bg`. This paints the splash screen behind
     * the icon, and every icon below already carries its own black plate — a
     * near-black-but-not-black sheet would ring that plate with a visible halo
     * for the whole launch. Locked by `src/themes/brand.contract.test.ts`.
     */
    background_color: '#000000',
    categories: ['finance', 'productivity'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      /*
       * Android masks the launcher icon to the device's shape. Without a
       * `maskable` entry it falls back to an `any` icon and shrinks it into a
       * white circle; with one, the platform crops into this icon's own safe
       * zone (the mascot is drawn at 64% here, versus 76% for the `any` icons)
       * and the black plate reaches every edge of whatever shape is applied.
       */
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
