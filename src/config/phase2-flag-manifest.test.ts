import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LOST_WHEN_ORDER_FLAG_ON,
  OVERVIEW_ORDER_FLAG,
  OVERVIEW_SECTION_KEYS,
  PHASE2_FLAGS,
  phase2FlagByName,
} from './phase2-flag-manifest.mjs';
import {
  OVERVIEW_ORDER_V1,
  OVERVIEW_ORDER_V2,
  orderedOverviewSections,
  type OverviewSectionKey,
  type OverviewSectionPresence,
} from '@/src/lib/overview/section-order';

/**
 * A FLAG THAT CANNOT REACH THE PAGE MUST SAY SO, IN ONE PLACE.
 *
 * ===========================================================================
 * THE DEFECT THIS EXISTS FOR
 * ===========================================================================
 * `PHASE2_EVENTS=true` shipped to production and drew nothing. It was read, the
 * data was built, the presence map said `events: true`, and the component's
 * marker matched what the checker looked for. It failed at the step nobody
 * checked: `orderedOverviewSections` iterates the ORDER ARRAY, and `'events'` is
 * not in `OVERVIEW_ORDER_V1`, so presence was never consulted.
 *
 * The dependency on `OVERVIEW_V2` was recorded in three places and wrong in all
 * three. The manifest is now the only copy, and these tests hold the other two —
 * the rollout doc and the QA script — to it.
 *
 * ===========================================================================
 * WHAT THESE ASSERT, AND WHAT THEY CANNOT
 * ===========================================================================
 * They compare the manifest against the REAL arrays imported from
 * `section-order.ts`, not against a transcription of them, so widening or
 * narrowing an order array moves these tests. They cannot check that a flag is
 * set correctly in Vercel, or that a deploy happened — nothing offline can.
 */
