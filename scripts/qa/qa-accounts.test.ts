import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QA_EMAIL_DOMAIN, QA_OWNERS, QA_OWNER_TAGS, qaOwner } from './qa-accounts.mjs';

/**
 * THE TEST THAT GOES RED WHEN THE SWEEP STOPS KNOWING ABOUT A QA SCRIPT.
 *
 * ===========================================================================
 * THE FAILURE THIS EXISTS FOR
 * ===========================================================================
 * `trial:qa-cleanup` finds throwaway accounts by the `qa_owner` stamped on them
 * at creation. The stamps were written in nine scripts and the list of stamps
 * to look for was written in the sweep, and the second list said `phase1-ux-qa`
 * and nothing else. So the sweep ran, matched nothing, and printed
 * `"deletable": 0` over a production database holding twelve QA accounts from
 * eight runs it had never heard of. Every part of that was working as written.
 *
 * Nothing could have caught it, because nothing compared the two lists — and
 * they were not comparable: one was a `const` in a TypeScript file, the other
 * was nine string literals spread across nine `.mjs` files, and no test in this
 * repo read either.
 *
 * ===========================================================================
 * WHAT IS ACTUALLY ASSERTED
 * ===========================================================================
 * The requirement in one line: EVERY OWNER ANY SCRIPT STAMPS ON AN ACCOUNT MUST
 * BE AN OWNER THE SWEEP COLLECTS. That is `stamped ⊆ swept`, and the cases below
 * establish it from both ends:
 *
 *   1. every `qa_owner` written anywhere under `scripts/` is registered;
 *   2. the sweep's list IS the registry, imported rather than restated;
 *   3. the registry's entries are real — each names a script that stamps it;
 *   4. the second half of the sweep's rule, the reserved mailbox domain, holds
 *      for every one of those scripts too.
 *
 * (3) is what stops the registry being widened just to pass (1): a tag cannot be
 * added without a script behind it, so "make the test green" and "make the sweep
 * correct" are the same edit.
 *
 * The sources are read as TEXT rather than imported. A `.mjs` QA script opens a
 * browser and creates accounts on import, and the stamp is written inside a
 * `fetch` body several hundred lines in — reading the file is the only way to
 * see every stamp without running any of them.
 */

const REPO = resolve(process.cwd()).replace(/\\/g, '/');
const SCRIPTS_DIR = resolve(REPO, 'scripts');
const SWEEP = 'scripts/trial-qa-cleanup.ts';

/**
 * Every file under `scripts/`, so a new QA script is covered the day it lands.
 *
 * Tests are the one exclusion, and for the reason the eslint copy rule excludes
 * them: a test about `qa_owner` has to write `qa_owner` — this file writes it in
 * prose, in a regex and in a failure message — and holding the assertion to its
 * own rule would ban stating what is being asserted. Nothing under `scripts/`
 * creates an account from a test.
 */
function everyScriptFile(): string[] {
  return readdirSync(SCRIPTS_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(mjs|mts|ts|tsx|js)$/.test(entry.name))
    .filter((entry) => !/\.(test|spec)\.[cm]?tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).replace(/\\/g, '/'))
    .map((file) => file.slice(REPO.length + 1))
    .sort();
}

const read = (file: string) => readFileSync(resolve(REPO, file), 'utf8');

/**
 * Where a stamp is WRITTEN — `qa_owner: <value>` — never where one is read.
 *
 * The optional-property spelling `qa_owner?:` and the member read `.qa_owner`
 * are both excluded by requiring the bare `qa_owner:`, so the sweep's own type
 * declaration and its metadata read are not mistaken for creations.
 */
const STAMP = /(?<![.?\w])qa_owner:\s*([^,\n}]+)/g;

/** The readable forms: the literal it used to be, and the checked call it is now. */
const TAG_OF = /^(?:qaOwner\(\s*)?'([a-z0-9-]+)'\s*\)?$/;

interface Stamp { file: string; raw: string; tag: string | null }

function stampsIn(file: string): Stamp[] {
  const found: Stamp[] = [];
  for (const match of read(file).matchAll(STAMP)) {
    const raw = match[1]!.trim();
    found.push({ file, raw, tag: TAG_OF.exec(raw)?.[1] ?? null });
  }
  return found;
}

const ALL_STAMPS = everyScriptFile().flatMap(stampsIn);

