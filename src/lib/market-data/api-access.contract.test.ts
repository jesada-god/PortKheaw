import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The public API surface, pinned to the pages that justify it.
 *
 * ===========================================================================
 * WHY THIS IS A SOURCE-READING TEST
 * ===========================================================================
 * The rule the product decided on is "an endpoint is public exactly when a
 * page a signed-out visitor can reach needs it". That is a statement about the
 * whole route tree, and it is broken by ADDING a file — a new route handler
 * with no guard is public by default, and no runtime test of the existing
 * routes would notice.
 *
 * So this reads the tree. A new market, analytics or news route either carries
 * a guard or is named here as deliberately public, and the failure names the
 * file. It is the same technique the repository already uses for its other
 * whole-tree contracts.
 */

const API_ROOT = join(process.cwd(), 'app', 'api');

/** The route groups the public/authenticated split covers. */
const GOVERNED_PREFIXES = ['market', 'analytics', 'news'];

/**
 * Endpoints a signed-out visitor may reach, each with the page that requires
 * it. `/stock/{symbol}` and `/search` are the only public pages, so this list
 * cannot grow without one of them gaining a need or another page becoming
 * public — which is a product decision, not a refactor.
 */
const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  'market/profile/[symbol]': '/stock/{symbol} — the company profile card',
  'market/quote/[symbol]': '/stock/{symbol} header price, and /search result rows',
  'market/search': '/search — the symbol lookup',
  'market/candles': '/stock/{symbol} — the price chart',
  'market/history/[symbol]': '/stock/{symbol} — the historical series',
  'market/chart-levels': '/stock/{symbol} — support/resistance overlay',
  'analytics/analyst-target/[symbol]': '/stock/{symbol} — the analyst consensus card',
  'analytics/key-statistics/[symbol]': '/stock/{symbol} — the key statistics card',
  'news/summary/[symbol]': '/stock/{symbol} — the News tab',
  /*
   * Public to reach, but never free: each of these opens with
   * `guardRouteEntitlement`, which refuses an anonymous caller before any
   * provider is touched. They are listed so the sweep below does not demand a
   * session guard on top of an entitlement guard that already refuses harder.
   */
  'market/options/chain': '/stock/{symbol} — entitlement-guarded',
  'market/options/expirations': '/stock/{symbol} — entitlement-guarded',
  'market/options/walls': '/stock/{symbol} — entitlement-guarded',
  'analytics/options-signal/[symbol]': '/stock/{symbol} — entitlement-guarded',
};

/** Any of these in a route file means the route is not anonymously reachable. */
const GUARDS = [
  'guardAuthenticatedMarketRoute',
  'guardOrphanMarketRoute',
  'guardRouteEntitlement',
  'resolveRequestAccountAccess',
  'auth.getUser',
];

function routeFiles(directory: string, prefix: string[] = []): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...routeFiles(full, [...prefix, entry]));
    } else if (entry === 'route.ts') {
      found.push(prefix.join('/'));
    }
  }
  return found;
}

describe('public API surface', () => {
  const governed = routeFiles(API_ROOT)
    .filter((route) => GOVERNED_PREFIXES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`)));

  it('finds the governed routes at all', () => {
    // A path bug that returned nothing would make every assertion below pass
    // while checking nothing.
    expect(governed.length).toBeGreaterThan(10);
  });

  it('requires a guard on every governed route that is not deliberately public', () => {
    const unguarded = governed
      .filter((route) => !(route in PUBLIC_ROUTES))
      .filter((route) => {
        const source = readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8');
        return !GUARDS.some((guard) => source.includes(guard));
      });

    expect(
      unguarded,
      'routes reachable without a session that are not listed in PUBLIC_ROUTES — '
      + 'add the guard, or add the route with the public page that needs it',
    ).toEqual([]);
  });

  it('keeps every deliberately public route real', () => {
    // A renamed or deleted route left in the list would quietly stop the sweep
    // above from covering its replacement.
    const missing = Object.keys(PUBLIC_ROUTES).filter((route) => !governed.includes(route));
    expect(missing, 'PUBLIC_ROUTES entries with no route file').toEqual([]);
  });
});
