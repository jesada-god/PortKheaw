import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the public gateway URL at build time. This avoids a stale/empty client
  // constant when a cached production compilation is reused.
  env: {
    NEXT_PUBLIC_MARKET_WS_URL: process.env.NEXT_PUBLIC_MARKET_WS_URL ?? '',
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '',
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  // No `remotePatterns` on purpose. News thumbnails are served by whichever
  // publisher CDN each article names, so routing them through the built-in
  // optimizer would require `hostname: '**'` — an open image proxy anyone could
  // point at any URL, billed to this deployment. `NewsThumbnail` therefore renders
  // `next/image` with `unoptimized`, which streams the publisher's own URL
  // directly (no optimizer, no allowlist) and is bounded by the `img-src https:`
  // CSP in middleware.ts instead.
  images: {
    remotePatterns: [],
  },
  /*
   * `/auth/login` and `/auth/register` are the spellings people type, bookmark
   * and link to; the forms themselves live at `/auth/sign-in` and
   * `/auth/sign-up`. Answering the common spelling with a 404 is, from the
   * outside, indistinguishable from a broken sign-in page.
   *
   * These are declared here rather than as redirecting pages so the browser is
   * answered with a real 307 before anything renders. A page calling
   * `redirect()` cannot: the shell has already been flushed by the time it
   * runs, so Next falls back to a client-side hop that needs JavaScript and
   * shows a blank frame first.
   *
   * `permanent: false` keeps this reversible — a 308 would be cached by
   * browsers indefinitely and is very hard to take back. Any `next` query
   * carries through untouched and is sanitised by the destination page's own
   * `getSafeReturnPath`, which is the only place that decision belongs.
   */
  async redirects() {
    return [
      { source: '/auth/login', destination: '/auth/sign-in', permanent: false },
      { source: '/auth/register', destination: '/auth/sign-up', permanent: false },
      /*
       * The manifest moved from a static `app/manifest.json` to the typed
       * `app/manifest.ts` route, which Next serves at `/manifest.webmanifest`.
       * A Home Screen install made before that change recorded the old URL and
       * re-fetches it on launch; answering with a 404 would strand it without
       * a name, icon or `display: standalone`. Same reasoning as the auth
       * aliases above — a real redirect, not a page that renders one.
       */
      { source: '/manifest.json', destination: '/manifest.webmanifest', permanent: false },
    ];
  },
  output: 'standalone',
  transpilePackages: ['motion'],
  webpack: (config, {dev}) => {
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/,
      };
    }
    return config;
  },
};

export default nextConfig;