describe('qa_owner registry — every stamp a script writes, the sweep collects', () => {
  /*
   * The guard on this suite's own reach. If the file walk ever stops finding
   * the QA scripts — a moved directory, a renamed extension, a `recursive`
   * option that quietly changed shape — every case below would pass over an
   * empty set and report green while checking nothing.
   */
  it('finds the stamps at all', () => {
    expect(ALL_STAMPS.length, 'no qa_owner stamp found under scripts/ — the walk is broken')
      .toBeGreaterThanOrEqual(Object.keys(QA_OWNERS).length);
  });

  it('writes every stamp in a form this test can read', () => {
    const unreadable = ALL_STAMPS.filter((stamp) => stamp.tag === null);
    expect(unreadable, `a computed qa_owner cannot be checked against the registry: ${
      unreadable.map((stamp) => `${stamp.file} -> ${stamp.raw}`).join(', ')
    }`).toEqual([]);
  });

  /** THE REQUIREMENT. Every owner any script creates with is an owner the sweep looks for. */
  it('registers every owner any script stamps on an account', () => {
    for (const stamp of ALL_STAMPS) {
      expect(
        QA_OWNER_TAGS,
        `${stamp.file} stamps qa_owner ${JSON.stringify(stamp.tag)}, which trial:qa-cleanup `
        + 'will never sweep. Add it to QA_OWNERS in scripts/qa/qa-accounts.mjs.',
      ).toContain(stamp.tag);
    }
  });

  /*
   * The other direction, which is what stops the registry from being widened
   * until the case above goes green. A tag with no script behind it is a sweep
   * looking for accounts nothing makes.
   */
  it('backs every registered owner with the script named against it', () => {
    for (const [tag, file] of Object.entries(QA_OWNERS)) {
      const stamps = stampsIn(file);
      expect(stamps.map((stamp) => stamp.tag), `${file} must stamp ${tag}`).toContain(tag);
    }
  });

  it('routes every stamp through qaOwner(), so an unregistered tag throws at creation', () => {
    const bare = ALL_STAMPS.filter((stamp) => !stamp.raw.startsWith('qaOwner('));
    expect(bare, `a bare literal is a tag nothing checks: ${
      bare.map((stamp) => `${stamp.file} -> ${stamp.raw}`).join(', ')
    }`).toEqual([]);
  });

  it('refuses a tag that is not in the registry', () => {
    expect(() => qaOwner('not-a-registered-qa')).toThrow(/not registered/);
    expect(qaOwner('phase1-ux-qa')).toBe('phase1-ux-qa');
  });
});

describe('qa_owner registry — the sweep reads it rather than restating it', () => {
  it('imports the owner list and the mailbox domain from the registry', () => {
    const source = read(SWEEP);
    expect(source, `${SWEEP} must import the shared owner list`)
      .toMatch(/import\s*\{[^}]*QA_OWNER_TAGS[^}]*\}\s*from\s*'\.\/qa\/qa-accounts\.mjs'/);
    expect(source, `${SWEEP} must import the shared mailbox domain`)
      .toMatch(/import\s*\{[^}]*QA_EMAIL_DOMAIN[^}]*\}\s*from\s*'\.\/qa\/qa-accounts\.mjs'/);
  });

  /*
   * A second declaration is how the drift would come back: the import stays, an
   * inline list is added "just for this run", and the sweep narrows again with
   * the import still sitting at the top of the file looking correct.
   */
  it('declares no owner list or mailbox domain of its own', () => {
    const source = read(SWEEP);
    expect(source, `${SWEEP} must not declare its own owner list`)
      .not.toMatch(/(const|let)\s+QA_OWNER(S|_TAGS)\s*[:=]/);
    expect(source, `${SWEEP} must not declare its own mailbox domain`)
      .not.toMatch(/(const|let)\s+QA_EMAIL_DOMAIN\s*[:=]/);
  });

  it('filters on the imported list, not on a subset of it', () => {
    expect(read(SWEEP)).toContain('new Set<string>(QA_OWNER_TAGS)');
  });
});

describe('qa_owner registry — the mailbox half of the rule', () => {
  /*
   * The sweep requires the tag AND the reserved domain. A script that stamped a
   * registered tag onto an address outside that domain would pass every case
   * above and still create an account the sweep can never collect, so the
   * addresses are checked against the same exported constant.
   */
  it('builds every QA address on the reserved domain', () => {
    for (const [tag, file] of Object.entries(QA_OWNERS)) {
      const addresses = [...read(file).matchAll(/@([a-z][\w.-]*\.[a-z]{2,})/gi)]
        .map((match) => `@${match[1]!.toLowerCase()}`);
      expect(addresses.length, `${file} (${tag}) builds no address this test can see`)
        .toBeGreaterThan(0);
      for (const domain of addresses) {
        expect(domain, `${file} (${tag}) uses ${domain}, which trial:qa-cleanup will not sweep`)
          .toBe(QA_EMAIL_DOMAIN);
      }
    }
  });
});
