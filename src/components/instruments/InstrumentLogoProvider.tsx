'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { normalizeLogoUrl } from '@/src/lib/instruments/logo-policy';

/**
 * Carries the logos a server page already resolved down to every
 * `InstrumentLogo` inside it.
 *
 * The alternative was threading a `logoUrl` through holding rows, expanded
 * detail panels and mobile cards — which is exactly how the pages drifted apart
 * in the first place, each passing `null` because the value was not in scope.
 * One provider per page keeps the resolver single, and a component that is
 * handed its own URL still wins over it.
 */

const InstrumentLogoContext = createContext<Readonly<Record<string, string | null>>>({});

export function InstrumentLogoProvider({
  logos,
  children,
}: {
  logos: Readonly<Record<string, string | null>>;
  children: ReactNode;
}) {
  const value = useMemo(() => logos, [logos]);
  return (
    <InstrumentLogoContext.Provider value={value}>
      {children}
    </InstrumentLogoContext.Provider>
  );
}

/**
 * Logos a mutation resolved after this page was rendered.
 *
 * When a symbol is added to a portfolio or watchlist, the server action resolves
 * and persists its logo and returns the URL. Handing it to this store paints it
 * everywhere that symbol is on screen, immediately — no navigation, no reload,
 * and no second request to discover what the mutation already knew.
 *
 * Writes are one-way on purpose: `null` and unusable values are ignored, so a
 * response that simply has nothing to say can never blank a logo that works.
 */
const resolvedLogos = new Map<string, string>();
const listeners = new Set<() => void>();

export function rememberInstrumentLogo(symbol: string, logoUrl: string | null | undefined): void {
  const normalized = normalizeLogoUrl(logoUrl);
  if (!normalized) return;
  const key = symbol.trim().toUpperCase();
  if (!key || resolvedLogos.get(key) === normalized) return;
  resolvedLogos.set(key, normalized);
  for (const listener of listeners) listener();
}

/** Test seam: forgets everything mutations have resolved in this tab. */
export function resetRememberedInstrumentLogos(): void {
  resolvedLogos.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The URL to draw for `symbol`.
 *
 * An explicit prop that is `null`, `''` or unusable is treated as "this caller
 * has nothing to say", not as "this instrument has no logo" — otherwise the
 * page's own resolved logo would be overwritten by a placeholder argument. The
 * same rule orders the three sources: whatever is real wins, and nothing that is
 * empty displaces it.
 */
export function useInstrumentLogoUrl(
  symbol: string,
  explicit?: string | null,
): string | null {
  const logos = useContext(InstrumentLogoContext);
  const key = symbol.trim().toUpperCase();
  const remembered = useSyncExternalStore(
    subscribe,
    useCallback(() => resolvedLogos.get(key) ?? null, [key]),
    () => null,
  );
  return normalizeLogoUrl(explicit)
    ?? normalizeLogoUrl(logos[key])
    ?? remembered;
}
