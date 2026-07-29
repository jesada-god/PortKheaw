import { describe, expect, it } from 'vitest';
import { MarketTracer } from '@/src/lib/market-data/realtime';
import { WebSocketMarketSourceImpl } from './websocket-source';
import type { RealtimeSocket } from './realtime-socket';
import type { MarketUpdate } from './types';

class FakeSocket implements RealtimeSocket {
  readonly sent: string[] = [];
  closed = false;
  closeReasons: (string | undefined)[] = [];
  private openCb?: () => void;
  private msgCb?: (data: string) => void;
  private closeCb?: () => void;
  private errCb?: (error: unknown) => void;

  send(data: string): void { this.sent.push(data); }
  close(reason?: string): void { this.closed = true; this.closeReasons.push(reason); }
  onOpen(cb: () => void): void { this.openCb = cb; }
  onMessage(cb: (data: string) => void): void { this.msgCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
  onError(cb: (error: unknown) => void): void { this.errCb = cb; }

  emitOpen(): void { this.openCb?.(); }
  emit(payload: unknown): void { this.msgCb?.(typeof payload === 'string' ? payload : JSON.stringify(payload)); }
  emitClose(): void { this.closeCb?.(); }
  emitError(): void { this.errCb?.(new Error('drop')); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((raw) => JSON.parse(raw)); }
}

function setup(overrides: { staleMs?: number; heartbeatMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const pending: Array<() => void> = [];
  let clock = 1_000;
  const source = new WebSocketMarketSourceImpl({
    symbol: 'AAPL',
    url: 'wss://gw.example/ws',
    selection: { interval: '1m', session: 'regular', adjusted: false },
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    now: () => clock,
    random: () => 0,
    scheduler: (cb) => { pending.push(cb); return () => {}; },
    heartbeatMs: overrides.heartbeatMs ?? 0,
    staleMs: overrides.staleMs ?? 30_000,
  });
  const updates: MarketUpdate[] = [];
  source.subscribe((u) => updates.push(u));
  const flush = (): void => { pending.splice(0).forEach((cb) => cb()); };
  const advance = (ms: number): void => { clock += ms; };
  const connect = (socket: FakeSocket, realtime = true): void => {
    socket.emitOpen();
    socket.emit({ type: 'connected', feed: realtime ? 'iex' : 'test', realtime });
  };
  const tradeAt = (msIso: string, price: number) => ({ type: 'event', event: { kind: 'trade', symbol: 'AAPL', price, size: 10, timestampMs: Date.parse(msIso) } });
  return { source, sockets, updates, flush, advance, connect, tradeAt };
}

describe('WebSocketMarketSource lifecycle', () => {
  it('subscribes on connect and labels a live trade REAL-TIME · iex', () => {
    const { source, sockets, updates, connect, tradeAt } = setup();
    source.start();
    connect(sockets[0]);
    const subscribe = sockets[0].frames().find((frame) => frame.type === 'subscribe');
    expect(subscribe).toMatchObject({
      symbols: ['AAPL'],
      channels: ['trades', 'bars', 'updatedBars'],
    });
    expect(source.connectionState).toBe('open');

    sockets[0].emit(tradeAt('2024-01-02T15:04:05Z', 190.5));
    const last = updates[updates.length - 1];
    expect(last.price).toBe(190.5);
    expect(last.label.mode).toBe('REAL-TIME');
    expect(last.label.realtime).toBe(true);
    expect(last.label.feed).toBe('iex');
    expect(last.candle?.close).toBe(190.5);
  });

  it('carries exchange/gateway/browser/accepted timing without replacing exchange time', () => {
    const { source, sockets, updates, connect } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].emit({
      type: 'event',
      event: {
        kind: 'trade', symbol: 'AAPL', price: 190.5, size: 10,
        timestampMs: 800, gatewayReceivedAtMs: 900,
      },
    });
    const last = updates.at(-1)!;
    expect(last.label.exchangeTimestamp).toBe(new Date(800).toISOString());
    expect(last.observation).toEqual({
      exchangeTimestampMs: 800,
      gatewayReceivedAtMs: 900,
      browserReceivedAtMs: 1_000,
      acceptedAtMs: 1_000,
    });
    expect(last.price).toBe(last.candle?.close);
  });

  it('seeds header price + current 1m candle from the initial snapshot without waiting for a trade', () => {
    const { source, sockets, updates, connect } = setup();
    source.start();
    connect(sockets[0]);
    const before = updates.length;
    sockets[0].emit({
      type: 'snapshot',
      snapshot: {
        symbol: 'AAPL',
        trade: { kind: 'trade', symbol: 'AAPL', price: 69.71, size: 12, timestampMs: Date.parse('2024-01-02T15:04:30Z') },
        quote: { kind: 'quote', symbol: 'AAPL', bidPrice: 69.70, bidSize: 3, askPrice: 69.72, askSize: 4, timestampMs: Date.parse('2024-01-02T15:04:31Z') },
        bars: [
          { kind: 'bar', symbol: 'AAPL', open: 69.5, high: 69.8, low: 69.4, close: 69.6, volume: 800, timestampMs: Date.parse('2024-01-02T15:03:00Z'), updated: false },
        ],
        origin: 'rest',
        asOfMs: Date.parse('2024-01-02T15:04:31Z'),
      },
    });
    expect(updates.length).toBeGreaterThan(before); // emitted immediately, no trade needed
    const last = updates[updates.length - 1];
    // Header price and the current 1m candle close are the SAME snapshot trade.
    expect(last.price).toBe(69.71);
    expect(last.candle?.close).toBe(69.71);
    expect(last.label.mode).toBe('REAL-TIME');
    expect(last).toMatchObject({ bid: 69.70, ask: 69.72 });
  });

  it('a snapshot never regresses an already-newer live last price', () => {
    const { source, sockets, updates, connect, tradeAt } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].emit(tradeAt('2024-01-02T15:05:00Z', 71.0)); // newer live trade first
    sockets[0].emit({
      type: 'snapshot',
      snapshot: {
        symbol: 'AAPL',
        trade: { kind: 'trade', symbol: 'AAPL', price: 69.71, size: 1, timestampMs: Date.parse('2024-01-02T15:04:30Z') },
        quote: null,
        bars: [],
        origin: 'cache',
        asOfMs: Date.parse('2024-01-02T15:05:01Z'),
      },
    });
    expect(updates[updates.length - 1].price).toBe(71.0); // older snapshot ignored
  });

  it('never claims real-time for the test/FAKEPACA feed', () => {
    const { source, sockets, updates, connect, tradeAt } = setup();
    source.start();
    connect(sockets[0], false);
    sockets[0].emit(tradeAt('2024-01-02T15:04:05Z', 5));
    const last = updates[updates.length - 1];
    expect(last.label.realtime).toBe(false);
    expect(last.label.mode).not.toBe('REAL-TIME');
  });

  it('maps bid/ask separately and ignores an out-of-order quote', () => {
    const { source, sockets, updates, connect } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].emit({ type: 'event', event: { kind: 'quote', symbol: 'AAPL', bidPrice: 190.1, bidSize: 2, askPrice: 190.2, askSize: 3, timestampMs: 2_000 } });
    expect(updates[updates.length - 1]).toMatchObject({ bid: 190.1, ask: 190.2, bidSize: 2, askSize: 3 });
    // Older quote must not regress the book.
    sockets[0].emit({ type: 'event', event: { kind: 'quote', symbol: 'AAPL', bidPrice: 1, bidSize: 1, askPrice: 2, askSize: 1, timestampMs: 1_000 } });
    expect(updates[updates.length - 1]).toMatchObject({ bid: 190.1, ask: 190.2 });
  });

