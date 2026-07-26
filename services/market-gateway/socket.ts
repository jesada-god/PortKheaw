import type { WebSocket as WsWebSocket } from 'ws';

/**
 * Minimal transport abstraction shared by the provider upstream and downstream
 * (browser) sockets. Keeping the Gateway logic behind this interface lets the
 * unit/integration tests drive fully deterministic fake sockets while the real
 * server binds it to the `ws` library — no test ever opens a real connection.
 */

/**
 * Outcome of a {@link SocketLike.send}. `send()` MUST NOT throw: a closed or
 * still-connecting socket returns `'dropped'` instead of raising
 * `WebSocket is not open: readyState 0` and crashing the process.
 */
export type SendResult = 'sent' | 'dropped';

/** The `ws` numeric readyState for an OPEN connection. */
const WS_OPEN = 1;

export interface SocketLike {
  /** Enqueue-free write. Never throws; reports whether the byte hit the wire. */
  send(data: string): SendResult;
  /** True only while the transport is in the OPEN state. */
  isOpen(): boolean;
  /**
   * Send a protocol-level ping as a liveness probe. Never throws and no-ops
   * unless OPEN; the peer's pong (or any other frame) is the proof of life the
   * upstream watchdog waits for before ever recycling a socket.
   */
  ping(): void;
  close(code?: number, reason?: string): void;
  /** Remove every listener so a superseded socket can no longer re-enter. */
  detach(): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: unknown) => void): void;
  /** Protocol-level heartbeats (Alpaca/`ws` ping/pong), used for liveness. */
  onPing(listener: () => void): void;
  onPong(listener: () => void): void;
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Buffer) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  return String(data);
}

/** Adapt a live `ws` socket (either an upstream client or an accepted peer). */
export function fromWs(socket: WsWebSocket): SocketLike {
  return {
    send: (data) => {
      // Guard the readyState BEFORE calling ws.send — ws throws synchronously
      // ("WebSocket is not open: readyState N") for anything but OPEN, and an
      // unguarded throw here is exactly what crashed the Gateway on reconnect.
      if (socket.readyState !== WS_OPEN) return 'dropped';
      try {
        socket.send(data);
        return 'sent';
      } catch {
        return 'dropped';
      }
    },
    isOpen: () => socket.readyState === WS_OPEN,
    ping: () => {
      // Guard readyState BEFORE ws.ping — like send(), ws throws synchronously
      // when the socket is not OPEN, and an unguarded throw here would crash the
      // watchdog. A ping on a dead socket is pointless anyway.
      if (socket.readyState !== WS_OPEN) return;
      try {
        socket.ping();
      } catch {
        // Slipped out of OPEN between the guard and the call — ignore.
      }
    },
    close: (code, reason) => {
      try {
        socket.close(code, reason);
      } catch {
        // Already closing/closed — nothing to do.
      }
    },
    detach: () => {
      socket.removeAllListeners();
      // A ws EventEmitter with no 'error' listener re-throws late errors and
      // crashes the process; keep a no-op sink after detaching.
      socket.on('error', () => {});
    },
    onOpen: (listener) => socket.on('open', listener),
    onMessage: (listener) => socket.on('message', (raw) => listener(toText(raw))),
    onClose: (listener) => socket.on('close', () => listener()),
    onError: (listener) => socket.on('error', (error) => listener(error)),
    onPing: (listener) => socket.on('ping', () => listener()),
    onPong: (listener) => socket.on('pong', () => listener()),
  };
}

/** A cancelable scheduled callback, injected so tests control time. */
export type Scheduler = (callback: () => void, delayMs: number) => () => void;

export const defaultScheduler: Scheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};
