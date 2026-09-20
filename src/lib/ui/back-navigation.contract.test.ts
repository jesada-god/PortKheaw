import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every page a reader can arrive at cold has a way back.
 *
 * ===========================================================================
 * WHY BROWSER BACK IS NOT THE ANSWER
 * ===========================================================================
 * These pages are reachable by direct URL — a bookmark, a link, a refresh —
 * and the product is installable, so a large share of visits happen in a
 * standalone window with no browser chrome at all. There is no back button to
 * fall back on there, and a page with none of its own is a dead end: the only
 * way out is to force-quit the app.
 *
 * ===========================================================================
 * WHICH OF THE TWO CONTROLS, AND WHY IT MATTERS
 * ===========================================================================
 * `Header` offers both and they are not interchangeable:
 *
 *   `backHref`          a Link to a fixed parent. Right when the page has ONE
 *                       sensible parent however the reader got there. It shows
 *                       its target on hover, survives a middle-click, and can
 *                       never walk the reader out of the product.
 *   `backFallbackHref`  steps through history and only falls back to its href
 *                       when there is nothing to step to. Right when the page
 *                       is reached from a list it should return to, scrolled
 *                       where it was left.
 *
 * The pages below are asserted with the one they should have. Getting this
 * wrong is not cosmetic: `backFallbackHref` on a page people arrive at cold
 * sends them OUT of the app, because `window.history.length > 1` is true for
 * any tab that has been used at all and the fallback never fires.
 */

interface BackExpectation {
  /** Why this page needs one at all. */
  readonly reason: string;
  readonly control: 'backHref' | 'backFallbackHref';
  readonly target: string;
}

const PAGES: Readonly<Record<string, BackExpectation>> = {
  'app/settings/page.tsx': {
    reason: 'reached from the header avatar, not from the dock — no other way out',
    control: 'backHref',
    target: '/',
  },
  'app/profile/page.tsx': {
    reason: 'same entry point as settings, and equally off the dock',
    control: 'backHref',
    target: '/',
  },
  'app/notifications/page.tsx': {
    reason: 'reached from the header bell; a push notification opens it cold',
    control: 'backHref',
    target: '/',
  },
  'app/settings/subscription/page.tsx': {
    reason: 'a child of settings, and the paywall links straight into it',
    // History, because the reader usually came from the settings list and
    // should land back on it — but a paywall deep-link has no history to step
    // through, which is what the fallback is for.
    control: 'backFallbackHref',
    target: '/settings',
  },
  'app/admin/reliability/page.tsx': {
    reason: 'the one console page that was missing what the other nine have',
    control: 'backFallbackHref',
    target: '/admin',
  },
};

/**
 * Pages that deliberately have no back control, so the sweep cannot be read as
 * "every page must have one".
 */
const ROOTED_PAGES = [
  // The five dock destinations: the dock IS their navigation.
  'app/page.tsx',
  'app/search/page.tsx',
  'app/watchlist/page.tsx',
  'app/portfolio/page.tsx',
  'app/tools/page.tsx',
];

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('back navigation', () => {
  for (const [path, expectation] of Object.entries(PAGES)) {
    it(`gives ${path.replace('app/', '/').replace('/page.tsx', '') || '/'} a way back — ${expectation.reason}`, () => {
      const source = read(path);
      expect(source, `expected ${expectation.control} on every Header in this page`)
        .toContain(`${expectation.control}="${expectation.target}"`);

      /*
       * EVERY Header in the file, not just the first. Several of these pages
       * render a second, earlier Header for the unconfigured or signed-out
       * branch, and a reader who lands in that branch is the one most likely
       * to be stuck.
       */
      const headers = source.match(/<Header\b/g) ?? [];
      const withBack = source.match(new RegExp(`${expectation.control}="`, 'g')) ?? [];
      expect(withBack.length, 'a Header in this page renders without a back control')
        .toBe(headers.length);
    });
  }

  it('leaves the dock destinations without one, deliberately', () => {
    for (const path of ROOTED_PAGES) {
      const source = read(path);
      expect(source, `${path} is a dock destination and should not carry a back control`)
        .not.toMatch(/backHref=|backFallbackHref=/);
    }
  });
});