  it('reconciles an official bar into the same bucket and flags barFinalized', () => {
    const { source, sockets, updates, connect, tradeAt } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].emit(tradeAt('2024-01-02T15:04:05Z', 100));
    sockets[0].emit({ type: 'event', event: { kind: 'bar', symbol: 'AAPL', open: 100, high: 104, low: 99, close: 102, volume: 900, timestampMs: Date.parse('2024-01-02T15:04:00Z'), updated: false } });
    const last = updates[updates.length - 1];
    expect(last.candle).toMatchObject({ close: 102, volume: 900 });
    expect(last.barFinalized).toBe(true);
  });

  it('surfaces a per-symbol halt independently', () => {
    const { source, sockets, updates, connect } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].emit({ type: 'event', event: { kind: 'status', symbol: 'AAPL', statusCode: 'H', statusMessage: 'Halt', reasonMessage: 'News', timestampMs: 5_000, halted: true } });
    expect(updates[updates.length - 1]).toMatchObject({ halted: true, haltReason: 'News' });
  });

  it('reconnects with one attempt on drop and resubscribes on reconnect', () => {
    const { source, sockets, flush, connect } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].emitClose();
    expect(source.connectionState).toBe('connecting');
    flush();
    expect(sockets).toHaveLength(2);
    connect(sockets[1]);
    expect(sockets[1].frames().some((f) => f.type === 'subscribe')).toBe(true);
  });

  it('downgrades to STALE when the socket goes silent past the stale window', () => {
    const { source, sockets, updates, flush, advance, connect } = setup({ heartbeatMs: 5_000, staleMs: 10_000 });
    source.start();
    connect(sockets[0]);
    advance(11_000);
    flush(); // heartbeat tick detects staleness
    const last = updates[updates.length - 1];
    expect(last.label.realtime).toBe(false);
    expect(source.connectionState).not.toBe('open');
  });

  it('tears down fully on stop (Strict-Mode safe) and stops reconnecting', () => {
    const { source, sockets, flush, connect } = setup();
    source.start();
    connect(sockets[0]);
    source.stop();
    expect(sockets[0].closed).toBe(true);
    sockets[0].emitClose();
    flush();
    expect(sockets).toHaveLength(1); // no reconnect after stop
  });

  it('releases the socket when hidden and reconnects when shown', () => {
    const { source, sockets, connect } = setup();
    source.start();
    connect(sockets[0]);
    source.setVisible(false);
    expect(sockets[0].closed).toBe(true);
    source.setVisible(true);
    expect(sockets).toHaveLength(2);
  });

  it('does NOT tear down a still-CONNECTING socket when hidden (defers the hide)', () => {
    const { source, sockets } = setup();
    source.start(); // socket is CONNECTING (no "connected" frame yet)
    expect(sockets).toHaveLength(1);
    source.setVisible(false); // must not close a socket mid-handshake (the 1006 bug)
    expect(sockets[0].closed).toBe(false);
    expect(source.connectionState).toBe('connecting');
    // Once the handshake completes while still hidden, it releases cleanly.
    sockets[0].emitOpen();
    sockets[0].emit({ type: 'connected', feed: 'iex', realtime: true });
    expect(sockets[0].closed).toBe(true);
  });

  it('cancels a deferred hide when shown again before the handshake completes', () => {
    const { source, sockets, connect } = setup();
    source.start();
    source.setVisible(false); // defer hide
    source.setVisible(true);  // shown again before connect → cancel the hide
    connect(sockets[0]);
    expect(sockets[0].closed).toBe(false);
    expect(source.connectionState).toBe('open');
    expect(sockets).toHaveLength(1); // no reconnect, no second socket
  });

  it('resubscribes on the SAME socket when the symbol changes (no reconnect)', () => {
    const { source, sockets, updates, connect } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].sent.length = 0; // drop the initial AAPL subscribe
    source.setSymbol('MSFT');
    expect(sockets).toHaveLength(1); // same socket, never closed/reopened
    expect(sockets[0].closed).toBe(false);
    const frames = sockets[0].frames();
    expect(frames.some((f) => f.type === 'unsubscribe' && (f.symbols as string[])[0] === 'AAPL')).toBe(true);
    expect(frames.some((f) => f.type === 'subscribe' && (f.symbols as string[])[0] === 'MSFT')).toBe(true);
    // The new symbol's trades are accepted; the old symbol is ignored.
    sockets[0].emit({ type: 'event', event: { kind: 'trade', symbol: 'AAPL', price: 999, size: 1, timestampMs: Date.parse('2024-01-02T15:05:00Z') } });
    sockets[0].emit({ type: 'event', event: { kind: 'trade', symbol: 'MSFT', price: 300, size: 1, timestampMs: Date.parse('2024-01-02T15:05:01Z') } });
    const last = updates[updates.length - 1];
    expect(last.symbol).toBe('MSFT');
    expect(last.price).toBe(300);
  });

  it('stays open across a redundant re-assert (a rerender with the tab still visible)', () => {
    const { source, sockets, connect } = setup();
    source.start();
    connect(sockets[0]);
    const unsubscribesBefore = sockets[0].frames().filter((f) => f.type === 'unsubscribe').length;
    // A rerender that recomputes the same visibility + selection must be a no-op:
    // the live socket keeps its subscription (never regresses the Gateway to zero
    // desired symbols / `upstream_subscribed (none)`), and never reconnects.
    source.setVisible(true);
    source.setSelection({ interval: '1m', session: 'regular', adjusted: false });
    expect(sockets[0].closed).toBe(false);
    expect(source.connectionState).toBe('open');
    expect(sockets).toHaveLength(1);
    expect(sockets[0].frames().filter((f) => f.type === 'unsubscribe').length).toBe(unsubscribesBefore);
  });

  it('closes with an explicit reason (not a bare 1005) when the tab is hidden', () => {
    const { source, sockets, connect } = setup();
    source.start();
    connect(sockets[0]);
    source.setVisible(false);
    expect(sockets[0].closed).toBe(true);
    // An intentional client teardown carries a reason so the wire close is a
    // legible 1000+reason instead of the ambiguous 1005 ("no status received").
    expect(sockets[0].closeReasons).toContain('tab-hidden');
  });

  it('closes with a source-stopped reason on stop()', () => {
    const { source, sockets, connect } = setup();
    source.start();
    connect(sockets[0]);
    source.stop();
    expect(sockets[0].closeReasons).toContain('source-stopped');
  });
});

