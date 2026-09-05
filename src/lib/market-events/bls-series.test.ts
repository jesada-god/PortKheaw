import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLS_KINDS,
  BLS_SERIES,
  CATALOG_VERIFIED,
  CHANGE_UNIT_LABEL_TH,
  UNIT_LABEL_TH,
} from './bls-series';

/**
 * ONE TABLE, ONE ADJUSTMENT, AND A DEBT THAT CANNOT BE WALKED PAST.
 *
 * The seasonal adjustment is the kind of decision that goes wrong by being made
 * twice. SA and NSA of the same month differ by 1.1 index points on CPI and by
 * 195,000 people on NFP, so a feature that fetches one and labels it as the
 * other is not slightly wrong — it is quoting a different number than the
 * headline the reader is comparing against.
 */
describe('the BLS series table', () => {
  it('binds exactly the three kinds BLS publishes', () => {
    expect([...BLS_KINDS].sort()).toEqual(['CPI', 'NFP', 'PPI']);
  });

  /*
   * Every binding is SEASONALLY ADJUSTED, because the panel asks "how much did
   * this move from the month before" and that question is unanswerable on a
   * series with the season still inside it.
   */
  it('is seasonally adjusted, every one of them', () => {
    for (const [kind, binding] of Object.entries(BLS_SERIES)) {
      expect(binding.adjustment, `${kind} must be seasonally adjusted`).toBe('SA');
    }
  });

  it('gives every binding a unit, and every unit a Thai label', () => {
    for (const [kind, binding] of Object.entries(BLS_SERIES)) {
      expect(UNIT_LABEL_TH[binding.unit], `${kind} has no unit label`).toBeTruthy();
      expect(CHANGE_UNIT_LABEL_TH[binding.unit], `${kind} has no change label`).toBeTruthy();
    }
  });

  /*
   * ===========================================================================
   * THE ID IS WRITTEN DOWN ONCE
   * ===========================================================================
   * A second copy is how a feature fetches one series and labels it as another.
   * This scans the shipped source — not the probe, which must name every
   * candidate including the ones we rejected, and not the generated data file,
   * which records what was fetched.
   */
  it('is the only place in the shipped source that names a series id', () => {
    const roots = ['src', 'app'];
    const allowed = path.join('src', 'lib', 'market-events', 'bls-series');
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
        if (full.startsWith(allowed)) continue;
        const text = readFileSync(full, 'utf8');
        for (const binding of Object.values(BLS_SERIES)) {
          if (text.includes(binding.seriesId)) offenders.push(`${full} names ${binding.seriesId}`);
        }
      }
    };
    for (const root of roots) walk(root);

    expect(offenders, 'a series id must be written in bls-series.ts and nowhere else')
      .toEqual([]);
  });
});

/**
 * ===========================================================================
 * THE UNPAID DEBT, AS A FAILING TEST
 * ===========================================================================
 * The ids in `bls-series.ts` were never confirmed by BLS. `catalog: true`
 * returns the agency's own `series_title` and is served only to a registered
 * key; the key available when the figures were generated was rejected, so the
 * data was fetched anonymously — which returns values and footnotes and no
 * titles.
 *
 * THIS TEST IS RED ON PURPOSE and it is meant to stay red until somebody does
 * the work. A comment saying "verify this later" is a note anybody can walk
 * past; a red suite is not. The cost is deliberate: the next push is blocked
 * until the ids are confirmed, which is exactly the forcing function this debt
 * deserves — the wrong id here is 23 million people.
 */
describe('the catalog verification debt', () => {
  it('is settled — run the probe and confirm every series_title', () => {
    expect(
      CATALOG_VERIFIED,
      [
        '',
        'The BLS series ids have NOT been confirmed against the agency.',
        '',
        'They were chosen from memory and the data was fetched anonymously,',
        'because v2 serves `catalog: true` only to a registered key and the key',
        'available at the time was rejected by BLS.',
        '',
        'CES0000000001 is the dangerous one: CES0500000001 is total PRIVATE',
        'nonfarm employment, about 23 million people fewer, and both return',
        'numbers that look entirely plausible in this panel.',
        '',
        'To settle this:',
        '  1. put a working BLS_API_KEY in .env.local',
        '  2. npm run probe:bls-series',
        '  3. check each series_title against `believedToBe` in bls-series.ts',
        '  4. set CATALOG_VERIFIED = true, and catalogVerified: true in',
        '     src/data/market-event-figures.json',
        '',
        'Until then the figures on the calendar are unverified.',
      ].join('\n'),
    ).toBe(true);
  });
});
