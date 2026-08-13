import { describe, expect, it, vi } from 'vitest';
import { GatewayHub } from './hub';
import { IdentityVerifier, MAX_CONNECTIONS_PER_USER } from './identity';
import {
  CLIENT_IDLE_TIMEOUT_MS,
  CLIENT_PROBE_AFTER_MS,
  ConnectionCapGuard,
  isOriginAllowed,
  MAX_CONNECTIONS_PER_IP,
  MAX_MALFORMED_FRAMES,
  MAX_MESSAGE_BYTES,
  MAX_SUBSCRIPTIONS_PER_CLIENT,
  MAX_TOTAL_CONNECTIONS,
} from './runtime';
import type { SendResult, SocketLike } from './socket';

/**
 * The Gateway, under abuse.
 *
 * The realtime service is the one part of this product that holds long-lived
 * state per caller, which makes it the one part where an attacker's cost model
 * is inverted: a request is over in milliseconds, but a socket they opened and
 * abandoned costs the process memory, a slot and — through the subscription
 * registry — a share of the upstream provider quota, indefinitely.
 *
 * So the bounds here are about *holding*, not *arriving*, and the cases are
 * written accordingly: open and never speak, subscribe to everything, send
 * rubbish forever, hold slots and never release them. Rate limiting alone
 * catches none of these.
 *
 * Every socket is a deterministic fake and every clock is injected. Nothing here
 * opens a connection, binds a port, or touches a provider.
 */

const OPEN = 1;
const CLOSED = 3;

class FakePeer implements SocketLike {
  readonly sent: string[] = [];
  pinged = 0;
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  readyState = OPEN;
  private msgCb?: (data: string) => void;
  private closeCb?: () => void;
  private errCb?: (error: unknown) => void;
  private pingCb?: () => void;
  private pongCb?: () => void;

