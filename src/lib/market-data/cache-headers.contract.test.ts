import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A response behind a session may never be kept by a cache this product does
 * not control.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE CONTRACT FROM `api-access.contract.test.ts`
 * ===========================================================================
 * That one asks "is this route reachable without a session". This one asks
 * "and if it is not, does its answer say so". They fail independently, and the
 * combination is the one that actually leaks: `/api/market/industry/{slug}/chart`
 * was, for the length of one change, a route with a session check that answered
 * `Cache-Control: public, s-maxage=60`. A shared cache holding that 200 hands
 * it to the next caller who has no session at all — the authentication above
 * it undone by a header below it, with no test failing in between.
 *
 * ===========================================================================
 * WHY IT READS SOURCE
 * ===========================================================================
 * The failure mode is a line somebody adds. A runtime test covers the routes
 * that exist today; this covers the one written next month, and names the file
 * when it is wrong.
 */

const API_ROOT = join(process.cwd(), 'app', 'api');
const GOVERNED_PREFIXES = ['market', 'analytics', 'news', 'option-simulations', 'tools'];

/** Any of these makes a route unreachable without a session. */
const SESSION_GUARDS = [
  'guardAuthenticatedMarketRoute',
  'guardOrphanMarketRoute',
  'guardRouteEntitlement',
  'resolveRequestAccountAccess',
  'auth.getUser',
];

/**
 * `public` in a Cache-Control the route sets itself, or `sharedCache: true`
 * handed to a response helper. Both make the answer storable by an
 * intermediary, and both are wrong on a route that required a session.
 */
const SHARED_CACHE_MARKERS = [/Cache-Control['"],?\s*[`'"]public/, /['"]Cache-Control['"]:\s*[`'"]public/, /sharedCache:\s*true/];

function routeFiles(directory: string, prefix: string[] = []): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full, [...prefix, entry]));
    else if (entry === 'route.ts') found.push(prefix.join('/'));
  }
  return found;
}

function source(route: string): string {
  return readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8');
}

describe('cache headers on authenticated routes', () => {
  const governed = routeFiles(API_ROOT)
    .filter((route) => GOVERNED_PREFIXES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`)));

  it('finds the governed routes at all', () => {
    expect(governed.length).toBeGreaterThan(10);
  });

  it('never lets a session-guarded route answer with a shared-cacheable header', () => {
    const leaking = governed.filter((route) => {
      const text = source(route);
      const guarded = SESSION_GUARDS.some((guard) => text.includes(guard));
      if (!guarded) return false;
      /*
       * `withEntitledCacheHeaders` runs last and replaces whatever came before
       * with `private, no-store` plus `Vary: Cookie`, so a route that ends with
       * it is safe even if a helper set something shared on the way. That is
       * the one legitimate ordering, and it is recognised rather than assumed:
       * a route WITHOUT it and WITH a shared marker has nothing correcting it.
       */
      if (text.includes('withEntitledCacheHeaders')) return false;
      return SHARED_CACHE_MARKERS.some((marker) => marker.test(text));
    });

    expect(
      leaking,
      'routes that require a session but allow a shared cache to keep the answer — '
      + 'use a private Cache-Control with Vary: Cookie, or withEntitledCacheHeaders',
    ).toEqual([]);
  });

  it('keeps the response helpers private unless a route opts in', () => {
    const helper = readFileSync(join(process.cwd(), 'src', 'lib', 'market-data', 'route.ts'), 'utf8');
    /*
     * The default is the whole point. If `public` ever became reachable without
     * `sharedCache`, every route in the tree would silently become shareable
     * again and the sweep above would still pass, because it only looks at
     * routes that name it.
     */
    const applyBody = helper.slice(helper.indexOf('function applyFreshnessCacheHeaders'));
    const body = applyBody.slice(0, applyBody.indexOf('\n}\n'));
    expect(body).toContain('if (sharedCache) {');
    expect(body).toContain("'Vary'");
    // The private branch is what runs when nobody opted in.
    expect(body).toContain('private, max-age=');
  });
});
