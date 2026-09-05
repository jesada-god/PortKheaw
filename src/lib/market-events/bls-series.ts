import type { MarketEventKind } from './types';

/**
 * WHICH BLS SERIES EACH RELEASE IS, AND IN WHICH SEASONAL ADJUSTMENT.
 *
 * ===========================================================================
 * SEASONALLY ADJUSTED, AND THE REASON IS THE QUESTION THE CALENDAR ASKS
 * ===========================================================================
 * The panel under a calendar day answers "how much did this move from the
 * month before". That question is only answerable on a SEASONALLY ADJUSTED
 * series. The not-adjusted one carries the calendar's own regular swings inside
 * it — school terms, heating, holiday hiring — so a month-over-month difference
 * taken from NSA is partly the season and partly the economy, mixed, with no
 * way to tell a reader which part they are looking at.
 *
 * It is also the number the market quotes. When a headline says CPI rose 0.3%
 * last month, that is the SA series; a reader comparing this panel against
 * anything they read elsewhere is comparing against SA.
 *
 * The gap is not academic. Measured from BLS on the same day:
 *
 *     CPI  July 2026     SA 332.813    NSA 333.918    1.105 index points apart
 *     NFP  August 2026   SA 159,075k   NSA 158,880k   195,000 people apart
 *
 * Two providers disagreeing about "the CPI for July" is usually this, and
 * nothing else: Polygon serves SA, Alpha Vantage serves NSA.
 *
 * ===========================================================================
 * THIS TABLE IS THE ONLY PLACE A SERIES ID IS WRITTEN
 * ===========================================================================
 * A second copy is how a feature ends up fetching one series and labelling it
 * as another. `bls-series.test.ts` scans `src/` and `app/` and fails if any of
 * these ids appears outside this file, so the adjustment cannot be changed in
 * one place and left alone in another.
 *
 * `adjustment` is carried into the generated file's `_provenance` for the same
 * reason: switching to NSA would then show up as a diff on committed data
 * rather than as numbers that quietly moved.
 *
 * ===========================================================================
 * ⚠️ THESE IDS ARE NOT CATALOG-VERIFIED YET
 * ===========================================================================
 * BLS confirms what a series actually is through `catalog: true`, which the v2
 * API serves only to a registered key. The key available when this was written
 * was rejected by BLS, so the data behind these ids was fetched anonymously —
 * which works, returns values and footnotes, and does NOT return the agency's
 * own `series_title`.
 *
 * So each id below is believed, not confirmed. The one that matters most is
 * `CES0000000001`: `CES0500000001` is TOTAL PRIVATE nonfarm employment, differs
 * by roughly 23 million people, and returns numbers that look every bit as
 * plausible. Nothing in this repository can tell them apart.
 *
 * The debt is tracked by a failing test rather than by this comment —
 * `bls-series.test.ts` is RED while `CATALOG_VERIFIED` is false and says what
 * to run. Run `npm run probe:bls-series` with a working key, check each
 * `series_title` against `believedToBe` below, and flip the flag.
 */

/**
 * Whether BLS itself has confirmed the ids in this file.
 *
 * FALSE until somebody runs the catalog probe with a working key and reads the
 * titles. It is a constant rather than a comment because a test asserts it, and
 * a test is the only kind of note nobody can walk past.
 */
export const CATALOG_VERIFIED = false;

/** What a figure is counted in. Decides how it is written, never what it is. */
export type BlsUnit = 'index' | 'thousands-of-persons';

export interface BlsSeriesBinding {
  seriesId: string;
  adjustment: 'SA' | 'NSA';
  unit: BlsUnit;
  /**
   * What we believe the id is, in BLS's own vocabulary, for whoever runs the
   * catalog probe to compare against. Not used at runtime.
   */
  believedToBe: string;
}

/**
 * The three kinds BLS publishes, and only those three.
 *
 * The calendar also carries JOBLESS_CLAIMS (DOL), PCE and GDP (BEA) and FOMC
 * (Federal Reserve). None of them has a BLS series, so none of them is here and
 * none of them gets a figure — see `docs/market-events-figures.md`.
 */
export const BLS_SERIES: Partial<Record<MarketEventKind, BlsSeriesBinding>> = {
  CPI: {
    // Consumer Price Index for All Urban Consumers, all items, US city average.
    // NOT catalog-verified — see the header. NSA twin is CUUR0000SA0.
    seriesId: 'CUSR0000SA0',
    adjustment: 'SA',
    unit: 'index',
    believedToBe: 'CPI-U, all items, US city average, seasonally adjusted',
  },
  PPI: {
    // Producer Price Index, final demand.
    // NOT catalog-verified — see the header. NSA twin is WPUFD4.
    seriesId: 'WPSFD4',
    adjustment: 'SA',
    unit: 'index',
    believedToBe: 'PPI final demand, seasonally adjusted',
  },
  NFP: {
    /*
      Total nonfarm employment, in thousands.

      NOT catalog-verified, and this is the one that matters: CES0500000001 is
      TOTAL PRIVATE nonfarm employment — about 23 million people fewer — and
      both return plausible-looking numbers. The NSA twin is CEU0000000001.
    */
    seriesId: 'CES0000000001',
    adjustment: 'SA',
    unit: 'thousands-of-persons',
    believedToBe: 'All employees, total nonfarm, seasonally adjusted, thousands',
  },
};

/** The kinds that can carry a figure at all. */
export const BLS_KINDS = Object.keys(BLS_SERIES) as MarketEventKind[];

/**
 * How a level is written, per unit.
 *
 * A BARE NUMBER IS UNREADABLE. "332.813" is an index point and "159075" is a
 * headcount in thousands, and a reader given either without its unit has been
 * given a digit string. Both labels are Thai because every figure this feature
 * prints sits in a Thai sentence.
 */
export const UNIT_LABEL_TH: Record<BlsUnit, string> = {
  index: 'ดัชนี',
  'thousands-of-persons': 'พันคน',
};

/**
 * How a month-over-month change is written, per unit.
 *
 * An index moves in PERCENT — that is the number a headline quotes — while a
 * headcount moves in people, so the same "change" field is a different quantity
 * depending on the series and has to say which it is.
 */
export const CHANGE_UNIT_LABEL_TH: Record<BlsUnit, string> = {
  index: '%',
  'thousands-of-persons': 'พันคน',
};
