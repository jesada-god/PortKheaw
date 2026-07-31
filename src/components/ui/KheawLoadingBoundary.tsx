'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { KheawLoader, type KheawLoaderProps } from './KheawLoader';
import { cn } from '@/src/utils/cn';
import {
  INITIAL_KHEAW_LOADER_STATE,
  kheawLoaderTimeout,
  reduceKheawLoader,
  type KheawLoaderPhase,
} from '@/src/lib/ui/loading-visibility';

/**
 * Drives `KheawLoader` from a client request's own loading flag.
 *
 * Everything the timing rules in `@/src/lib/ui/loading-visibility` promise is
 * enforced here: a request that finishes inside the grace never mounts the
 * mascot, one that outruns it keeps the mascot for the full minimum, and the
 * content is mounted underneath before the fade starts so there is no empty
 * frame in between. No request is ever held back — the minimum applies to the
 * loader, never to the data.
 */

/**
 * Tracks the loader phase for a request. `active` is "a request is in flight
 * AND there is nothing to show yet"; see `KheawLoadingBoundary` for why the
 * second half matters.
 */
export function useKheawLoaderPhase(active: boolean): KheawLoaderPhase {
  const [state, setState] = useState(INITIAL_KHEAW_LOADER_STATE);
  /*
   * Mirrors `active` so the machine can be advanced during render — React's
   * recommended shape for state that derives from a prop change. An effect
   * would work the same transition out one commit later, and a commit is
   * exactly long enough for a settled request to paint an empty box first.
   * Seeded `false` so a component that mounts already loading arms on its very
   * first render.
   */
  const [observedActive, setObservedActive] = useState(false);

  if (observedActive !== active) {
    setObservedActive(active);
    setState((current) => reduceKheawLoader(
      current,
      { type: active ? 'activate' : 'settle' },
    ));
  }

  const { phase, minimumServed } = state;
  const delay = kheawLoaderTimeout(phase, minimumServed);

  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(
      () => setState((current) => reduceKheawLoader(current, { type: 'elapsed' })),
      delay,
    );
    /*
     * Covers a re-render, a restarted request and an unmount alike: at most one
     * timer is ever outstanding, and none survives this component.
     *
     * The dependencies are the two things the timer's duration is derived from,
     * not the state object. A request settling inside the minimum-visible
     * window changes the state but must NOT restart that window's timer —
     * depending on the object would silently extend the wait every time.
     */
    return () => clearTimeout(timer);
  }, [delay, phase]);

  return phase;
}

export interface KheawLoadingBoundaryProps
  extends Pick<KheawLoaderProps, 'variant' | 'message'> {
  /** A request is in flight. */
  loading: boolean;
  /**
   * There is already something worth showing — a previous result, a cached
   * snapshot, a server-rendered value. When true the loader stays out of the
   * way entirely and `children` render throughout, so a background revalidation
   * never blanks out data the reader is already looking at.
   */
  ready?: boolean;
  /** Loaded content, or the existing empty/error state once a request fails. */
  children: ReactNode;
  className?: string;
}

export function KheawLoadingBoundary({
  loading,
  ready = false,
  variant = 'section',
  message,
  children,
  className,
}: KheawLoadingBoundaryProps) {
  const phase = useKheawLoaderPhase(loading && !ready);

  // Settled: no wrapper, no overlay, nothing left behind.
  if (phase === 'hidden') return <>{children}</>;

  /*
   * Inside the grace. An empty box the size of the loader holds the space the
   * section is about to occupy — reserving it here is what keeps a fast request
   * from expanding the page a moment after it collapsed it. The mascot, the
   * bubble and the live region are all absent, so nothing is announced and
   * nothing is painted for a wait that may never be worth mentioning.
   */
  if (phase === 'armed') {
    return (
      <div
        aria-hidden="true"
        data-kheaw-loader="pending"
        className={cn('kheaw-loader', `kheaw-loader--${variant}`, className)}
      />
    );
  }

  const leaving = phase === 'leaving';
  return (
    <div className="kheaw-loader-host">
      {/* Mounted before the fade begins, so the loader dissolves onto real
          content rather than onto a blank frame. */}
      {leaving ? children : null}
      <KheawLoader
        variant={variant}
        message={message}
        leaving={leaving}
        className={leaving ? 'kheaw-loader--overlay' : className}
      />
    </div>
  );
}
