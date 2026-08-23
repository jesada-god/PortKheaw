/**
 * Section 8's copy, checked against the engine that produces its input.
 *
 * The list the card renders is built from string slugs the engine pushes, and a
 * translation table is only as complete as somebody remembered to keep it. So
 * the slugs are read out of `calculations.ts` rather than typed here: a blocker
 * added tomorrow fails this file on the day it ships, instead of appearing on a
 * Thai page in English months later, which is how the last one got there.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTIONS_SIGNAL_CONFIG } from '@/src/lib/analytics/options-signal/config';
import { describePrimeBlocker, type PrimeBlockerContext } from './presentation';

const SOURCE = readFileSync(
  join(process.cwd(), 'src', 'lib', 'analytics', 'options-signal', 'calculations.ts'),
  'utf8',
);

/** Every literal slug the engine pushes onto `primeBlockers`. */
const literalBlockers = [...SOURCE.matchAll(/primeBlockers(?:\.push\(|: \[)'([a-z0-9:-]+)'/g)]
  .map((match) => match[1]);

/**
 * The one templated slug, spelled out per factor. `missing:${id}` is built from
 * `sufficiency.primeRequired`, so the list here is that config and not a copy.
 */
const missingBlockers = OPTIONS_SIGNAL_CONFIG.sufficiency.primeRequired.map((id) => `missing:${id}`);

const context: PrimeBlockerContext = {
  directionBalance: -18,
  directionScore0to100: 41,
  confidenceScore: 31,
  agreement: 0.3889,
  coverage: 0.8889,
};

/** A slug looks like `two-or-more-lowercase-words` or `missing:something`. */
const looksLikeASlug = (text: string) => /^[a-z0-9]+(?:[:-][a-z0-9]+)+$/.test(text.trim());

describe('describePrimeBlocker', () => {
  it('found the engine\'s blockers to check against, rather than checking nothing', () => {
    // A regex that silently stopped matching would make every test below pass
    // over an empty list. This is the guard on the guard.
    expect(literalBlockers.length).toBeGreaterThanOrEqual(8);
    expect(literalBlockers).toContain('score-below-prime');
    expect(literalBlockers).toContain('coverage-below-floor');
    expect(literalBlockers).toContain('data-insufficient');
  });

  it('translates every blocker the engine can emit', () => {
    for (const blocker of [...literalBlockers, ...missingBlockers]) {
      const copy = describePrimeBlocker(blocker, context);
      expect(copy.id, `${blocker} lost its slug`).toBe(blocker);
      expect(looksLikeASlug(copy.text), `${blocker} still renders as a raw slug`).toBe(false);
      // Thai, not a transliteration or an English sentence with a Thai word in it.
      expect(/[฀-๿]/.test(copy.text), `${blocker} has no Thai in it`).toBe(true);
    }
  });

  it('keeps the slug retrievable for logs and telemetry', () => {
    // The whole bargain of the translation: readers get Thai, and anything that
    // searched by slug before still finds it.
    expect(describePrimeBlocker('agreement-below-prime', context).id).toBe('agreement-below-prime');
    expect(describePrimeBlocker('missing:momentum', context).id).toBe('missing:momentum');
  });

  it('quotes the real threshold beside the real value, not just the verdict', () => {
    const { quality, sufficiency } = OPTIONS_SIGNAL_CONFIG;

    const score = describePrimeBlocker('score-below-prime', context).text;
    expect(score).toContain('41');
    expect(score).toContain(String(quality.primeScore));

    const confidence = describePrimeBlocker('confidence-below-prime', context).text;
    expect(confidence).toContain('31');
    expect(confidence).toContain(String(quality.primeConfidence));

    const agreement = describePrimeBlocker('agreement-below-prime', context).text;
    expect(agreement).toContain('39%');
    expect(agreement).toContain(`${quality.primeAgreement * 100}%`);

    const coverage = describePrimeBlocker('coverage-below-floor', context).text;
    expect(coverage).toContain('89%');
    expect(coverage).toContain(`${sufficiency.primeMinimumCoverage * 100}%`);
  });

  it('states the direction threshold on the scale the card shows, first', () => {
    /*
     * THE REASON THIS IS NOT A DETAIL.
     *
     * `|balance| >= 55` is what the code compares, and it was what section 8
     * printed. The card shows 0-100. On the handover fixture the card reads 58
     * and the balance is +16, so a reader comparing the only two numbers in
     * front of them concludes 58 >= 55 = PASSED, beside a card saying it did
     * not — the exact shape of contradiction this whole pass removed, relocated
     * into the section meant to explain it.
     *
     * 55 on the bipolar ruler is 77.5 / 22.5 on the card's.
     */
    const text = describePrimeBlocker('score-below-prime', context).text;
    const upper = 50 + OPTIONS_SIGNAL_CONFIG.quality.primeScore / 2;
    const lower = 50 - OPTIONS_SIGNAL_CONFIG.quality.primeScore / 2;

    expect(text).toContain(`${context.directionScore0to100} / 100`);
    expect(text).toContain(`≥ ${upper}`);
    expect(text).toContain(`≤ ${lower}`);
    // The card-scale figure comes BEFORE the engine-scale one, because it is the
    // one the reader can check against something on the page.
    expect(text.indexOf(`${upper}`)).toBeLessThan(text.indexOf('−100..+100'));
  });

  it('cites no number a reader cannot find a tile for', () => {
    /*
     * Every blocker that quotes a value has to quote it in the units of
     * something published on the page. The mapping is written out rather than
     * inferred, so adding a blocker that cites a fourth quantity forces a
     * deliberate decision about where that quantity is shown.
     *
     *   score-below-prime      -> section 1, "คะแนนทิศทางที่แสดงบนการ์ด" (0-100)
     *   confidence-below-prime -> the card's own confidence (0-100)
     *   agreement-below-prime  -> section 7 tile "ความสอดคล้อง" (%)
     *   coverage-below-floor   -> section 1 line "สัดส่วนน้ำหนักของโมเดลที่วัดได้" (%)
     */
    const CITED: Record<string, string[]> = {
      // 100 and 18 belong to the "|−18| ≥ 55 on the −100..+100 scale" clause,
      // which names the engine's own ruler explicitly rather than leaving a
      // number floating in the reader's.
      'score-below-prime': ['41', '77.5', '22.5', '55', '100', '18'],
      'confidence-below-prime': ['31', '65'],
      'agreement-below-prime': ['39', '70'],
      'coverage-below-floor': ['89', '75'],
    };

    for (const [blocker, allowed] of Object.entries(CITED)) {
      // Section cross-references are navigation, not measurements.
      const text = describePrimeBlocker(blocker, context).text.replace(/\(?ดูข้อ \d+\)?/g, '');
      const numbers = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]);
      expect(numbers.length, `${blocker} cites nothing`).toBeGreaterThan(0);
      for (const number of numbers) {
        expect(allowed, `${blocker} cites ${number}, which is on no scale the page shows`)
          .toContain(number);
      }
    }
  });

  it('does not call the coverage floor "ความครบของข้อมูล", which is a different number', () => {
    /*
     * Section 7 publishes `completeness` under that exact Thai name — 77.5% on
     * the golden case — while this blocker is written on `coverage`, which is
     * 88.9% on the same card. One name over two fractions would put a reader in
     * front of two different percentages both labelled "ความครบของข้อมูล" and no
     * way to tell which the threshold applies to.
     */
    expect(describePrimeBlocker('coverage-below-floor', context).text).not.toContain('ความครบของข้อมูล');
  });

  it('prints an unknown slug rather than dropping it', () => {
    // Withholding a blocker would be the same silence section 8 exists to end,
    // and a slug on screen is loud enough to get fixed.
    const copy = describePrimeBlocker('some-future-blocker', context);
    expect(copy.id).toBe('some-future-blocker');
    expect(copy.text).toBe('some-future-blocker');
  });
});
