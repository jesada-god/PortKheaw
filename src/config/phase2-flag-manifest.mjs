/**
 * WHAT EACH PHASE 2 FLAG NEEDS, DECLARED ONCE.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * `PHASE2_EVENTS=true` was set in production, redeployed, and the section did
 * not appear. Every obvious check passed: the env var name was right, the flag
 * was read, the data was built, the presence map said `events: true`, and the
 * component's `data-testid` matched what the QA script looked for.
 *
 * It failed one step further down. `orderedOverviewSections` iterates the ORDER
 * ARRAY and filters by presence, so a key absent from the array can never be
 * emitted however true its presence is — and `'events'` is absent from
 * `OVERVIEW_ORDER_V1`. The flag is unreachable without `OVERVIEW_V2=true`.
 *
 * That dependency was written down in three places and wrong in all three: the
 * rollout doc listed no prerequisite, the QA script's note said only "the
 * SECTION is what must appear", and a report to the owner said no Phase 2 flag
 * depends on another. Three copies of a fact is three chances to be wrong, and
 * they took it.
 *
 * So the dependency is declared HERE, once. `phase2-flag-manifest.test.ts`
 * checks this against `section-order.ts` — the actual arrays, not a copy of them
 * — and against the rollout doc and the QA script, so none of the three can
 * drift from it again.
 *
 * ===========================================================================
 * WHY .mjs AND NOT .ts
 * ===========================================================================
 * `scripts/qa/phase2-live-qa.mjs` runs under plain `node`, with no TypeScript
 * loader, and it is one of the two consumers that must not be allowed to hold
 * its own copy. Plain ESM is the only format both it and the test can import.
 *
 * ===========================================================================
 * THE FIVE STAGES A FLAG PASSES THROUGH
 * ===========================================================================
 * `stages` on each entry names them in order, because the failure above was
 * invisible to anyone checking only the first one:
 *
 *   1. the flag is read              src/config/features.ts
 *   2. the data is built             app/page.tsx
 *   3. presence is declared          DashboardClient.tsx, the presence map
 *   4. the ORDER ARRAY contains it   section-order.ts  <- the trap
 *   5. the component draws a marker  the section's own component
 */

/** Keys `orderedOverviewSections` may emit. Mirrors `OverviewSectionKey`. */
export const OVERVIEW_SECTION_KEYS = [
  'marketToday',
  'marketStatus',
  'portfolio',
  'watchlist',
  'whatChanged',
  'marketEvents',
  'events',
  'upcoming',
  'news',
];

/**
 * The base flag that selects which order array is walked.
 *
 * Not a Phase 2 flag and not parallel to them: it decides whether a Phase 2
 * section is reachable at all. `OVERVIEW_ORDER_V2` is the only array containing
 * `'events'`.
 */
export const OVERVIEW_ORDER_FLAG = 'OVERVIEW_V2';

/**
 * Sections that exist ONLY in V1, and therefore disappear when the base flag is
 * turned on. Stated here because it is the cost of satisfying `PHASE2_EVENTS`,
 * and nobody should discover it by looking at the page afterwards.
 */
export const LOST_WHEN_ORDER_FLAG_ON = ['marketStatus', 'upcoming', 'marketEvents'];

/**
 * One entry per Phase 2 flag.
 *
 *   flag         the `--flag` value `verify:phase2-live` takes
 *   env          the environment variable, spelled exactly
 *   sectionKey   the `OverviewSectionKey` this flag's output lands in
 *   requires     env vars that must ALSO be true, or the output is unreachable
 *   requiresAuth whether a signed-out reader can see the result at all
 *   markers      `data-testid` values the flag makes appear, once reachable
 */
export const PHASE2_FLAGS = [
  {
    flag: 'events',
    env: 'PHASE2_EVENTS',
    sectionKey: 'events',
    /*
      The one that bit us. `'events'` is in OVERVIEW_ORDER_V2 and NOT in
      OVERVIEW_ORDER_V1, so with the base flag off the section is filtered out
      before it is ever asked whether it has rows.
    */
    requires: [OVERVIEW_ORDER_FLAG],
    requiresAuth: false,
    markers: ['overview-events'],
    note: 'The macro calendar is a static import and its rows do not depend on '
      + 'a session, so once reachable this shows rows signed out — not an empty '
      + 'section.',
  },
  {
    flag: 'what-changed',
    env: 'PHASE2_WHAT_CHANGED',
    sectionKey: 'whatChanged',
    /*
      `whatChanged` is in BOTH order arrays, so no base flag is needed. What it
      does need is a reader: `app/page.tsx` builds `changes` from
      `watchlistView?.whatChanged`, and the watchlist view is only loaded when
      there is a client, a user and a selected watchlist.
    */
    requires: [],
    requiresAuth: true,
    markers: ['overview-changes'],
    note: 'Signed out the section falls back to the V1 ChangesSection, which '
      + 'does not carry the overview-changes marker. Check this one signed in.',
  },
  {
    flag: 'market-snapshot',
    env: 'PHASE2_MARKET_SNAPSHOT',
    sectionKey: 'marketToday',
    /*
      `marketToday` is in both arrays and its presence is hardcoded `true`, so
      the section is always drawn. The flag decides WHICH of two things it draws
      — the Phase 2 band, or the block that shipped.
    */
    requires: [],
    requiresAuth: false,
    markers: ['market-today-strip', 'market-today-status', 'market-today-reasons'],
    note: 'The only flag that spends: six provider quotes behind a 60s shared '
      + 'cache. Visible signed out.',
  },
  {
    flag: 'alerts',
    env: 'PHASE2_ALERTS',
    /*
      No section of its own. The count is decoration on watchlist rows, and
      `watchlist` is in both arrays — so nothing is unreachable here, but nothing
      is visible without a signed-in reader who owns rules either.
    */
    sectionKey: 'watchlist',
    requires: [],
    requiresAuth: true,
    markers: [],
    note: 'Draws no section. Signed out it changes nothing on the page at all; '
      + 'its evidence is overview_alert_hits after a pg_cron tick.',
  },
];

/** One entry by its `--flag` value, or undefined. */
export function phase2FlagByName(name) {
  return PHASE2_FLAGS.find((entry) => entry.flag === name);
}