describe('WebSocketMarketSource tracing', () => {
  function tracedSetup() {
    const lines: string[] = [];
    const tracer = new MarketTracer({ sink: (l) => lines.push(l), now: () => 0, sampleIntervalMs: 0 });
    const sockets: FakeSocket[] = [];
    const source = new WebSocketMarketSourceImpl({
      symbol: 'AAPL',
      url: 'wss://gw.example/ws',
      selection: { interval: '1m', session: 'regular', adjusted: false },
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      now: () => 0,
      random: () => 0,
      scheduler: (cb) => { void cb; return () => {}; },
      heartbeatMs: 0,
      tracer,
    });
    source.subscribe(() => {});
    source.start();
    sockets[0].emitOpen();
    sockets[0].emit({ type: 'connected', feed: 'iex', realtime: true });
    return { sockets, lines };
  }

  it('traces browser_market_event_received and price_header_updated on a live trade', () => {
    const { sockets, lines } = tracedSetup();
    sockets[0].emit({ type: 'event', event: { kind: 'trade', symbol: 'AAPL', price: 190.5, size: 10, timestampMs: 1_000 } });
    expect(lines.some((l) => l.includes('browser_market_event_received') && l.includes('type=trade') && l.includes('symbol=AAPL'))).toBe(true);
    expect(lines.some((l) => l.includes('price_header_updated') && l.includes('symbol=AAPL') && l.includes('price=190.5'))).toBe(true);
  });

  it('does not emit price_header_updated for a quote (bid/ask never drives Last Price)', () => {
    const { sockets, lines } = tracedSetup();
    sockets[0].emit({ type: 'event', event: { kind: 'quote', symbol: 'AAPL', bidPrice: 1, bidSize: 1, askPrice: 2, askSize: 1, timestampMs: 2_000 } });
    expect(lines.some((l) => l.includes('browser_market_event_received') && l.includes('type=quote'))).toBe(true);
    expect(lines.some((l) => l.includes('price_header_updated'))).toBe(false);
  });

  it('does not emit price_header_updated for an out-of-order (older) trade', () => {
    const { sockets, lines } = tracedSetup();
    sockets[0].emit({ type: 'event', event: { kind: 'trade', symbol: 'AAPL', price: 100, size: 1, timestampMs: 5_000 } });
    const before = lines.filter((l) => l.includes('price_header_updated')).length;
    sockets[0].emit({ type: 'event', event: { kind: 'trade', symbol: 'AAPL', price: 999, size: 1, timestampMs: 1_000 } }); // older
    const after = lines.filter((l) => l.includes('price_header_updated')).length;
    expect(before).toBe(1);
    expect(after).toBe(1); // the stale trade did not update the header
  });
});

