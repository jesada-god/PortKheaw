'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acquireMarketConnection,
  buildAcceptedResource,
  candidateFromUpdate,
  createBrowserMarketTransport,
  freshnessFromMode,
  labelFromAccepted,
  resolveAcceptedPrice,
  selectionKeyOf,
  type AcceptedPriceCandidate,
  type ConnectionStatus,
  type LiveCandle,
  type ManagedMarketSource,
  type MarketDataLabel,
  type MarketSelection,
  type MarketSessionKind,
} from '@/src/lib/stock-detail/market-source';
import { resolvePublicMarketWsUrl } from '@/src/lib/market-data/realtime';
import type { MarketDataApiError } from '@/src/lib/market-data/types';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';
import type { MarketUpdate } from '@/src/lib/stock-detail/market-source';
import { realtimeUpdatePolicy } from './realtime-performance';

/** Regular-session cadence is 12s (inside the mandated 10–15s window); closed is slower. */
const CADENCE = { regularMs: 12_000, closedMs: 60_000 };

export type CanonicalLiveUpdateSink = (update: MarketUpdate) => void;

export interface UseMarketSourceOptions {
  symbol: string;
  initialQuote: StockDetailQuoteResource;
  session: MarketSessionKind;
  /**
   * The chart's current selection. The single {@link PollingMarketSource} follows
   * it so the header price and the chart's active candle derive from one accepted
   * event. Defaults to 5m/regular (the header's current-price proxy) when the
   * chart is not driving a selection.
   */
  selection?: MarketSelection;
  /**
   * The newest completed bar the chart currently displays for this symbol +
   * selection, as a history-fallback candidate. Used only when neither an
   * entitled snapshot nor an accepted live aggregate is available (e.g. a
   * Daily/Week/Month header, or a snapshot-403 selection). Pass null while the
   * chart has no result so a stale bar can never linger.
   */
  historyFallback?: AcceptedPriceCandidate | null;
  active: boolean;
  online: boolean;
  enabled: boolean;
  /** Server-created snapshot time used by both SSR and the first client render. */
  initialReceivedAt?: string;
  /** Disable the live stream for a view that explicitly requires REST-only data. */
  allowWebSocket?: boolean;
  /**
   * Imperative price sink owned by the header. Finnhub trade ticks call this ref
   * directly instead of scheduling a React render for every trade.
   */
  transientPriceSinkRef?: {
    current: ((price: number, metadata?: {
      asOf: string | null;
      feed: string | null;
      session?: string | null;
    }) => void) | null;
  };
  /** Imperative chart hot path. Receives the same accepted gateway update. */
  liveUpdateSinkRef?: { current: CanonicalLiveUpdateSink | null };
}

export interface UseMarketSourceResult {
  quoteResource: StockDetailQuoteResource;
  quoteLoading: boolean;
  quoteRetryAt: number;
  dataLabel: MarketDataLabel | null;
  /**
   * The latest accepted active candle from the shared source, or null before the
   * first tick. This is the single source of truth the chart consumes so the
   * header price, chart current candle and S/R distance all derive from one
   * accepted market event.
   */
  liveCandle: LiveCandle | null;
  /**
   * The single accepted price shared by the header, the chart price line and the
   * (future) S/R currentPrice, or null when unavailable. Equal to
   * `quoteResource.data?.price` for the accepted source.
   */
  acceptedPrice: number | null;
  /**
   * Top-of-book and halt state from the live stream (null/false on REST paths).
   * Shown separately from Last Price in the header.
   */
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  quoteTimestamp: string | null;
  halted: boolean;
  haltReason: string | null;
  /**
   * True on the most recent emission that finalized a bar (a new bucket opened or
   * an official/updated bar closed one). The chart gates heavy S/R + indicator
   * recomputation on this so intra-bar ticks stay cheap.
   */
  barFinalized: boolean;
  /**
   * Live-connection lifecycle from the WS coordinator, for the header's status
   * indicator only. `null` on a REST-only deployment (no Gateway URL) so it never
   * shows a "reconnecting" pill. Changing it NEVER triggers a refetch.
   */
  connectionState: ConnectionStatus | null;
  liveSession: string | null;
  refresh: () => void;
}

interface LiveMeta {
  symbol: string;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  quoteTimestamp: string | null;
  halted: boolean;
  haltReason: string | null;
  barFinalized: boolean;
  session: string | null;
}

const EMPTY_META: LiveMeta = {
  symbol: '', bid: null, ask: null, bidSize: null, askSize: null,
  quoteTimestamp: null, halted: false, haltReason: null, barFinalized: false,
  session: null,
};

