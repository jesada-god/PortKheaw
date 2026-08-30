import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  marketEventsCardEnabled,
  marketStatusCardEnabled,
  newsFilterEnabled,
  overviewV2Enabled,
  watchlistV2Enabled,
  whatChangedCardEnabled,
} from './features';

/**
 * THE SIX PHASE 2 FLAGS, AUDITED AGAINST THE CODE RATHER THAN THE DOCS.
 *
 * ===========================================================================
 * WHY THIS EXISTS SEPARATELY FROM features.test.ts
 * ===========================================================================
 * `features.test.ts` proves `featureFlagEnabled` itself — that the PARSER
 * treats an unset variable as off. That is a different claim from "every one of
 * these six is off by default", and the gap between them is exactly one
 * character: a second argument. `analystConsensusEnabled` passes `true` as the
 * default and is on unless disabled, which is legitimate and is precisely why
 * the parser test cannot stand in for this one — the same helper produces
 * default-on and default-off flags depending on a call site nobody re-reads.
 *
 * So each of the six is called here with its variable genuinely absent, and the
 * source is scanned to prove none of them passes a default at all.
 *
 * ===========================================================================
 * OFF MUST MEAN FREE, NOT MERELY INVISIBLE
 * ===========================================================================
 * A flag that hides a card while still paying for its data is not a shipping
 * switch, it is a blindfold. `MARKET_STATUS_CARD` gates six provider calls and
 * `WHAT_CHANGED_CARD` gates a daily-bar read; both must be READ BEFORE the load
 * is issued, which in JavaScript means the load sits on the far side of a
 * conditional rather than inside a promise that is created and then discarded.
 *
 * `await x ? a() : b()` and `x ? await a() : b()` look alike and are not: the
 * second only ever calls one of them. The behavioural half of this file proves
 * the flag path actually short-circuits; the source half proves the shape that
 * makes it possible.
 */

const FLAGS = [
  { name: 'MARKET_STATUS_CARD', read: marketStatusCardEnabled },
  { name: 'WATCHLIST_V2', read: watchlistV2Enabled },
  { name: 'WHAT_CHANGED_CARD', read: whatChangedCardEnabled },
  { name: 'MARKET_EVENTS_CARD', read: marketEventsCardEnabled },
  { name: 'NEWS_FILTER', read: newsFilterEnabled },
  { name: 'OVERVIEW_V2', read: overviewV2Enabled },
] as const;

const read = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the six Phase 2 flags are off by default', () => {
  it.each(FLAGS)('$name is off when the variable is absent', ({ name, read: isEnabled }) => {
    const original = process.env[name];
    try {
      delete process.env[name];
      expect(isEnabled()).toBe(false);
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });

  it.each(FLAGS)('$name is off for every value that is not "true"', ({ name, read: isEnabled }) => {
    for (const value of ['', 'false', 'FALSE', '0', '1', 'yes', 'on', 'True ']) {
      vi.stubEnv(name, value);
      const expected = value.trim().toLowerCase() === 'true';
      expect(isEnabled(), `${name}=${JSON.stringify(value)}`).toBe(expected);
    }
  });

  it.each(FLAGS)('$name turns on only for an explicit true', ({ name, read: isEnabled }) => {
    vi.stubEnv(name, 'true');
    expect(isEnabled()).toBe(true);
  });

  /*
   * The default is not passed anywhere. `featureFlagEnabled(value, true)` is a
   * one-token change that would flip a flag to default-ON while every test
   * above still passed locally, because a developer's shell rarely has these
   * set either way. Reading the source is the only way to catch the shape.
   */
  it('passes no default argument for any of the six', () => {
    const source = read('src/config/features.ts');
    for (const { name } of FLAGS) {
      const call = new RegExp(`featureFlagEnabled\\(process\\.env\\.${name}\\s*\\)`);
      expect(source, `${name} must call featureFlagEnabled with no default`).toMatch(call);
    }
  });
});

/**
 * WHERE THE FLAG IS READ RELATIVE TO THE SPEND.
 *
 * Each entry names the file that must contain the guard and the loader that
 * must not run without it. Scanned with comments stripped, because several of
 * these modules explain the guarantee in prose directly above the code that
 * keeps it, and a scan that could not tell the two apart would forbid
 * documenting it.
 */
const code = (relative: string) => read(relative)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*/g, '');

