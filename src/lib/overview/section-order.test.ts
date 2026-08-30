import { describe, expect, it } from 'vitest';
import {
  orderedOverviewSections,
  OVERVIEW_ORDER_V1,
  OVERVIEW_ORDER_V2,
  type OverviewSectionKey,
  type OverviewSectionPresence,
} from './section-order';

const KEYS: readonly OverviewSectionKey[] = [
  'marketStatus', 'portfolio', 'watchlist', 'whatChanged', 'marketEvents', 'upcoming', 'news',
];

/** All 2^7 on/off combinations of the seven sections. */
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
  it('covers every on/off combination of the seven sections', () => {
    expect(SUBSETS).toHaveLength(128);
  });

  it('lists each section exactly once in both orders', () => {
    for (const order of [OVERVIEW_ORDER_V1, OVERVIEW_ORDER_V2]) {
      expect([...order].sort()).toEqual([...KEYS].sort());
      expect(new Set(order).size).toBe(order.length);
    }
  });

  it('puts the requested sections in the requested order under V2', () => {
    const requested: OverviewSectionKey[] = [
      'marketStatus', 'whatChanged', 'watchlist', 'marketEvents', 'news',
    ];
    const positions = requested.map((key) => OVERVIEW_ORDER_V2.indexOf(key));
    expect(positions.every((index) => index > -1)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  /*
   * The market block leads and the portfolio line is second, in BOTH orders.
   * Everything below the market is read against it, and a reader is here for
   * their own money before anybody else's — neither argument is weakened by the
   * reordering, so neither position moves.
   */
  it('keeps the portfolio line second in both orders', () => {
    for (const order of [OVERVIEW_ORDER_V1, OVERVIEW_ORDER_V2]) {
      expect(order[0]).toBe('marketStatus');
      expect(order[1]).toBe('portfolio');
    }
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
        const expected = KEYS.filter((key) => present[key]);
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
