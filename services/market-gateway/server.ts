import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { isTracingEnabled, MarketTracer, resolveFinnhubConfig } from '@/src/lib/market-data/realtime';
import { GatewayHub } from './hub';
import { UpstreamConnection } from './upstream';
import { fromWs } from './socket';
import { GatewayLifecycle } from './lifecycle';
import { MarketCache } from './cache';
import { fetchFinnhubRestSnapshot } from './rest-snapshot';
import { MarketCandleEngine } from './candle-engine';
import type { MarketSnapshot } from '@/src/lib/market-data/realtime';
import {
  buildHealthReport,
  ConnectionRateGuard,
  CONNECTION_RATE_LIMIT,
  CONNECTION_RATE_WINDOW_MS,
  HEALTH_PATH,
  isDevelopment,
  isOriginAllowed,
  isUpstreamReady,
  MAX_MESSAGE_BYTES,
  READY_PATH,
  resolveAllowedOrigins,
  resolveGatewayPort,
  sanitizeError,
  SlidingWindowRateLimiter,
  SUBSCRIBE_RATE_LIMIT,
  SUBSCRIBE_RATE_WINDOW_MS,
  WS_PATH,
} from './runtime';

/**
 * Standalone Node WebSocket Gateway entrypoint — the composition root for the
 * production deployment gate. All policy lives in the tested `runtime` and
 * `lifecycle` modules; this file only wires them to the live `http`/`ws`
 * servers and the process signals.
 *
 * This is a LONG-LIVED process and MUST NOT run inside a Next.js/Vercel route
 * handler: serverless functions are request-scoped and cannot hold the single
 * persistent upstream socket this service owns. Deploy it as its own always-on
 * Node service (Railway / Render / Fly / a container) and point
 * `NEXT_PUBLIC_MARKET_WS_URL` at it.
 *
 *   npm run gateway   # reads .env.local for FINNHUB_API_KEY + MARKET_REALTIME_ENABLED
 *
 * Exactly ONE upstream Finnhub connection exists per instance. Scale horizontally
 * by running more instances behind the load balancer, never by opening a second
 * upstream socket here. Secrets are read only via resolveFinnhubConfig and never
 * reach a client, a health response, or a log line.
 */
