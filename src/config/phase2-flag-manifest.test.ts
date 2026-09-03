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
    expect(PHASE2_FLAGS.length).toBe(4);
    expect(PHASE2_FLAGS.map((entry) => entry.env).sort()).toEqual([
      'PHASE2_ALERTS', 'PHASE2_EVENTS', 'PHASE2_MARKET_SNAPSHOT', 'PHASE2_WHAT_CHANGED',
    ]);
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
  it('declares the base flag for every section that only exists in V2', () => {
    const problems: string[] = [];
    for (const entry of PHASE2_FLAGS) {
      // An unreachable flag has no prerequisite to declare — satisfying one
      // would change nothing, and the previous test holds it to that.
      if (entry.unreachable) continue;
      const onlyV2 = inV2(entry.sectionKey) && !inV1(entry.sectionKey);
      const declares = entry.requires.includes(OVERVIEW_ORDER_FLAG);
      if (onlyV2 && !declares) {
        problems.push(
          `${entry.env} lands in '${entry.sectionKey}', which is only in `
          + `OVERVIEW_ORDER_V2 — it must declare ${OVERVIEW_ORDER_FLAG} in requires`,
        );
      }
      if (!onlyV2 && declares) {
        problems.push(
          `${entry.env} declares ${OVERVIEW_ORDER_FLAG}, but '${entry.sectionKey}' `
          + 'is in both orders and needs no base flag',
        );
      }
    }
    expect(problems).toEqual([]);
  });

  /*
   * A V1-ONLY KEY IS THE SAME TRAP MIRRORED.
   *
   * If a flag lands in a section V2 dropped, turning the base flag ON silently
   * removes it — the same invisible failure as `PHASE2_EVENTS`, in the other
   * direction. Nothing lands in one today, and this is what would say so.
   */
  it('has no flag landing in a section V2 dropped', () => {
    const stranded = PHASE2_FLAGS
      .filter((entry) => inV1(entry.sectionKey) && !inV2(entry.sectionKey))
      .map((entry) => `${entry.env} -> ${entry.sectionKey}`);
    expect(stranded).toEqual([]);
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

      expect(withBaseOn, `${entry.env} must be reachable with the base flag on`)
        .toContain(key);
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
      for (const required of entry.requires) {
        if (!row.includes(required)) {
          problems.push(`the doc's ${entry.env} row does not name its prerequisite ${required}`);
        }
      }
      if (entry.requires.length === 0 && row.includes(OVERVIEW_ORDER_FLAG)) {
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
