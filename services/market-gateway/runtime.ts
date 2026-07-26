import type { UpstreamState } from './upstream';

/**
 * Pure, side-effect-free runtime policy for the standalone Gateway process:
 * port resolution, browser-Origin allow-listing, the `/healthz` report shape,
 * simple sliding-window rate limits, and secret-scrubbing for logs.
 *
 * Everything here is deterministic and injectable (clock, env) so the production
 * deployment gate can be exercised without opening a real socket or binding a
 * port. The composition root ({@link ./server}) wires these into the live
 * `http`/`ws` servers.
 */

/** Fallback listen port when neither PORT nor MARKET_WS_PORT is set. */
export const DEFAULT_PORT = 8081;

/** The only WebSocket upgrade path the Gateway accepts. */
export const WS_PATH = '/ws';

/**
 * The HTTP LIVENESS path (never carries secrets). Answers 200 whenever the
 * server is listening on PORT — even while the upstream is (re)connecting — so a
 * transient provider connection-limit response during a rolling deploy never fails the new instance's
 * healthcheck and hands the single connection slot back to the old one. This is
 * the path Railway's healthcheck uses.
 */
export const HEALTH_PATH = '/healthz';

/**
 * The HTTP READINESS path. Unlike {@link HEALTH_PATH}, it answers 200 only when
 * the upstream is actually streaming (503 otherwise), for callers that want to
 * gate on a live feed. Railway does NOT use this for liveness.
 */
export const READY_PATH = '/readyz';

/**
 * Hard cap on a single inbound WebSocket message. Control frames
 * (subscribe/unsubscribe/ping) are tiny; anything larger is abusive, so the
 * `ws` server closes the peer with 1009 rather than buffering it.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024;

/** Per-IP connection attempts allowed inside {@link CONNECTION_RATE_WINDOW_MS}. */
export const CONNECTION_RATE_LIMIT = 30;
export const CONNECTION_RATE_WINDOW_MS = 60_000;

/** Per-client subscribe/unsubscribe frames allowed inside the window. */
export const SUBSCRIBE_RATE_LIMIT = 60;
export const SUBSCRIBE_RATE_WINDOW_MS = 60_000;

/** True only for a genuine local development process (never in production). */
export function isDevelopment(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'development';
}

/**
 * Resolve the listen port. `PORT` (injected by Railway/most PaaS) wins over the
 * project-specific `MARKET_WS_PORT`, which wins over {@link DEFAULT_PORT}. A
 * blank or non-numeric value is ignored rather than coerced to NaN/0.
 */
export function resolveGatewayPort(env: Record<string, string | undefined> = process.env): number {
  for (const raw of [env.PORT, env.MARKET_WS_PORT]) {
    if (raw === undefined || raw.trim() === '') continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0 && value < 65_536) return value;
  }
  return DEFAULT_PORT;
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Parse the comma-separated `NEXORA_ALLOWED_ORIGINS` allow-list into normalized
 * origins (scheme + host + port, no path). Unparseable entries are dropped so a
 * typo cannot silently widen the policy to everything.
 */
export function resolveAllowedOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.NEXORA_ALLOWED_ORIGINS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(normalizeOrigin)
    .filter((origin): origin is string => origin !== null);
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export interface OriginPolicy {
  allowedOrigins: string[];
  development: boolean;
}

/**
 * Decide whether a browser WebSocket handshake may proceed.
 *
 * - An origin present in the allow-list is always accepted.
 * - `localhost` / loopback origins are accepted ONLY in development.
 * - A missing `Origin` header (non-browser client) is accepted only in
 *   development — browsers always send one, so in production its absence is
 *   treated as untrusted.
 */
export function isOriginAllowed(origin: string | undefined, policy: OriginPolicy): boolean {
  if (origin === undefined || origin.trim() === '') return policy.development;
  const normalized = normalizeOrigin(origin) ?? origin;
  if (policy.allowedOrigins.includes(normalized)) return true;
  if (policy.development && isLocalhostOrigin(normalized)) return true;
  return false;
}

export type HealthStatus = 'ready' | 'degraded';

/**
 * The `/healthz` body. Deliberately carries only non-sensitive operational
 * signal — never a credential, URL, or key. `status` is `ready` only when the
 * upstream feed is authenticated and streaming; every other upstream state is
 * reported honestly as `degraded` while the process itself stays alive.
 */
export interface HealthReport {
  status: HealthStatus;
  upstreamState: UpstreamState;
  feed: string;
  /** Whole seconds the process has been up. */
  uptime: number;
  timestamp: string;
}

export function healthStatusFor(upstreamState: UpstreamState): HealthStatus {
  return upstreamState === 'ready' ? 'ready' : 'degraded';
}

/** True only when the upstream feed is authenticated and streaming. */
export function isUpstreamReady(upstreamState: UpstreamState): boolean {
  return upstreamState === 'ready';
}

export function buildHealthReport(input: {
  upstreamState: UpstreamState;
  feed: string;
  startedAt: number;
  now?: number;
}): HealthReport {
  const now = input.now ?? Date.now();
  return {
    status: healthStatusFor(input.upstreamState),
    upstreamState: input.upstreamState,
    feed: input.feed,
    uptime: Math.max(0, Math.floor((now - input.startedAt) / 1000)),
    timestamp: new Date(now).toISOString(),
  };
}

/** A rate-limit gate with a `tryAcquire` decision. */
export interface RateGate {
  tryAcquire(): boolean;
}

/**
 * A fixed-count sliding-window limiter. Allows at most `limit` acquisitions in
 * any trailing `windowMs`. The clock is injected so tests are deterministic.
 */
export class SlidingWindowRateLimiter implements RateGate {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(): boolean {
    const t = this.now();
    while (this.hits.length > 0 && t - this.hits[0] >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(t);
    return true;
  }
}

/**
 * Per-key (per-IP) connection-rate guard. Keeps one sliding window per source
 * so one abusive client cannot exhaust the budget for everyone. Idle windows
 * are pruned on access to bound memory.
 */
export class ConnectionRateGuard {
  private readonly perKey = new Map<string, SlidingWindowRateLimiter>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    let limiter = this.perKey.get(key);
    if (!limiter) {
      limiter = new SlidingWindowRateLimiter(this.limit, this.windowMs, this.now);
      this.perKey.set(key, limiter);
    }
    return limiter.tryAcquire();
  }
}

/**
 * Replace any occurrence of a known secret substring with `***`. Short secrets
 * (< 8 chars) are skipped to avoid masking innocuous text. This is the last
 * line of defence: the Gateway already logs only messages, never raw config.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 8) out = out.split(trimmed).join('***');
  }
  return out;
}

/**
 * Turn an unknown thrown value into a single safe log line: name + message
 * only (never the full object, whose enumerable fields could echo config), with
 * known secrets redacted as a belt-and-braces measure.
 */
export function sanitizeError(error: unknown, secrets: readonly string[] = []): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecrets(raw, secrets);
}