function main(): void {
  const config = resolveFinnhubConfig();
  if (!config.enabled) {
    console.error(`[gateway] disabled: ${config.reason}. Set MARKET_REALTIME_ENABLED and FINNHUB_API_KEY to enable.`);
    process.exit(1);
    return;
  }

  const secrets = [config.apiKey] as const;
  const log = (level: 'info' | 'error', message: string, detail?: unknown): void => {
    const line = `[gateway] ${message}`;
    if (detail === undefined) console[level === 'info' ? 'log' : 'error'](line);
    else console[level === 'info' ? 'log' : 'error'](line, sanitizeError(detail, secrets));
  };

  const port = resolveGatewayPort();
  const development = isDevelopment();
  const allowedOrigins = resolveAllowedOrigins();
  const connectionGuard = new ConnectionRateGuard(CONNECTION_RATE_LIMIT, CONNECTION_RATE_WINDOW_MS);
  const startedAt = Date.now();

  // Shared end-to-end pipeline tracer. On by default (MARKET_TRACE=off silences
  // it) and sampled, so an operator can follow one event upstream→broadcast in
  // the Railway logs without the feed flooding the process output.
  const tracer = new MarketTracer({ enabled: isTracingEnabled(process.env.MARKET_TRACE) });

  // --- Per-symbol latest-state cache, warmed from the live stream + a REST
  // bootstrap for cold symbols, so a new subscriber gets a price immediately. ---
  const cache = new MarketCache();
  const candleEngine = new MarketCandleEngine();
  const shouldLogDrop = (count: number): boolean => count === 1 || count % 100 === 0;
  // Dedupe concurrent REST bootstraps for the same cold symbol: many browsers
  // subscribing at once must not each hit Finnhub REST. Credentials stay in this
  // closure (Gateway host) and never reach the hub or a client frame.
  const inflightBootstraps = new Map<string, Promise<MarketSnapshot | null>>();
  const bootstrapSnapshot = (symbol: string): Promise<MarketSnapshot | null> => {
    const key = symbol.toUpperCase();
    const existing = inflightBootstraps.get(key);
    if (existing) return existing;
    const promise = fetchFinnhubRestSnapshot(key, {
      apiKey: config.apiKey,
    })
      .then((snapshot) => {
        if (snapshot) cache.seed(snapshot);
        return snapshot;
      })
      .catch((error) => {
        log('error', 'rest snapshot bootstrap failed', error);
        return null;
      })
      .finally(() => inflightBootstraps.delete(key));
    inflightBootstraps.set(key, promise);
    return promise;
  };

  // --- Upstream + fan-out hub (one upstream connection per instance) ---
  const hub = new GatewayHub({
    feed: config.feed,
    realtime: config.realtime,
    applySubscribe: (refs) => upstream.subscribe(refs),
    applyUnsubscribe: (refs) => upstream.unsubscribe(refs),
    createRateLimiter: () => new SlidingWindowRateLimiter(SUBSCRIBE_RATE_LIMIT, SUBSCRIBE_RATE_WINDOW_MS),
    getSnapshot: (symbol) => cache.snapshotFor(symbol),
    bootstrapSnapshot,
    tracer,
  });

  const upstream = new UpstreamConnection({
    config: { url: config.url, protocol: 'finnhub' },
    createSocket: (url) => fromWs(new WebSocket(url)),
    // Warm the cache from every normalized event BEFORE fan-out so the next
    // subscriber's snapshot reflects the latest tick.
    onEvent: (event) => {
      if (event.kind !== 'trade') {
        cache.record(event);
        hub.handleUpstreamEvent(event);
        return;
      }
      const result = candleEngine.ingest(event);
      if (!result.accepted) {
        const reason = result.rejectionReason ?? (result.droppedDuplicate ? 'duplicate' : 'out-of-order');
        const stats = candleEngine.statsFor(event.symbol);
        const count = reason === 'duplicate' ? stats.duplicateDropped : stats.outOfOrderDropped;
        if (shouldLogDrop(count)) log('info', `tradeDropped reason=${reason} symbol=${event.symbol} count=${count}`);
        return;
      }
      cache.record(event);
      hub.handleUpstreamEvent(event);
      for (const bar of result.bars) {
        cache.record(bar);
        hub.handleUpstreamEvent(bar);
        if (bar.finalized) {
          const stats = candleEngine.statsFor(bar.symbol);
          log('info', `candleFinalized symbol=${bar.symbol} timeframe=1m start=${bar.timestampMs} receivedTrades=${stats.receivedTrades} acceptedTrades=${stats.acceptedTrades} duplicateDropped=${stats.duplicateDropped} outOfOrderDropped=${stats.outOfOrderDropped} staleDropped=${stats.staleDropped} invalidDropped=${stats.invalidDropped}`);
        }
      }
    },
    onTradeRejected: (symbol, reason) => {
      const stats = candleEngine.recordRejected(symbol, reason);
      const count = reason === 'stale' ? stats.staleDropped : stats.invalidDropped;
      if (shouldLogDrop(count)) log('info', `tradeDropped reason=${reason} symbol=${symbol} count=${count}`);
    },
    getSubscriptions: () => hub.subscriptionSnapshot(),
    onStateChange: (state) => log('info', `upstream ${state}`),
    // Liveness is a real protocol ping/pong, NOT market ticks: probe after 15s of
    // wire silence, recycle only if no pong answers within 10s. A quiet or closed
    // market never trips this.
    heartbeatIntervalMs: 15_000,
    pongTimeoutMs: 10_000,
    tracer,
  });

  // --- HTTP server: /healthz + the WebSocket upgrade endpoint on one port ---
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === HEALTH_PATH) {
      // Liveness: 200 as long as the server is listening, regardless of upstream
      // state, so a reconnecting upstream never fails the Railway healthcheck.
      const report = buildHealthReport({ upstreamState: upstream.getState(), feed: config.feed, startedAt });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(report));
      return;
    }
    if (req.method === 'GET' && path === READY_PATH) {
      // Readiness: 200 only when the upstream is actually streaming; 503 while it
      // is connecting/degraded. The body reports upstreamState honestly either way.
      const report = buildHealthReport({ upstreamState: upstream.getState(), feed: config.feed, startedAt });
      const code = isUpstreamReady(upstream.getState()) ? 200 : 503;
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(report));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  wss.on('error', (error) => log('error', 'wss error', error));

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) return rejectUpgrade(socket, 404, 'Not Found');

    if (!isOriginAllowed(req.headers.origin, { allowedOrigins, development })) {
      log('error', `rejected upgrade: origin not allowed (${req.headers.origin ?? 'none'})`);
      return rejectUpgrade(socket, 403, 'Forbidden');
    }

    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!connectionGuard.allow(ip)) {
      log('error', 'rejected upgrade: connection rate exceeded');
      return rejectUpgrade(socket, 429, 'Too Many Requests');
    }

    wss.handleUpgrade(req, socket, head, (peer) => {
      peer.on('error', (error) => log('error', 'peer error', error));
      hub.addClient(fromWs(peer));
    });
  });

  // --- Ordered teardown for signals + fatal errors ---
  const lifecycle = new GatewayLifecycle({
    stopUpstream: () => upstream.stop(),
    closePeers: () => {
      for (const peer of wss.clients) {
        try {
          peer.terminate();
        } catch {
          // already gone
        }
      }
    },
    closeWebSocketServer: (done) => wss.close(() => done()),
    closeHttpServer: (done) => httpServer.close(() => done()),
    clearTimers: () => {
      /* upstream owns its own timers and is stopped above; nothing else here */
    },
    exit: (code) => process.exit(code),
    log,
  });

  process.on('SIGTERM', () => lifecycle.shutdown(0, 'SIGTERM'));
  process.on('SIGINT', () => lifecycle.shutdown(0, 'SIGINT'));
  // A fatal error must never leave the process in an unknown state: log it
  // sanitized, drain every resource, then exit non-zero so the platform can
  // restart a clean instance.
  process.on('uncaughtException', (error) => lifecycle.handleFatal('uncaughtException', error));
  process.on('unhandledRejection', (reason) => lifecycle.handleFatal('unhandledRejection', reason));

  httpServer.on('error', (error) => log('error', 'http server error', error));
  httpServer.listen(port, '0.0.0.0', () => {
    log('info', `listening on 0.0.0.0:${port} · ws=${WS_PATH} · health=${HEALTH_PATH} · feed=${config.feed} · realtime=${config.realtime}`);
    upstream.start();
  });
}

/** Reject a WebSocket upgrade with a minimal HTTP response, then close. */
function rejectUpgrade(socket: Socket, code: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch {
    // socket may already be gone
  }
  socket.destroy();
}

main();
