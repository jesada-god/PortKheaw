import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the public gateway URL at build time. This avoids a stale/empty client
  // constant when a cached production compilation is reused.
  env: {
    NEXT_PUBLIC_MARKET_WS_URL: process.env.NEXT_PUBLIC_MARKET_WS_URL ?? '',
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
