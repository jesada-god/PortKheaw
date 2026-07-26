import { describe, expect, it } from 'vitest';
import {
  buildAuthFrame,
  buildSubscriptionFrame,
  computeBackoffDelayMs,
  resolveAlpacaConfig,
  resolveFinnhubConfig,
  resolvePublicMarketWsUrl,
} from './config';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('resolveAlpacaConfig', () => {
  it('is disabled when the feature flag is off', () => {
    const config = resolveAlpacaConfig(env({ ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }));
    expect(config.enabled).toBe(false);
  });

  it('is disabled when credentials are missing', () => {
    const config = resolveAlpacaConfig(env({ MARKET_REALTIME_ENABLED: 'true' }));
    expect(config.enabled).toBe(false);
  });

  it('resolves the IEX production feed as real-time', () => {
    const config = resolveAlpacaConfig(env({
      MARKET_REALTIME_ENABLED: 'true', ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's', ALPACA_DATA_FEED: 'iex',
    }));
    expect(config).toMatchObject({ enabled: true, feed: 'iex', url: 'wss://stream.data.alpaca.markets/v2/iex', realtime: true });
  });

  it('resolves the test/FAKEPACA sandbox as NOT real-time', () => {
    const config = resolveAlpacaConfig(env({
      MARKET_REALTIME_ENABLED: '1', ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's', ALPACA_DATA_FEED: 'test',
    }));
    expect(config).toMatchObject({ enabled: true, feed: 'test', url: 'wss://stream.data.alpaca.markets/v2/test', realtime: false });
  });

  it('defaults an unknown feed to iex', () => {
    const config = resolveAlpacaConfig(env({
      MARKET_REALTIME_ENABLED: 'true', ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's', ALPACA_DATA_FEED: 'bogus',
    }));
    expect(config).toMatchObject({ enabled: true, feed: 'iex' });
  });
});

describe('resolveFinnhubConfig', () => {
  it('is disabled when the feature flag is off or the server key is missing', () => {
    expect(resolveFinnhubConfig(env({ FINNHUB_API_KEY: 'server-key' })).enabled).toBe(false);
    expect(resolveFinnhubConfig(env({ MARKET_REALTIME_ENABLED: 'true' })).enabled).toBe(false);
  });

  it('builds the server-only production stream configuration', () => {
    expect(resolveFinnhubConfig(env({
      MARKET_REALTIME_ENABLED: 'true',
      FINNHUB_API_KEY: 'server-key',
    }))).toEqual({
      enabled: true,
      apiKey: 'server-key',
      feed: 'finnhub',
      provider: 'finnhub',
      url: 'wss://ws.finnhub.io/?token=server-key',
      realtime: true,
    });
  });
});

