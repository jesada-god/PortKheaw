import type { MarketDataApiError, Quote } from '@/src/lib/market-data/types';

/**
 * The market update source is deliberately transport-agnostic. Today only a
 * REST {@link PollingMarketSource} exists; the {@link WebSocketMarketSource}
 * type is a forward-looking contract with no production implementation because
 * the configured Polygon key is not entitled to the real-time WebSocket feed.
 * See the `polygon-ws-entitlement` memory. Nothing here may ever be labelled
 * REAL-TIME.
 */

/**
 * Truthful data-mode vocabulary.
 *
 * `REAL-TIME` may be set ONLY by a genuine live entitled stream — the Phase 12
 * {@link WebSocketMarketSource} connected to an Alpaca IEX feed (`realtime: true`,
 * `feed: 'iex'`). The REST polling / Polygon path must NEVER claim it and keeps
 * downgrading a provider's "realtime" tag to `DELAYED` (see `modeFromFreshness`).
 * A cached, previous-close or stale value is likewise never `REAL-TIME`.
 */
export type MarketDataMode =
  | 'REAL-TIME'
  | 'DELAYED'
  | 'END-OF-DAY'
  | 'CACHED'
  | 'STALE'
  | 'UNAVAILABLE';

/**
 * Where the currently displayed price came from, in descending trust order:
 * an entitled `snapshot`, an accepted live `aggregate-fallback` close, or the
 * newest displayed `history-fallback` bar close (Daily/Week/Month, or any
 * selection when neither snapshot nor live aggregate is available).
 */
export type MarketPriceSource = 'snapshot' | 'aggregate-fallback' | 'history-fallback';

/** Regular trading session vs. a closed market, which drives the poll cadence. */
export type MarketSessionKind = 'regular' | 'closed';

/**
 * Live-connection lifecycle for the WS coordinator, surfaced to the header so it
 * can honestly reflect the socket's health WITHOUT ever touching the accepted
 * price, timestamp, session or freshness. Only the {@link CoordinatedMarketSource}
 * produces it; the REST-only {@link PollingMarketSource} leaves it undefined so a
 * REST-only deployment never shows a "reconnecting" indicator.
 *
 * - `connecting`    — establishing the initial socket, no live data yet.
 * - `awaiting-data` — the socket is genuinely OPEN and subscribed, but no priced
 *   tick has arrived yet (a quiet market / low-volume IEX symbol). This is a
 *   healthy connection, NOT a fault: the header shows "connected, awaiting live
 *   data" and keeps the fallback price. It flips to `connected` on the first tick.
 * - `connected`     — live stream flowing (the Real-time badge is gated elsewhere).
 * - `reconnecting`  — the socket dropped and is being restored (transient).
 * - `degraded`      — gave up on the socket for now; REST fallback is serving data.
 * - `disconnected`  — paused/offline: neither the socket nor REST is active.
 */
export type ConnectionStatus =
  | 'connecting'
  | 'awaiting-data'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'disconnected';

/**
 * A single deterministic OHLCV bucket. `time` is the bucket start in unix
 * seconds and is the ordering key used to replace/append/ignore updates.
 */
export interface LiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Provenance for the currently displayed value. Always carries the provider,
 * the exchange (source) timestamp, when we received it and the derived delay
 * age so the UI can be honest about staleness.
 */
export interface MarketDataLabel {
  mode: MarketDataMode;
  provider: string | null;
  source: MarketPriceSource | null;
  /** Provider/exchange timestamp for the value (ISO-8601), if known. */
  exchangeTimestamp: string | null;
  /** When this client received/derived the value (ISO-8601). */
  receivedAt: string;
  /** receivedAt − exchangeTimestamp, in seconds, when both are known. */
  delayAgeSeconds: number | null;
  /** Human-facing note when a fallback path is in use. */
  fallbackNote: string | null;
  /**
   * True only when the value came from a genuine live entitled stream. The UI
   * gates the "Real-time" badge on this, never on `mode` alone. Absent/false for
   * every REST/polling/cached path. Optional for backward compatibility.
   */
  realtime?: boolean;
  /** Upstream feed identifier for the badge, e.g. `iex`. Null when not streaming. */
  feed?: string | null;
}

