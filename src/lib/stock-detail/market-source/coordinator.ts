import { PollingMarketSource } from './polling-source';
import { WebSocketMarketSourceImpl } from './websocket-source';
import type { RealtimeSocketFactory } from './realtime-socket';
import type { MarketSelection } from './config';
import type {
  ConnectionStatus,
  MarketSessionKind,
  MarketSource,
  MarketSourceTransport,
  MarketUpdate,
  MarketUpdateListener,
  PollingCadence,
} from './types';

/**
 * Coordinates the live {@link WebSocketMarketSourceImpl} with the REST
 * {@link PollingMarketSource} behind one {@link MarketSource} facade.
 *
 * State machine:
 *   starting → (WS live)  → live   [REST polling stopped]
 *   live     → (WS drops) → grace  [short grace before falling back]
 *   grace    → (timeout)  → rest   [REST polling every 15–30s, open symbol only]
 *   rest/grace → (WS live) → live  [reconcile one REST snapshot, then stop polling]
 *
 * Guarantees: exactly one transport drives the forwarded updates at a time (no
 * overlap); WS-live forwards only the live stream and stops polling; a degraded
 * WS never keeps the "Real-time" label because the WS source downgrades it; and
 * cached/previous-close values only ever reach the UI via the REST path, which
 * never sets the realtime flag.
 */

type CoordinatorState = 'starting' | 'live' | 'grace' | 'rest';

export interface CoordinatedMarketSourceOptions {
  symbol: string;
  /** REST transport used by the polling source and the reconcile snapshot. */
  transport: MarketSourceTransport;
  wsUrl: string;
  session: MarketSessionKind;
  selection: MarketSelection;
  /** Fallback cadence while WS is down. Requirement: 15–30s regular. */
  restCadence?: PollingCadence;
  /** Grace period after a WS drop before REST fallback engages. */
  graceMs?: number;
  createSocket?: RealtimeSocketFactory;
  scheduler?: (callback: () => void, delayMs: number) => () => void;
  now?: () => number;
  random?: () => number;
  /**
   * Resolves the reader's Supabase access token for the Gateway `hello`. Passed
   * straight through; see {@link WebSocketMarketSourceOptions.resolveAccessToken}.
   */
  resolveAccessToken?: () => Promise<string | null>;
  /** Test seams: inject fake sources instead of the real WS/REST implementations. */
  createWsSource?: () => MarketSource;
  createPollSource?: () => MarketSource;
}

