'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/**
 * `false` on the server and during the hydration render, `true` immediately
 * after. Lets a component hold back browser-only work (portals, a request that
 * depends on restored localStorage) without a setState-in-effect cascade and
 * without risking a hydration mismatch.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
}
