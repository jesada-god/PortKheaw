import { isTradeablePrice } from './candle-validation';
import {
  LiveBucketStore,
  classifyUsEquityTimestamp,
  isRealtimeInterval,
  parseServerFrame,
  MarketTracer,
  computeBackoffDelayMs,
  type MarketSnapshot,
  type NormalizedMarketEvent,
  type RealtimeInterval,
} from '@/src/lib/market-data/realtime';
import { buildRealtimeLabel } from './labels';
import type { MarketSelection } from './config';
import { browserSocketFactory, type RealtimeSocket, type RealtimeSocketFactory } from './realtime-socket';
import type {
  LiveCandle,
  MarketSessionKind,
  MarketUpdate,
  MarketUpdateListener,
  WebSocketMarketSource,
} from './types';

/**
 * Live market source backed by the Phase 12 Gateway.
 *
 * Connects ONLY to the Gateway (`NEXT_PUBLIC_MARKET_WS_URL`) — never to Alpaca,
 * and never with any Alpaca secret. Trade ticks fold into a client-side
 * {@link LiveBucketStore}; higher timeframes are aggregated locally so the active
 * candle updates without a refetch. Owns reconnection (exponential backoff + full
 * jitter, one attempt at a time), an application heartbeat + stale watchdog, and
 * a visibility lifecycle. `stop()` fully tears down (React Strict-Mode safe).
 *
 * Truthfulness: `REAL-TIME` / the `realtime` flag are set only while genuinely
 * connected to a live feed; a degraded (stale/reconnecting) socket downgrades to
 * `STALE`, so a stalled connection can never keep claiming real-time.
 */

export interface WebSocketMarketSourceOptions {
  symbol: string;
  url: string;
  selection?: MarketSelection;
  session?: MarketSessionKind;
  createSocket?: RealtimeSocketFactory;
  now?: () => number;
  random?: () => number;
  scheduler?: (callback: () => void, delayMs: number) => () => void;
  heartbeatMs?: number;
  staleMs?: number;
  /** End-to-end pipeline tracer. Defaults to a live, sampled console tracer. */
  tracer?: MarketTracer;
  /**
   * The signed-in reader's Supabase access token, if there is one.
   *
   * Sent to the Gateway as an opening `hello` so it can bound connections per
   * *account* rather than only per address — an address is shared by everybody
   * behind a NAT and free to rotate for anybody with a proxy pool.
   *
   * Resolved lazily, per connection, because a token expires and this source
   * outlives several of them: capturing one at construction would send a stale
   * token on every reconnect for the rest of the page's life. Returning `null`
   * is the ordinary case — stock pages are public — and changes nothing about
   * what the reader sees.
   */
  resolveAccessToken?: () => Promise<string | null>;
}