describe('resolvePublicMarketWsUrl', () => {
  it('returns the configured public URL or null', () => {
    expect(resolvePublicMarketWsUrl({ NEXT_PUBLIC_MARKET_WS_URL: 'wss://gw.example/ws' })).toBe('wss://gw.example/ws');
    expect(resolvePublicMarketWsUrl({})).toBeNull();
  });

  it('accepts a ws://localhost Gateway in development', () => {
    expect(resolvePublicMarketWsUrl({
      NEXT_PUBLIC_APP_ENV: 'development',
      NEXT_PUBLIC_MARKET_WS_URL: 'ws://localhost:8081/ws',
    })).toBe('ws://localhost:8081/ws');
  });

  it('rejects a ws:// (plaintext) URL in production', () => {
    expect(resolvePublicMarketWsUrl({
      NEXT_PUBLIC_APP_ENV: 'production',
      NEXT_PUBLIC_MARKET_WS_URL: 'ws://gw.example/ws',
    })).toBeNull();
  });

  it('rejects a localhost / 127.0.0.1 URL in production', () => {
    for (const url of ['wss://localhost:8081/ws', 'wss://127.0.0.1/ws', 'ws://localhost/ws']) {
      expect(resolvePublicMarketWsUrl({
        NEXT_PUBLIC_APP_ENV: 'production',
        NEXT_PUBLIC_MARKET_WS_URL: url,
      })).toBeNull();
    }
  });

  it('accepts a wss:// production Gateway domain', () => {
    expect(resolvePublicMarketWsUrl({
      NEXT_PUBLIC_APP_ENV: 'production',
      NEXT_PUBLIC_MARKET_WS_URL: 'wss://market-gateway.up.railway.app/ws',
    })).toBe('wss://market-gateway.up.railway.app/ws');
  });

  it('resolves the live production Railway Gateway URL', () => {
    const url = 'wss://loving-growth-production-0965.up.railway.app/ws';
    expect(resolvePublicMarketWsUrl({ NEXT_PUBLIC_APP_ENV: 'production', NEXT_PUBLIC_MARKET_WS_URL: url })).toBe(url);
    // Same URL survives when only NODE_ENV signals production (NEXT_PUBLIC_APP_ENV unset on Vercel).
    expect(resolvePublicMarketWsUrl({ NODE_ENV: 'production', NEXT_PUBLIC_MARKET_WS_URL: url })).toBe(url);
  });

  it('falls back to NODE_ENV=production when NEXT_PUBLIC_APP_ENV is unset', () => {
    expect(resolvePublicMarketWsUrl({
      NODE_ENV: 'production',
      NEXT_PUBLIC_MARKET_WS_URL: 'ws://localhost:8081/ws',
    })).toBeNull();
  });

  it('rejects a malformed URL', () => {
    expect(resolvePublicMarketWsUrl({ NEXT_PUBLIC_MARKET_WS_URL: 'not-a-url' })).toBeNull();
    expect(resolvePublicMarketWsUrl({ NEXT_PUBLIC_MARKET_WS_URL: 'https://gw.example/ws' })).toBeNull();
  });
});

describe('computeBackoffDelayMs', () => {
  it('grows exponentially and is capped at 30s (full jitter uses the ceiling)', () => {
    const ceiling = (attempt: number) => computeBackoffDelayMs(attempt, { random: () => 0.999999 });
    expect(ceiling(0)).toBeLessThanOrEqual(1_000);
    expect(ceiling(1)).toBeLessThanOrEqual(2_000);
    expect(ceiling(1)).toBeGreaterThan(1_000);
    expect(ceiling(20)).toBeLessThanOrEqual(30_000);
    expect(ceiling(20)).toBeGreaterThan(29_000);
  });

  it('applies full jitter down to zero', () => {
    expect(computeBackoffDelayMs(5, { random: () => 0 })).toBe(0);
  });

  it('equal jitter keeps a floor of half the cap so it never fires sub-second', () => {
    // The upstream's connection-limit-safe policy: base 5s, cap 60s, equal jitter.
    const opts = { baseMs: 5_000, factor: 2, maxMs: 60_000, jitter: 'equal' as const };
    // Even at random()=0 the delay is the FLOOR (half the capped backoff), never 0.
    expect(computeBackoffDelayMs(0, { ...opts, random: () => 0 })).toBe(2_500);
    expect(computeBackoffDelayMs(1, { ...opts, random: () => 0 })).toBe(5_000);
    expect(computeBackoffDelayMs(2, { ...opts, random: () => 0 })).toBe(10_000);
    // Capped at 60s: floor 30s, ceiling 60s.
    expect(computeBackoffDelayMs(20, { ...opts, random: () => 0 })).toBe(30_000);
    expect(computeBackoffDelayMs(20, { ...opts, random: () => 0.999999 })).toBeLessThanOrEqual(60_000);
    expect(computeBackoffDelayMs(20, { ...opts, random: () => 0.999999 })).toBeGreaterThan(59_000);
  });
});

describe('Alpaca frames', () => {
  it('builds the auth frame with server-only credentials', () => {
    expect(JSON.parse(buildAuthFrame('key', 'secret'))).toEqual({ action: 'auth', key: 'key', secret: 'secret' });
  });

  it('omits empty channels from a subscription frame', () => {
    const frame = JSON.parse(buildSubscriptionFrame('subscribe', { trades: ['AAPL'], quotes: [], bars: ['AAPL'] }));
    expect(frame).toEqual({ action: 'subscribe', trades: ['AAPL'], bars: ['AAPL'] });
  });
});
