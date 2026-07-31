import { describe, expect, it } from 'vitest';
import {
  INITIAL_KHEAW_LOADER_STATE,
  KHEAW_LOADER_DELAY_MS,
  KHEAW_LOADER_FADE_MS,
  KHEAW_LOADER_MIN_VISIBLE_MS,
  isKheawLoaderMounted,
  kheawLoaderTimeout,
  reduceKheawLoader,
  type KheawLoaderEvent,
  type KheawLoaderState,
} from './loading-visibility';

/**
 * The timing rules on their own. Every awkward ordering the UI can produce is a
 * sequence here — a request finishing either side of a threshold, a retry
 * landing mid-fade, a section that refetches while it is still waiting on its
 * first attempt.
 */

const activate: KheawLoaderEvent = { type: 'activate' };
const settle: KheawLoaderEvent = { type: 'settle' };
/** The timer for the current phase firing. */
const elapsed: KheawLoaderEvent = { type: 'elapsed' };

function run(...script: KheawLoaderEvent[]): KheawLoaderState {
  return script.reduce(reduceKheawLoader, INITIAL_KHEAW_LOADER_STATE);
}

/** The timer this state would run. */
const timeout = (state: KheawLoaderState) =>
  kheawLoaderTimeout(state.phase, state.minimumServed);

describe('Kheaw loader timing', () => {
  it('starts hidden and asks for no timer', () => {
    expect(INITIAL_KHEAW_LOADER_STATE.phase).toBe('hidden');
    expect(timeout(INITIAL_KHEAW_LOADER_STATE)).toBeNull();
  });

  it('draws nothing during the grace, and runs the grace timer', () => {
    const armed = run(activate);
    expect(armed.phase).toBe('armed');
    expect(isKheawLoaderMounted(armed.phase)).toBe(false);
    expect(timeout(armed)).toBe(KHEAW_LOADER_DELAY_MS);
  });

  it('never shows the mascot for a request that settles inside the grace', () => {
    const state = run(activate, settle);
    expect(state.phase).toBe('hidden');
    expect(timeout(state)).toBeNull();
  });

  it('shows the mascot once the grace has run out', () => {
    const state = run(activate, elapsed);
    expect(state.phase).toBe('visible');
    expect(isKheawLoaderMounted(state.phase)).toBe(true);
    expect(timeout(state)).toBe(KHEAW_LOADER_MIN_VISIBLE_MS);
  });

  it('holds the mascot for the full minimum when the request lands early', () => {
    const settledEarly = run(activate, elapsed, settle);

    // Still on screen, still counting down the same window — the settle did not
    // shorten it and, just as importantly, did not restart it.
    expect(settledEarly.phase).toBe('visible');
    expect(settledEarly.settleRequested).toBe(true);
    expect(timeout(settledEarly)).toBe(KHEAW_LOADER_MIN_VISIBLE_MS);

    const handedOver = reduceKheawLoader(settledEarly, elapsed);
    expect(handedOver.phase).toBe('leaving');
    expect(timeout(handedOver)).toBe(KHEAW_LOADER_FADE_MS);
  });

  it('starts the fade immediately when the minimum is already served', () => {
    const served = run(activate, elapsed, elapsed);
    expect(served.phase).toBe('visible');
    expect(served.minimumServed).toBe(true);
    // Nothing left to wait for but the request itself.
    expect(timeout(served)).toBeNull();

    const leaving = reduceKheawLoader(served, settle);
    expect(leaving.phase).toBe('leaving');
    expect(timeout(leaving)).toBe(KHEAW_LOADER_FADE_MS);
  });

  it('lets go once the fade is over', () => {
    const done = run(activate, elapsed, elapsed, settle, elapsed);
    expect(done.phase).toBe('hidden');
    expect(timeout(done)).toBeNull();
  });

  describe('overlapping requests', () => {
    it('measures the grace from the first request, not the latest retry', () => {
      const armed = run(activate);
      // Same reference through every retry: no re-render, so the grace timer
      // the hook already scheduled keeps running rather than restarting.
      expect(reduceKheawLoader(armed, activate)).toBe(armed);
      expect(run(activate, activate, activate)).toStrictEqual(armed);
      expect(reduceKheawLoader(armed, elapsed).phase).toBe('visible');
    });

    it('cancels a pending hand-off when a new request starts', () => {
      const pending = run(activate, elapsed, settle);
      expect(pending.settleRequested).toBe(true);

      const restarted = reduceKheawLoader(pending, activate);
      expect(restarted.phase).toBe('visible');
      expect(restarted.settleRequested).toBe(false);
      // The window it was already serving is untouched, so the loader neither
      // hands over early nor gets a fresh 500ms every time a retry fires.
      expect(timeout(restarted)).toBe(KHEAW_LOADER_MIN_VISIBLE_MS);
      // And the old hand-off cannot fire late.
      expect(reduceKheawLoader(restarted, elapsed).phase).toBe('visible');
    });

    it('brings the mascot back if a request restarts mid-fade', () => {
      const leaving = run(activate, elapsed, elapsed, settle);
      const restarted = reduceKheawLoader(leaving, activate);
      expect(restarted.phase).toBe('visible');
      // A full minimum-visible window again, so the second wait cannot be cut
      // shorter than the first.
      expect(restarted.minimumServed).toBe(false);
      expect(timeout(restarted)).toBe(KHEAW_LOADER_MIN_VISIBLE_MS);
      expect(reduceKheawLoader(restarted, settle).phase).toBe('visible');
    });

    it('re-arms cleanly after a settled cycle', () => {
      const done = run(activate, elapsed, elapsed, settle, elapsed);
      expect(done.phase).toBe('hidden');
      const again = reduceKheawLoader(done, activate);
      expect(again.phase).toBe('armed');
      expect(again.minimumServed).toBe(false);
      expect(again.settleRequested).toBe(false);
    });
  });

  describe('events that cannot move the machine', () => {
    it('returns the same object so a caller cannot loop on a no-op', () => {
      expect(reduceKheawLoader(INITIAL_KHEAW_LOADER_STATE, settle))
        .toBe(INITIAL_KHEAW_LOADER_STATE);
      expect(reduceKheawLoader(INITIAL_KHEAW_LOADER_STATE, elapsed))
        .toBe(INITIAL_KHEAW_LOADER_STATE);

      const armed = run(activate);
      expect(reduceKheawLoader(armed, activate)).toBe(armed);

      const shown = run(activate, elapsed);
      expect(reduceKheawLoader(shown, activate)).toBe(shown);

      const leaving = run(activate, elapsed, elapsed, settle);
      expect(reduceKheawLoader(leaving, settle)).toBe(leaving);
    });
  });

  it('keeps the three phase timers distinct', () => {
    /*
     * The React hook keys its timer on (phase, minimumServed) precisely so it
     * does not have to rely on this — but two equal thresholds would still make
     * the machine's behaviour ambiguous to read, and this is the cheapest place
     * to notice that.
     */
    const spans = [KHEAW_LOADER_DELAY_MS, KHEAW_LOADER_MIN_VISIBLE_MS, KHEAW_LOADER_FADE_MS];
    expect(new Set(spans).size).toBe(spans.length);
    // The fade has to fit inside the 180–220ms the design calls for.
    expect(KHEAW_LOADER_FADE_MS).toBeGreaterThanOrEqual(180);
    expect(KHEAW_LOADER_FADE_MS).toBeLessThanOrEqual(220);
  });
});
