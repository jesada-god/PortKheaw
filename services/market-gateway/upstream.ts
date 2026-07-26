import {
  buildAuthFrame,
  buildFinnhubSubscriptionFrame,
  buildSubscriptionFrame,
  channelOfEvent,
  classifyAlpacaControl,
  computeBackoffDelayMs,
  MarketTracer,
  normalizeAlpacaMessage,
  normalizeFinnhubMessageWithDiagnostics,
  type BackoffOptions,
  type ChannelRef,
  type MarketChannel,
  type NormalizedMarketEvent,
} from '@/src/lib/market-data/realtime';
import { defaultScheduler, type Scheduler, type SocketLike } from './socket';

/**
 * The single provider upstream connection owned by one Gateway instance.
 *
 * Drives the handshake state machine (connect → authenticate → subscribe),
 * normalizes every market message before emitting it, and owns reconnection:
 * exponential backoff with EQUAL jitter (5s → cap 60s, never sub-second), exactly
 * one pending reconnect at a time, and a full resubscribe from the live registry
 * snapshot once re-authenticated. This backoff is what keeps an Alpaca 406
 * (connection-limit) rejection from hot-looping and re-tripping the same limit.
 *
 * LIVENESS — the watchdog is deliberately conservative. It NEVER treats "no
 * trade/quote/bar" as a dead connection: a closed market, or an instance with
 * zero desired subscriptions, is silent yet perfectly healthy. Only when the
 * WIRE (any frame at all, including a subscription ack or a protocol pong) has
 * gone quiet for a full interval does it actively ping, and it recycles solely
 * when that ping is not answered within the pong timeout. `lastWireMessageAge`
 * and `lastMarketEventAge` are tracked and logged separately for exactly this
 * reason.
 *
 * CONNECTION GENERATION GUARD — every {@link open} mints a fresh generation
 * token. Each socket's open/message/close/error/ping/pong handler (and every
 * watchdog timer) captures its generation and no-ops unless it is still current.
 * This is what makes reconnect race-safe: a message delivered — or a stale-feed
 * timer fired — by a superseded socket can never authenticate, resubscribe,
 * close, or otherwise touch the freshly-created (and possibly still-CONNECTING)
 * replacement socket.
 */

export type UpstreamState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'reconnecting'
  | 'stopped';

export interface UpstreamOptions {
  config: {
    url: string;
    protocol?: 'alpaca' | 'finnhub';
    keyId?: string;
    secretKey?: string;
  };
  /** Opens a new transport to `config.url`. Injected so tests use fake sockets. */
  createSocket: (url: string) => SocketLike;
  /** Receives every normalized market event. */
  onEvent: (event: NormalizedMarketEvent) => void;
  /** Classifies Finnhub rows rejected before canonical trade ingestion. */
  onTradeRejected?: (symbol: string, reason: 'stale' | 'invalid') => void;
  /** The current live subscriptions to replay after a reconnect. */
  getSubscriptions: () => ChannelRef[];
  onStateChange?: (state: UpstreamState) => void;
  scheduler?: Scheduler;
  random?: () => number;
  now?: () => number;
  /**
   * Silent-wire interval: when NO frame (market, control, or protocol pong) has
   * arrived for this long AND at least one symbol is desired, actively ping to
   * probe liveness. 0 disables the watchdog entirely.
   */
  heartbeatIntervalMs?: number;
  /** After a probe ping, recycle only if nothing answers within this window. */
  pongTimeoutMs?: number;
  /** Reconnect backoff. Defaults to connection-limit-safe 5s → 60s equal jitter. */
  backoff?: BackoffOptions;
  /** End-to-end pipeline tracer. Defaults to a live, sampled console tracer. */
  tracer?: MarketTracer;
}

/**
 * Upper bound on the control-frame queue. Only auth/subscribe/unsubscribe
 * frames are ever queued (market events are emitted upward, never queued), so
 * this can only fill during a wedged handshake — dropping the oldest keeps
 * memory bounded rather than growing without limit.
 */
const MAX_OUTBOX = 64;

/** Fallback pong window when {@link UpstreamOptions.pongTimeoutMs} is unset. */
const DEFAULT_PONG_TIMEOUT_MS = 10_000;

/**
 * Reconnect backoff tuned for a single, connection-limited upstream: start at
 * 5s, double, cap at 60s, and use EQUAL jitter so two failures can never produce
 * two reconnects inside the same second. This is the direct fix for the observed
 * 406 hot-loop.
 */