describe('a flag that is off costs nothing', () => {
  /*
   * MARKET_STATUS_CARD is the expensive one: six provider quotes, one per
   * instrument on the card. The guard is a ternary, so with the flag off the
   * promise is never constructed — not constructed and ignored, which would
   * still have been billed.
   */
  it('reads MARKET_STATUS_CARD before building the market-status promise', () => {
    const page = code('app/page.tsx');
    expect(page).toMatch(/marketStatusCardEnabled\(\)\s*\?/);
    // The loaders appear only inside that conditional.
    const guard = page.indexOf('marketStatusCardEnabled()');
    const undefinedBranch = page.indexOf(': undefined', guard);
    const region = page.slice(guard, undefinedBranch);
    expect(region).toContain('loadMarketStatusWithHistory');
    expect(region).toContain('loadMarketStatus(');
    /*
      And CALLED nowhere else on the page. Matched with the opening paren: the
      import at the top names both loaders and is not a call, so a bare name
      match would fail here for the one reason that carries no cost.
    */
    for (const outside of [page.slice(0, guard), page.slice(undefinedBranch)]) {
      expect(outside).not.toContain('loadMarketStatus(');
      expect(outside).not.toContain('loadMarketStatusWithHistory(');
    }
  });

  it('reads WHAT_CHANGED_CARD before the daily-bar load', () => {
    const service = code('src/lib/watchlist/service.ts');
    expect(service).toMatch(/whatChangedCardEnabled\(\)\s*\?/);
    const guard = service.indexOf('whatChangedCardEnabled()');
    expect(service.slice(0, guard)).not.toContain('loadWhatChanged(');
    expect(service.slice(guard)).toContain('loadWhatChanged(');
  });

  it('reads MARKET_EVENTS_CARD before rendering the route at all', () => {
    const route = code('app/market-events/page.tsx');
    const guard = route.indexOf('marketEventsCardEnabled()');
    expect(guard).toBeGreaterThan(-1);
    expect(route).toContain('notFound()');
    // Nothing is loaded above the guard — not even the Supabase client.
    expect(route.slice(0, guard)).not.toContain('createClient(');
    expect(route.slice(0, guard)).not.toContain('await ');
  });

  /*
   * The three cheap flags, asserted as cheap rather than assumed to be.
   *
   * MARKET_EVENTS_CARD on the overview and OVERVIEW_V2 buy no data at all —
   * the calendar is a static import and the ordering is a pure function — and
   * NEWS_FILTER changes the PARAMETERS of a request the page was already
   * making. Pinning that here is what stops a later "just fetch the tags
   * server-side" turning a render switch into a spending one.
   */
  it('spends nothing for MARKET_EVENTS_CARD or OVERVIEW_V2 on the overview', () => {
    const page = code('app/page.tsx');
    expect(page).toContain('buildMarketEventsCardView({ now: generatedAt })');
    expect(page).not.toMatch(/await\s+buildMarketEventsCardView/);
    expect(page).toContain('overviewV2: overviewV2Enabled()');

    const cardView = code('src/lib/market-events/card-view.ts');
    expect(cardView).not.toContain('fetch(');
    expect(cardView).not.toContain('await ');

    const order = code('src/lib/overview/section-order.ts');
    for (const forbidden of ['fetch(', 'await ', 'load', 'provider']) {
      expect(order).not.toContain(forbidden);
    }
  });

  it('adds no request for NEWS_FILTER — it changes the one already made', () => {
    const page = code('app/page.tsx');
    const guard = page.indexOf('newsFilterEnabled()');
    expect(guard).toBeGreaterThan(-1);
    /*
     * The symbols handed to the feed were computed for the quote loads long
     * before this point. If the guard ever grows an `await` beside it, the
     * filter has started buying something.
     */
    const region = page.slice(guard, guard + 400);
    expect(region).not.toContain('await ');
    expect(region).toContain('portfolioSymbols');
    expect(region).toContain('watchlistSymbols');
  });

  /*
   * WATCHLIST_V2 is the one flag that changes what is LOADED rather than only
   * what is shown, and it changes it downward: the preview cuts the symbol list
   * to five before any price is fetched. So the flag being ON is the cheaper
   * path on the overview, and this pins the cut as happening before the load.
   */
  it('applies the WATCHLIST_V2 preview cut before prices are fetched', () => {
    const page = code('app/page.tsx');
    const guard = page.indexOf('watchlistV2Enabled()');
    const load = page.indexOf('loadWatchlistPrices(watchlistSymbols');
    expect(guard).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(guard);
    expect(page.slice(guard, load)).toContain('overviewPreview(');
  });
});