/**
 * The emitted `session` describes the PRICE, and only the price.
 *
 * It used to fall back to `this.selection.session` — the chart's REQUEST parameter,
 * which is `regular` by default. That made every after-hours print look like a
 * regular-session price to the header, and is how NVTS's 16:41 ET print at 10.42
 * replaced the official 9.735 close in the main row.
 */
describe('WebSocketMarketSource price session', () => {
  const AFTER_HOURS = '2026-07-29T20:41:12.000Z'; // 16:41 ET Wednesday
  const REGULAR = '2026-07-29T15:00:00.000Z'; //     11:00 ET
  const PRE_MARKET = '2026-07-29T12:25:00.000Z'; //  08:25 ET

  it('reports the session of the trade, not the chart selection', () => {
    // The source is configured with a `regular` selection throughout.
    const { source, sockets, updates, connect, tradeAt } = setup();
    source.start();
    connect(sockets[0]);

    sockets[0].emit(tradeAt(AFTER_HOURS, 10.42));
    expect(updates[updates.length - 1].session).toBe('after-hours');

    sockets[0].emit(tradeAt(PRE_MARKET, 10.15));
    // Older than the accepted price, so the accepted price and its session both hold.
    expect(updates[updates.length - 1].session).toBe('after-hours');
  });

  it.each([
    [REGULAR, 'regular'],
    [PRE_MARKET, 'pre-market'],
    [AFTER_HOURS, 'after-hours'],
  ] as const)('classifies a trade at %s as %s', (timestamp, session) => {
    const { source, sockets, updates, connect, tradeAt } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].emit(tradeAt(timestamp, 10.42));
    expect(updates[updates.length - 1].session).toBe(session);
  });

  it('prefers a provider-declared session when the feed states one', () => {
    const { source, sockets, updates, connect } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].emit({
      type: 'event',
      event: {
        kind: 'trade', symbol: 'AAPL', price: 10.42, size: 10,
        timestampMs: Date.parse(AFTER_HOURS), session: 'after-hours', provider: 'finnhub',
      },
    });
    expect(updates[updates.length - 1].session).toBe('after-hours');
  });

  it('reports no session at all while there is no priced value', () => {
    const { source, sockets, updates, connect } = setup();
    source.start();
    connect(sockets[0]);
    // A lifecycle emission before the first trade must not claim `regular`.
    expect(updates[updates.length - 1].price).toBeNull();
    expect(updates[updates.length - 1].session).toBeNull();
  });

  it('clears the price session on a symbol switch', () => {
    const { source, sockets, updates, connect, tradeAt } = setup();
    source.start();
    connect(sockets[0]);
    sockets[0].emit(tradeAt(AFTER_HOURS, 10.42));
    expect(updates[updates.length - 1].session).toBe('after-hours');

    source.setSymbol('MSFT');
    // The previous instrument's session can never describe the new one.
    expect(updates[updates.length - 1].session).toBeNull();
  });
});