const DEFAULT_SELECTION: MarketSelection = { interval: '5m', session: 'regular', adjusted: false };
// The hot UI path needs executed trades for the header and official/corrected
// bars for the chart. Avoid subscribing this view to quote/status firehoses that
// it does not need to repaint; the Gateway still supports those channels for
// watchlists and future order-book screens.
const STOCK_DETAIL_CHANNELS = ['trades', 'bars', 'updatedBars'] as const;
const defaultScheduler = (callback: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/**
 * The session an accepted price was executed in, from the price's OWN exchange
 * timestamp in America/New_York.
 *
 * The provider's declared session is preferred when present (Finnhub states one),
 * and the timestamp classification is the authority otherwise (Alpaca does not) —
 * so this is never absent for a priced event, and never inherited from an unrelated
 * bar, quote or request parameter.
 */
function sessionOfPrice(
  priced: { timestampMs: number; session?: 'pre-market' | 'regular' | 'after-hours' | 'closed' },
): MarketUpdate['session'] {
  return priced.session ?? classifyUsEquityTimestamp(priced.timestampMs);
}

export class WebSocketMarketSourceImpl implements WebSocketMarketSource {
  readonly transport = 'websocket' as const;

  private symbol: string;
  private readonly url: string;
  private readonly createSocket: RealtimeSocketFactory;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly scheduler: (callback: () => void, delayMs: number) => () => void;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly resolveAccessToken: (() => Promise<string | null>) | null;
  private readonly tracer: MarketTracer;

  private selection: MarketSelection;
  private session: MarketSessionKind;

  private store = new LiveBucketStore();
  private readonly listeners = new Set<MarketUpdateListener>();

  private socket: RealtimeSocket | null = null;
  private state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  private running = false;
  private visible = true;
  private degraded = false;
  /**
   * A hide (`setVisible(false)`) requested while the socket is still CONNECTING
   * is deferred here rather than tearing the pending socket down mid-handshake
   * (which yields "closed before the connection is established" / code 1006). It
   * is applied once the connection resolves, or cancelled if we become visible
   * again first.
   */
  private pendingHide = false;

  private attempt = 0;
  private reconnectPending = false;
  private nextReconnectAt = 0;
  private cancelReconnect: (() => void) | null = null;
  private cancelHeartbeat: (() => void) | null = null;
  private lastMessageAt = 0;

  private feed: string | null = null;
  private realtime = false;

  private lastPrice: number | null = null;
  private lastPriceMs = 0;
  private lastTradeIso: string | null = null;
  private lastObservation: MarketUpdate['observation'] = null;
  private bid: number | null | undefined;
  private ask: number | null | undefined;
  private bidSize: number | null | undefined;
  private askSize: number | null | undefined;
  private lastQuoteMs = 0;
  private quoteIso: string | null | undefined;
  private halted = false;
  private haltReason: string | null | undefined;
  /**
   * The session the LAST ACCEPTED PRICE was executed in, from that price's own
   * exchange timestamp. Only the accepted-price path writes it, so it can never
   * describe a bar or a quote while the header reads it as the price's session.
   */
  private priceSession: MarketUpdate['session'] = null;

  constructor(options: WebSocketMarketSourceOptions) {
    this.symbol = options.symbol.toUpperCase();
    this.url = options.url;
    this.selection = options.selection ?? DEFAULT_SELECTION;
    this.session = options.session ?? 'regular';
    this.createSocket = options.createSocket ?? browserSocketFactory;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.staleMs = options.staleMs ?? 30_000;
    this.tracer = options.tracer ?? new MarketTracer();
    this.resolveAccessToken = options.resolveAccessToken ?? null;
  }

  get connectionState(): 'idle' | 'connecting' | 'open' | 'closed' {
    return this.state;
  }

  subscribe(listener: MarketUpdateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  isSnapshotEntitled(): boolean { return true; }

  cooldownRemainingMs(): number {
    return Math.max(0, this.nextReconnectAt - this.now());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.visible) this.open();
  }

  stop(): void {
    this.running = false;
    this.teardownSocket('source-stopped');
    this.clearReconnect();
    this.clearHeartbeat();
    this.state = 'closed';
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!this.running) return;
    if (!visible) {
      if (this.state === 'connecting' && this.socket) {
        // Do NOT tear down a socket that is still completing its handshake — that
        // is the production 1006 bug. Defer the hide until the socket opens.
        this.pendingHide = true;
        return;
      }
      // Hidden: release the socket to save resources; the coordinator may poll.
      this.teardownSocket('tab-hidden');
      this.clearReconnect();
      this.clearHeartbeat();
      this.state = 'idle';
      this.degraded = true;
      this.emit(false, 'lifecycle');
      return;
    }
    // Shown again before/after the socket resolved: cancel any deferred hide and
    // reconnect (which resubscribes) if we are not already connecting/open. The
    // coordinator reconciles a REST snapshot around this transition.
    this.pendingHide = false;
    if (this.state === 'connecting' || this.state === 'open') return;
    this.attempt = 0;
    this.open();
  }

  setSession(session: MarketSessionKind): void {
    if (this.session === session) return;
    this.session = session;
    this.emit(false, 'lifecycle');
  }

  setSelection(selection: MarketSelection): void {
    if (
      selection.interval === this.selection.interval
      && selection.session === this.selection.session
      && selection.adjusted === this.selection.adjusted
    ) return;
    this.selection = selection;
    // Aggregation is client-side, so no resubscribe is needed: re-derive the
    // active candle for the new interval from the existing 1m buckets and emit.
    this.emit(false, 'lifecycle');
  }

  /**
   * Switch the streamed instrument WITHOUT dropping the socket: unsubscribe the
   * previous symbol and subscribe the new one on the same live connection. All
   * per-symbol state (buckets, last trade/quote, halt) is reset so the previous
   * instrument's data can never leak into the new one. When the socket is not
   * open the resubscribe is deferred to the next `connected` handshake, which
   * always subscribes the current symbol.
   */
  setSymbol(symbol: string): void {
    const next = symbol.toUpperCase();
    if (next === this.symbol) return;
    const previous = this.symbol;
    if (this.state === 'open') this.sendUnsubscribe(previous);
    this.symbol = next;
    // Reset all per-symbol state: a fresh bucket store and cleared book/price so
    // the old instrument's candle or last price can never surface for the new one.
    this.store = new LiveBucketStore();
    this.lastPrice = null;
    this.lastPriceMs = 0;
    this.lastTradeIso = null;
    this.lastObservation = null;
    this.bid = undefined;
    this.ask = undefined;
    this.bidSize = undefined;
    this.askSize = undefined;
    this.lastQuoteMs = 0;
    this.quoteIso = undefined;
    this.halted = false;
    this.haltReason = undefined;
    this.priceSession = null;
    if (this.state === 'open') this.sendSubscribe();
    this.emit(false, 'lifecycle');
  }

  refresh(): Promise<void> {
    this.emit(false, 'lifecycle');
    return Promise.resolve();
  }

  /* ------------------------------- connection ------------------------------- */

  private open(): void {
    if (this.socket) return; // a live/pending socket already exists
    this.state = 'connecting';
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onOpen(() => { this.lastMessageAt = this.now(); });
    socket.onMessage((data) => this.handleMessage(data));
    socket.onClose(() => this.handleDrop());
    socket.onError(() => this.handleDrop());
  }

  private handleMessage(data: string): void {
    this.lastMessageAt = this.now();
    const frame = parseServerFrame(data);
    if (!frame) return;
    switch (frame.type) {
      case 'connected':
        this.feed = frame.feed;
        this.realtime = frame.realtime;
        this.attempt = 0;
        this.degraded = false;
        this.nextReconnectAt = 0;
        this.state = 'open';
        this.sendIdentity();
        this.sendSubscribe();
        this.startHeartbeat();
        this.emit(false, 'lifecycle');
        // A hide arrived mid-handshake: now that the socket is cleanly open we can
        // release it without tripping the "closed before established" warning.
        if (this.pendingHide && !this.visible) {
          this.pendingHide = false;
          this.teardownSocket('tab-hidden');
          this.clearReconnect();
          this.clearHeartbeat();
          this.state = 'idle';
          this.degraded = true;
          this.emit(false, 'lifecycle');
        } else {
          this.pendingHide = false;
        }
        break;
      case 'snapshot':
        this.applySnapshot(frame.snapshot);
        break;
      case 'event':
        this.applyEvent(frame.event);
        break;
      case 'limit-exceeded':
      case 'subscribed':
      case 'pong':
      case 'error':
        break;
    }
  }

  /**
   * Tell the Gateway which account this connection belongs to, when there is
   * one.
   *
   * Fire-and-forget, and deliberately *not* awaited before `sendSubscribe()`:
   * the market feed must start flowing without waiting on an auth round trip,
   * and an anonymous connection is a fully supported connection. Every failure —
   * no session, an unreadable one, a Supabase that is not configured — resolves
   * to sending nothing.
   *
   * The socket is re-checked after the await because a token read is
   * asynchronous and the connection may have been torn down in the meantime.
   */
  private sendIdentity(): void {
    const resolve = this.resolveAccessToken;
    if (!resolve) return;
    void resolve()
      .then((token) => {
        if (!token || this.state !== 'open') return;
        this.socket?.send(JSON.stringify({ type: 'hello', token }));
      })
      .catch(() => {
        // An unresolvable token is an anonymous connection, which is fine.
      });
  }

  private sendSubscribe(): void {
    this.socket?.send(JSON.stringify({ type: 'subscribe', symbols: [this.symbol], channels: [...STOCK_DETAIL_CHANNELS] }));
    console.info('[market-ws] subscribed', this.symbol);
  }

  private sendUnsubscribe(symbol: string): void {
    this.socket?.send(JSON.stringify({ type: 'unsubscribe', symbols: [symbol], channels: [...STOCK_DETAIL_CHANNELS] }));
  }

  /**
   * Seed the store from the Gateway's initial snapshot so the header shows a live
   * price and the chart shows a current 1m candle WITHOUT waiting for the next
   * trade tick. Finalized minutes are applied first so the snapshot's latest
   * trade extends the newest (current) bucket; the trade also sets the Last Price
   * and the quote sets bid/ask. Every value is real provider data. Ordering guards
   * mean a snapshot that races behind already-newer live ticks can never regress
   * the last price/quote.
   */
  private applySnapshot(snapshot: MarketSnapshot): void {
    if (snapshot.symbol !== this.symbol) return;
    const browserReceivedAtMs = this.now();
    this.tracer.trace({ stage: 'browser_market_event_received', type: 'snapshot', symbol: snapshot.symbol, browserReceivedAtMs });
    for (const bar of snapshot.bars) this.store.applyBar(bar);
    if (snapshot.trade && snapshot.trade.timestampMs >= this.lastPriceMs) {
      // Legacy Alpaca snapshots carried trade + official bars but no gateway
      // partial candle. Finnhub snapshots/cycles receive the canonical candle as
      // a separate gateway bar, so folding its trade here would double volume.
      if (snapshot.trade.provider !== 'finnhub') this.store.applyTrade(snapshot.trade);
      this.lastPrice = snapshot.trade.price;
      this.lastPriceMs = snapshot.trade.timestampMs;
      this.lastTradeIso = new Date(snapshot.trade.timestampMs).toISOString();
      const acceptedAtMs = this.now();
      this.lastObservation = {
        exchangeTimestampMs: snapshot.trade.timestampMs,
        gatewayReceivedAtMs: snapshot.trade.gatewayReceivedAtMs ?? null,
        browserReceivedAtMs,
        acceptedAtMs,
      };
      this.priceSession = sessionOfPrice(snapshot.trade);
      this.tracer.trace({
        stage: 'price_header_updated', symbol: snapshot.symbol, price: snapshot.trade.price,
        ...this.lastObservation,
        latencyMs: acceptedAtMs - snapshot.trade.timestampMs,
      });
    }
    if (snapshot.quote && snapshot.quote.timestampMs >= this.lastQuoteMs) {
      this.lastQuoteMs = snapshot.quote.timestampMs;
      this.bid = snapshot.quote.bidPrice;
      this.ask = snapshot.quote.askPrice;
      this.bidSize = snapshot.quote.bidSize;
      this.askSize = snapshot.quote.askSize;
      this.quoteIso = new Date(snapshot.quote.timestampMs).toISOString();
    }
    // A seeded run of canonical minutes is a good moment for the chart to compute
    // indicators/S-R once; intra-bar ticks after this stay cheap.
    this.emit(snapshot.bars.length > 0, 'snapshot');
  }

  private applyEvent(event: NormalizedMarketEvent): void {
    if (event.symbol !== this.symbol) return;
    const browserReceivedAtMs = this.now();
    this.tracer.trace({
      stage: 'browser_market_event_received', type: event.kind, symbol: event.symbol,
      exchangeTimestampMs: event.timestampMs, gatewayReceivedAtMs: event.gatewayReceivedAtMs,
      browserReceivedAtMs,
    });
    let barFinalized = false;
    switch (event.kind) {
      case 'trade': {
        if (event.provider !== 'finnhub') this.store.applyTrade(event);
        if (event.timestampMs >= this.lastPriceMs) {
          this.lastPrice = event.price;
          this.lastPriceMs = event.timestampMs;
          this.lastTradeIso = new Date(event.timestampMs).toISOString();
          const acceptedAtMs = this.now();
          this.lastObservation = {
            exchangeTimestampMs: event.timestampMs,
            gatewayReceivedAtMs: event.gatewayReceivedAtMs ?? null,
            browserReceivedAtMs,
            acceptedAtMs,
          };
          this.priceSession = sessionOfPrice(event);
          // The header's Last Price is driven by trades; trace only the accepted
          // (newer-than-last) update so an out-of-order tick can't fake a change.
          this.tracer.trace({
            stage: 'price_header_updated', symbol: event.symbol, price: event.price,
            ...this.lastObservation,
            latencyMs: acceptedAtMs - event.timestampMs,
          });
        }
        break;
      }
      case 'quote': {
        // Ignore an out-of-order quote so bid/ask never regress to older data.
        if (event.timestampMs < this.lastQuoteMs) return;
        this.lastQuoteMs = event.timestampMs;
        this.bid = event.bidPrice;
        this.ask = event.askPrice;
        this.bidSize = event.bidSize;
        this.askSize = event.askSize;
        this.quoteIso = new Date(event.timestampMs).toISOString();
        break;
      }
      case 'bar': {
        // An official/updated 1m bar is only emitted after the minute closes, so
        // it always finalizes that bucket — the chart may recompute heavy S/R.
        this.store.applyBar(event);
        barFinalized = event.finalized !== false;
        break;
      }
      case 'status': {
        this.halted = event.halted;
        this.haltReason = event.reasonMessage ?? event.statusMessage ?? null;
        break;
      }
    }
    this.emit(barFinalized, event.kind);
  }

  private handleDrop(): void {
    // The socket already closed/errored; null it out without a second wire close.
    this.teardownSocket();
    this.clearHeartbeat();
    if (!this.running || !this.visible) {
      this.state = 'idle';
      return;
    }
    this.degraded = true;
    this.state = 'connecting';
    this.emit(false, 'lifecycle');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectPending) return; // no overlapping reconnects
    this.reconnectPending = true;
    const delay = computeBackoffDelayMs(this.attempt, { random: this.random });
    this.attempt += 1;
    this.nextReconnectAt = this.now() + delay;
    this.cancelReconnect = this.scheduler(() => {
      this.reconnectPending = false;
      this.cancelReconnect = null;
      if (this.running && this.visible) this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0) return;
    this.clearHeartbeat();
    const tick = (): void => {
      if (!this.running || this.state !== 'open') return;
      if (this.now() - this.lastMessageAt >= this.staleMs) {
        // Silent socket: treat as stale and recycle through the reconnect path.
        this.degraded = true;
        this.socket?.close('stale-watchdog');
        this.handleDrop();
        return;
      }
      this.socket?.send(JSON.stringify({ type: 'ping', t: this.now() }));
      this.cancelHeartbeat = this.scheduler(tick, this.heartbeatMs);
    };
    this.cancelHeartbeat = this.scheduler(tick, this.heartbeatMs);
  }

  private teardownSocket(reason?: string): void {
    if (this.socket) {
      this.socket.close(reason);
      this.socket = null;
    }
  }

  private clearReconnect(): void {
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.reconnectPending = false;
    this.nextReconnectAt = 0;
  }

  private clearHeartbeat(): void {
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
  }

  /* --------------------------------- emit ---------------------------------- */

  private activeCandle(): LiveCandle | null {
    const interval = this.selection.interval;
    // Daily/weekly history remains Polygon-owned. The live source exposes its
    // canonical current 1m delta so the chart bridge can merge it into only the
    // current historical bucket without replacing the historical series.
    if (interval === '1D' || interval === 'Week') return this.store.activeCandle('1m');
    if (!isRealtimeInterval(interval)) return null;
    return this.store.activeCandle(interval as RealtimeInterval);
  }

  private emit(barFinalized: boolean, eventKind: MarketUpdate['eventKind'] = 'lifecycle'): void {
    const hasPrice = this.lastPrice !== null && isTradeablePrice(this.lastPrice);
    const receivedAt = new Date(this.now()).toISOString();
    const label = buildRealtimeLabel({
      realtime: this.realtime,
      feed: this.feed,
      hasPrice,
      exchangeTimestamp: this.lastTradeIso,
      receivedAt,
      degraded: this.degraded || this.state !== 'open',
    });
    const update: MarketUpdate = {
      symbol: this.symbol,
      price: hasPrice ? this.lastPrice : null,
      quote: null,
      candle: this.activeCandle(),
      label,
      error: null,
      observation: this.lastObservation,
      bid: this.bid,
      ask: this.ask,
      bidSize: this.bidSize,
      askSize: this.askSize,
      quoteTimestamp: this.quoteIso,
      halted: this.halted,
      haltReason: this.haltReason,
      // The session of the PRICE above, never `this.selection.session`: the chart
      // selection is a request parameter, and using it here made every extended
      // print look like a regular-session price to the header.
      session: hasPrice ? this.priceSession : null,
      barFinalized,
      eventKind,
      // The socket lifecycle at emit time. The coordinator uses this to keep a
      // genuinely OPEN-but-quiet socket in a healthy "awaiting data" state instead
      // of degrading to a REST/"connection error" fallback before the first tick.
      streamStatus: this.state,
    };
    for (const listener of this.listeners) listener(update);
  }
}
