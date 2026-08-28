import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_MUST_NOT_SAY, NEVER_SAY } from './banned-copy';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('the banned copy lists', () => {
  /*
   * The rule ships a copy of NEVER_SAY as its default, because an eslint rule is
   * a `.mjs` module loaded by the flat config and cannot import a `.ts` one. A
   * copy is fine; a copy that drifts is not, and this is the only thing standing
   * between the two.
   */
  it('keeps the eslint rule’s defaults identical to NEVER_SAY', () => {
    const source = read('eslint-rules/no-banned-copy.mjs');
    const block = source.slice(source.indexOf('const DEFAULT_BANNED = ['), source.indexOf('];'));
    for (const phrase of NEVER_SAY) {
      expect(block, `the rule does not carry "${phrase}"`).toContain(phrase);
    }
    // And nothing extra: a phrase enforced by the rule but absent from the list
    // would be a ban nobody could find the reasoning for.
    const inRule = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(new Set(inRule)).toEqual(new Set(NEVER_SAY));
  });

  it('is wired over the five pages Phase 1 covers', () => {
    const config = read('eslint.config.mjs');
    expect(config).toContain('"portkheaw/no-banned-copy": "error"');
    /*
     * The `files:` list belonging to THIS rule, not any other block's — taken as
     * the last one declared before the rule is switched on, which is the same
     * config object it sits in.
     */
    const before = config.slice(0, config.indexOf('"portkheaw/no-banned-copy"'));
    const scope = before.slice(before.lastIndexOf('files: ['));
    for (const page of ['app/page.tsx', 'app/search/', 'app/stock/', 'app/tools/']) {
      expect(scope, `${page} is outside the rule's scope`).toContain(page);
    }
    // And the components the five pages are assembled from, or a page would be
    // covered while every block on it was not.
    expect(scope).toContain('src/components/');
  });

  /*
   * THE PORTFOLIO SURFACES, named individually because leaving them out is not a
   * hypothetical failure — it was the state of this config until the day-figure
   * captions were written.
   *
   * With "ระบบประเมินว่า" planted as a live string literal in
   * `src/lib/portfolio/day-change-label.ts`, and "เครื่องมือนี้จะช่วยให้คุณ" in
   * `tracker/OptionPositionCard.tsx`, `npx eslint` on both files reported
   * nothing at all. The rule was not clearing that copy; it was never shown it.
   *
   * Both halves are asserted because covering one is not enough. The captions a
   * reader sees are COMPOSED in `src/lib/portfolio` and passed into the tracker
   * components as props, so a scope holding only the components would still not
   * see a single sentence — which is precisely how a rule reports success over
   * copy it has never read.
   */
  it('covers the portfolio surfaces, where the day figure’s copy is written', () => {
    const config = read('eslint.config.mjs');
    const before = config.slice(0, config.indexOf('"portkheaw/no-banned-copy"'));
    const scope = before.slice(before.lastIndexOf('files: ['));
    expect(scope, 'the tracker components are outside the rule’s scope').toContain('portfolio');
    expect(scope, 'src/lib/portfolio, where the captions are composed, is outside the scope')
      .toMatch(/src\/lib\/\{[^}]*portfolio[^}]*\}/);
    expect(scope, 'the /portfolio page itself is outside the scope').toContain('app/portfolio/');
  });

  /*
   * The two lists forbid different things over different scopes, and merging
   * them would be a mistake in both directions: "ATR" is correct inside the
   * dialog that shows the arithmetic, and "AI วิเคราะห์ว่า" is wrong everywhere.
   */
  it('keeps the two lists disjoint', () => {
    const overlap = CARD_MUST_NOT_SAY.filter((word) => NEVER_SAY.some((phrase) => phrase.includes(word)));
    expect(overlap).toEqual([]);
  });

  it('carries every phrase the brief named', () => {
    for (const phrase of [
      'ระบบประเมินว่า',
      'จากการวิเคราะห์ปัจจัย',
      'มีความเป็นไปได้ว่า',
      'เครื่องมือนี้จะช่วยให้คุณ',
      'AI วิเคราะห์ว่า',
    ]) {
      expect(NEVER_SAY as readonly string[]).toContain(phrase);
    }
  });

  /*
   * "การวิเคราะห์ด้วย AI" is on the list because it SHIPPED — a banner on the
   * stock page's Analysis tab announced it as coming soon. The banner is gone,
   * and this is what keeps it gone.
   */
  it('holds the phrase that actually reached production', () => {
    expect(NEVER_SAY as readonly string[]).toContain('การวิเคราะห์ด้วย AI');
    expect(read('src/components/stock/StockDetailClient.tsx')).not.toContain('การวิเคราะห์ด้วย AI');
  });
});
