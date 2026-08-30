import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CONTRACT THE TIME MODEL RESTS ON, CHECKED AS SOURCE TEXT.
 *
 * These are claims about what the code DOES NOT DO, and a behavioural test
 * cannot make them: you cannot mount a component and observe the absence of a
 * second parsing path. So this reads the files.
 *
 * That is the same trade `overview.contract.test.ts` makes, with the same
 * limitation understood — a source scan proves a shape, not a behaviour. The
 * behaviour is proved next door in `time.test.ts`, against a hand-written table
 * under two host time zones. This file exists to stop a SECOND, unproved path
 * appearing beside the proved one.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));

function sourceFiles(...directories: string[]): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = [];
  const walk = (directory: string) => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return; // A directory this feature has not grown yet is not a failure.
    }
    for (const entry of entries) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        found.push({ path: full.slice(root.length).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const directory of directories) walk(join(root, directory));
  return found;
}

const FEATURE_FILES = sourceFiles(
  'src/lib/market-events',
  'src/components/market-events',
  'app/market-events',
);

describe('the market-events time contract', () => {
  it('has files to check, so a passing run is never a vacuous one', () => {
    expect(FEATURE_FILES.length).toBeGreaterThan(0);
  });

  /*
   * `etDisplay` IS A LABEL. NOTHING READS IT BACK.
   *
   * The bug this forbids: storing "8:30 a.m. ET" and reconstructing an instant
   * from it at render time. That re-derives a DST offset on every machine that
   * draws the row, which is exactly the calculation the stored UTC instant
   * exists to have already done — once, at authoring time, against the agency's
   * published schedule.
   *
   * Printing it is fine and is the point of it. Anything that takes it apart is
   * not.
   */
  it('never parses etDisplay — it is printed and nothing else', () => {
    const parsing = /\b(?:Date\.parse|new Date|parseInt|parseFloat|Number)\s*\([^)]*etDisplay|etDisplay\s*(?:\.\s*(?:split|match|replace|slice|substring|indexOf|search)\b|\))/;
    for (const file of FEATURE_FILES) {
      for (const [index, line] of file.text.split('\n').entries()) {
        if (!line.includes('etDisplay')) continue;
        // A comment explaining the ban is not a violation of it.
        if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) continue;
        expect(
          parsing.test(line),
          `${file.path}:${index + 1} takes etDisplay apart: ${line.trim()}`,
        ).toBe(false);
      }
    }
  });

  /*
   * The stored value is an instant, and only `at` is ever computed with. A
   * second field naming a zone — `timeZone: 'America/New_York'` beside a wall
   * clock — is the "date + time + zone name" shape the whole module rejects.
   */
  it('stores no wall-clock-plus-zone-name pair to be resolved at render time', () => {
    for (const file of FEATURE_FILES) {
      if (file.path.endsWith('src/lib/market-events/time.ts')) continue; // the one converter
      expect(file.text, `${file.path} must not name a time zone outside time.ts`)
        .not.toMatch(/'America\/New_York'|'Asia\/Bangkok'/);
    }
  });

  /*
   * The host-local readers are a lint error under `portkheaw-time/no-host-local-time`
   * (see eslint.config.mjs). Asserted here as well because a lint rule can be
   * disabled inline, and this is the claim the whole feature rests on.
   */
  it('uses no host-local Date readers, and no inline escape from the rule that bans them', () => {
    for (const file of FEATURE_FILES) {
      expect(file.text, `${file.path} reads the host clock`)
        .not.toMatch(/\.(?:getDate|getMonth|getDay|getHours|getMinutes|getFullYear)\s*\(/);
      /*
       * An eslint-disable DIRECTIVE, not a mention. `time.ts` names the rule in
       * its header to explain why it exists, and a check that could not tell
       * the documentation from an escape hatch would forbid documenting it —
       * the same distinction `no-banned-copy` draws when it skips comments.
       */
      expect(file.text, `${file.path} disables the host-clock rule inline`)
        .not.toMatch(/eslint-disable[^\n]*no-host-local-time/);
    }
  });

  /*
   * One converter. The reason `time.ts` can promise that a row lands on the
   * same Thai day everywhere is that it is the only file doing the conversion —
   * a second `Intl.DateTimeFormat` with its own options is a second answer.
   */
  it('keeps every zone conversion inside time.ts', () => {
    for (const file of FEATURE_FILES) {
      if (file.path.endsWith('src/lib/market-events/time.ts')) continue;
      expect(file.text, `${file.path} formats a date outside the one converter`)
        .not.toContain('Intl.DateTimeFormat');
    }
  });

  /*
   * Earnings are a separate feed with a separate source. The calendar is macro
   * only, and this is the assertion that keeps somebody from "just adding" an
   * earnings row to a grid whose cells are sized and ranked for market-wide
   * releases.
   */
  it('pulls nothing from the earnings pipeline', () => {
    for (const file of FEATURE_FILES) {
      expect(file.text, `${file.path} reaches into earnings`)
        .not.toMatch(/analytics\/earnings|loadUpcomingEarnings/);
    }
  });
});
