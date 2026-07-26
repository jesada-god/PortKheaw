/**
 * Server-only configuration for the real-time Gateway plus the pure
 * reconnect-backoff policy shared by the Gateway (upstream) and the browser
 * client (downstream).
 *
 * Provider secrets are resolved here and
 * MUST NOT be prefixed `NEXT_PUBLIC_`. {@link resolveAlpacaConfig} refuses to run
 * in a browser so a bundling mistake fails loudly instead of leaking a key. The
 * browser only ever learns the public Gateway URL via {@link resolvePublicMarketWsUrl}.
 */

export type AlpacaFeed = 'iex' | 'sip' | 'test';

const FEED_URLS: Record<AlpacaFeed, string> = {
  iex: 'wss://stream.data.alpaca.markets/v2/iex',
  sip: 'wss://stream.data.alpaca.markets/v2/sip',
  test: 'wss://stream.data.alpaca.markets/v2/test',
};

/** The sandbox stream (`/v2/test`) only carries the synthetic FAKEPACA symbol. */
export const FAKEPACA_SYMBOL = 'FAKEPACA';

export type AlpacaConfig =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      feed: AlpacaFeed;
      url: string;
      keyId: string;
      secretKey: string;
      /**
       * Honest claim about the upstream: `true` only for a live entitled feed
       * (iex/sip). The `test` sandbox is deterministic fake data and is NEVER
       * real-time, so nothing downstream may label it "Real-time".
       */
      realtime: boolean;
    };

export type FinnhubConfig =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      provider: 'finnhub';
      feed: 'finnhub';
      url: string;
      apiKey: string;
      realtime: true;
    };

const FINNHUB_WS_URL = 'wss://ws.finnhub.io';

function parseFeed(value: string | undefined): AlpacaFeed {
  const feed = (value ?? 'iex').trim().toLowerCase();
  if (feed === 'iex' || feed === 'sip' || feed === 'test') return feed;
  return 'iex';
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Resolve the Gateway's Alpaca configuration from server environment. Returns a
 * disabled result (never throws for ordinary misconfiguration) when the feature
 * flag is off or credentials are absent, so the Gateway can degrade to polling.
 */
export function resolveAlpacaConfig(
  env: NodeJS.ProcessEnv = process.env,
): AlpacaConfig {
  if (typeof window !== 'undefined') {
    throw new Error('resolveAlpacaConfig must never run in the browser: Alpaca secrets are server-only.');
  }
  if (!isTruthy(env.MARKET_REALTIME_ENABLED)) {
    return { enabled: false, reason: 'MARKET_REALTIME_ENABLED is not set' };
  }
  const keyId = env.ALPACA_API_KEY_ID?.trim();
  const secretKey = env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secretKey) {
    return { enabled: false, reason: 'ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not configured' };
  }
  const feed = parseFeed(env.ALPACA_DATA_FEED);
  return {
    enabled: true,
    feed,
    url: FEED_URLS[feed],
    keyId,
    secretKey,
    realtime: feed !== 'test',
  };
}

/** Resolve the server-only Finnhub Gateway configuration. */
export function resolveFinnhubConfig(
  env: NodeJS.ProcessEnv = process.env,
): FinnhubConfig {
  if (typeof window !== 'undefined') {
    throw new Error('resolveFinnhubConfig must never run in the browser: FINNHUB_API_KEY is server-only.');
  }
  if (!isTruthy(env.MARKET_REALTIME_ENABLED)) {
    return { enabled: false, reason: 'MARKET_REALTIME_ENABLED is not set' };
  }
  const apiKey = env.FINNHUB_API_KEY?.trim();
  if (!apiKey) return { enabled: false, reason: 'FINNHUB_API_KEY is not configured' };
  const url = new URL(FINNHUB_WS_URL);
  url.searchParams.set('token', apiKey);
  return {
    enabled: true,
    provider: 'finnhub',
    feed: 'finnhub',
    url: url.toString(),
    apiKey,
    realtime: true,
  };
}

/** Hosts that must never be used from a production browser bundle. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

function isProductionEnv(env: Record<string, string | undefined>): boolean {
  const appEnv = env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
  if (appEnv) return appEnv === 'production';
  return env.NODE_ENV?.trim().toLowerCase() === 'production';
}

/**
 * The public Gateway URL the browser connects to. Safe to expose; not a secret.
 *
 * In production the browser MUST reach the Gateway over a secure `wss://` origin
 * and MUST NOT target a loopback host — a `ws://` scheme or a `localhost` /
 * `127.0.0.1` URL slipping into a production build is a misconfiguration, so it
 * is rejected (→ `null`, REST-only) rather than silently attempting a connection
 * that would fail the browser's mixed-content / origin rules. Development keeps
 * accepting `ws://localhost` so `npm run gateway` works locally.
 */
export function resolvePublicMarketWsUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.NEXT_PUBLIC_MARKET_WS_URL?.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null; // not a valid absolute URL — never hand a malformed value to WebSocket
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;

  if (isProductionEnv(env)) {
    if (parsed.protocol !== 'wss:') return null; // no plaintext ws:// in production
    const host = parsed.hostname.toLowerCase();
    if (LOCAL_HOSTS.has(host)) return null; // no loopback host in production
  }
  return raw;
}

export interface BackoffOptions {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  /**
   * Jitter strategy. `full` (the default) draws uniformly in `[0, cappedBackoff]`
   * and can return 0. `equal` draws in `[cappedBackoff/2, cappedBackoff]`, keeping
   * a floor so a reconnect can never fire back-to-back within the same second —
   * the property the single upstream needs after an Alpaca 406 (connection-limit)
   * rejection, where hot-looping just re-trips the same limit.
   */
  jitter?: 'full' | 'equal';
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * Exponential backoff with jitter. `attempt` is 0-based (the first reconnect
 * attempt is 0). `full` jitter — a uniform draw in `[0, cappedBackoff]` — spreads
 * reconnect storms so many clients do not all retry on the same tick. `equal`
 * jitter keeps a floor of `cappedBackoff/2` so a single long-lived connection
 * never retries instantly (see {@link BackoffOptions.jitter}).
 */
export function computeBackoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 1_000;
  const factor = options.factor ?? 2;
  const maxMs = options.maxMs ?? 30_000;
  const jitter = options.jitter ?? 'full';
  const random = options.random ?? Math.random;
  const exponential = baseMs * factor ** Math.max(0, attempt);
  const capped = Math.min(maxMs, exponential);
  if (jitter === 'equal') {
    const half = capped / 2;
    return Math.floor(half + random() * half);
  }
  return Math.floor(random() * capped);
}

/** The Alpaca auth frame sent immediately after the socket reports connected. */
export function buildAuthFrame(keyId: string, secretKey: string): string {
  return JSON.stringify({ action: 'auth', key: keyId, secret: secretKey });
}

/** Alpaca subscribe/unsubscribe frames grouped by channel (arrays of symbols). */
export function buildSubscriptionFrame(
  action: 'subscribe' | 'unsubscribe',
  channels: {
    trades?: string[];
    quotes?: string[];
    bars?: string[];
    updatedBars?: string[];
    statuses?: string[];
  },
): string {
  const frame: Record<string, unknown> = { action };
  for (const [channel, symbols] of Object.entries(channels)) {
    if (symbols && symbols.length > 0) frame[channel] = symbols;
  }
  return JSON.stringify(frame);
}