describe('the Phase 2 flag manifest', () => {
  const inV1 = (key: string) => (OVERVIEW_ORDER_V1 as readonly string[]).includes(key);
  const inV2 = (key: string) => (OVERVIEW_ORDER_V2 as readonly string[]).includes(key);

  it('has every flag to check, so a pass is never vacuous', () => {
    expect(PHASE2_FLAGS.length).toBe(5);
    expect(PHASE2_FLAGS.map((entry) => entry.env).sort()).toEqual([
      'MARKET_EVENTS_CARD', 'PHASE2_ALERTS', 'PHASE2_EVENTS',
      'PHASE2_MARKET_SNAPSHOT', 'PHASE2_WHAT_CHANGED',
    ]);
  });

  /*
   * MARKET_EVENTS_CARD is not a PHASE2_* flag and belongs here anyway.
   *
   * What this file is for is flags whose output has to survive
   * `orderedOverviewSections`, and that one does — it fell into this exact trap
   * from the V1 side while the manifest built to prevent it did not mention it.
   * Naming the requirement rather than the prefix is what stops the next
   * order-gated flag being left out for the same reason.
   */
  it('covers every flag whose section key the order arrays decide', () => {
    const covered = new Set(PHASE2_FLAGS.map((entry) => entry.sectionKey));
    expect(covered, 'the calendar card is order-gated and must be declared')
      .toContain('marketEvents');
  });

  /*
   * A key in no order array can never be emitted, so a flag landing in one is
   * a switch that does nothing. That is allowed — but only when the manifest
   * SAYS SO, and the claim has to keep being true in both directions: a flag
   * silently stranded is red, and a flag declared unreachable that quietly
   * became reachable is red too.
   */
  it('names only section keys the order arrays can emit, or says why not', () => {
    for (const entry of PHASE2_FLAGS) {
      expect(OVERVIEW_SECTION_KEYS, `${entry.env} names ${entry.sectionKey}`)
        .toContain(entry.sectionKey);
      const placed = inV1(entry.sectionKey) || inV2(entry.sectionKey);
      expect(
        placed || Boolean(entry.unreachable),
        `${entry.env} lands in '${entry.sectionKey}', which is in no order array `
        + '— it must carry an `unreachable` reason saying so',
      ).toBe(true);
      if (entry.unreachable) {
        expect(
          placed,
          `${entry.env} is declared unreachable, but '${entry.sectionKey}' is in an order`,
        ).toBe(false);
      }
    }
  });

  /*
   * THE ASSERTION THAT WOULD HAVE CAUGHT IT.
   *
   * A section key present in only one order array is reachable only when that
   * array is the one being walked. For a V2-only key that means the base flag,
   * and the manifest must say so — because the whole failure was a flag whose
   * prerequisite nobody had written down.
   */
  it('declares the base flag in the direction its section actually needs it', () => {
    const problems: string[] = [];
    for (const entry of PHASE2_FLAGS) {
      // An unreachable flag has no prerequisite to declare — satisfying one
      // would change nothing, and the previous test holds it to that.
      if (entry.unreachable) continue;
      const onlyV2 = inV2(entry.sectionKey) && !inV1(entry.sectionKey);
      const onlyV1 = inV1(entry.sectionKey) && !inV2(entry.sectionKey);
      const needs = entry.requires.includes(OVERVIEW_ORDER_FLAG);
      const refuses = entry.forbids.includes(OVERVIEW_ORDER_FLAG);

      if (onlyV2 && !needs) {
        problems.push(
          `${entry.env} lands in '${entry.sectionKey}', which is only in `
          + `OVERVIEW_ORDER_V2 — it must declare ${OVERVIEW_ORDER_FLAG} in requires`,
        );
      }
      if (onlyV1 && !refuses) {
        problems.push(
          `${entry.env} lands in '${entry.sectionKey}', which is only in `
          + `OVERVIEW_ORDER_V1 — it must declare ${OVERVIEW_ORDER_FLAG} in forbids`,
        );
      }
      if (!onlyV2 && needs) {
        problems.push(
          `${entry.env} requires ${OVERVIEW_ORDER_FLAG}, but '${entry.sectionKey}' `
          + 'is not a V2-only section',
        );
      }
      if (!onlyV1 && refuses) {
        problems.push(
          `${entry.env} forbids ${OVERVIEW_ORDER_FLAG}, but '${entry.sectionKey}' `
          + 'is not a V1-only section',
        );
      }
    }
    expect(problems).toEqual([]);
  });

  /*
   * ===========================================================================
   * THE CALENDAR CARD IS REACHABLE WHATEVER THE BASE FLAG IS
   * ===========================================================================
   * This is the assertion that goes red if `marketEvents` falls out of either
   * order array — which is the defect it exists for. `MARKET_EVENTS_CARD` was
   * set in production, `OVERVIEW_V2` was set too, and the card did not draw
   * because V2's array had no `'marketEvents'` key. Nothing failed; there was
   * simply nothing that could notice.
   *
   * Stated over the REAL arrays and the REAL filter, so it cannot be satisfied
   * by editing the manifest.
   */
  it('keeps the calendar card reachable in both orders', () => {
    expect(inV1('marketEvents'), "'marketEvents' must be in OVERVIEW_ORDER_V1").toBe(true);
    expect(inV2('marketEvents'), "'marketEvents' must be in OVERVIEW_ORDER_V2").toBe(true);

    const allPresent = Object.fromEntries(
      OVERVIEW_SECTION_KEYS.map((key) => [key, true]),
    ) as OverviewSectionPresence;
    expect(orderedOverviewSections(allPresent, false)).toContain('marketEvents');
    expect(orderedOverviewSections(allPresent, true)).toContain('marketEvents');
  });

  it('lists exactly the sections the base flag removes', () => {
    const lost = (OVERVIEW_ORDER_V1 as readonly string[])
      .filter((key) => !inV2(key))
      .sort();
    expect([...LOST_WHEN_ORDER_FLAG_ON].sort()).toEqual(lost);
  });

  /*
   * The manifest's claim, executed. `orderedOverviewSections` is the real
   * function, so this fails if the filtering behaviour changes underneath it.
   */
  it('agrees with orderedOverviewSections about what is reachable', () => {
    const allPresent = Object.fromEntries(
      OVERVIEW_SECTION_KEYS.map((key) => [key, true]),
    ) as OverviewSectionPresence;

    for (const entry of PHASE2_FLAGS) {
      const key = entry.sectionKey as OverviewSectionKey;
      const withBaseOff = orderedOverviewSections(allPresent, false);
      const withBaseOn = orderedOverviewSections(allPresent, true);
      const needsBase = entry.requires.includes(OVERVIEW_ORDER_FLAG);
      const refusesBase = entry.forbids.includes(OVERVIEW_ORDER_FLAG);

      /*
        An unreachable flag's key must be emitted in NEITHER state — with every
        section present, which is the most generous input there is. Anything
        less than "absent both ways" would mean the `unreachable` claim is
        wrong, and a claim like that is worse than no claim.
      */
      if (entry.unreachable) {
        expect(withBaseOff, `${entry.env} is unreachable and must not appear in V1`)
          .not.toContain(key);
        expect(withBaseOn, `${entry.env} is unreachable and must not appear in V2`)
          .not.toContain(key);
        continue;
      }

      expect(
        withBaseOn.includes(key),
        `${entry.env} reachable with the base flag on should be ${!refusesBase}`,
      ).toBe(!refusesBase);
      expect(
        withBaseOff.includes(key),
        `${entry.env} reachable with the base flag off should be ${!needsBase}`,
      ).toBe(!needsBase);
    }
  });
});