  send(data: string): SendResult {
    if (this.readyState !== OPEN) return 'dropped';
    this.sent.push(data);
    return 'sent';
  }
  isOpen(): boolean { return this.readyState === OPEN; }
  ping(): void { if (this.readyState === OPEN) this.pinged += 1; }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = CLOSED;
  }
  detach(): void {}
  onOpen(): void {}
  onMessage(cb: (data: string) => void): void { this.msgCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
  onError(cb: (error: unknown) => void): void { this.errCb = cb; }
  onPing(cb: () => void): void { this.pingCb = cb; }
  onPong(cb: () => void): void { this.pongCb = cb; }

  emitMessage(payload: unknown): void {
    this.msgCb?.(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
  emitClose(): void { this.readyState = CLOSED; this.closeCb?.(); }
  emitError(error: unknown): void { this.errCb?.(error); }
  emitPong(): void { this.pongCb?.(); }

  frames(): Array<Record<string, unknown>> { return this.sent.map((raw) => JSON.parse(raw)); }
  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames().filter((frame) => frame.type === type);
  }
}

function makeHub(overrides: Partial<ConstructorParameters<typeof GatewayHub>[0]> = {}, clock = { now: 0 }) {
  const hub = new GatewayHub({
    feed: 'test',
    realtime: false,
    applySubscribe: () => {},
    applyUnsubscribe: () => {},
    maxSymbols: 1_000,
    maxSubscriptionsPerClient: MAX_SUBSCRIPTIONS_PER_CLIENT,
    maxMalformedFrames: MAX_MALFORMED_FRAMES,
    now: () => clock.now,
    ...overrides,
  });
  return { hub, clock };
}

describe('who may open a connection at all', () => {
  it('accepts only the configured origins in production', () => {
    const policy = { allowedOrigins: ['https://portkheaw.vercel.app'], development: false };
    expect(isOriginAllowed('https://portkheaw.vercel.app', policy)).toBe(true);
    expect(isOriginAllowed('https://portkheaw.vercel.app.evil.com', policy)).toBe(false);
    expect(isOriginAllowed('https://evil.com', policy)).toBe(false);
    // A browser always sends Origin, so its absence in production is a non-browser.
    expect(isOriginAllowed(undefined, policy)).toBe(false);
    expect(isOriginAllowed('', policy)).toBe(false);
    // Loopback is a development affordance and must not leak into production.
    expect(isOriginAllowed('http://localhost:3000', policy)).toBe(false);
  });
});

describe('how many connections one source may hold', () => {
  it('admits a household of tabs and refuses a script', () => {
    const guard = new ConnectionCapGuard(MAX_CONNECTIONS_PER_IP, MAX_TOTAL_CONNECTIONS);
    for (let index = 0; index < MAX_CONNECTIONS_PER_IP; index += 1) {
      expect(`#${index}: ${guard.acquire('203.0.113.9').ok}`).toBe(`#${index}: true`);
    }
    expect(guard.acquire('203.0.113.9')).toEqual({ ok: false, reason: 'per-key' });
    // Somebody else is unaffected — this is a per-source cap, not a global one.
    expect(guard.acquire('198.51.100.4').ok).toBe(true);
  });

  it('protects the instance as a whole once it is full', () => {
    const guard = new ConnectionCapGuard(100, 3);
    guard.acquire('a'); guard.acquire('b'); guard.acquire('c');
    /*
     * `global` rather than `per-key`, because the two need different answers:
     * "come back, this instance is saturated" is something a browser's backoff
     * and a load balancer can both act on, while "you are the problem" is not
     * fixed by retrying.
     */
    expect(guard.acquire('d')).toEqual({ ok: false, reason: 'global' });
  });

  it('gives a slot back on release, so a cap is not a ratchet', () => {
    const guard = new ConnectionCapGuard(1, 10);
    expect(guard.acquire('ip').ok).toBe(true);
    expect(guard.acquire('ip').ok).toBe(false);
    guard.release('ip');
    expect(guard.acquire('ip').ok).toBe(true);
  });

  it('forgets a source entirely once it holds nothing', () => {
    // A map entry per address that ever connected is an unbounded map in a
    // process that runs for weeks.
    const guard = new ConnectionCapGuard(2, 10);
    guard.acquire('ip'); guard.release('ip');
    expect(guard.openFor('ip')).toBe(0);
    expect(guard.openConnections).toBe(0);
  });

  it('never lets an over-release manufacture capacity', () => {
    const guard = new ConnectionCapGuard(1, 1);
    guard.acquire('ip');
    guard.release('ip');
    guard.release('ip');
    guard.release('unknown');
    expect(guard.openConnections).toBe(0);
    expect(guard.acquire('ip').ok).toBe(true);
    expect(guard.acquire('other')).toEqual({ ok: false, reason: 'global' });
  });
});

describe('how much one client may subscribe to', () => {
  it('refuses a client that tries to take the whole instance allowance', () => {
    const { hub } = makeHub();
    const peer = new FakePeer();
    hub.addClient(peer);

    const symbols = Array.from({ length: 200 }, (_, index) => `SYM${index}`);
    peer.emitMessage({ type: 'subscribe', symbols, channels: ['trades'] });

    const subscribed = peer.framesOfType('subscribed').at(-1);
    expect((subscribed?.symbols as string[]).length).toBe(MAX_SUBSCRIPTIONS_PER_CLIENT);

    // The surplus is reported honestly rather than silently dropped.
    const exceeded = peer.framesOfType('limit-exceeded').at(-1);
    expect((exceeded?.rejected as string[]).length).toBe(200 - MAX_SUBSCRIPTIONS_PER_CLIENT);
  });

  it('leaves the rest of the allowance for everybody else', () => {
    const { hub } = makeHub();
    const greedy = new FakePeer();
    const bystander = new FakePeer();
    hub.addClient(greedy);
    hub.addClient(bystander);

    greedy.emitMessage({
      type: 'subscribe',
      symbols: Array.from({ length: 200 }, (_, index) => `SYM${index}`),
      channels: ['trades'],
    });
    bystander.emitMessage({ type: 'subscribe', symbols: ['AAPL'], channels: ['trades'] });

    const accepted = bystander.framesOfType('subscribed').at(-1);
    expect(accepted?.symbols).toEqual(['AAPL']);
  });

  it('releases a client\'s whole share when it disconnects', () => {
    const released: string[] = [];
    const { hub } = makeHub({ applyUnsubscribe: (refs) => refs.forEach((ref) => released.push(ref.symbol)) });
    const peer = new FakePeer();
    hub.addClient(peer);
    peer.emitMessage({ type: 'subscribe', symbols: ['AAPL', 'MSFT'], channels: ['trades'] });

    peer.emitClose();
    /*
     * A closed tab that strands its upstream interest is the leak that ends in a
     * provider quota nobody can account for — the symbol stays subscribed
     * upstream forever with no client to receive it.
     */
    expect(released.sort()).toEqual(['AAPL', 'MSFT']);
    expect(hub.clientCount).toBe(0);
  });
});

describe('a client that does not speak the protocol', () => {
  it('tolerates a truncated frame, because flaky phones produce them', () => {
    const { hub } = makeHub();
    const peer = new FakePeer();
    hub.addClient(peer);

    peer.emitMessage('{"type":"subscr');
    expect(peer.closed).toBe(false);
    expect(peer.framesOfType('error').at(-1)?.code).toBe('bad-frame');
  });

  it('disconnects one that keeps sending rubbish', () => {
    const closed: string[] = [];
    const { hub } = makeHub({ onClientClosed: (reason) => closed.push(reason) });
    const peer = new FakePeer();
    hub.addClient(peer);

    for (let index = 0; index < MAX_MALFORMED_FRAMES; index += 1) {
      peer.emitMessage('not json at all');
    }
    expect(peer.closed).toBe(true);
    expect(closed).toEqual(['malformed']);
    expect(hub.clientCount).toBe(0);
  });

  it('rejects malformed input before it costs anything', () => {
    const applySubscribe = vi.fn();
    const { hub } = makeHub({ applySubscribe });
    const peer = new FakePeer();
    hub.addClient(peer);

    for (const junk of [
      'null',
      '[]',
      '{"type":"subscribe"}',
      '{"type":"subscribe","symbols":[],"channels":[]}',
      '{"type":"subscribe","symbols":["AAPL"],"channels":["not-a-channel"]}',
      '{"type":"unknown-verb"}',
      '{"type":"ping","t":-1}',
    ]) {
      peer.emitMessage(junk);
    }
    // Nothing reached the registry or the upstream: a schema check is the whole
    // cost of a malformed frame.
    expect(applySubscribe).not.toHaveBeenCalled();
  });

  it('caps an inbound frame well below anything a control message needs', () => {
    // Enforced by the `ws` server's `maxPayload`; asserted here so the number
    // cannot drift upward unnoticed.
    expect(MAX_MESSAGE_BYTES).toBeLessThanOrEqual(16 * 1024);
  });
});

describe('a connection that stops speaking', () => {
  it('is probed once it goes quiet', () => {
    const { hub, clock } = makeHub();
    const peer = new FakePeer();
    hub.addClient(peer);

    clock.now = CLIENT_PROBE_AFTER_MS;
    hub.sweepIdleClients({ probeAfterMs: CLIENT_PROBE_AFTER_MS, idleAfterMs: CLIENT_IDLE_TIMEOUT_MS });
    expect(peer.pinged).toBe(1);
    expect(peer.closed).toBe(false);
  });

  it('is closed and released once it stays quiet', () => {
    const released: string[] = [];
    const closed: string[] = [];
    const { hub, clock } = makeHub({
      applyUnsubscribe: (refs) => refs.forEach((ref) => released.push(ref.symbol)),
      onClientClosed: (reason) => closed.push(reason),
    });
    const peer = new FakePeer();
    hub.addClient(peer);
    peer.emitMessage({ type: 'subscribe', symbols: ['AAPL'], channels: ['trades'] });

    clock.now = CLIENT_IDLE_TIMEOUT_MS + 1;
    hub.sweepIdleClients({ probeAfterMs: CLIENT_PROBE_AFTER_MS, idleAfterMs: CLIENT_IDLE_TIMEOUT_MS });

    expect(peer.closed).toBe(true);
    expect(closed).toEqual(['idle']);
    // The subscription goes back too — a reaped socket that keeps its upstream
    // interest is the leak the reaping was supposed to prevent.
    expect(released).toEqual(['AAPL']);
    expect(hub.clientCount).toBe(0);
  });

  /*
   * The false positive that would matter most: a reader who switched apps. A
   * backgrounded tab has its timers throttled and stops sending application
   * pings, but the browser's transport still answers a protocol ping without the
   * page being involved — which is exactly why the watchdog probes at that level.
   */
  it('is kept alive by a transport pong, even with no application traffic', () => {
    const { hub, clock } = makeHub();
    const peer = new FakePeer();
    hub.addClient(peer);

    for (let elapsed = CLIENT_PROBE_AFTER_MS; elapsed < CLIENT_IDLE_TIMEOUT_MS * 3; elapsed += CLIENT_PROBE_AFTER_MS) {
      clock.now = elapsed;
      hub.sweepIdleClients({ probeAfterMs: CLIENT_PROBE_AFTER_MS, idleAfterMs: CLIENT_IDLE_TIMEOUT_MS });
      peer.emitPong();
    }
    expect(peer.closed).toBe(false);
    expect(hub.clientCount).toBe(1);
  });

  it('is kept alive by the client\'s own application ping', () => {
    const { hub, clock } = makeHub();
    const peer = new FakePeer();
    hub.addClient(peer);

    // The browser client sends one every 15 seconds.
    for (let elapsed = 15_000; elapsed < CLIENT_IDLE_TIMEOUT_MS * 3; elapsed += 15_000) {
      clock.now = elapsed;
      peer.emitMessage({ type: 'ping', t: elapsed });
      hub.sweepIdleClients({ probeAfterMs: CLIENT_PROBE_AFTER_MS, idleAfterMs: CLIENT_IDLE_TIMEOUT_MS });
    }
    expect(peer.closed).toBe(false);
  });

  it('sweeps many idle peers without needing a timer each', () => {
    const { hub, clock } = makeHub();
    const peers = Array.from({ length: 50 }, () => new FakePeer());
    peers.forEach((peer) => hub.addClient(peer));

    clock.now = CLIENT_IDLE_TIMEOUT_MS + 1;
    hub.sweepIdleClients({ probeAfterMs: CLIENT_PROBE_AFTER_MS, idleAfterMs: CLIENT_IDLE_TIMEOUT_MS });
    expect(hub.clientCount).toBe(0);
  });
});

describe('who a connection belongs to', () => {
  const verifyIdentity = async (token: string) => (token.startsWith('good:') ? token.slice(5) : null);

  it('stays anonymous and fully usable when nobody says who they are', async () => {
    const { hub } = makeHub({ verifyIdentity });
    const peer = new FakePeer();
    hub.addClient(peer);

    // Stock pages are public. A connection that never identifies must work.
    peer.emitMessage({ type: 'subscribe', symbols: ['AAPL'], channels: ['trades'] });
    await Promise.resolve();
    expect(peer.closed).toBe(false);
    expect(peer.framesOfType('subscribed').at(-1)?.symbols).toEqual(['AAPL']);
  });

  it('does not disconnect a client whose token no longer verifies', async () => {
    const { hub } = makeHub({ verifyIdentity });
    const peer = new FakePeer();
    hub.addClient(peer);

    /*
     * A session that expired between page load and socket open is an ordinary
     * event, not an attack. The connection simply stays anonymous — closing it
     * would break the public page for anybody whose token went stale.
     */
    peer.emitMessage({ type: 'hello', token: 'expired-token' });
    await Promise.resolve();
    await Promise.resolve();
    expect(peer.closed).toBe(false);
  });

  it('bounds how many sockets one account may hold', async () => {
    const guard = new ConnectionCapGuard(2, 100);
    const closed: string[] = [];
    const { hub } = makeHub({
      verifyIdentity,
      acquireIdentity: (userId) => guard.acquire(userId).ok,
      releaseIdentity: (userId) => guard.release(userId),
      onClientClosed: (reason) => closed.push(reason),
    });

    const peers = Array.from({ length: 3 }, () => new FakePeer());
    for (const peer of peers) {
      hub.addClient(peer);
      peer.emitMessage({ type: 'hello', token: 'good:user-1' });
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(peers.filter((peer) => peer.closed)).toHaveLength(1);
    expect(closed).toEqual(['user-cap']);
  });

  it('returns an account\'s slot when its socket closes', async () => {
    const guard = new ConnectionCapGuard(1, 100);
    const { hub } = makeHub({
      verifyIdentity,
      acquireIdentity: (userId) => guard.acquire(userId).ok,
      releaseIdentity: (userId) => guard.release(userId),
    });

    const first = new FakePeer();
    hub.addClient(first);
    first.emitMessage({ type: 'hello', token: 'good:user-1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(guard.openFor('user-1')).toBe(1);

    first.emitClose();
    expect(guard.openFor('user-1')).toBe(0);

    // The same account can connect again immediately.
    const second = new FakePeer();
    hub.addClient(second);
    second.emitMessage({ type: 'hello', token: 'good:user-1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(second.closed).toBe(false);
  });

  /*
   * Identifying twice would let one connection hold a slot as account A and then
   * claim to be account B — the per-account cap would then count neither
   * correctly, and releasing on close would return the wrong account's slot.
   */
  it('answers only the first hello, so a connection cannot change accounts', async () => {
    const seen: string[] = [];
    const { hub } = makeHub({
      verifyIdentity: async (token) => { seen.push(token); return token.slice(5); },
    });
    const peer = new FakePeer();
    hub.addClient(peer);

    peer.emitMessage({ type: 'hello', token: 'good:user-1' });
    peer.emitMessage({ type: 'hello', token: 'good:user-2' });
    await Promise.resolve();
    expect(seen).toEqual(['good:user-1']);
  });

  it('keeps the per-account cap tighter than the per-address one', () => {
    // An address is a household or a campus; an account is one person with a
    // phone, a laptop and a few tabs.
    expect(MAX_CONNECTIONS_PER_USER).toBeLessThan(MAX_CONNECTIONS_PER_IP);
  });
});

describe('verifying a presented token', () => {
  function verifier(responses: Array<{ ok: boolean; id?: string }>, clock = { now: 0 }) {
    const calls: string[] = [];
    let index = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''));
      const answer = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        ok: answer.ok,
        json: async () => ({ id: answer.id }),
      } as Response;
    }) as unknown as typeof fetch;

    return {
      calls,
      instance: new IdentityVerifier({
        supabaseUrl: 'https://project.supabase.co',
        publishableKey: 'publishable',
        now: () => clock.now,
        fetchImpl,
      }),
      clock,
    };
  }

  it('asks the auth server rather than decoding the token itself', async () => {
    const { instance, calls } = verifier([{ ok: true, id: 'user-1' }]);
    expect(await instance.verify('token-abc')).toEqual({ userId: 'user-1' });
    expect(calls[0]).toBe('Bearer token-abc');
  });

  it('answers null for anything the auth server does not confirm', async () => {
    const { instance } = verifier([{ ok: false }]);
    expect(await instance.verify('forged')).toBeNull();
  });

  it('answers null — never a session — when the auth server cannot be reached', async () => {
    const failing = new IdentityVerifier({
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'publishable',
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    expect(await failing.verify('token')).toBeNull();
  });

  it('does not re-ask for a token it already resolved', async () => {
    const { instance, calls } = verifier([{ ok: true, id: 'user-1' }]);
    await instance.verify('token-abc');
    await instance.verify('token-abc');
    await instance.verify('token-abc');
    expect(calls).toHaveLength(1);
  });

  it('collapses a reconnect storm into one verification', async () => {
    const { instance, calls } = verifier([{ ok: true, id: 'user-1' }]);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => instance.verify('token-abc')),
    );
    expect(calls).toHaveLength(1);
    expect(results.every((result) => result?.userId === 'user-1')).toBe(true);
  });

  it('stops trusting a verdict once its window closes', async () => {
    const clock = { now: 0 };
    const { instance, calls } = verifier([{ ok: true, id: 'user-1' }, { ok: false }], clock);
    expect(await instance.verify('token-abc')).toEqual({ userId: 'user-1' });

    // A revoked session must stop counting as a session reasonably quickly.
    clock.now = 400_000;
    expect(await instance.verify('token-abc')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('never keeps the token itself', async () => {
    const { instance } = verifier([{ ok: true, id: 'user-1' }]);
    await instance.verify('super-secret-token');
    // The cache is keyed by a digest: a store of live credentials in a process
    // that runs for weeks is a credential store nobody signed up for.
    expect(JSON.stringify(instance)).not.toContain('super-secret-token');
  });
});
