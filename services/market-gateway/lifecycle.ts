/**
 * Ordered teardown for the Gateway process.
 *
 * A production instance must never be left in an unknown state: a SIGTERM (the
 * platform draining the container), a SIGINT (an operator), or a fatal
 * `uncaughtException` / `unhandledRejection` all funnel through {@link
 * GatewayLifecycle.shutdown}, which tears everything down in a fixed order and
 * then exits. Every collaborator is injected so the sequence can be asserted
 * deterministically without a real socket, timer, or process.
 */

export interface LifecycleDeps {
  /** Stop the single provider upstream connection (cancels its own timers). */
  stopUpstream: () => void;
  /** Close every accepted browser peer. */
  closePeers: () => void;
  /** Stop accepting WebSocket upgrades; invoke the callback once drained. */
  closeWebSocketServer: (done: () => void) => void;
  /** Stop the HTTP listener; invoke the callback once closed. */
  closeHttpServer: (done: () => void) => void;
  /** Cancel any Gateway-owned timers (rate-guard sweeps, watchdogs). */
  clearTimers: () => void;
  /** Terminate the process with the given code. */
  exit: (code: number) => void;
  /** Sanitized structured logger — MUST NOT receive credentials. */
  log: (level: 'info' | 'error', message: string, detail?: unknown) => void;
  /**
   * Schedules the force-exit fallback so a wedged `close` cannot hang draining
   * forever. Returns a canceller. Injected for deterministic tests.
   */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  /** How long to wait for graceful close before force-exiting. */
  forceExitMs?: number;
}

const DEFAULT_FORCE_EXIT_MS = 5_000;

export class GatewayLifecycle {
  private shuttingDown = false;

  constructor(private readonly deps: LifecycleDeps) {}

  /**
   * Tear down in order — timers → upstream → peers → WS server → HTTP server —
   * then exit with `code`. Idempotent: a second signal during draining is
   * ignored so we never double-close or double-exit.
   */
  shutdown(code: number, reason: string): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.deps.log('info', `shutting down (${reason})`);

    // A hung close must not strand the container; force-exit is the backstop.
    const schedule = this.deps.schedule ?? defaultSchedule;
    const cancelForceExit = schedule(() => {
      this.deps.log('error', 'graceful shutdown timed out; forcing exit');
      this.deps.exit(code);
    }, this.deps.forceExitMs ?? DEFAULT_FORCE_EXIT_MS);

    // Cancel timers first so nothing reschedules work mid-teardown.
    this.safely(this.deps.clearTimers, 'clearTimers');
    this.safely(this.deps.stopUpstream, 'stopUpstream');
    this.safely(this.deps.closePeers, 'closePeers');

    this.deps.closeWebSocketServer(() => {
      this.deps.closeHttpServer(() => {
        cancelForceExit();
        this.deps.exit(code);
      });
    });
  }

  /**
   * A fatal, unrecoverable error. Log it sanitized, drain, then exit non-zero —
   * never leave the process running in an undefined state.
   */
  handleFatal(reason: string, detail: unknown): void {
    this.deps.log('error', `fatal: ${reason}`, detail);
    this.shutdown(1, `fatal:${reason}`);
  }

  private safely(step: () => void, label: string): void {
    try {
      step();
    } catch (error) {
      // A failure in one teardown step must not abort the rest of the sequence.
      this.deps.log('error', `teardown step failed: ${label}`, error);
    }
  }
}

const defaultSchedule: NonNullable<LifecycleDeps['schedule']> = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  // Do not let the force-exit backstop itself keep the event loop alive.
  handle.unref?.();
  return () => clearTimeout(handle);
};
