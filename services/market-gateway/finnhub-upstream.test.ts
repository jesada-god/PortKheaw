import { describe, expect, it } from 'vitest';
import type { ChannelRef } from '@/src/lib/market-data/realtime';
import type { Scheduler, SocketLike } from './socket';
import { UpstreamConnection } from './upstream';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  open = false;
  private opened: Array<() => void> = [];
  private messages: Array<(data: string) => void> = [];
  private capturedMessages: Array<(data: string) => void> = [];
  private closes: Array<() => void> = [];
  send(data: string) { if (!this.open) return 'dropped' as const; this.sent.push(data); return 'sent' as const; }
  isOpen() { return this.open; }
  ping() {}
  close() { this.open = false; }
  detach() { this.opened = []; this.messages = []; this.closes = []; }
  onOpen(listener: () => void) { this.opened.push(listener); }
  onMessage(listener: (data: string) => void) { this.messages.push(listener); this.capturedMessages.push(listener); }
  onClose(listener: () => void) { this.closes.push(listener); }
  onError() {}
  onPing() {}
  onPong() {}
  emitOpen() { this.open = true; for (const listener of this.opened) listener(); }
  emitMessage(value: unknown) { for (const listener of this.messages) listener(JSON.stringify(value)); }
  emitLateMessage(value: unknown) { for (const listener of this.capturedMessages) listener(JSON.stringify(value)); }
  emitClose() { this.open = false; for (const listener of this.closes) listener(); }
}

describe('Finnhub UpstreamConnection', () => {
  it('subscribes once per symbol, normalizes trades, reconnects and resubscribes', () => {
    const sockets: FakeSocket[] = [];
    const tasks: Array<() => void> = [];
    const scheduler: Scheduler = (callback) => { tasks.push(callback); return () => {}; };
    const refs: ChannelRef[] = [
      { symbol: 'NVDA', channel: 'trades' },
      { symbol: 'NVDA', channel: 'bars' },
      { symbol: 'NVDA', channel: 'updatedBars' },
    ];
    const events: unknown[] = [];
    const upstream = new UpstreamConnection({
      config: { url: 'wss://example.test?token=redacted', protocol: 'finnhub' },
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      onEvent: (event) => events.push(event),
      getSubscriptions: () => refs,
      scheduler,
      random: () => 0,
    });

    upstream.start();
    sockets[0].emitOpen();
    expect(sockets[0].sent.map((frame) => JSON.parse(frame))).toEqual([{ type: 'subscribe', symbol: 'NVDA' }]);
    sockets[0].emitMessage({ type: 'trade', data: [
      { s: 'NVDA', p: 188, v: 10, t: Date.UTC(2026, 6, 24, 14, 0) },
    ] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'finnhub', symbol: 'NVDA', price: 188 });

    sockets[0].emitClose();
    tasks.shift()?.();
    sockets[1].emitOpen();
    expect(sockets[1].sent.map((frame) => JSON.parse(frame))).toEqual([{ type: 'subscribe', symbol: 'NVDA' }]);
  });

  it('classifies invalid and superseded-generation trade rows without emitting them', () => {
    const sockets: FakeSocket[] = [];
    const tasks: Array<() => void> = [];
    const rejected: Array<{ symbol: string; reason: string }> = [];
    const events: unknown[] = [];
    const upstream = new UpstreamConnection({
      config: { url: 'wss://example.test?token=redacted', protocol: 'finnhub' },
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      onEvent: (event) => events.push(event),
      onTradeRejected: (symbol, reason) => rejected.push({ symbol, reason }),
      getSubscriptions: () => [{ symbol: 'NVDA', channel: 'trades' }],
      scheduler: (callback) => { tasks.push(callback); return () => {}; },
      random: () => 0,
    });
    upstream.start();
    sockets[0].emitOpen();
    sockets[0].emitMessage({ type: 'trade', data: [{ s: 'NVDA', p: 0, v: 1, t: 1 }] });
    sockets[0].emitClose();
    tasks.shift()?.();
    sockets[1].emitOpen();
    sockets[0].emitLateMessage({ type: 'trade', data: [{ s: 'NVDA', p: 188, v: 1, t: Date.UTC(2026, 6, 24, 14, 0) }] });
    expect(events).toHaveLength(0);
    expect(rejected).toEqual([
      { symbol: 'NVDA', reason: 'invalid' },
      { symbol: 'NVDA', reason: 'stale' },
    ]);
  });
});