/** The normalized snapshot the source emits to subscribers. */
export interface MarketUpdate {
  symbol: string;
  price: number | null;
  quote: Quote | null;
  candle: LiveCandle | null;
  label: MarketDataLabel;
  error: MarketDataApiError | null;
  /**
   * Provider event that caused this emission. WebSocket consumers use this to
   * keep high-frequency trade ticks on an imperative/ref path while committing
   * snapshots and bars through React state. REST sources omit it.
   */
  eventKind?: 'trade' | 'quote' | 'bar' | 'status' | 'snapshot' | 'lifecycle';
  /**
   * Top-of-book, shown separately from Last Price in the header. Present only on
   * a real-time stream carrying quotes; null/undefined on REST paths. `undefined`
   * (never a fabricated 0) means "unknown".
   */
  bid?: number | null;
  ask?: number | null;
  bidSize?: number | null;
  askSize?: number | null;
  /** Exchange timestamp (ISO-8601) of the top-of-book quote, when known. */
  quoteTimestamp?: string | null;
  /** Per-symbol halt state, tracked independently of the market-wide session. */
  halted?: boolean;
  haltReason?: string | null;
  /** Regular/pre/post/closed session hint for the value, when the stream knows it. */
  session?: string | null;
  /**
   * True when this update finalized the previously-active bucket (a new bucket
   * opened, or an official/updated bar closed one). The chart uses this to gate
   * heavy S/R + indicator recomputation to finalized/appended bars only.
   */
  barFinalized?: boolean;
  /**
   * Live-connection lifecycle from the WS coordinator, for a status indicator
   * only. Never used to alter the accepted price/timestamp/session/freshness.
   * Absent on the REST-only {@link PollingMarketSource}.
   */
  connectionState?: ConnectionStatus;
  /**
   * The underlying socket lifecycle as seen by the {@link WebSocketMarketSource}
   * at emit time (`idle`/`connecting`/`open`/`closed`). The coordinator reads this
   * to tell a genuinely OPEN socket that is merely awaiting its first priced tick
   * apart from one that is truly down — so a quiet market never falsely degrades
   * to a "connection error". Absent on the REST-only path and on non-WS emitters.
   */
  streamStatus?: 'idle' | 'connecting' | 'open' | 'closed';
}

export type MarketUpdateListener = (update: MarketUpdate) => void;

/**
 * Normalized freshness statuses the transport may report. Mirrors the provider
 * freshness vocabulary minus `realtime`, which the label layer downgrades.
 */
export type TransportFreshness =
  | 'realtime'
  | 'delayed'
  | 'end-of-day'
  | 'cached'
  | 'stale'
  | 'unknown';

export interface SnapshotValue {
  quote: Quote;
  price: number;
  provider: string | null;
  status: TransportFreshness;
  asOf: string | null;
}

export interface AggregateValue {
  bars: LiveCandle[];
  provider: string | null;
  status: TransportFreshness;
  asOf: string | null;
}

/**
 * Structured transport outcome. Errors are surfaced (not thrown) so the engine
 * can route on entitlement (403), rate limits (429) and transient faults
 * without a try/catch treadmill.
 */
export type TransportOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: MarketDataApiError; retryAfterSeconds: number | null };

export interface SnapshotRequest {
  symbol: string;
  signal: AbortSignal;
}

export interface AggregateRequest {
  symbol: string;
  interval: string;
  session: string;
  /** Minimal chart-route-compatible range that still contains the newest bucket. */
  range: string;
  /** Split/dividend adjustment; part of the single-flight key. */
  adjusted: boolean;
  signal: AbortSignal;
}

/**
 * The pluggable REST/WS boundary. Each verified endpoint is a method so the
 * engine can probe capabilities independently and disable an endpoint once it
 * returns an entitlement error.
 */
export interface MarketSourceTransport {
  fetchSnapshot(request: SnapshotRequest): Promise<TransportOutcome<SnapshotValue>>;
  fetchAggregate(request: AggregateRequest): Promise<TransportOutcome<AggregateValue>>;
}

/** Effective polling cadence per session. */
export interface PollingCadence {
  /** Regular session interval; requirement mandates 10–15s. */
  regularMs: number;
  /** Slower cadence while the market is closed. */
  closedMs: number;
}

/**
 * Transport-agnostic market update source. Implementations own their own
 * lifecycle (timers, sockets) and single-flight guarantees.
 */
export interface MarketSource {
  readonly transport: 'polling' | 'websocket';
  /** Begin producing updates (idempotent). */
  start(): void;
  /** Stop producing updates and release timers/sockets (idempotent). */
  stop(): void;
  /** Pause when hidden, resume with exactly one request when shown. */
  setVisible(visible: boolean): void;
  /** Switch cadence between regular and closed sessions. */
  setSession(session: MarketSessionKind): void;
  /** Manual refresh: one request, joins an identical in-flight request. */
  refresh(): Promise<void>;
  /** Remaining rate-limit / backoff cooldown in ms (0 when clear). */
  cooldownRemainingMs(): number;
  /** Whether the entitled snapshot endpoint is still being polled. */
  isSnapshotEntitled(): boolean;
  subscribe(listener: MarketUpdateListener): () => void;
}

/**
 * Contract for an entitled real-time stream. Implemented in Phase 12 by
 * `WebSocketMarketSourceImpl`, which connects to the Gateway (never to Alpaca
 * directly) via `NEXT_PUBLIC_MARKET_WS_URL`. When no Gateway URL is configured
 * the app stays on the REST {@link PollingMarketSource}.
 */
export interface WebSocketMarketSource extends MarketSource {
  readonly transport: 'websocket';
  /** Underlying socket connection state. */
  readonly connectionState: 'idle' | 'connecting' | 'open' | 'closed';
}