const DEFAULT_REST_CADENCE: PollingCadence = { regularMs: 20_000, closedMs: 60_000 };
const defaultScheduler = (callback: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

export class CoordinatedMarketSource implements MarketSource {
  readonly transport = 'websocket' as const;

  private readonly ws: MarketSource;
  private readonly poll: MarketSource;
  private readonly listeners = new Set<MarketUpdateListener>();
  private readonly scheduler: (callback: () => void, delayMs: number) => () => void;
  private readonly graceMs: number;

  private state: CoordinatorState = 'starting';
  private running = false;
  private visible = true;
  private pollingActive = false;
  /**
   * Whether the live socket is currently OPEN (handshake completed, subscribed),
   * per the WS source's own `streamStatus`. Distinct from `state === 'live'`,
   * which additionally requires a priced real-time tick. An open-but-quiet socket
   * is healthy (`awaiting-data`), never a "connection error". Stays false when the
   * emitter does not report a `streamStatus` (e.g. injected test sources).
   */
  private wsStreamOpen = false;
  /** True once a genuine live tick (`label.realtime`) has been forwarded. */
  private sawLiveTick = false;
  private cancelGrace: (() => void) | null = null;
  private unsubWs: (() => void) | null = null;
  private unsubPoll: (() => void) | null = null;

  constructor(private readonly options: CoordinatedMarketSourceOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.graceMs = options.graceMs ?? 4_000;
    this.ws = options.createWsSource?.() ?? new WebSocketMarketSourceImpl({
      symbol: options.symbol,
      url: options.wsUrl,
      selection: options.selection,
      session: options.session,
      createSocket: options.createSocket,
      now: options.now,
      random: options.random,
      scheduler: options.scheduler,
      resolveAccessToken: options.resolveAccessToken,
    });
    this.poll = options.createPollSource?.() ?? new PollingMarketSource({
      symbol: options.symbol,
      transport: options.transport,
      session: options.session,
      cadence: options.restCadence ?? DEFAULT_REST_CADENCE,
      aggregateInterval: options.selection.interval,
      aggregateSession: options.selection.session,
      aggregateAdjusted: options.selection.adjusted,
      now: options.now,
    });
  }

  subscribe(listener: MarketUpdateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = 'starting';
    this.unsubWs = this.ws.subscribe((update) => this.onWsUpdate(update));
    this.unsubPoll = this.poll.subscribe((update) => this.onPollUpdate(update));
    this.ws.setVisible(this.visible);
    this.ws.start();
    // Safety net: if WS never reaches "live", fall back after the grace period.
    this.startGrace();
  }

  stop(): void {
    this.running = false;
    this.cancelGraceTimer();
    this.unsubWs?.(); this.unsubWs = null;
    this.unsubPoll?.(); this.unsubPoll = null;
    this.ws.stop();
    this.poll.stop();
    this.pollingActive = false;
    this.state = 'starting';
    this.wsStreamOpen = false;
    this.sawLiveTick = false;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.ws.setVisible(visible);
    if (this.pollingActive) this.poll.setVisible(visible);
  }

  setSession(session: MarketSessionKind): void {
    this.ws.setSession(session);
    this.poll.setSession(session);
  }

  setSelection(selection: MarketSelection): void {
    // Both sources follow the selection so a fallback mid-view stays consistent.
    (this.ws as MarketSource & { setSelection?: (s: MarketSelection) => void }).setSelection?.(selection);
    (this.poll as MarketSource & { setSelection?: (s: MarketSelection) => void }).setSelection?.(selection);
  }

  /**
   * Follow a symbol change on the SAME connection: both transports resubscribe in
   * place (the WS unsubscribes the old symbol and subscribes the new one on the
   * live socket; the REST loop retargets) so the shared socket is never closed and
   * reopened just because the viewed instrument changed.
   */
  setSymbol(symbol: string): void {
    (this.ws as MarketSource & { setSymbol?: (s: string) => void }).setSymbol?.(symbol);
    (this.poll as MarketSource & { setSymbol?: (s: string) => void }).setSymbol?.(symbol);
  }

  refresh(): Promise<void> {
    return this.state === 'live' ? this.ws.refresh() : this.poll.refresh();
  }

  cooldownRemainingMs(): number {
    return this.state === 'live' ? this.ws.cooldownRemainingMs() : this.poll.cooldownRemainingMs();
  }

  isSnapshotEntitled(): boolean {
    return this.poll.isSnapshotEntitled();
  }

  /* ------------------------------ state machine ----------------------------- */

  private onWsUpdate(update: MarketUpdate): void {
    // Track the socket lifecycle independently of tick delivery. Only update the
    // flag when the emitter actually reports one, so injected/legacy sources that
    // omit `streamStatus` keep the previous (state-machine-driven) behaviour.
    if (update.streamStatus !== undefined) this.wsStreamOpen = update.streamStatus === 'open';
    const live = update.label.realtime === true;
    if (live) {
      this.sawLiveTick = true;
      if (this.state !== 'live') this.enterLive();
      this.forward(update);
      return;
    }
    // The socket is genuinely OPEN and subscribed but no priced tick has arrived
    // yet (a quiet / low-volume market). This is a healthy connection, so treat it
    // exactly like the live path for transport arbitration — stop any REST
    // fallback and cancel the grace safety net — WITHOUT claiming a real-time tick.
    // The connection status reports `awaiting-data` (see connectionStatus) until
    // the first tick, and the last accepted (fallback) price keeps showing.
    if (this.wsStreamOpen) {
      if (this.state !== 'live') this.enterLive();
      this.forward(update);
      return;
    }
    // The socket is NOT open (connecting/dropped/idle). Leave "live" for the grace
    // path so a real drop falls back to REST after the grace period.
    if (this.state === 'live' || this.state === 'starting') {
      if (this.state === 'live') this.state = 'grace';
      this.startGrace();
    }
    // While no REST data is flowing yet, surface the degraded WS state so the UI
    // can show "reconnecting" instead of freezing.
    if (!this.pollingActive) this.forward(update);
  }

  private onPollUpdate(update: MarketUpdate): void {
    // REST output is authoritative only while we are actually in fallback.
    if (this.state === 'rest' || this.state === 'grace') this.forward(update);
  }

  private enterLive(): void {
    this.cancelGraceTimer();
    if (this.pollingActive) {
      // Reconcile one REST snapshot against the resumed stream, then stop polling.
      void this.poll.refresh().finally(() => this.poll.stop());
      this.pollingActive = false;
    }
    this.state = 'live';
  }

  private startGrace(): void {
    if (this.state === 'rest' || this.cancelGrace) return; // no overlapping timers
    this.cancelGrace = this.scheduler(() => {
      this.cancelGrace = null;
      if (!this.running || this.state === 'live') return;
      this.state = 'rest';
      if (!this.pollingActive) {
        this.poll.setVisible(this.visible);
        this.poll.start();
        this.pollingActive = true;
      }
    }, this.graceMs);
  }

  private cancelGraceTimer(): void {
    this.cancelGrace?.();
    this.cancelGrace = null;
  }

  /**
   * Derives the typed connection lifecycle from the coordinator's own state
   * machine. Purely a status signal for the header; it never influences which
   * price/timestamp is forwarded. A paused (hidden/offline) or stopped source is
   * `disconnected` regardless of the last transport state.
   */
  private connectionStatus(): ConnectionStatus {
    if (!this.running || !this.visible) return 'disconnected';
    // `live` means the WS is our authoritative source. It is reached either by a
    // genuine priced tick (`sawLiveTick` → `connected`) or by a healthy open
    // socket still awaiting its first tick (`awaiting-data`). A REST 403 never
    // reaches here: REST failures flow through onPollUpdate and can only move us
    // to `grace`/`rest`, and only while the socket is NOT open.
    if (this.state === 'live') return this.sawLiveTick ? 'connected' : 'awaiting-data';
    switch (this.state) {
      case 'starting': return 'connecting';
      case 'grace': return 'reconnecting';
      case 'rest': return 'degraded';
    }
  }

  private forward(update: MarketUpdate): void {
    // Attach the connection lifecycle without mutating the source's update (the
    // price/timestamp/freshness carried by `update` are forwarded untouched).
    const withStatus: MarketUpdate = { ...update, connectionState: this.connectionStatus() };
    for (const listener of this.listeners) listener(withStatus);
  }
}

/**
 * Build the market source for the Stock Detail header/chart. Returns the
 * coordinated WS+REST source when a Gateway URL is configured, otherwise the
 * existing REST-only {@link PollingMarketSource} (unchanged behaviour).
 */
/**
 * The reader's access token, read from the browser's own Supabase session.
 *
 * Imported lazily so this module — which is also loaded on paths that never open
 * a socket — does not drag the auth client into their bundle, and so a Supabase
 * that is not configured is a resolved `null` rather than an import-time throw.
 * Every failure is `null`, which is a fully supported anonymous connection: the
 * stock pages this runs on are public.
 */
async function browserAccessToken(): Promise<string | null> {
  try {
    const { createClient } = await import('@/src/lib/supabase/client');
    const client = createClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export function createMarketSource(options: {
  symbol: string;
  transport: MarketSourceTransport;
  session: MarketSessionKind;
  selection: MarketSelection;
  cadence: PollingCadence;
  wsUrl: string | null;
  createSocket?: RealtimeSocketFactory;
  /** Test seam; production resolves the token from the browser session. */
  resolveAccessToken?: () => Promise<string | null>;
}): MarketSource {
  if (options.wsUrl) {
    return new CoordinatedMarketSource({
      symbol: options.symbol,
      transport: options.transport,
      wsUrl: options.wsUrl,
      session: options.session,
      selection: options.selection,
      createSocket: options.createSocket,
      resolveAccessToken: options.resolveAccessToken ?? browserAccessToken,
    });
  }
  return new PollingMarketSource({
    symbol: options.symbol,
    transport: options.transport,
    session: options.session,
    cadence: options.cadence,
    aggregateInterval: options.selection.interval,
    aggregateSession: options.selection.session,
    aggregateAdjusted: options.selection.adjusted,
  });
}