/**
 * Drives the Stock Detail header/price from a transport-agnostic
 * {@link PollingMarketSource}: entitlement-aware REST polling that pauses when
 * hidden/offline, honors rate limits and never claims real-time data.
 *
 * The displayed price follows one deterministic accepted-event policy: the
 * newest verified exchange timestamp wins, with snapshot → aggregate → history
 * trust order breaking equal/missing timestamp ties. This keeps the header,
 * chart price line and S/R currentPrice on the same event without allowing an
 * older snapshot to contradict a newer Polygon candle. A selection change isolates
 * aggregate candidates by selection key so sessions/intervals never mix.
 */
const DEFAULT_SELECTION: MarketSelection = { interval: '5m', session: 'regular', adjusted: false };

/**
 * Client-only Gateway configuration.
 *
 * These MUST be written as direct, static `process.env.NEXT_PUBLIC_*` member
 * expressions. Next.js only inlines a `NEXT_PUBLIC_*` value into the browser
 * bundle where that literal token appears in the source — a dynamic read
 * (`process.env[key]`, destructuring `process.env`, or reading through a passed
 * `process.env` object inside another module) is NOT inlined and comes back
 * `undefined` in the browser. That is exactly what silently disabled the live
 * WebSocket in production (the Gateway URL resolved to `null` → REST-only, so no
 * socket was ever opened). Resolving the value here and handing it to
 * {@link resolvePublicMarketWsUrl} explicitly keeps the inlined literal on the
 * static path. The URL is public (never a secret).
 */
const PUBLIC_MARKET_WS_URL = process.env.NEXT_PUBLIC_MARKET_WS_URL?.trim() || null;
const PUBLIC_APP_ENV = process.env.NEXT_PUBLIC_APP_ENV?.trim() || undefined;