/**
 * THE OTHER TWO COPIES, HELD TO THE MANIFEST.
 *
 * Neither the doc nor the QA script can import a value and still be readable to
 * a person, so both restate the flag names — and restating is what went wrong
 * before. These read the two files and compare.
 */
describe('the manifest is the only copy', () => {
  const read = (path: string) => readFileSync(
    fileURLToPath(new URL(`../../${path}`, import.meta.url)),
    'utf8',
  );

  it('is what the QA script drives its --flag list from', () => {
    const script = read('scripts/qa/phase2-live-qa.mjs');
    /*
      Asserted as an IMPORT rather than by diffing two lists. A script holding
      its own table would pass a comparison the day it was written and drift the
      day after; one that imports cannot drift at all.
    */
    expect(script).toContain("from '../../src/config/phase2-flag-manifest.mjs'");
    expect(script).toContain('PHASE2_FLAGS');
  });

  it('agrees with the rollout doc about every flag and its prerequisite', () => {
    const doc = read('docs/operations/phase2-flag-rollout.md');
    const problems: string[] = [];

    for (const entry of PHASE2_FLAGS) {
      if (!doc.includes(entry.env)) {
        problems.push(`the doc never mentions ${entry.env}`);
        continue;
      }
      /*
        The row for a flag with a prerequisite has to name it on the same line.
        A doc that lists the flag and forgets the dependency is exactly the state
        this whole exercise started from.
      */
      const row = doc.split('\n').find((line) => line.includes(`\`${entry.env}\``) && line.startsWith('|'));
      if (!row) {
        problems.push(`${entry.env} has no table row in the doc`);
        continue;
      }
      for (const required of [...entry.requires, ...entry.forbids]) {
        if (!row.includes(required)) {
          problems.push(`the doc's ${entry.env} row does not name its prerequisite ${required}`);
        }
      }
      if (entry.requires.length === 0
        && entry.forbids.length === 0
        && row.includes(OVERVIEW_ORDER_FLAG)) {
        problems.push(`the doc's ${entry.env} row claims a ${OVERVIEW_ORDER_FLAG} prerequisite it does not have`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('agrees with the doc about what the base flag costs', () => {
    const doc = read('docs/operations/phase2-flag-rollout.md');
    for (const key of LOST_WHEN_ORDER_FLAG_ON) {
      expect(doc, `the doc must say ${key} disappears`).toContain(key);
    }
  });
});

describe('phase2FlagByName', () => {
  it('finds every flag by the name the QA script takes', () => {
    for (const entry of PHASE2_FLAGS) {
      expect(phase2FlagByName(entry.flag)?.env).toBe(entry.env);
    }
  });

  it('is undefined for a name nobody declared', () => {
    expect(phase2FlagByName('nonsense')).toBeUndefined();
  });
});
