import { describe, expect, it } from 'vitest';
import {
  orderedOverviewSections,
  OVERVIEW_ORDER_V1,
  OVERVIEW_ORDER_V2,
  STRANDED_SECTION_KEYS,
  type OverviewSectionKey,
  type OverviewSectionPresence,
} from './section-order';

const KEYS: readonly OverviewSectionKey[] = [
  'marketToday', 'marketStatus', 'portfolio', 'watchlist', 'whatChanged',
  'marketEvents', 'events', 'upcoming', 'news',
];

/**
 * All 2^9 on/off combinations of the nine keys.
 *
 * Nine keys, and NEITHER ORDER LISTS ALL OF THEM. `marketStatus` and
 * `upcoming` are V1's alone; `events` is in no order at all. A key that is
 * present but not in the order being used must produce nothing, which is a
 * property this sweep checks for free — it was not checkable while every order
 * held every key.
 */
function everySubset(): OverviewSectionPresence[] {
  const subsets: OverviewSectionPresence[] = [];
  for (let mask = 0; mask < (1 << KEYS.length); mask += 1) {
    const present = {} as Record<OverviewSectionKey, boolean>;
    KEYS.forEach((key, index) => { present[key] = Boolean(mask & (1 << index)); });
    subsets.push(present);
  }
  return subsets;
}

const SUBSETS = everySubset();

/** True when `list` appears inside `full` in the same relative order. */
function isSubsequenceOf(
  list: readonly OverviewSectionKey[],
  full: readonly OverviewSectionKey[],
): boolean {
  let cursor = 0;
  for (const key of full) {
    if (list[cursor] === key) cursor += 1;
  }
  return cursor === list.length;
}