export function useMarketSource(options: UseMarketSourceOptions): UseMarketSourceResult {
  const { symbol, initialQuote, session, active, online, enabled } = options;
  const initialReceivedAt = options.initialReceivedAt
    ?? initialQuote.freshness.asOf
    ?? '1970-01-01T00:00:00.000Z';
  const selection = options.selection ?? DEFAULT_SELECTION;
  const selectionKey = selectionKeyOf(selection);
  const historyFallback = options.historyFallback ?? null;

  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteRetryAt, setQuoteRetryAt] = useState(0);
  const [lastError, setLastError] = useState<MarketDataApiError | null>(null);
  // Last-good snapshot (symbol-scoped: the snapshot is the selection-independent
  // current price) and last-good aggregate (symbol + selection scoped: an
  // aggregate bucket belongs to exactly one interval/session). Both are updated
  // only on a priced success, so a transient blip keeps the last verified value.
  const [snapState, setSnapState] = useState<{ symbol: string; candidate: AcceptedPriceCandidate; resource: StockDetailQuoteResource } | null>(null);
  const [aggState, setAggState] = useState<{ symbol: string; selectionKey: string; candidate: AcceptedPriceCandidate } | null>(null);
  // The active candle, tagged with symbol + selection so a symbol/selection switch
  // never surfaces the previous instrument's or selection's bucket.
  const [candleState, setCandleState] = useState<{ symbol: string; selectionKey: string; candle: LiveCandle } | null>(null);
  const [liveMeta, setLiveMeta] = useState<LiveMeta>(EMPTY_META);
  // Latest connection lifecycle forwarded by the WS coordinator (null until the
  // first coordinator emission, and always null on the REST-only path). Setting
  // it to an unchanged value is a React no-op, so quiet ticks stay quiet.
  const [connectionState, setConnectionState] = useState<ConnectionStatus | null>(null);

  const sourceRef = useRef<ManagedMarketSource | null>(null);
  const symUpper = symbol.toUpperCase();
  const transport = useMemo(() => createBrowserMarketTransport(), []);
  // Public Gateway URL (null → REST-only). Built from the statically-inlined
  // client config above and validated (wss + non-loopback in production) here.
  // `process.env.NODE_ENV` is likewise a direct static access so Next inlines it.
  const wsUrl = useMemo(
    () => options.allowWebSocket === false
      ? null
      : resolvePublicMarketWsUrl({
        NEXT_PUBLIC_MARKET_WS_URL: PUBLIC_MARKET_WS_URL ?? undefined,
        NEXT_PUBLIC_APP_ENV: PUBLIC_APP_ENV,
        NODE_ENV: process.env.NODE_ENV,
      }),
    [options.allowWebSocket],
  );
  // Kept current so the subscribe callback (registered once) tags every emission
  // with the source's live selection at emit time.
  const selectionKeyRef = useRef(selectionKey);
  useEffect(() => { selectionKeyRef.current = selectionKey; }, [selectionKey]);
  // Skip a live-meta rerender when nothing the header/chart reads has changed:
  // an intra-bar trade with an unchanged quote and no finalized bar is a no-op.
  const metaKeyRef = useRef('');
  // Once live provenance has rendered, repeated trade ticks stay on the
  // transient DOM path until a snapshot/bar needs a real React commit.
  const hasCommittedLivePriceRef = useRef(false);
  const hasCommittedLiveCandleRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    // Temporary, secret-free production diagnostic: confirms whether a Gateway URL
    // was inlined into the client bundle (true) or the source is REST-only (false).
    console.info('[market-ws] configured', Boolean(wsUrl));
    // Acquire the tab-shared connection instead of building a fresh source here.
    // A Strict-Mode double-invoke (mount → cleanup → remount) or a transient
    // re-render releases and re-acquires within the manager's grace window, so the
    // SAME live socket is reused and never torn down mid-handshake (the 1006 bug).
    // `symbol` is intentionally NOT a dependency: a symbol change resubscribes on
    // the same socket via the dedicated `setSymbol` effect below.
    const handle = acquireMarketConnection({
      wsUrl,
      symbol,
      transport,
      session,
      selection,
      cadence: CADENCE,
      visible: active && online,
    });
    const source = handle.source;
    sourceRef.current = source;
    let pendingCandidate: { symbol: string; selectionKey: string; candidate: AcceptedPriceCandidate } | null = null;
    let candidateTimer: ReturnType<typeof setTimeout> | null = null;
    const commitPendingCandidate = () => {
      candidateTimer = null;
      if (!pendingCandidate) return;
      setAggState(pendingCandidate);
      pendingCandidate = null;
    };
    const unsubscribe = source.subscribe((update) => {
      const tag = selectionKeyRef.current;
      // Tag by the event's own symbol so a stray emit from a just-superseded
      // instrument can never surface for the current one.
      const updateSymbol = update.symbol.toUpperCase();
      setLastError(update.error);
      const candidate = candidateFromUpdate(update);
      const policy = realtimeUpdatePolicy(update, hasCommittedLivePriceRef.current);
      if (update.candle && update.label.realtime) options.liveUpdateSinkRef?.current?.(update);
      if (policy.transientPrice && update.price !== null) {
        // Direct DOM update via StockPriceHeader's ref-backed sink. This is the
        // hot path: no useState, no parent render, no chart reconciliation.
        // Metadata keeps the cached observation tied to its exchange time/feed.
        options.transientPriceSinkRef?.current?.(update.price, {
          asOf: update.label.exchangeTimestamp,
          feed: update.label.feed ?? null,
          session: update.session ?? null,
        });
      }
      const commitMarketState = policy.commitMarketState
        || Boolean(update.candle && !hasCommittedLiveCandleRef.current);
      if (commitMarketState) {
        if (candidate?.source === 'snapshot' && update.quote) {
          setSnapState({
            symbol: updateSymbol,
            candidate,
            resource: {
              data: update.quote,
              freshness: freshnessFromMode(candidate.mode, candidate.exchangeTimestamp),
              provider: candidate.provider,
              reason: null,
              error: null,
              fallbackLabel: null,
            },
          });
        } else if (candidate?.source === 'aggregate-fallback') {
          setAggState({ symbol: updateSymbol, selectionKey: tag, candidate });
        }
        // Snapshot / official bar commits feed the chart. Its series layer uses
        // update() for the latest bar and never replays setData() per tick.
        if (update.candle) {
          setCandleState({ symbol: updateSymbol, selectionKey: tag, candle: update.candle });
          if (update.label.realtime) hasCommittedLiveCandleRef.current = true;
        }
        if (update.label.realtime && candidate) hasCommittedLivePriceRef.current = true;
      }
      if (!commitMarketState && candidate?.realtime) {
        // Keep canonical consumers (change %, S/R distance, options underlying)
        // fresh without rendering the React tree for every wire tick. The header
        // and chart have already updated imperatively from this exact update.
        pendingCandidate = { symbol: updateSymbol, selectionKey: tag, candidate };
        if (candidateTimer === null) candidateTimer = setTimeout(commitPendingCandidate, 100);
      }
      // Capture top-of-book / halt state; only rerender when something the header
      // or chart actually reads has changed (or a bar just finalized).
      const nextMeta: LiveMeta = {
        symbol: updateSymbol,
        bid: update.bid ?? null,
        ask: update.ask ?? null,
        bidSize: update.bidSize ?? null,
        askSize: update.askSize ?? null,
        quoteTimestamp: update.quoteTimestamp ?? null,
        halted: update.halted ?? false,
        haltReason: update.haltReason ?? null,
        barFinalized: update.barFinalized ?? false,
        session: update.session ?? null,
      };
      const metaKey = `${nextMeta.bid}|${nextMeta.ask}|${nextMeta.bidSize}|${nextMeta.askSize}|${nextMeta.halted}|${nextMeta.haltReason}|${nextMeta.session}`;
      if (nextMeta.barFinalized || metaKey !== metaKeyRef.current) {
        metaKeyRef.current = metaKey;
        setLiveMeta(nextMeta);
      }
      // Status-only signal: never feeds price/timestamp/freshness and never
      // schedules a fetch. `undefined` (REST-only source) collapses to null.
      setConnectionState(update.connectionState ?? null);
      setQuoteLoading(false);
      const remaining = source.cooldownRemainingMs();
      setQuoteRetryAt(remaining > 0 ? Date.now() + remaining : 0);
    });
    return () => {
      unsubscribe();
      if (candidateTimer !== null) clearTimeout(candidateTimer);
      // Release the subscriber; the manager tears the socket down only if no other
      // subscriber remains after the grace period (Strict-Mode/re-render safe).
      handle.release('effect-cleanup');
      sourceRef.current = null;
    };
    // `symbol`/`session`/`selection`/visibility are applied via dedicated effects
    // so those changes never re-acquire the connection (which would drop the live
    // socket + active candle). They are read once here only for the initial config.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, enabled, wsUrl]);

  useEffect(() => { sourceRef.current?.setSession(session); }, [session]);
  useEffect(() => { sourceRef.current?.setVisible(active && online); }, [active, online]);
  // Reconfigure the single loop to follow the chart selection: abort the previous
  // generation, clear the incompatible candle, start exactly one new loop.
  useEffect(() => {
    sourceRef.current?.setSelection?.(selection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  // Follow a symbol change on the SAME socket: unsubscribe the old symbol and
  // subscribe the new one in place (no socket close/reopen).
  useEffect(() => {
    hasCommittedLivePriceRef.current = false;
    hasCommittedLiveCandleRef.current = false;
    sourceRef.current?.setSymbol?.(symUpper);
  }, [symUpper]);

  // The candidates valid for the CURRENT symbol + selection. The snapshot is
  // symbol-scoped; the aggregate and history bar are selection-scoped, so a
  // superseded selection's aggregate/bar can never enter the current price.
  const snapshotResource = snapState?.symbol === symUpper ? snapState.resource : null;
  const snapCandidate = snapState?.symbol === symUpper ? snapState.candidate : null;
  const aggCandidate = aggState?.symbol === symUpper && aggState.selectionKey === selectionKey ? aggState.candidate : null;
  const historyCandidate = historyFallback && historyFallback.source === 'history-fallback' ? historyFallback : null;

  const accepted = useMemo(
    () => resolveAcceptedPrice([snapCandidate, aggCandidate, historyCandidate]),
    [snapCandidate, aggCandidate, historyCandidate],
  );

  const baseQuote = snapshotResource?.data ?? initialQuote.data;
  const quoteResource = useMemo<StockDetailQuoteResource>(() => {
    if (accepted) return buildAcceptedResource({ accepted, snapshotResource, baseQuote, symbol });
    // Nothing accepted yet: surface the last verified snapshot (or the initial
    // resource), annotated with any live error so the header can offer a retry.
    const base = snapshotResource ?? initialQuote;
    if (lastError) return { ...base, reason: `${lastError.code}: ${lastError.message}`, error: lastError };
    return base;
  }, [accepted, snapshotResource, baseQuote, symbol, lastError, initialQuote]);

  const dataLabel = useMemo(
    () => labelFromAccepted(accepted, initialReceivedAt),
    [accepted, initialReceivedAt],
  );

  const refresh = useCallback(() => {
    const source = sourceRef.current;
    if (!source) return;
    if (source.cooldownRemainingMs() > 0) {
      setQuoteRetryAt(Date.now() + source.cooldownRemainingMs());
      return;
    }
    setQuoteLoading(true);
    void source.refresh().finally(() => setQuoteLoading(false));
  }, []);

  const liveCandle = candleState
    && candleState.symbol === symUpper
    && candleState.selectionKey === selectionKey
    ? candleState.candle
    : null;

  // Live meta is symbol-scoped; a stale instrument's book never leaks through.
  const meta = liveMeta.symbol === symUpper ? liveMeta : EMPTY_META;

  return {
    quoteResource,
    quoteLoading,
    quoteRetryAt,
    dataLabel,
    liveCandle,
    acceptedPrice: accepted?.price ?? quoteResource.data?.price ?? null,
    bid: meta.bid,
    ask: meta.ask,
    bidSize: meta.bidSize,
    askSize: meta.askSize,
    quoteTimestamp: meta.quoteTimestamp,
    halted: meta.halted,
    haltReason: meta.haltReason,
    barFinalized: meta.barFinalized,
    // REST-only (no Gateway URL) never surfaces a connection lifecycle, so the
    // header can never show a "reconnecting" pill without a real socket.
    connectionState: wsUrl ? connectionState : null,
    liveSession: meta.session,
    refresh,
  };
}