const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 5_000, factor: 2, maxMs: 60_000, jitter: 'equal' };

function groupByChannel(refs: ChannelRef[]): Partial<Record<MarketChannel, string[]>> {
  const grouped: Partial<Record<MarketChannel, string[]>> = {};
  for (const { symbol, channel } of refs) {
    (grouped[channel] ??= []).push(symbol);
  }
  return grouped;
}

export class UpstreamConnection {
  private socket: SocketLike | null = null;
  private state: UpstreamState = 'idle';
  /** Monotonic token identifying the current socket; bumped on every open(). */
  private generation = 0;
  private attempt = 0;
  private stopped = false;
  private reconnectPending = false;
  private cancelReconnect: (() => void) | null = null;
  private cancelHeartbeat: (() => void) | null = null;
  private cancelPongTimer: (() => void) | null = null;
  /** Last time ANY frame arrived on the wire (market, control, ping, or pong). */
  private lastWireMessageAt = 0;
  /** Last time a normalized market event arrived — tracked distinctly from wire. */
  private lastMarketEventAt = 0;
  /** Bounded queue of control frames awaiting an OPEN socket of this generation. */
  private outbox: string[] = [];
  /** Finnhub subscribes once per symbol (not once per downstream channel). */
  private readonly upstreamSymbols = new Set<string>();
  private readonly scheduler: Scheduler;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly tracer: MarketTracer;

  constructor(private readonly options: UpstreamOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.tracer = options.tracer ?? new MarketTracer();
  }

  getState(): UpstreamState {
    return this.state;
  }

  getGeneration(): number {
    return this.generation;
  }

  /** Open the upstream and begin the handshake. Idempotent while active. */
  start(): void {
    this.stopped = false;
    if (
      this.state === 'connecting' ||
      this.state === 'authenticating' ||
      this.state === 'ready' ||
      this.state === 'reconnecting'
    ) {
      return; // a connect is already in flight — never open a second socket
    }
    this.open();
  }

