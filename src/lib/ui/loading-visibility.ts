/**
 * Timing rules for the Kheaw loading indicator, as a pure state machine.
 *
 * The whole point is that a wait short enough not to notice must not be
 * decorated, and a wait long enough to notice must not be decorated for so
 * short a time that the decoration itself becomes the glitch. Two thresholds do
 * that:
 *
 *   - nothing is shown for the first 300ms, so a fast request renders its
 *     content with the loader never mounted — not hidden, never mounted;
 *   - once the loader HAS been shown it stays for at least 500ms, so a request
 *     that lands at 310ms cannot flash the mascot for a tenth of a second.
 *
 * The minimum only ever applies after the loader is on screen, so it can never
 * hold data back: content is rendered the moment it arrives and the loader
 * dissolves off the top of it.
 *
 * There is deliberately no clock in here. Each phase owns one timer, and
 * `elapsed` is that timer reporting back — which keeps the whole machine a
 * synchronous, exhaustively testable function, and keeps `Date.now()` out of a
 * React render where it would make the component non-idempotent.
 */

/** Grace before a wait is worth decorating. */
export const KHEAW_LOADER_DELAY_MS = 300;
/** Once shown, the shortest time the mascot may stay on screen. */
export const KHEAW_LOADER_MIN_VISIBLE_MS = 500;
/** Cross-fade from loader to content. */
export const KHEAW_LOADER_FADE_MS = 200;

export type KheawLoaderPhase =
  /** No request in flight, or one that finished inside the grace. */
  | 'hidden'
  /** A request is in flight but still inside the grace: nothing is drawn. */
  | 'armed'
  /** The mascot is on screen. */
  | 'visible'
  /** Content has arrived; the mascot is dissolving off it. */
  | 'leaving';

export interface KheawLoaderState {
  readonly phase: KheawLoaderPhase;
  /** The minimum-visible window for this appearance has already closed. */
  readonly minimumServed: boolean;
  /** A request settled while that window was still open. */
  readonly settleRequested: boolean;
}

export type KheawLoaderEvent =
  /** A request started, or is still running. */
  | { readonly type: 'activate' }
  /** A request finished — resolved or rejected; the loader treats both alike. */
  | { readonly type: 'settle' }
  /** The timer for the current phase fired. */
  | { readonly type: 'elapsed' };

export const INITIAL_KHEAW_LOADER_STATE: KheawLoaderState = {
  phase: 'hidden',
  minimumServed: false,
  settleRequested: false,
};

function enter(phase: KheawLoaderPhase): KheawLoaderState {
  return { phase, minimumServed: false, settleRequested: false };
}

/**
 * Advances the machine. Returns the state object unchanged — same reference —
 * whenever an event does not apply, so a React caller can store it directly
 * without a redundant render.
 */
export function reduceKheawLoader(
  state: KheawLoaderState,
  event: KheawLoaderEvent,
): KheawLoaderState {
  switch (state.phase) {
    case 'hidden':
      return event.type === 'activate' ? enter('armed') : state;

    case 'armed':
      /*
       * `activate` is a no-op on purpose: the grace is measured from the first
       * request, not the latest one. Re-arming it on every retry would let a
       * section that keeps refetching stay blank indefinitely.
       */
      if (event.type === 'activate') return state;
      // Finished inside the grace — the loader was never mounted, and now
      // never will be for this request.
      return event.type === 'settle' ? enter('hidden') : enter('visible');

    case 'visible':
      if (event.type === 'activate') {
        // A new request landed inside the minimum-visible window; the loader
        // stays up and the pending hand-off is cancelled.
        return state.settleRequested ? { ...state, settleRequested: false } : state;
      }
      if (event.type === 'settle') {
        return state.minimumServed
          ? enter('leaving')
          : { ...state, settleRequested: true };
      }
      // The minimum-visible window just closed.
      return state.settleRequested
        ? enter('leaving')
        : { ...state, minimumServed: true };

    case 'leaving':
      // Restarted mid-fade: bring the loader back rather than let it finish
      // dissolving into content that is already stale again.
      if (event.type === 'activate') return enter('visible');
      return event.type === 'elapsed' ? enter('hidden') : state;
  }
}

/**
 * How long the timer for this phase runs, or `null` when the phase is waiting
 * on the request rather than on a timer.
 *
 * Takes the two fields it actually depends on rather than the whole state, so a
 * caller can use the result as an effect dependency: a `settle` that only sets
 * `settleRequested` must NOT restart the minimum-visible timer, and passing the
 * state object would make that impossible to express.
 */
export function kheawLoaderTimeout(
  phase: KheawLoaderPhase,
  minimumServed: boolean,
): number | null {
  switch (phase) {
    case 'armed':
      return KHEAW_LOADER_DELAY_MS;
    case 'visible':
      return minimumServed ? null : KHEAW_LOADER_MIN_VISIBLE_MS;
    case 'leaving':
      return KHEAW_LOADER_FADE_MS;
    default:
      return null;
  }
}

/** Whether the mascot is on screen in this phase. */
export function isKheawLoaderMounted(phase: KheawLoaderPhase): boolean {
  return phase === 'visible' || phase === 'leaving';
}
