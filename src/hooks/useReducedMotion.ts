'use client';

import { useSyncExternalStore } from 'react';

/**
 * Reads the motion decision the app has already made, rather than making a
 * second one.
 *
 * `AppRuntime` resolves the reader's saved preference against the OS
 * `prefers-reduced-motion` query and writes the answer to `data-reduce-motion`
 * on <html>; every reduced-motion rule in globals.css keys off that attribute.
 * A component that queried `matchMedia` directly would disagree with the CSS
 * for anyone who set the in-app preference to "normal" on a system that asks
 * for reduced motion — so this observes the attribute instead.
 *
 * The server snapshot is `false`, which is also the state before AppRuntime's
 * effect runs: nothing has moved yet at that point, so there is nothing to
 * suppress, and hydration renders the same markup the server sent.
 */
const subscribe = (onChange: () => void) => {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-reduce-motion'],
  });
  return () => observer.disconnect();
};

const getSnapshot = () => document.documentElement.hasAttribute('data-reduce-motion');
const getServerSnapshot = () => false;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