  /** Intentional shutdown — cancels every timer and schedules no reconnect. */
  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    const socket = this.socket;
    this.teardownSocket();
    socket?.close();
    this.setState('stopped');
  }

  /** Subscribe the given pairs upstream (no-op unless authenticated). */
  subscribe(refs: ChannelRef[]): void {
    if (this.state !== 'ready' || refs.length === 0) return;
    if (this.options.config.protocol === 'finnhub') {
      for (const symbol of new Set(refs.map((ref) => ref.symbol.toUpperCase()))) {
        if (this.upstreamSymbols.has(symbol)) continue;
        this.upstreamSymbols.add(symbol);
        this.enqueueControl(buildFinnhubSubscriptionFrame('subscribe', symbol));
        this.tracer.trace({ stage: 'upstream_subscribe_sent', symbol, channels: 'trades' });
      }
      return;
    }
    const grouped = groupByChannel(refs);
    this.enqueueControl(buildSubscriptionFrame('subscribe', grouped));
    for (const symbol of new Set(refs.map((ref) => ref.symbol))) {
      const channels = refs.filter((ref) => ref.symbol === symbol).map((ref) => ref.channel).join(',');
      this.tracer.trace({ stage: 'upstream_subscribe_sent', symbol, channels });
    }
  }

  /** Unsubscribe the given pairs upstream (no-op unless authenticated). */
  unsubscribe(refs: ChannelRef[]): void {
    if (this.state !== 'ready' || refs.length === 0) return;
    if (this.options.config.protocol === 'finnhub') {
      const desired = new Set(this.options.getSubscriptions().map((ref) => ref.symbol.toUpperCase()));
      for (const symbol of new Set(refs.map((ref) => ref.symbol.toUpperCase()))) {
        if (desired.has(symbol) || !this.upstreamSymbols.delete(symbol)) continue;
        this.enqueueControl(buildFinnhubSubscriptionFrame('unsubscribe', symbol));
      }
      return;
    }
    this.enqueueControl(buildSubscriptionFrame('unsubscribe', groupByChannel(refs)));
  }

  private open(): void {
    // Detach any lingering socket + drop its stale control frames BEFORE minting
    // the new generation, so nothing from the previous socket survives.
    this.teardownSocket();
    const generation = ++this.generation;
    this.setState('connecting');

    let socket: SocketLike;
    try {
      socket = this.options.createSocket(this.options.config.url);
    } catch (error) {
      // createSocket threw synchronously (bad URL, resource limit): treat as a
      // transient failure and retry with backoff rather than crashing.
      this.log('warn', generation, 'create-socket-failed', error);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    // Register error/close first so a synchronous failure is contained.
    socket.onError((error) => this.onDisconnect(generation, 'error', error));
    socket.onClose(() => this.onDisconnect(generation, 'close'));
    socket.onOpen(() => this.onOpen(generation, socket));
    socket.onMessage((data) => this.onUpstreamMessage(generation, data));
    socket.onPing(() => this.onHeartbeat(generation));
    socket.onPong(() => this.onHeartbeat(generation));
  }

  /** Is `generation` the socket the connection currently cares about? */
  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private onOpen(generation: number, socket: SocketLike): void {
    if (!this.isCurrent(generation)) return; // superseded socket opened late
    this.markWire();
    this.armHeartbeat(generation);
    if (this.options.config.protocol === 'finnhub') {
      this.attempt = 0;
      this.setState('ready');
      this.subscribe(this.options.getSubscriptions());
      this.flushOutbox(socket);
      return;
    }
    // Alpaca sends {"T":"success","msg":"connected"} first; auth follows that.
    // Anything queued while CONNECTING can flush now that the socket is OPEN.
    this.flushOutbox(socket);
  }

  private onHeartbeat(generation: number): void {
    if (!this.isCurrent(generation)) return;
    // A protocol ping/pong is wire activity — proof the socket is alive even when
    // the market is silent. This is what lets a quiet feed answer the watchdog.
    this.markWire();
  }

  private onUpstreamMessage(generation: number, data: string): void {
    const current = this.isCurrent(generation);
    if (!current && this.options.config.protocol !== 'finnhub') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!current) {
      if (this.options.config.protocol === 'finnhub') {
        const diagnostics = normalizeFinnhubMessageWithDiagnostics(parsed);
        for (const symbol of diagnostics.observedSymbols) this.options.onTradeRejected?.(symbol, 'stale');
      }
      return;
    }
    this.markWire();
    if (this.options.config.protocol === 'finnhub') {
      this.handleFinnhubMessage(generation, parsed);
      return;
    }
    // Alpaca frames arrive as arrays of messages.
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) this.handleOne(generation, message);
  }

  private handleFinnhubMessage(generation: number, message: unknown): void {
    if (!this.isCurrent(generation) || typeof message !== 'object' || message === null) return;
    const envelope = message as { type?: unknown; msg?: unknown };
    if (envelope.type === 'ping') return;
    if (envelope.type === 'error') {
      this.log('error', generation, 'protocol-error', {
        message: typeof envelope.msg === 'string' ? envelope.msg : 'Finnhub upstream error',
      });
      this.recycle(generation);
      return;
    }
    const diagnostics = normalizeFinnhubMessageWithDiagnostics(message);
    for (const rejected of diagnostics.rejected) this.options.onTradeRejected?.(rejected.symbol, rejected.reason);
    const events = diagnostics.trades;
    if (events.length === 0) return;
    this.markMarketEvent();
    for (const event of events) {
      const observed = { ...event, gatewayReceivedAtMs: this.now() } as NormalizedMarketEvent;
      this.tracer.trace({ stage: 'upstream_market_event_received', type: 'trade', symbol: event.symbol });
      this.tracer.trace({
        stage: 'gateway_market_event_normalized', type: observed.kind, symbol: observed.symbol,
        exchangeTimestampMs: observed.timestampMs, gatewayReceivedAtMs: observed.gatewayReceivedAtMs,
      });
      this.options.onEvent(observed);
    }
  }

  private handleOne(generation: number, message: unknown): void {
    if (!this.isCurrent(generation)) return;
    const control = classifyAlpacaControl(message);
    if (control) {
      if (control.kind === 'success' && control.message === 'connected') {
        this.setState('authenticating');
        // authenticate is sent only after OPEN — enqueueControl guarantees it.
        this.enqueueControl(buildAuthFrame(this.options.config.keyId ?? '', this.options.config.secretKey ?? ''));
      } else if (control.kind === 'success' && control.message === 'authenticated') {
        this.attempt = 0;
        this.setState('ready');
        // resubscribe happens only after authentication success.
        this.subscribe(this.options.getSubscriptions());
      } else if (control.kind === 'subscription') {
        // Alpaca's authoritative echo of what is ACTUALLY subscribed. Logging it
        // is what turns "we asked for trades but the feed is quotes-only" from an
        // invisible mystery into one grep. Symbols/channels only — never secrets.
        if (control.symbols.length === 0) {
          this.tracer.trace({ stage: 'upstream_subscribed', symbol: '(none)', channels: '' });
        }
        for (const symbol of control.symbols) {
          const channels = Object.entries(control.channels)
            .filter(([, syms]) => syms?.some((s) => s.toUpperCase() === symbol))
            .map(([channel]) => channel)
            .join(',');
          this.tracer.trace({ stage: 'upstream_subscribed', symbol, channels });
        }
      } else if (control.kind === 'error') {
        // Distinguish a fatal auth error, a connection-limit rejection, and a
        // generic protocol drop for the operator's benefit. ALL recycle through
        // the SAME backoff path: a 406 "connection limit exceeded" must back off
        // (5s → 60s), never hot-loop and re-trip the very limit it hit — the old
        // deployment may still be holding the single Alpaca slot mid-rollout.
        const fatal = control.code === 401 || control.code === 402;
        const reason =
          control.code === 406 ? 'connection-limit' : fatal ? 'fatal-auth-error' : 'protocol-error';
        this.log('error', generation, reason, { code: control.code, message: control.message });
        this.recycle(generation);
      }
      return;
    }
    // Not a control frame → market data. Track it separately from generic wire
    // activity so the watchdog never confuses market silence with a dead socket.
    this.markMarketEvent();
    // Trace what the wire delivered BEFORE normalization so a value dropped by
    // schema/type mapping is still visible as "received but not normalized"
    // rather than vanishing silently.
    const wireType = typeof (message as { T?: unknown })?.T === 'string' ? (message as { T: string }).T : 'unknown';
    const wireSymbol = typeof (message as { S?: unknown })?.S === 'string' ? (message as { S: string }).S : undefined;
    this.tracer.trace({ stage: 'upstream_market_event_received', type: wireType, symbol: wireSymbol });
    const event = normalizeAlpacaMessage(message);
    if (event) {
      const observed = { ...event, gatewayReceivedAtMs: this.now() } as NormalizedMarketEvent;
      // channelOfEvent keeps updatedBars distinct from bars for downstream fan-out.
      void channelOfEvent(observed);
      this.tracer.trace({
        stage: 'gateway_market_event_normalized', type: observed.kind, symbol: observed.symbol,
        exchangeTimestampMs: observed.timestampMs, gatewayReceivedAtMs: observed.gatewayReceivedAtMs,
      });
      this.options.onEvent(observed);
    }
  }

  /**
   * Queue a control frame and flush what we can. Only OPEN sockets of the
   * current generation are written to; a CONNECTING/CLOSING socket holds the
   * frame until onOpen flushes it. Bounded so a stuck handshake cannot grow it.
   */
  private enqueueControl(frame: string): void {
    if (this.outbox.length >= MAX_OUTBOX) this.outbox.shift();
    this.outbox.push(frame);
    if (this.socket) this.flushOutbox(this.socket);
  }

  private flushOutbox(socket: SocketLike): void {
    if (socket !== this.socket || !socket.isOpen()) return;
    while (this.outbox.length > 0) {
      const frame = this.outbox[0];
      if (socket.send(frame) !== 'sent') break; // socket slipped out of OPEN
      this.outbox.shift();
    }
  }

  private onDisconnect(generation: number, reason: string, error?: unknown): void {
    // A stale socket's close/error must never drive reconnection.
    if (generation !== this.generation) return;
    this.log('warn', generation, `disconnect:${reason}`, error);
    this.teardownSocket();
    if (this.stopped) {
      this.setState('stopped');
      return;
    }
    this.scheduleReconnect();
  }

  /** Force-recycle the current socket through the normal reconnect path. */
  private recycle(generation: number): void {
    if (generation !== this.generation) return;
    const socket = this.socket;
    this.teardownSocket();
    socket?.close();
    if (this.stopped) {
      this.setState('stopped');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectPending || this.stopped) return; // exactly one pending reconnect
    this.reconnectPending = true;
    this.setState('reconnecting');
    const delay = computeBackoffDelayMs(this.attempt, {
      ...DEFAULT_BACKOFF,
      ...this.options.backoff,
      random: this.random,
    });
    // Log the attempt and the next retry delay (never a secret) so a 406 loop, if
    // one ever recurs, is a single grep of increasing nextRetryMs values.
    this.log('warn', this.generation, 'reconnect-scheduled', { attempt: this.attempt, nextRetryMs: delay });
    this.attempt += 1;
    this.cancelReconnect = this.scheduler(() => {
      this.reconnectPending = false;
      this.cancelReconnect = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  /** (Re)arm the single recurring liveness watchdog for `generation`. */
  private armHeartbeat(generation: number): void {
    const interval = this.options.heartbeatIntervalMs ?? 0;
    if (interval <= 0) return; // watchdog disabled
    this.clearHeartbeat();
    this.cancelHeartbeat = this.scheduler(() => this.heartbeatTick(generation), interval);
  }

  /**
   * One watchdog tick. Recycles ONLY on a genuine ping/pong failure — never on
   * mere market silence:
   *  - a non-ready socket is re-armed, never judged (a slow handshake is not death);
   *  - ZERO desired subscriptions means silence is expected → keep the socket, do
   *    not probe and never reconnect (a closed market / idle instance is healthy);
   *  - recent wire activity (any frame, including a subscription ack or a pong) is
   *    proof of life → no probe;
   *  - only a full interval of wire silence triggers an active ping, and the
   *    reconnect decision is deferred to {@link probeLiveness}.
   */
  private heartbeatTick(generation: number): void {
    if (!this.isCurrent(generation) || this.socket === null) return;
    const interval = this.options.heartbeatIntervalMs ?? 0;
    if (interval <= 0) return;
    if (this.state !== 'ready') {
      this.armHeartbeat(generation);
      return;
    }
    if (this.options.getSubscriptions().length === 0) {
      this.armHeartbeat(generation);
      return;
    }
    if (this.now() - this.lastWireMessageAt < interval) {
      this.armHeartbeat(generation);
      return;
    }
    this.probeLiveness(generation);
  }

  /** Silent wire → send one protocol ping and recycle only if nothing answers. */
  private probeLiveness(generation: number): void {
    const socket = this.socket;
    if (socket === null) {
      this.armHeartbeat(generation);
      return;
    }
    const pongTimeout = this.options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    const pingSentAt = this.now();
    socket.ping();
    this.clearPongTimer();
    this.cancelPongTimer = this.scheduler(() => {
      this.cancelPongTimer = null;
      if (!this.isCurrent(generation) || this.state !== 'ready' || this.socket === null) {
        // Superseded, no longer ready, or already torn down: never touch the
        // (possibly brand-new) current socket. Just re-arm if we still own it.
        this.armHeartbeat(generation);
        return;
      }
      // ANY frame since the ping (pong, control, or market data) proves the socket
      // is alive — a quiet market that still answers pong is NOT a failure.
      if (this.lastWireMessageAt >= pingSentAt) {
        this.armHeartbeat(generation);
        return;
      }
      // Genuine ping/pong failure. Log the three signals distinctly so an operator
      // can tell a dead socket from a merely quiet market at a glance.
      this.log('warn', generation, 'stale-feed', {
        desiredSymbols: this.options.getSubscriptions().length,
        lastWireMessageAge: this.now() - this.lastWireMessageAt,
        lastMarketEventAge: this.lastMarketEventAt === 0 ? -1 : this.now() - this.lastMarketEventAt,
      });
      this.recycle(generation);
    }, pongTimeout);
  }

  private markWire(): void {
    this.lastWireMessageAt = this.now();
  }

  private markMarketEvent(): void {
    this.lastMarketEventAt = this.now();
  }

  /** Detach the current socket's listeners and drop its queued control frames. */
  private teardownSocket(): void {
    this.clearHeartbeat();
    this.clearPongTimer();
    this.outbox = [];
    this.upstreamSymbols.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.detach();
  }

  private clearHeartbeat(): void {
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
  }

  private clearPongTimer(): void {
    this.cancelPongTimer?.();
    this.cancelPongTimer = null;
  }

  private clearReconnect(): void {
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.reconnectPending = false;
  }

  private setState(state: UpstreamState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }

  /** Structured log — deliberately never includes credentials. */
  private log(level: 'warn' | 'error', generation: number, reason: string, detail?: unknown): void {
    const base = `[gateway] upstream ${reason} gen=${generation} state=${this.state}`;
    const extra = detail instanceof Error ? detail.message : detail;
    if (extra === undefined) console[level](base);
    else if (this.options.config.protocol === 'finnhub') {
      let serialized: string;
      try { serialized = typeof extra === 'string' ? extra : JSON.stringify(extra); }
      catch { serialized = 'unserializable upstream detail'; }
      try {
        const token = new URL(this.options.config.url).searchParams.get('token');
        if (token) serialized = serialized.split(token).join('[REDACTED]');
      } catch {
        // A malformed URL is handled by createSocket; do not widen logging here.
      }
      console[level](base, serialized);
    } else console[level](base, extra);
  }
}
