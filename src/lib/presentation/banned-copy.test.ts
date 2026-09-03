import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_MUST_NOT_SAY, EVENT_REACTION_MUST_NOT_SAY, NEVER_SAY } from './banned-copy';

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

  /*
   * ===========================================================================
   * THE SCOPE IS AN INVERSION NOW, AND THIS IS WHAT HOLDS IT THAT WAY
   * ===========================================================================
   * Three separate times a folder turned out to be outside the rule and the fix
   * was to add it: portfolio components, then `src/lib/portfolio`, then
   * `src/lib/market-status` and `src/config`. Each patch was correct and each
   * left the next gap open, because an allow-list of folders is a list of what
   * somebody remembered.
   *
   * An audit ended it. A banned phrase was planted as a live string literal in
   * 29 real files across `app/`, `src/components/` and `src/lib/`, and eslint
   * reported nothing on ALL 29 — settings, pricing, support, sign-in, admin,
   * alerts, notifications, watchlist, upcoming, not-found, the error boundary,
   * subscription, auth, news, layout, billing reminders, notification copy, the
   * alert engine, the market-signal engine, the security lockdown. The scope is
   * now "everything that can hand a reader a string", so a folder created
   * tomorrow is covered without anybody thinking about it.
   *
   * These assertions are deliberately about the SHAPE of the scope rather than
   * a list of blessed directories. A test naming directories would have passed
   * happily through all three of those gaps.
   */
  it('scans every app route and everything under src, not a list of folders', () => {
    const config = read('eslint.config.mjs');
    expect(config).toContain('"portkheaw/no-banned-copy": "error"');
    /*
     * The `files:` list belonging to THIS rule, not any other block's — taken as
     * the last one declared before the rule is switched on, which is the same
     * config object it sits in.
     */
    const before = config.slice(0, config.indexOf('"portkheaw/no-banned-copy"'));
    const scope = before.slice(before.lastIndexOf('files: ['));

    expect(scope, 'app routes are not scanned wholesale').toContain('app/**/*.{ts,tsx}');
    expect(scope, 'src is not scanned wholesale').toContain('src/**/*.{ts,tsx}');
    expect(scope, 'middleware composes the lockdown and maintenance copy a reader sees')
      .toContain('middleware.ts');

    /*
     * And NOT a narrowed list. A brace-expansion over hand-picked folders is the
     * exact shape that failed three times, so its return is a failure here even
     * though the rule would still "pass" on whatever it happened to cover.
     */
    expect(scope, 'the scope narrowed back to a hand-picked folder list')
      .not.toMatch(/src\/components\/\{/);
    expect(scope, 'the scope narrowed back to a hand-picked folder list')
      .not.toMatch(/src\/lib\/\{/);
  });

  /*
   * Every path the audit probed, asserted as data.
   *
   * This is the half that fails loudly if somebody re-narrows the scope: each of
   * these is a real file that was proven unscanned, and the glob shape above is
   * what covers them. Listing them keeps the evidence in the tree rather than
   * only in a commit message.
   */
  it('covers every path the audit proved was unscanned', () => {
    const config = read('eslint.config.mjs');
    const before = config.slice(0, config.indexOf('"portkheaw/no-banned-copy"'));
    const scope = before.slice(before.lastIndexOf('files: ['));
    const covered = (path: string) =>
      (path.startsWith('app/') && scope.includes('app/**/*.{ts,tsx}'))
      || (path.startsWith('src/') && scope.includes('src/**/*.{ts,tsx}'))
      || (path === 'middleware.ts' && scope.includes('middleware.ts'));

    for (const path of [
      'app/settings/page.tsx',
      'app/pricing/page.tsx',
      'app/support/page.tsx',
      'app/auth/sign-in/page.tsx',
      'app/admin/page.tsx',
      'app/not-found.tsx',
      'app/error.tsx',
      'src/components/subscription/SubscriptionFaq.tsx',
      'src/components/auth/LiveMemberCount.tsx',
      'src/components/layout/Header.tsx',
      'src/components/support/SupportFaq.tsx',
      'src/lib/billing/promptpay-reminders.ts',
      'src/lib/notifications/account-events.ts',
      'src/lib/alerts/background.ts',
      'src/lib/analytics/market-signal/calculations.ts',
      'src/lib/analytics/glossary/terms.ts',
      'src/lib/security/lockdown.ts',
      'middleware.ts',
    ]) {
      expect(covered(path), `${path} is outside the rule's scope`).toBe(true);
    }
  });

  /*
   * THE FRAME-WORD RULE is scoped narrowly ON PURPOSE, and that is a different
   * decision from the one above rather than an oversight.
   *
   * `FRAME_WORD` matches as a substring, and "กรอบ" is a substring of ordinary
   * Thai words with nothing to do with a price frame — "ทุกรอบ", "อีกรอบ",
   * "หลายรอบ" — which appear across the subscription copy, the support FAQ and
   * the options simulator. Widening it would produce false positives silenceable
   * only by allow-listing unrelated sentences, turning the allow list from a
   * record of frame provenance into noise.
   *
   * What it DID have to gain is the engine that writes the card's reason and
   * note copy: the audit planted "กรอบ" in `src/lib/analytics/market-signal/`
   * and eslint reported nothing, even though two strings in `calculations.ts`
   * already say it.
   */
  it('holds the frame word over the engine that writes the card copy, not just the component', () => {
    const config = read('eslint.config.mjs');
    const before = config.slice(0, config.indexOf('"market-signal/no-unsourced-frame-word"'));
    const scope = before.slice(before.lastIndexOf('files: ['));
    expect(scope, 'the card component is outside the frame rule')
      .toContain('src/components/analytics/market-signal/');
    expect(scope, 'the engine that composes the reason copy is outside the frame rule')
      .toContain('src/lib/analytics/market-signal/');
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

  /*
   * ===========================================================================
   * THE REACTION LIST, AND WHY IT IS NOT IN `NEVER_SAY`
   * ===========================================================================
   * "เฉลี่ย" is the correct word in sixty-five places in this product —
   * ต้นทุนเฉลี่ย, ค่าเฉลี่ย 20 วัน, ราคาไกลค่าเฉลี่ย — where it names a real
   * average of a real series. Product-wide it would ban the vocabulary rather
   * than its misuse, which is the argument `CARD_MUST_NOT_SAY` already makes
   * for staying on its card.
   *
   * Where it IS wrong is over three release days, because an average implies
   * they are samples of one repeatable quantity. That is the claim the block
   * declines to make, so the ban is scoped to the block.
   */
  it('scopes the reaction list to the calendar feature and leaves the rest of the product alone', () => {
    const config = read('eslint.config.mjs');
    const before = config.slice(0, config.indexOf('"portkheaw-reactions/no-banned-copy"'));
    const scope = before.slice(before.lastIndexOf('files: ['));
    expect(scope).toContain('src/lib/market-events/');
    expect(scope).toContain('src/components/market-events/');
    expect(scope, 'the reaction vocabulary must not be enforced product-wide')
      .not.toContain('src/**/*.{ts,tsx}');
    for (const phrase of EVENT_REACTION_MUST_NOT_SAY) {
      expect(NEVER_SAY as readonly string[], `"${phrase}" must not be banned product-wide`)
        .not.toContain(phrase);
    }
  });

  /*
   * The same drift problem the `DEFAULT_BANNED` check above solves, for the
   * same reason: the flat config is `.mjs` and cannot import this `.ts` list,
   * so it carries a copy, and a copy that drifts is a ban with no reasoning
   * beside it — or reasoning with no ban behind it.
   */
  it('keeps the eslint config’s reaction list identical to EVENT_REACTION_MUST_NOT_SAY', () => {
    const config = read('eslint.config.mjs');
    const start = config.indexOf('"portkheaw-reactions/no-banned-copy"');
    const block = config.slice(config.indexOf('banned: [', start), config.indexOf('],', config.indexOf('banned: [', start)));
    const inConfig = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(new Set(inConfig)).toEqual(new Set(EVENT_REACTION_MUST_NOT_SAY));
  });

  it('names the three ways the reaction copy could cross the line', () => {
    const list = EVENT_REACTION_MUST_NOT_SAY as readonly string[];
    expect(list, 'attribution').toContain('ส่งผลให้');
    expect(list, 'attribution, including the feature’s own Thai name').toContain('ปฏิกิริยา');
    expect(list, 'generalising three dates into a tendency').toContain('มักจะ');
    expect(list, 'the arithmetic that reads as a finding').toContain('เฉลี่ย');
    expect(list, 'forecasting').toContain('คาดว่า');
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