describe('the overview reading order', () => {
  it('covers every on/off combination of the nine keys', () => {
    expect(SUBSETS).toHaveLength(512);
  });

  it('lists no section twice, and names only keys that exist', () => {
    for (const order of [OVERVIEW_ORDER_V1, OVERVIEW_ORDER_V2]) {
      expect(new Set(order).size).toBe(order.length);
      for (const key of order) expect(KEYS).toContain(key);
    }
  });

  /*
   * A key in neither order is DEAD: nothing can ever render it, however true
   * its flag. That is the `PHASE2_EVENTS` defect exactly, so a key may only be
   * stranded when the module says so out loud — an accidental strand is red
   * here, and a declared one has to keep being true.
   */
  it('gives every key a home in an order, or declares it stranded', () => {
    const placed = new Set([...OVERVIEW_ORDER_V1, ...OVERVIEW_ORDER_V2]);
    expect([...placed, ...STRANDED_SECTION_KEYS].sort()).toEqual([...KEYS].sort());
    // And the declaration cannot go stale: a stranded key is really in neither.
    for (const key of STRANDED_SECTION_KEYS) {
      expect(placed.has(key), `${key} is declared stranded but is in an order`).toBe(false);
    }
  });

  it('puts the requested sections in the requested order under V2', () => {
    const requested: OverviewSectionKey[] = [
      'marketToday', 'portfolio', 'whatChanged', 'watchlist', 'marketEvents', 'news',
    ];
    const positions = requested.map((key) => OVERVIEW_ORDER_V2.indexOf(key));
    expect(positions.every((index) => index > -1)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  /*
   * The two sections that never move.
   *
   * ตลาดวันนี้ leads in BOTH orders — everything below it is read against it,
   * and it leads in V1 because it replaced a fixed section that was rendered
   * above the ordered run. The portfolio line is the first thing after the
   * market readings, because a reader is here for their own money before
   * anybody else's. In V1 that is behind `marketStatus`, which is a second
   * market reading rather than somebody else's money; in V2 there is no second
   * reading, so it is immediately after.
   */
  it('leads with the market and puts the portfolio right after it', () => {
    for (const order of [OVERVIEW_ORDER_V1, OVERVIEW_ORDER_V2]) {
      expect(order[0]).toBe('marketToday');
      const marketKeys = order.filter((key) => key === 'marketToday' || key === 'marketStatus');
      expect(order.indexOf('portfolio')).toBe(marketKeys.length);
      for (const below of ['watchlist', 'whatChanged', 'news'] as const) {
        expect(order.indexOf('portfolio')).toBeLessThan(order.indexOf(below));
      }
    }
  });

  it('never shows two readings of the same market on one page', () => {
    // `marketToday` publishes the same six instruments and the same regime the
    // Market Status card does, so V2 carries one of them and not both.
    expect(OVERVIEW_ORDER_V2).not.toContain('marketStatus');
    // `upcoming` goes because the calendar slot answers the same question.
    expect(OVERVIEW_ORDER_V2).not.toContain('upcoming');
  });

  /*
   * ===========================================================================
   * THE CALENDAR IS ONE SECTION, AND IT IS THE GRID
   * ===========================================================================
   * The Overview shows the month grid, never the merged list, and never both:
   * two cards about the same calendar on one page is the reader reading the
   * same dates twice in two shapes.
   *
   * `marketEvents` in BOTH orders is the assertion that would go red if it were
   * dropped from either — which is the failure that put a `MARKET_EVENTS_CARD`
   * that was correctly switched on behind a page that could not draw it.
   */
  it('draws the calendar as the month grid in both orders, and never beside the list', () => {
    expect(OVERVIEW_ORDER_V1).toContain('marketEvents');
    expect(OVERVIEW_ORDER_V2).toContain('marketEvents');
    for (const order of [OVERVIEW_ORDER_V1, OVERVIEW_ORDER_V2]) {
      expect(order.includes('marketEvents') && order.includes('events')).toBe(false);
    }
  });

  /*
   * Under V2 the grid sits where a reader who has just looked at what they own
   * asks what is coming — after the watchlist, before the news.
   */
  it('puts the calendar after the watchlist and above the news under V2', () => {
    expect(OVERVIEW_ORDER_V2.indexOf('marketEvents'))
      .toBeGreaterThan(OVERVIEW_ORDER_V2.indexOf('watchlist'));
    expect(OVERVIEW_ORDER_V2.indexOf('marketEvents'))
      .toBeLessThan(OVERVIEW_ORDER_V2.indexOf('news'));
  });

  it('puts the summary above the rows it is derived from, under V2 only', () => {
    expect(OVERVIEW_ORDER_V2.indexOf('whatChanged'))
      .toBeLessThan(OVERVIEW_ORDER_V2.indexOf('watchlist'));
    expect(OVERVIEW_ORDER_V1.indexOf('whatChanged'))
      .toBeGreaterThan(OVERVIEW_ORDER_V1.indexOf('watchlist'));
  });

  /*
   * ===========================================================================
   * THE REQUIREMENT: THE ORDER SURVIVES A CARD VANISHING FROM THE MIDDLE
   * ===========================================================================
   * Losing a section must never reorder the ones that remain. This is checked
   * over every subset in both orders, because the failure it guards against is
   * not "the list is wrong" — the list is obviously right when everything is on
   * — but "the list is wrong for one of the 126 partial pages nobody looked at".
   */
  for (const useV2 of [false, true]) {
    const full = useV2 ? OVERVIEW_ORDER_V2 : OVERVIEW_ORDER_V1;
    const name = useV2 ? 'V2' : 'V1';

    it(`keeps every subset in ${name} order`, () => {
      for (const present of SUBSETS) {
        const ordered = orderedOverviewSections(present, useV2);
        expect(
          isSubsequenceOf(ordered, full),
          `${name} order broke for ${JSON.stringify(present)}`,
        ).toBe(true);
      }
    });

    /*
     * A section that is off must occupy NOTHING — not a slot, not a gap. The
     * returned list is what the page renders, so "no gap" is exactly "the key
     * is not in the list", and the length check is what makes it airtight: an
     * absent section cannot come back as a null entry.
     */
    it(`leaves no gap for an absent section in ${name}`, () => {
      for (const present of SUBSETS) {
        const ordered = orderedOverviewSections(present, useV2);
        const expected = full.filter((key) => present[key]);
        expect(ordered).toHaveLength(expected.length);
        expect([...ordered].sort()).toEqual([...expected].sort());
        expect(ordered.every(Boolean)).toBe(true);
      }
    });

    it(`renders nothing at all when every section is off in ${name}`, () => {
      const none = Object.fromEntries(KEYS.map((key) => [key, false])) as OverviewSectionPresence;
      expect(orderedOverviewSections(none, useV2)).toEqual([]);
    });

    it(`renders the whole list when every section is on in ${name}`, () => {
      const all = Object.fromEntries(KEYS.map((key) => [key, true])) as OverviewSectionPresence;
      expect(orderedOverviewSections(all, useV2)).toEqual([...full]);
    });
  }

  /*
   * Removing one section from a page leaves the other six in the order they
   * were in. Stated separately from the subsequence check because this is the
   * case a reader actually meets — one flag turned off, everything else on.
   */
  it('holds the order when exactly one section is removed', () => {
    for (const useV2 of [false, true]) {
      const full = useV2 ? OVERVIEW_ORDER_V2 : OVERVIEW_ORDER_V1;
      for (const missing of KEYS) {
        const present = Object.fromEntries(
          KEYS.map((key) => [key, key !== missing]),
        ) as OverviewSectionPresence;
        expect(orderedOverviewSections(present, useV2))
          .toEqual(full.filter((key) => key !== missing));
      }
    }
  });

  it('is a pure function of its inputs', () => {
    const present = Object.fromEntries(KEYS.map((key) => [key, true])) as OverviewSectionPresence;
    expect(orderedOverviewSections(present, true)).toEqual(orderedOverviewSections(present, true));
    // And it does not hand back the module's own array to be mutated.
    const first = orderedOverviewSections(present, true);
    first.pop();
    expect(orderedOverviewSections(present, true)).toEqual([...OVERVIEW_ORDER_V2]);
  });
});
