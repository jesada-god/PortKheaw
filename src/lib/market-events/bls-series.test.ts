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
import { FIGURES_CATALOG_VERIFIED } from './figures';

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
    /*
      Thirty seconds because this reads every .ts and .tsx under src/ and app/.
      It takes about two on its own and timed out at the default five when the
      full suite was running beside it — a flake that says nothing about the
      code, which is the worst kind of red to leave in a suite that already has
      one deliberate one.
    */
  }, 30_000);
});

/**
 * ===========================================================================
 * THE UNPAID DEBT, AND WHY IT DOES NOT FAIL THE SUITE
 * ===========================================================================
 * The ids in `bls-series.ts` were never confirmed by BLS. `catalog: true`
 * returns the agency's own `series_title` and v2 serves it only to a registered
 * key; three keys in a row were rejected by BLS, so the figures were fetched
 * anonymously — values and footnotes, no titles.
 *
 * This test used to be red for exactly that reason, and that was the wrong
 * shape. A red suite is a forcing function only when somebody can act on it.
 * Nobody here can make BLS accept a key, so the red never turned green by
 * anybody doing the right thing; it just sat there blocking every deploy and
 * teaching the team that a red suite is something you route around. A signal
 * everybody learns to ignore is worse than no signal.
 *
 * So the rule is about MEANS, not about state:
 *
 *   unverified, and no means to verify   -> PASS. A known, recorded limitation.
 *   unverified, but the means are there  -> FAIL. That is somebody not doing it.
 *   verified                             -> PASS, and the data file has to agree.
 *
 * ===========================================================================
 * WHAT "THE MEANS ARE THERE" IS MEASURED BY, AND WHAT THAT MISSES
 * ===========================================================================
 * `process.env.BLS_API_KEY`, and nothing else. The honest measure would be
 * "does a catalog request succeed", and that is exactly what this must not do:
 * a unit test that opens a socket fails on a train, fails when BLS is down, and
 * turns an offline suite into a weather report.
 *
 * The proxy is deliberately loose and here is where it is loose:
 *
 *  - It reads the PROCESS env, not `.env.local`. `vitest` does not load that
 *    file, so a key sitting on a developer's disk does not trip this. It trips
 *    in an environment that deliberately hands the key to the test runner —
 *    which is the environment where verification is actually possible.
 *  - A key being present does not mean BLS accepts it. Every key this project
 *    has tried was present and rejected. So a false red is possible, and the
 *    message says how to clear it in one line.
 *
 * Both directions of that are on purpose. This is a nudge that fires where the
 * work can be done, not a proof that it was.
 */
describe('the catalog verification debt', () => {
  /*
   * Trimmed, because an empty-but-set variable is how a CI config says "no key"
   * and reading that as "a key exists" would fail the build over a blank
   * string.
   */
  const keyInEnv = (process.env.BLS_API_KEY ?? '').trim();
  const meansToVerify = keyInEnv.length > 0;

  it('is unsettled only while there is no way to settle it', () => {
    if (CATALOG_VERIFIED) return;

    expect(
      meansToVerify,
      [
        '',
        'A BLS_API_KEY is in the environment, but CATALOG_VERIFIED is still false.',
        '',
        'The debt was acceptable while nobody could pay it. With a key present,',
        'somebody can — so this is now a thing that was not done rather than a',
        'thing that could not be done.',
        '',
        'CES0000000001 is why it matters: CES0500000001 is total PRIVATE nonfarm',
        'employment, about 23 million people fewer, and both return numbers that',
        'look entirely plausible in this panel. The Polygon cross-check on CPI',
        'says nothing about it.',
        '',
        'Settle it:',
        '  1. npm run probe:bls-series',
        '  2. check each series_title against `believedToBe` in bls-series.ts',
        '  3. set CATALOG_VERIFIED = true',
        '  4. npm run backfill:event-figures   (rewrites catalogVerified in the',
        '     data file from the constant)',
        '',
        'If the key is present but BLS rejects it — which has happened three',
        'times on this project — unset BLS_API_KEY for the test run. That is the',
        'honest state: no means, so no obligation.',
      ].join('\n'),
    ).toBe(false);
  });

  /*
   * THE FLAG AND THE SHIPPED DATA HAVE TO AGREE.
   *
   * Flipping the constant without regenerating would leave the calendar showing
   * numbers fetched anonymously under a claim that they were verified, which is
   * a worse state than the unverified one because it is no longer visible. The
   * backfill writes `catalogVerified` from this constant, so the two can only
   * disagree if somebody edited one by hand.
   */
  it('does not claim verification the shipped figures do not carry', () => {
    if (!CATALOG_VERIFIED) return;
    expect(
      FIGURES_CATALOG_VERIFIED,
      'CATALOG_VERIFIED is true but src/data/market-event-figures.json still says'
      + ' catalogVerified: false. Run `npm run backfill:event-figures` so the'
      + ' shipped numbers come from a verified run.',
    ).toBe(true);
  });
});
